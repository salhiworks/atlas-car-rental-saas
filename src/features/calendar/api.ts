import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type { Rental, RentalScheduleEntry, RentalStatus, VehicleFleetEntry } from '@/types/database'

/**
 * What the Calendar asks of the database.
 *
 * Two queries carry the board: the fleet, and the bookings that overlap the
 * window on screen. Neither invents anything — the schedule read model is a
 * view over `rentals`, and availability comes from the same function the
 * Rentals module books against.
 *
 * Nothing here fetches "all rentals". Every query is bounded by the visible
 * window, the organization, and the statuses actually being drawn.
 */

export interface ScheduleQuery {
  readonly organizationId: string
  /** ISO instants bounding the window, half-open. */
  readonly from: string
  readonly to: string
  readonly statuses: readonly RentalStatus[]
  readonly vehicleIds?: readonly string[]
}

/**
 * Every booking overlapping the window.
 *
 * The overlap test is `starts_at < to AND ends_at > from` — the same half-open
 * semantics as `rentals_no_vehicle_overlap`, so what the board draws and what
 * the database will accept agree exactly. It is also what keeps a hire that
 * began last month and ends next month on screen: filtering on `starts_at`
 * alone would silently drop the cars that are actually out.
 */
export async function fetchSchedule(query: ScheduleQuery): Promise<RentalScheduleEntry[]> {
  if (query.statuses.length === 0) return []

  let request = getSupabaseClient()
    .from('rental_schedule')
    .select('*')
    .eq('organization_id', query.organizationId)
    .in('status', [...query.statuses])
    .lt('starts_at', query.to)
    .gt('ends_at', query.from)

  if (query.vehicleIds && query.vehicleIds.length > 0) {
    request = request.in('vehicle_id', [...query.vehicleIds])
  }

  // A hard ceiling rather than pagination: a window this full is a filter
  // problem, and the toolbar says so instead of the board quietly truncating.
  const { data, error } = await request.order('starts_at', { ascending: true }).limit(2000)

  if (error) throw toAppError(error)
  return data ?? []
}

export interface FleetQuery {
  readonly organizationId: string
  readonly includeArchived: boolean
  readonly makes?: readonly string[]
}

/**
 * The vehicle rows of the board.
 *
 * Archived vehicles are absent unless asked for: they are not schedulable, and
 * an empty row for a car that left the fleet is noise. History mode brings them
 * back so a past booking still has a row to sit on.
 */
export async function fetchFleetRows(query: FleetQuery): Promise<VehicleFleetEntry[]> {
  let request = getSupabaseClient()
    .from('vehicle_fleet')
    .select('*')
    .eq('organization_id', query.organizationId)

  if (!query.includeArchived) request = request.is('archived_at', null)
  if (query.makes && query.makes.length > 0) request = request.in('make', [...query.makes])

  const { data, error } = await request
    .order('make', { ascending: true })
    .order('model', { ascending: true })
    .order('registration_plate', { ascending: true })
    .limit(1000)

  if (error) throw toAppError(error)
  return data ?? []
}

/**
 * The vehicles bookable for a period.
 *
 * Calls the same `vehicles_available_between()` the Rentals module uses. There
 * is deliberately no second availability algorithm: one that agreed with the
 * exclusion constraint today would drift from it tomorrow.
 */
export async function fetchAvailableVehicles(
  organizationId: string,
  from: string,
  to: string,
  excludeRentalId?: string,
): Promise<string[]> {
  const { data, error } = await getSupabaseClient().rpc('vehicles_available_between', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
    p_exclude_rental_id: excludeRentalId ?? null,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export interface RescheduleInput {
  readonly rentalId: string
  readonly startsAt: string
  readonly endsAt: string
  /** Omitted when the booking stays on its current vehicle. */
  readonly vehicleId?: string | null
  /** Consent to issuing a new contract version. Refused without it. */
  readonly amendContract?: boolean
}

/**
 * Moves a booking.
 *
 * One transactional call rather than a write per changed field: the period, the
 * vehicle, the day count and — where a contract exists — a new contract version
 * all land together or not at all. The exclusion constraint is what decides
 * whether the new slot is free.
 */
export async function rescheduleRental(input: RescheduleInput): Promise<Rental> {
  const { data, error } = await getSupabaseClient().rpc('rental_reschedule', {
    p_rental_id: input.rentalId,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_vehicle_id: input.vehicleId ?? null,
    p_amend_contract: input.amendContract ?? false,
  })

  if (error) throw toAppError(error)
  if (data === null) throw toAppError(new Error('The database returned nothing for that move.'))
  return Array.isArray(data) ? (data[0] as Rental) : data
}
