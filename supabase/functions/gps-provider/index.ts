/**
 * The GPS integration boundary.
 *
 * Hostinger serves this product as static files, so there is no application
 * server: the browser talks to Supabase directly. That is fine for everything
 * governed by row-level security, and completely unfit for a provider token,
 * which must never be in a bundle, a database row a user can read, local
 * storage, a URL or a log line. This function is the only place a token exists
 * in plaintext, and it exists there for the length of one request.
 *
 * AUTHORIZATION, IN THAT ORDER
 *
 *   1. Supabase verifies the caller's JWT before this code runs.
 *   2. We resolve the caller with a client carrying THEIR token, so every read
 *      is still subject to row-level security. The organization is never taken
 *      from the request body — it is read from the connection row the caller
 *      was actually able to see.
 *   3. Only once membership and role are established does the service-role
 *      client appear, and only to reach the Vault secret and write normalised
 *      state.
 *
 * The third step is where integrations usually go wrong. A service-role client
 * bypasses row-level security entirely, so obtaining one before establishing
 * who is asking turns "service-role bypass" into "tenant bypass". Here the
 * privileged client is created after the check and used only for the two things
 * the user's own client genuinely cannot do.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import {
  GpsProviderError,
  type NormalizedUnit,
  toSyncPayload,
} from '../_shared/gps-provider.ts'
import { WialonAdapter } from '../_shared/wialon-adapter.ts'

type Role = 'owner' | 'admin' | 'manager' | 'staff'

const ROLE_RANK: Record<Role, number> = { owner: 40, admin: 30, manager: 20, staff: 10 }

/** How long one agency's refresh serves every tab that asks. */
const REFRESH_COALESCE_SECONDS = 20

/** Nobody gets to ask for a year of second-by-second history in one go. */
const MAX_HISTORY_DAYS = 31
const MAX_HISTORY_POINTS = 20000

/*
 * Floors under the two other paths that reach the provider.
 *
 * Testing sends a candidate token upstream, so an unthrottled Test button is a
 * credential-testing oracle. History is a real `messages/load_interval` per
 * click against a provider that limits concurrent requests. Neither number is
 * high enough to get in the way of a person using the product; both are high
 * enough that a held-down button costs one call rather than fifty.
 */
const TEST_MIN_SECONDS = 5
const HISTORY_MIN_SECONDS = 2

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

/**
 * The only shape an error ever leaves this function in.
 *
 * A category and a sentence written for a person. Never a provider payload,
 * never a stack, never anything echoed back from a request that carried a
 * token.
 */
function failure(category: string, message: string, status = 400): Response {
  return json({ ok: false, error: { category, message } }, status)
}

function describe(error: unknown): { category: string; message: string; status: number } {
  if (error instanceof GpsProviderError) {
    const status =
      error.category === 'auth_error' ? 401
      : error.category === 'permission_denied' ? 403
      : error.category === 'rate_limited' ? 429
      : error.category === 'unreachable' ? 504
      : 400
    return { category: error.category, message: error.message, status }
  }
  return {
    category: 'provider_error',
    message: 'The tracking provider could not be reached.',
    status: 500,
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (request.method !== 'POST') return failure('malformed_config', 'Use POST.', 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return failure('malformed_config', 'The tracking integration is not configured.', 500)
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization) return failure('auth_error', 'Sign in to use tracking.', 401)

  // The caller's own client. Every read through it obeys row-level security,
  // which is what makes the checks below meaningful rather than decorative.
  const asUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: auth, error: authError } = await asUser.auth.getUser()
  if (authError || !auth?.user) return failure('auth_error', 'Sign in to use tracking.', 401)
  const userId = auth.user.id

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return failure('malformed_config', 'That request could not be read.')
  }

  const action = typeof body.action === 'string' ? body.action : ''

  try {
    switch (action) {
      case 'test':
        return await handleTest(asUser, body, userId)
      case 'save':
        return await handleSave(asUser, supabaseUrl, serviceKey, body, userId)
      case 'refresh':
        return await handleSync(asUser, supabaseUrl, serviceKey, body, userId, 'refresh')
      case 'sync':
        return await handleSync(asUser, supabaseUrl, serviceKey, body, userId, 'sync')
      case 'history':
        return await handleHistory(asUser, supabaseUrl, serviceKey, body, userId)
      case 'disconnect':
        return await handleDisconnect(asUser, supabaseUrl, serviceKey, body, userId)
      default:
        return failure('malformed_config', 'That is not something tracking can do.')
    }
  } catch (error) {
    const described = describe(error)
    // Deliberately not logging the error object: a provider client can carry
    // the request it was constructed with, and that request carried a token.
    console.error(`gps-provider ${action} failed: ${described.category}`)
    return failure(described.category, described.message, described.status)
  }
})

// -----------------------------------------------------------------------------
// Authorization helpers
// -----------------------------------------------------------------------------

/**
 * The caller's role in one agency, read under their own row-level security.
 *
 * `user_id` is not optional here, and leaving it out was not a cosmetic bug.
 * The SELECT policy on organization_members is `app.is_org_member(...)`, so a
 * query filtered only by organization returns EVERY active member — and
 * `.maybeSingle()` turns more than one row into an error with `data: null`.
 * While an agency had exactly one member the query happened to be right; the
 * first time anybody accepted a Team invitation, every tracking action started
 * answering "Only an administrator can do that" to the owner. Found by asking
 * what the Team review had not looked at, because Team is what made it
 * reachable.
 */
async function roleIn(
  asUser: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<Role | null> {
  const { data } = await asUser
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  const role = data?.role as Role | undefined
  return role ?? null
}

function atLeast(role: Role | null, minimum: Role): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/**
 * Resolves a connection the caller can actually see.
 *
 * The organization is taken from the row, never from the request. A browser
 * naming another agency's connection id gets the same answer as one naming an
 * id that never existed.
 */
async function resolveConnection(
  asUser: SupabaseClient,
  connectionId: unknown,
  minimum: Role,
  userId: string,
): Promise<
  | { ok: true; connection: Record<string, unknown>; role: Role }
  | { ok: false; response: Response }
> {
  if (typeof connectionId !== 'string' || connectionId === '') {
    return { ok: false, response: failure('malformed_config', 'No connection was named.') }
  }

  const { data } = await asUser
    .from('gps_provider_connections')
    .select('id, organization_id, provider, base_url, status, generation, disabled_at, label')
    .eq('id', connectionId)
    .maybeSingle()

  if (!data) {
    return { ok: false, response: failure('not_found', 'That connection was not found.', 404) }
  }

  const role = await roleIn(asUser, data.organization_id as string, userId)
  if (!atLeast(role, minimum)) {
    return {
      ok: false,
      response: failure('permission_denied', 'You do not have access to do that.', 403),
    }
  }

  return { ok: true, connection: data, role: role as Role }
}

/**
 * Server-side floor between provider-reaching actions.
 *
 * Returns a 429 response when the caller is too early, or null to proceed. The
 * decision is one atomic UPDATE in Postgres, so two isolates racing produce
 * exactly one winner — a per-isolate counter would not, because isolates are
 * ephemeral and there are many of them.
 */
async function throttle(
  service: SupabaseClient,
  connectionId: string,
  action: string,
  minSeconds: number,
): Promise<Response | null> {
  const { data, error } = await service.rpc('gps_claim_action', {
    p_connection_id: connectionId,
    p_action: action,
    p_min_seconds: minSeconds,
  })

  // A throttle that fails open would be no throttle at all under load, which is
  // exactly when it matters.
  if (error) {
    return failure('provider_error', 'The tracking service is busy. Try again in a moment.', 429)
  }
  if (data === true) return null

  return failure(
    'rate_limited',
    `That is faster than your provider allows. Try again in a few seconds.`,
    429,
  )
}

function serviceClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/**
 * Reads a connection's token out of Vault.
 *
 * The only path to a plaintext credential in this system, and it is reachable
 * only from here: `vault.decrypted_secrets` is granted to `service_role` and
 * `postgres` alone, and the `vault` schema is not among the schemas the Data
 * API exposes.
 */
async function readToken(service: SupabaseClient, connectionId: string): Promise<string> {
  const { data, error } = await service.rpc('gps_read_credential', {
    p_connection_id: connectionId,
  })

  if (error || typeof data !== 'string' || data === '') {
    throw new GpsProviderError(
      'auth_error',
      'This connection has no stored credential. Reconnect the provider.',
    )
  }
  return data
}

function adapterFor(provider: string, baseUrl: string, token: string) {
  switch (provider) {
    case 'wialon':
      return new WialonAdapter({ baseUrl, token })
    default:
      throw new GpsProviderError('malformed_config', 'That tracking provider is not supported.')
  }
}

// -----------------------------------------------------------------------------
// test — verify a configuration without saving anything
// -----------------------------------------------------------------------------

async function handleTest(
  asUser: SupabaseClient,
  body: Record<string, unknown>,
  userId: string,
): Promise<Response> {
  const organizationId = body.organizationId
  if (typeof organizationId !== 'string') {
    return failure('malformed_config', 'No agency was named.')
  }

  // The organization comes from the body here because nothing has been saved
  // yet — so it is checked against the caller's own membership before use.
  const role = await roleIn(asUser, organizationId, userId)
  if (!atLeast(role, 'admin')) {
    return failure('permission_denied', 'Only an administrator can connect a provider.', 403)
  }

  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const provider = typeof body.provider === 'string' ? body.provider : 'wialon'
  let token = typeof body.token === 'string' ? body.token : ''

  const service = serviceClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  /*
   * Re-testing a saved connection is throttled; testing a connection that does
   * not exist yet is not, because there is nothing durable to key a limit on.
   * That path is deliberately narrow: administrator only, against a host the
   * administrator typed, with a token the administrator typed, once per setup.
   * The provider's own concurrency limits are the backstop, and the adapter maps
   * them to `rate_limited` rather than swallowing them.
   */
  if (typeof body.connectionId === 'string' && body.connectionId !== '') {
    const resolved = await resolveConnection(asUser, body.connectionId, 'admin', userId)
    if (!resolved.ok) return resolved.response

    const tooSoon = await throttle(service, body.connectionId, 'test', TEST_MIN_SECONDS)
    if (tooSoon) return tooSoon

    if (token === '') token = await readToken(service, body.connectionId)
  }

  if (token === '') return failure('malformed_config', 'Enter the provider access token.')
  if (!/^https:\/\//i.test(baseUrl)) {
    return failure('malformed_config', 'The provider address has to be an https:// URL.')
  }

  const adapter = adapterFor(provider, baseUrl, token)
  try {
    const account = await adapter.testConnection()
    // Safe to return: a display name, a host and a count. Never the token, and
    // nothing about the provider account beyond what was asked for.
    return json({
      ok: true,
      account: {
        accountLabel: account.accountLabel ?? null,
        unitCount: account.unitCount,
        host: account.host,
        capabilities: account.capabilities,
      },
    })
  } finally {
    await adapter.close()
  }
}

// -----------------------------------------------------------------------------
// save — store the credential in Vault and create or update the connection
// -----------------------------------------------------------------------------

async function handleSave(
  asUser: SupabaseClient,
  url: string,
  key: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<Response> {
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const provider = typeof body.provider === 'string' ? body.provider : 'wialon'

  if (token === '') return failure('malformed_config', 'Enter the provider access token.')
  if (!/^https:\/\//i.test(baseUrl)) {
    return failure('malformed_config', 'The provider address has to be an https:// URL.')
  }

  const service = serviceClient(url, key)
  let connectionId: string
  let organizationId: string

  if (typeof body.connectionId === 'string' && body.connectionId !== '') {
    // Rotating the credential on a connection that already exists.
    const resolved = await resolveConnection(asUser, body.connectionId, 'admin', userId)
    if (!resolved.ok) return resolved.response
    connectionId = resolved.connection.id as string
    organizationId = resolved.connection.organization_id as string
  } else {
    const requested = body.organizationId
    if (typeof requested !== 'string') return failure('malformed_config', 'No agency was named.')

    const role = await roleIn(asUser, requested, userId)
    if (!atLeast(role, 'admin')) {
      return failure('permission_denied', 'Only an administrator can connect a provider.', 403)
    }
    organizationId = requested

    const { data, error } = await service
      .from('gps_provider_connections')
      .insert({
        organization_id: organizationId,
        provider,
        label: label === '' ? 'Wialon' : label,
        base_url: baseUrl,
        created_by: userId,
      })
      .select('id')
      .single()

    if (error || !data) {
      return failure('malformed_config', 'That connection could not be saved. Check the name is not already in use.')
    }
    connectionId = data.id as string
  }

  // Vault holds the secret; the application tables hold a reference to it and
  // the generation counter that makes a superseded credential unusable.
  const { error: storeError } = await service.rpc('gps_store_credential', {
    p_connection_id: connectionId,
    p_token: token,
    p_base_url: baseUrl,
    p_label: label === '' ? null : label,
    p_user_id: userId,
  })

  if (storeError) {
    return failure('malformed_config', 'The credential could not be stored securely.', 500)
  }

  return json({ ok: true, connectionId, organizationId })
}

// -----------------------------------------------------------------------------
// refresh / sync — talk to the provider and write normalised state
// -----------------------------------------------------------------------------

async function handleSync(
  asUser: SupabaseClient,
  url: string,
  key: string,
  body: Record<string, unknown>,
  userId: string,
  mode: 'refresh' | 'sync',
): Promise<Response> {
  /*
   * Refreshing positions is a manager's: they run the day and the map is no
   * use if it only updates when an administrator happens to look at it.
   * Changing the device inventory — adding units, marking them missing — stays
   * with the administrator who owns the connection, alongside assignment.
   */
  const resolved = await resolveConnection(asUser, body.connectionId, mode === 'sync' ? 'admin' : 'manager', userId)
  if (!resolved.ok) return resolved.response

  const connection = resolved.connection
  const connectionId = connection.id as string

  if (connection.disabled_at !== null) {
    return failure('malformed_config', 'This provider connection is switched off.')
  }

  const service = serviceClient(url, key)

  /*
   * One refresh per agency serves every open tab.
   *
   * The lease is a conditional UPDATE, so two tabs racing produce exactly one
   * provider call: the loser gets no row back and returns the snapshot that is
   * already in the database. Without it, five people watching the map would be
   * five times the provider traffic for the same answer.
   */
  const { data: lease } = await service.rpc('gps_claim_sync', {
    p_connection_id: connectionId,
    p_min_seconds: mode === 'sync' ? 0 : REFRESH_COALESCE_SECONDS,
  })

  if (!lease) {
    return json({ ok: true, coalesced: true, applied: false })
  }

  const generation = connection.generation as number
  const startedAt = new Date().toISOString()
  const token = await readToken(service, connectionId)
  const adapter = adapterFor(connection.provider as string, connection.base_url as string, token)

  let units: NormalizedUnit[] = []
  let skipped = 0
  let accountLabel: string | null = null
  let outcome: string = 'success'
  let errorCategory: string | null = null
  let errorMessage: string | null = null

  try {
    const result = await adapter.listUnits()
    units = result.units
    skipped = result.skipped
    accountLabel = result.account.accountLabel ?? null
    if (skipped > 0) outcome = 'partial'
  } catch (error) {
    const described = describe(error)
    outcome =
      described.category === 'auth_error' ? 'auth_error'
      : described.category === 'unreachable' ? 'unreachable'
      : described.category === 'rate_limited' ? 'rate_limited'
      : 'provider_error'
    errorCategory = described.category
    errorMessage = described.message
  } finally {
    await adapter.close()
  }

  /*
   * A position refresh never changes the inventory. It updates devices the
   * agency has already synchronised and ignores anything new, so a manager
   * refreshing the map cannot quietly add hardware nobody has approved.
   */
  if (mode === 'refresh' && units.length > 0) {
    const { data: known } = await service
      .from('gps_units')
      .select('external_id')
      .eq('connection_id', connectionId)

    const allowed = new Set((known ?? []).map((row) => row.external_id as string))
    units = units.filter((unit) => allowed.has(unit.externalId))
  }

  const { data: applied, error: applyError } = await service.rpc('gps_apply_sync', {
    p_connection_id: connectionId,
    p_generation: generation,
    // Translated into the database's own vocabulary. Handing the adapter's
    // camelCase straight to a function that reads snake_case would write a
    // device with no identifier and a position with no fields, quietly.
    p_units: toSyncPayload(units),
    p_outcome: outcome,
    p_started_at: startedAt,
    p_full_inventory: mode === 'sync',
    p_account_label: accountLabel,
    p_error_category: errorCategory,
    p_error_message: errorMessage,
    p_triggered_by: userId,
  })

  if (applyError) {
    return failure('provider_error', 'The tracking data could not be saved.', 500)
  }

  if (errorCategory) {
    return json({ ok: false, error: { category: errorCategory, message: errorMessage }, result: applied }, 200)
  }

  return json({ ok: true, result: applied, skipped })
}

// -----------------------------------------------------------------------------
// history — a bounded track, for a vehicle the caller can already see
// -----------------------------------------------------------------------------

async function handleHistory(
  asUser: SupabaseClient,
  url: string,
  key: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<Response> {
  const vehicleId = body.vehicleId
  if (typeof vehicleId !== 'string' || vehicleId === '') {
    return failure('malformed_config', 'No vehicle was named.')
  }

  /*
   * The browser sends a vehicle id and never a device id.
   *
   * This resolution runs under the caller's own row-level security, so naming
   * somebody else's vehicle returns nothing — and there is no code path at all
   * that accepts an external device identifier from a request and asks the
   * provider about it.
   */
  const { data: resolved } = await asUser
    .rpc('gps_resolve_tracked_vehicle', { p_vehicle_id: vehicleId })
    .maybeSingle()

  if (!resolved) {
    return failure('not_found', 'That vehicle has no tracking device assigned.', 404)
  }

  const role = await roleIn(asUser, resolved.organization_id as string, userId)
  if (!atLeast(role, 'manager')) {
    return failure('permission_denied', 'You do not have access to tracking history.', 403)
  }

  if (resolved.connection_status === 'disabled') {
    return failure('malformed_config', 'This provider connection is switched off.')
  }

  const from = new Date(String(body.from ?? ''))
  const to = new Date(String(body.to ?? ''))

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return failure('malformed_config', 'Choose a period that ends after it starts.')
  }

  const days = (to.getTime() - from.getTime()) / 86_400_000
  if (days > MAX_HISTORY_DAYS) {
    return failure(
      'malformed_config',
      `Choose a period of ${MAX_HISTORY_DAYS} days or fewer. A longer range is more history than the provider will return at once.`,
    )
  }

  const service = serviceClient(url, key)

  const tooSoon = await throttle(
    service,
    resolved.connection_id as string,
    'history',
    HISTORY_MIN_SECONDS,
  )
  if (tooSoon) return tooSoon

  const token = await readToken(service, resolved.connection_id as string)
  const adapter = adapterFor(
    resolved.provider as string,
    resolved.base_url as string,
    token,
  )

  try {
    const track = await adapter.fetchTrack(
      resolved.unit_external_id as string,
      from,
      to,
      MAX_HISTORY_POINTS,
    )
    return json({ ok: true, track })
  } finally {
    await adapter.close()
  }
}

// -----------------------------------------------------------------------------
// disconnect
// -----------------------------------------------------------------------------

async function handleDisconnect(
  asUser: SupabaseClient,
  url: string,
  key: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<Response> {
  const resolved = await resolveConnection(asUser, body.connectionId, 'admin', userId)
  if (!resolved.ok) return resolved.response

  const service = serviceClient(url, key)
  const { error } = await service.rpc('gps_disconnect_connection', {
    p_connection_id: resolved.connection.id as string,
    p_user_id: userId,
  })

  if (error) return failure('provider_error', 'The connection could not be switched off.', 500)

  // Devices, assignments and last-known positions all survive. Switching a
  // provider off stops future synchronisation; it does not rewrite which
  // tracker was on which car last March.
  return json({ ok: true })
}
