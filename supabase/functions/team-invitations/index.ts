/**
 * The Team invitation boundary.
 *
 * Three things need a server, and only three, so only three are here:
 *
 *   1. An email provider key, which cannot be in a browser bundle.
 *   2. The application's own origin, which cannot be taken from a request —
 *      honouring a client-supplied Host or redirect target would turn every
 *      invitation this product sends into an open redirect carrying a bearer
 *      token.
 *   3. The signed-out preview of an invitation, which by definition has no
 *      authenticated caller to authorise.
 *
 * Everything else — who may invite, which roles they may grant, what happens on
 * acceptance, the last-owner rule, the audit trail — is in the database, in
 * 20260821100000_team_membership.sql, and this function cannot weaken any of it.
 *
 * AUTHORIZATION
 *
 * `create` and `resend` run every database statement through a client carrying
 * the CALLER'S OWN token, so row-level security and the role checks inside the
 * Team functions apply exactly as they do to a browser. This function grants
 * nothing. It cannot invite on somebody's behalf, it cannot name an organization
 * the caller is not in, and it never sees a service-role key on those paths.
 *
 * `preview` is the one path that uses the service role, because there is no
 * caller to run as. It is confined to a single database function that accepts
 * one argument — the token — and returns an agency name, a role, an expiry, a
 * state and a masked address. No identifier of any kind comes back, so nothing
 * it returns can be pointed at another endpoint. That is what keeps a
 * service-role client from becoming a tenant bypass.
 *
 * NOTHING HERE LOGS A TOKEN, A LINK, OR A REQUEST BODY.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import {
  buildAcceptUrl,
  deliverInvitation,
  resolveAppOrigin,
  type DeliveryState,
} from '../_shared/team-email.ts'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // Belt and braces for anything this response might cause the browser to fetch.
  'Referrer-Policy': 'no-referrer',
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  staff: 'Staff',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function failure(category: string, message: string, status = 400): Response {
  return json({ ok: false, error: { category, message } }, status)
}

/**
 * A floor under the anonymous preview, and an honest account of what it is not.
 *
 * It is keyed on a forwarded address, which the caller can set, and it lives in
 * one short-lived isolate among many. It therefore stops a runaway client and a
 * held-down button; it does not stop somebody who is trying. What actually
 * protects this endpoint is that its only key is a 256-bit token — guessing one
 * is not a rate-limiting problem — and that it returns no identifier of any
 * kind. The platform's own limits sit in front of this.
 *
 * The last element of x-forwarded-for is used, not the first: an appending
 * proxy puts the address it observed at the end, and the values before it are
 * whatever the client sent.
 */
const previewHits = new Map<string, { count: number; resetAt: number }>()
const PREVIEW_WINDOW_MS = 60_000
const PREVIEW_MAX_PER_WINDOW = 30
const PREVIEW_MAX_KEYS = 5_000

function previewAllowed(key: string, now: number): boolean {
  // Evict what has expired before inserting. Without this the map only ever
  // grew, one entry per distinct forwarded address — which a caller chooses.
  if (previewHits.size >= PREVIEW_MAX_KEYS) {
    for (const [existing, entry] of previewHits) {
      if (entry.resetAt <= now) previewHits.delete(existing)
    }
    // Still full: every bucket is live, so refuse rather than grow without
    // bound. A legitimate visitor retries in under a minute.
    if (previewHits.size >= PREVIEW_MAX_KEYS) return false
  }

  const entry = previewHits.get(key)
  if (!entry || entry.resetAt <= now) {
    previewHits.set(key, { count: 1, resetAt: now + PREVIEW_WINDOW_MS })
    return true
  }
  entry.count += 1
  return entry.count <= PREVIEW_MAX_PER_WINDOW
}

/** The address of the caller, as far as the platform will say. */
function callerKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? ''
  const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean)
  return hops[hops.length - 1] || request.headers.get('cf-connecting-ip') || 'unknown'
}

function formatExpiry(iso: string): string {
  // A date, in a form that reads the same everywhere. The row carries the
  // authoritative instant; this is the sentence in the email.
  return new Date(iso).toISOString().slice(0, 10)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (request.method !== 'POST') return failure('malformed_request', 'Use POST.', 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')

  if (!supabaseUrl || !anonKey) {
    return failure('not_configured', 'Team invitations are not configured.', 500)
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return failure('malformed_request', 'That request could not be read.')
  }

  const action = typeof body.action === 'string' ? body.action : ''

  try {
    if (action === 'preview') {
      return await handlePreview(request, body, supabaseUrl)
    }

    /*
     * Everything below needs a real person. `verify_jwt` is off for this
     * function so the anonymous preview can reach it at all, which means the
     * caller is established here rather than by the platform: a request whose
     * Authorization header is not a live user session gets nothing.
     */
    const authorization = request.headers.get('Authorization') ?? ''
    if (!authorization.toLowerCase().startsWith('bearer ')) {
      return failure('auth_error', 'Sign in to manage invitations.', 401)
    }

    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: auth, error: authError } = await asUser.auth.getUser()
    if (authError || !auth?.user) {
      return failure('auth_error', 'Sign in to manage invitations.', 401)
    }

    switch (action) {
      case 'create':
        return await handleIssue(asUser, body, 'create')
      case 'resend':
        return await handleIssue(asUser, body, 'resend')
      default:
        return failure('malformed_request', 'That is not something invitations can do.')
    }
  } catch (error) {
    // The category only. An exception thrown around a fetch can carry the
    // request that was made, and that request carried the invitation link.
    const category = error instanceof Error ? error.name : 'unknown'
    console.error(`team-invitations ${action} failed: ${category}`)
    return failure('unexpected', 'The invitation could not be processed.', 500)
  }
})

// -----------------------------------------------------------------------------

/**
 * Creates or reissues an invitation, then tries to send it.
 *
 * The database decides whether the caller may do this at all, which role they
 * may grant, and whether an invitation for that address already exists. This
 * function receives an outcome and a token and does the two things a database
 * cannot: build a link against a trusted origin, and talk to an email provider.
 */
async function handleIssue(
  asUser: SupabaseClient,
  body: Record<string, unknown>,
  mode: 'create' | 'resend',
): Promise<Response> {
  let invitationId: string | null = null
  let token: string | null = null
  let expiresAt: string | null = null
  let outcome = ''

  if (mode === 'create') {
    const organizationId = typeof body.organization_id === 'string' ? body.organization_id : ''
    const email = typeof body.email === 'string' ? body.email : ''
    const role = typeof body.role === 'string' ? body.role : ''

    if (!organizationId || !email) {
      return failure('malformed_request', 'An organization and an email address are required.')
    }
    // `Object.hasOwn`, not a truthiness test on the lookup: a plain object
    // literal resolves inherited members, so role='constructor' would have
    // passed the guard and been handed to the database as an org_role.
    if (!Object.hasOwn(ROLE_LABELS, role)) {
      // Owner arrives here as an unknown role, which is the honest answer: it is
      // not something an invitation can carry.
      return failure('malformed_request', 'Choose administrator, manager or staff.')
    }

    const { data, error } = await asUser.rpc('create_team_invitation', {
      p_organization_id: organizationId,
      p_email: email,
      p_role: role,
    })

    if (error) return rpcFailure(error)

    const row = (data as Array<Record<string, unknown>> | null)?.[0]
    if (!row) return failure('unexpected', 'The invitation could not be created.', 500)

    outcome = String(row.outcome ?? '')
    if (outcome === 'already_member') {
      return json({ ok: true, outcome, delivery: null })
    }

    invitationId = String(row.invitation_id)
    token = String(row.token)
    expiresAt = String(row.expires_at)
  } else {
    const id = typeof body.invitation_id === 'string' ? body.invitation_id : ''
    if (!id) return failure('malformed_request', 'An invitation is required.')

    const { data, error } = await asUser.rpc('resend_team_invitation', { p_invitation_id: id })
    if (error) return rpcFailure(error)

    const row = (data as Array<Record<string, unknown>> | null)?.[0]
    if (!row) return failure('unexpected', 'The invitation could not be reissued.', 500)

    outcome = String(row.outcome ?? 'reissued')
    invitationId = String(row.invitation_id)
    token = String(row.token)
    expiresAt = String(row.expires_at)
  }

  /*
   * Everything the message needs, read back through the caller's own client and
   * a function that refuses anybody below administrator. A caller who somehow
   * reached an invitation they may not administer gets nothing to put in an
   * email.
   */
  const { data: described, error: describeError } = await asUser.rpc('team_invitation_message', {
    p_invitation_id: invitationId,
  })

  const details = (described as Array<Record<string, unknown>> | null)?.[0]
  if (describeError || !details) {
    return failure('unexpected', 'The invitation was created but could not be described.', 500)
  }

  const organizationName = String(details.organization_name ?? '')
  const inviterName = String(details.invited_by_name ?? '')
  const email = String(details.email ?? '')
  const roleKey = String(details.role ?? '')

  const origin = resolveAppOrigin(Deno.env.get('TEAM_APP_URL'))
  if (!origin) {
    /*
     * No trusted origin means no link this function is willing to put in an
     * email. The invitation is real and valid; the administrator is told to
     * deliver it themselves, and the raw token goes back to them once.
     */
    await recordDelivery(
      asUser,
      invitationId!,
      'not_configured',
      'No application address is configured, so no email was sent.',
    )
    return json({
      ok: true,
      outcome,
      invitationId,
      delivery: 'not_configured',
      deliveryDetail: 'No application address is configured for this project, so no email was sent.',
      token,
      expiresAt,
    })
  }

  const acceptUrl = buildAcceptUrl(origin, token!)

  const result = await deliverInvitation(
    {
      to: email,
      organizationName,
      inviterName,
      roleLabel: ROLE_LABELS[roleKey] ?? roleKey,
      acceptUrl,
      expiresAt: formatExpiry(expiresAt!),
      locale: 'en',
    },
    {
      provider: Deno.env.get('TEAM_EMAIL_PROVIDER'),
      apiKey: Deno.env.get('TEAM_EMAIL_API_KEY'),
      from: Deno.env.get('TEAM_EMAIL_FROM'),
    },
  )

  await recordDelivery(asUser, invitationId!, result.state, result.detail)

  /*
   * The token goes back to the browser only when nothing else will carry it.
   * When a provider took the message, the administrator has no reason to hold a
   * bearer capability and does not get one.
   */
  const needsManualDelivery = result.state === 'not_configured' || result.state === 'failed'

  return json({
    ok: true,
    outcome,
    invitationId,
    delivery: result.state,
    deliveryDetail: result.detail,
    expiresAt,
    ...(needsManualDelivery ? { token, acceptUrl } : {}),
  })
}

async function recordDelivery(
  asUser: SupabaseClient,
  invitationId: string,
  state: DeliveryState,
  detail: string,
): Promise<void> {
  await asUser.rpc('record_invitation_delivery', {
    p_invitation_id: invitationId,
    p_state: state,
    p_detail: detail,
  })
}

/**
 * The signed-out preview.
 *
 * Takes a token and returns a description. No identifier of any kind comes back,
 * so a valid token buys exactly one thing: knowing which agency invited you,
 * which is what the person about to accept needs to see.
 */
async function handlePreview(
  request: Request,
  body: Record<string, unknown>,
  supabaseUrl: string,
): Promise<Response> {
  const token = typeof body.token === 'string' ? body.token : ''
  if (token.length < 20 || token.length > 200) {
    return failure('not_found', 'That invitation link is not valid.', 404)
  }

  if (!previewAllowed(callerKey(request), Date.now())) {
    return failure('rate_limited', 'Too many attempts. Wait a minute and try again.', 429)
  }

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) {
    return failure('not_configured', 'Invitation links cannot be checked right now.', 500)
  }

  /*
   * The only privileged client in this file, created after the request has been
   * reduced to a single opaque token and used for exactly one call. It is given
   * no organization, no user and no identifier from the request, so there is
   * nothing for it to be pointed at.
   */
  const asService = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await asService.rpc('preview_team_invitation', { p_token: token })

  if (error || !Array.isArray(data) || data.length === 0) {
    return failure('not_found', 'That invitation link is not valid.', 404)
  }

  const row = data[0] as Record<string, unknown>

  return json({
    ok: true,
    invitation: {
      organizationName: String(row.organization_name ?? ''),
      role: String(row.role ?? ''),
      roleLabel: ROLE_LABELS[String(row.role ?? '')] ?? String(row.role ?? ''),
      expiresAt: row.expires_at ?? null,
      state: String(row.state ?? ''),
      invitedByName: String(row.invited_by_name ?? ''),
      emailMasked: String(row.email_masked ?? ''),
    },
  })
}

/** Turns a database refusal into the message it already wrote for a person. */
function rpcFailure(error: { code?: string; message?: string }): Response {
  const status =
    error.code === '42501' ? 403
    : error.code === 'P0002' ? 404
    : error.code === '55006' ? 429
    : 400

  return failure(
    error.code === '42501' ? 'permission_denied' : 'rejected',
    error.message ?? 'That invitation could not be processed.',
    status,
  )
}
