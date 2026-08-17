/**
 * What the tracking workspace asks of the server.
 *
 * Two kinds of call, and the split is the whole security story:
 *
 *   READS go straight to Postgres through PostgREST, under the caller's own row
 *   level security. `gps_fleet` and `gps_unit_inventory` are security-invoker
 *   views, so a manager sees their agency's vehicles and nobody else's — the
 *   filter is a policy, not a `.eq()` we could forget to write.
 *
 *   PROVIDER WORK goes to the `gps-provider` Edge Function, because it needs the
 *   agency's provider token and that token must never exist in a browser. The
 *   browser never sends a device identifier either: history is asked for by
 *   vehicle, and the server resolves vehicle → assignment → connection → unit
 *   under the caller's own policies before it talks to anybody.
 *
 * Nothing here accepts an `organization_id` from a caller and passes it to the
 * server as authority. Where one appears it narrows a read the database has
 * already restricted; the Edge Function reads the agency off the row it was able
 * to resolve, never off the request.
 */

import { getSupabaseClient } from '@/lib/supabase/client'
import { AppError, toAppError } from '@/lib/supabase/errors'
import type {
  GpsAttentionSignalRow,
  GpsFleetRow,
  GpsProviderConnection,
  GpsSyncRun,
  GpsTrack,
  GpsUnitAssignment,
  GpsUnitInventoryRow,
} from '@/types/database'

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export async function fetchConnections(organizationId: string): Promise<GpsProviderConnection[]> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('gps_provider_connections')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: true })

  if (error) throw toAppError(error)
  return data ?? []
}

export interface FleetQuery {
  readonly organizationId: string
  /** Plate, make, model, device name — matched server-side. */
  readonly search?: string
  readonly includeArchivedVehicles?: boolean
}

/**
 * Every tracked vehicle, in one request.
 *
 * The map needs all of them at once — a paginated map is not a map — so this
 * returns the whole read model rather than a page. The view is one row per
 * active assignment and carries no customer identity: who is driving is asked of
 * Rentals, separately, by somebody who opened a panel to ask.
 */
export async function fetchFleet(query: FleetQuery): Promise<GpsFleetRow[]> {
  const supabase = getSupabaseClient()

  let request = supabase
    .from('gps_fleet')
    .select('*')
    .eq('organization_id', query.organizationId)
    .order('vehicle_plate', { ascending: true })

  if (!query.includeArchivedVehicles) {
    request = request.eq('vehicle_archived', false)
  }

  const search = query.search?.trim() ?? ''
  if (search !== '') {
    const term = search.replace(/[,()%]/g, ' ').trim()
    if (term !== '') {
      request = request.or(
        [
          `vehicle_plate.ilike.*${term}*`,
          `vehicle_make.ilike.*${term}*`,
          `vehicle_model.ilike.*${term}*`,
          `unit_name.ilike.*${term}*`,
        ].join(','),
      )
    }
  }

  const { data, error } = await request
  if (error) throw toAppError(error)
  return data ?? []
}

/** One vehicle's tracking row, for the vehicle detail page. */
export async function fetchVehicleFleetRow(
  organizationId: string,
  vehicleId: string,
): Promise<GpsFleetRow | null> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('gps_fleet')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('vehicle_id', vehicleId)
    .maybeSingle()

  if (error) throw toAppError(error)
  return data ?? null
}

export interface InventoryQuery {
  readonly organizationId: string
  readonly search?: string
  readonly assigned?: 'any' | 'assigned' | 'unassigned'
}

export async function fetchUnitInventory(query: InventoryQuery): Promise<GpsUnitInventoryRow[]> {
  const supabase = getSupabaseClient()

  let request = supabase
    .from('gps_unit_inventory')
    .select('*')
    .eq('organization_id', query.organizationId)
    .order('name', { ascending: true })

  if (query.assigned === 'assigned') request = request.not('vehicle_id', 'is', null)
  if (query.assigned === 'unassigned') request = request.is('vehicle_id', null)

  const search = query.search?.trim() ?? ''
  if (search !== '') {
    const term = search.replace(/[,()%]/g, ' ').trim()
    if (term !== '') {
      request = request.or(
        [`name.ilike.*${term}*`, `external_id.ilike.*${term}*`, `device_uid.ilike.*${term}*`].join(
          ',',
        ),
      )
    }
  }

  const { data, error } = await request
  if (error) throw toAppError(error)
  return data ?? []
}

/**
 * The last synchronisation attempts for a connection.
 *
 * Kept to the most recent fifty per connection by a trigger, so this is a short
 * list by construction rather than by a LIMIT somebody could raise. An
 * administrator reading it can tell "the provider is down" from "our credential
 * is wrong" from "nothing has run since Tuesday".
 */
export async function fetchSyncRuns(connectionId: string, limit = 12): Promise<GpsSyncRun[]> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('gps_sync_runs')
    .select('*')
    .eq('connection_id', connectionId)
    .order('started_at', { ascending: false })
    .limit(limit)

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchAttentionSignals(
  organizationId: string,
): Promise<GpsAttentionSignalRow[]> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc('gps_attention_signals', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// Assignment
// -----------------------------------------------------------------------------

/**
 * Points a device at a vehicle.
 *
 * One statement, not three. Moving a tracker means closing whatever it was on,
 * closing whatever was on the vehicle, and opening the new link — and a browser
 * doing that in three requests can be interrupted between any two of them,
 * leaving a device on two cars or a car with none. The function does all three
 * inside one transaction, and two partial unique indexes make the invariant true
 * even if this code is wrong.
 */
export async function assignUnit(
  vehicleId: string,
  unitId: string,
  note?: string | null,
): Promise<GpsUnitAssignment> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc('gps_assign_unit', {
    p_vehicle_id: vehicleId,
    p_unit_id: unitId,
    p_note: note ?? null,
  })

  if (error) throw toAppError(error)
  if (!data) throw new AppError('unknown', 'That device could not be assigned.')
  return data
}

export async function unassignUnit(assignmentId: string): Promise<GpsUnitAssignment> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.rpc('gps_unassign_unit', {
    p_assignment_id: assignmentId,
  })

  if (error) throw toAppError(error)
  if (!data) throw new AppError('unknown', 'That device could not be released.')
  return data
}

/** Vehicles that could take a device: in the fleet, not archived, not tracked. */
export interface AssignableVehicle {
  readonly id: string
  readonly registration_plate: string
  readonly make: string
  readonly model: string
}

export async function fetchAssignableVehicles(
  organizationId: string,
  search: string,
): Promise<AssignableVehicle[]> {
  const supabase = getSupabaseClient()

  let request = supabase
    .from('vehicles')
    .select('id, registration_plate, make, model')
    .eq('organization_id', organizationId)
    .is('archived_at', null)
    .order('registration_plate', { ascending: true })
    .limit(50)

  const term = search
    .trim()
    .replace(/[,()%]/g, ' ')
    .trim()
  if (term !== '') {
    request = request.or(
      [`registration_plate.ilike.*${term}*`, `make.ilike.*${term}*`, `model.ilike.*${term}*`].join(
        ',',
      ),
    )
  }

  const { data, error } = await request
  if (error) throw toAppError(error)
  return data ?? []
}

// -----------------------------------------------------------------------------
// The provider boundary
// -----------------------------------------------------------------------------

/**
 * The categories the Edge Function is allowed to hand back.
 *
 * Provider payloads never reach here. A category and a sentence do, which is
 * enough to choose a message and a colour and not enough to leak a token, a
 * request URL or somebody else's account.
 */
export type GpsErrorCategory =
  | 'auth_error'
  | 'unreachable'
  | 'rate_limited'
  | 'permission_denied'
  | 'malformed_config'
  | 'not_found'
  | 'provider_error'

export class GpsProviderCallError extends AppError {
  readonly category: GpsErrorCategory

  constructor(category: GpsErrorCategory, message: string) {
    const kind =
      category === 'permission_denied'
        ? 'permission'
        : category === 'auth_error'
          ? 'auth'
          : category === 'malformed_config'
            ? 'validation'
            : category === 'not_found'
              ? 'notFound'
              : category === 'unreachable'
                ? 'network'
                : 'unknown'
    super(kind, message, { code: category })
    this.name = 'GpsProviderCallError'
    this.category = category
  }
}

interface FunctionFailure {
  readonly ok: false
  readonly error: { category: string; message: string }
}

function isFailure(value: unknown): value is FunctionFailure {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  return value.ok === false
}

const KNOWN_CATEGORIES: readonly GpsErrorCategory[] = [
  'auth_error',
  'unreachable',
  'rate_limited',
  'permission_denied',
  'malformed_config',
  'not_found',
  'provider_error',
]

function toCategory(value: unknown): GpsErrorCategory {
  return KNOWN_CATEGORIES.includes(value as GpsErrorCategory)
    ? (value as GpsErrorCategory)
    : 'provider_error'
}

/**
 * Calls the tracking function and unwraps its answer.
 *
 * supabase-js turns a non-2xx into a `FunctionsHttpError` whose body is still
 * unread, which is where the useful sentence lives — so the body is read before
 * anything is thrown, and a body that cannot be read becomes a generic message
 * rather than a stringified Response.
 */
async function callProvider<T>(payload: Record<string, unknown>): Promise<T> {
  const supabase = getSupabaseClient()

  const invocation: { data: unknown; error: unknown } = await supabase.functions.invoke(
    'gps-provider',
    { body: payload },
  )
  const { data, error } = invocation

  if (error) {
    const context: unknown = (error as { context?: unknown }).context
    if (context instanceof Response) {
      try {
        const parsed: unknown = await context.json()
        if (isFailure(parsed)) {
          throw new GpsProviderCallError(toCategory(parsed.error.category), parsed.error.message)
        }
      } catch (readError) {
        if (readError instanceof GpsProviderCallError) throw readError
      }
    }

    const message = error instanceof Error ? error.message : ''
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      throw new GpsProviderCallError(
        'unreachable',
        'Could not reach the tracking service. Check your connection and try again.',
      )
    }
    throw new GpsProviderCallError('provider_error', 'The tracking service could not be reached.')
  }

  if (isFailure(data)) {
    throw new GpsProviderCallError(toCategory(data.error.category), data.error.message)
  }

  return data as T
}

export interface ProviderAccountSummary {
  readonly accountLabel: string | null
  readonly unitCount: number
  readonly host: string
  readonly capabilities: readonly string[]
}

export interface TestConnectionInput {
  readonly organizationId: string
  readonly baseUrl: string
  /** Omitted when re-testing a saved connection; the server reads the stored one. */
  readonly token?: string
  readonly connectionId?: string
}

export async function testConnection(input: TestConnectionInput): Promise<ProviderAccountSummary> {
  const result = await callProvider<{ ok: true; account: ProviderAccountSummary }>({
    action: 'test',
    provider: 'wialon',
    organizationId: input.organizationId,
    baseUrl: input.baseUrl,
    ...(input.token ? { token: input.token } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  })
  return result.account
}

export interface SaveConnectionInput {
  readonly organizationId: string
  readonly label: string
  readonly baseUrl: string
  readonly token: string
  /** Present when rotating the credential on a connection that already exists. */
  readonly connectionId?: string
}

export async function saveConnection(
  input: SaveConnectionInput,
): Promise<{ connectionId: string }> {
  const result = await callProvider<{ ok: true; connectionId: string }>({
    action: 'save',
    provider: 'wialon',
    organizationId: input.organizationId,
    label: input.label,
    baseUrl: input.baseUrl,
    token: input.token,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  })
  return { connectionId: result.connectionId }
}

export interface SyncResult {
  readonly ok: boolean
  /** True when another tab's refresh was still fresh and this one reused it. */
  readonly coalesced?: boolean
  readonly result?: Record<string, number | boolean | string | null>
  readonly skipped?: number
}

/** Positions only, for devices the agency has already synchronised. Manager+. */
export async function refreshPositions(connectionId: string): Promise<SyncResult> {
  return await callProvider<SyncResult>({ action: 'refresh', connectionId })
}

/** The full device inventory, including marking vanished devices missing. Admin. */
export async function syncDevices(connectionId: string): Promise<SyncResult> {
  return await callProvider<SyncResult>({ action: 'sync', connectionId })
}

export interface HistoryQuery {
  readonly vehicleId: string
  readonly from: Date
  readonly to: Date
}

/**
 * A bounded track, fetched live from the provider and never stored.
 *
 * The provider stays the system of record for raw telemetry: this product holds
 * one current position per device and asks for history when somebody opens a
 * panel. That is a deliberate choice — an unbounded local archive of every
 * agency's every position is a liability with no corresponding benefit, and it
 * would drift from the provider's own record the first time a message arrived
 * late.
 */
export async function fetchVehicleTrack(query: HistoryQuery): Promise<GpsTrack> {
  const result = await callProvider<{ ok: true; track: GpsTrack }>({
    action: 'history',
    vehicleId: query.vehicleId,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
  })
  return result.track
}

export async function disconnectConnection(connectionId: string): Promise<void> {
  await callProvider<{ ok: true }>({ action: 'disconnect', connectionId })
}
