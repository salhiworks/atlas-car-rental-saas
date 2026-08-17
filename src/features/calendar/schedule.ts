import type { RentalScheduleEntry, RentalStatus } from '@/types/database'

/**
 * What the schedule means, as opposed to where it draws.
 *
 * The geometry lives in time-grid.ts; this is the operational reading of a
 * booking — is it late, how tight is the turnaround after it, how much of it
 * fits in the block we have room for.
 */

// -----------------------------------------------------------------------------
// Which bookings belong on an operational board
// -----------------------------------------------------------------------------

/**
 * The statuses shown unless the desk asks for more.
 *
 * A draft holds no vehicle — the exclusion constraint ignores it — so putting
 * one on the board by default would tell staff a car is committed when it is
 * not. Cancelled and completed bookings are history rather than schedule. Both
 * are available behind a filter, and drafts are drawn as outlines so they can
 * never be mistaken for a commitment.
 */
export const DEFAULT_SCHEDULE_STATUSES: readonly RentalStatus[] = ['reserved', 'active']

export const SCHEDULE_STATUS_OPTIONS: ReadonlyArray<{
  readonly value: RentalStatus
  readonly label: string
  readonly hint: string
}> = [
  { value: 'reserved', label: 'Reserved', hint: 'Confirmed, holding the vehicle' },
  { value: 'active', label: 'Out', hint: 'With a customer now' },
  { value: 'draft', label: 'Drafts', hint: 'Tentative — hold nothing' },
  { value: 'completed', label: 'Completed', hint: 'Finished hires' },
  { value: 'cancelled', label: 'Cancelled', hint: 'Called off' },
]

/** True when a booking of this status occupies its vehicle. */
export function occupiesVehicle(status: RentalStatus): boolean {
  return status === 'reserved' || status === 'active'
}

// -----------------------------------------------------------------------------
// Operational state
// -----------------------------------------------------------------------------

/**
 * The TypeScript twin of public.rental_is_overdue().
 *
 * The view supplies `is_overdue` on every row, and that is what the board
 * renders; this exists so a block that has been on screen since before its
 * return time can turn late without waiting for a refetch, and so the two
 * definitions can be asserted equal in the test suite.
 */
export function isOverdue(
  rental: Pick<RentalScheduleEntry, 'status' | 'ends_at' | 'returned_at'>,
  now: Date,
): boolean {
  return (
    rental.status === 'active' &&
    Date.parse(rental.ends_at) < now.getTime() &&
    rental.returned_at === null
  )
}

/**
 * The status a block is drawn as.
 *
 * Overdue is a presentation of an active rental, not a sixth status: the
 * contract has not changed, and giving lateness its own enum value would make
 * it something that has to be set and cleared correctly rather than observed.
 */
export type ScheduleTone = 'draft' | 'reserved' | 'active' | 'overdue' | 'completed' | 'cancelled'

export function toneFor(
  rental: Pick<RentalScheduleEntry, 'status' | 'ends_at' | 'returned_at'>,
  now: Date,
): ScheduleTone {
  if (rental.status === 'active' && isOverdue(rental, now)) return 'overdue'
  return rental.status
}

export const TONE_LABELS: Readonly<Record<ScheduleTone, string>> = {
  draft: 'Draft',
  reserved: 'Reserved',
  active: 'Out',
  overdue: 'Overdue',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

// -----------------------------------------------------------------------------
// Turnaround
// -----------------------------------------------------------------------------

export type TurnaroundPressure = 'none' | 'comfortable' | 'tight' | 'collision'

/**
 * How much room there is between this hire coming back and the next going out.
 *
 * No buffer is invented. The product has no configurable preparation time, so
 * inventing one — "under two hours is a problem" — would be this module making
 * up a business rule. What is reported is the real gap; "tight" only marks it
 * for attention, and "collision" is the case that genuinely cannot work: the
 * car is already late for a booking that has started.
 */
export function turnaroundPressure(
  turnaroundMinutes: number | null,
  isLate: boolean,
): TurnaroundPressure {
  if (turnaroundMinutes === null) return 'none'
  if (turnaroundMinutes <= 0) return isLate ? 'collision' : 'tight'
  if (turnaroundMinutes < 180) return 'tight'
  return 'comfortable'
}

export function formatGap(minutes: number): string {
  if (minutes <= 0) return 'no gap'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  }

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`
}

// -----------------------------------------------------------------------------
// Block density
// -----------------------------------------------------------------------------

export type BlockDensity = 'full' | 'compact' | 'minimal'

/**
 * How much a block can say at the width it has been given.
 *
 * Blocks degrade rather than overflow: a five-hour hire on a month view is a
 * few pixels wide and gets no text at all, which is honest — the label would be
 * unreadable, and clipping it produces the ellipsis soup that makes scheduling
 * boards hard to scan.
 */
export function densityFor(widthPx: number): BlockDensity {
  if (widthPx >= 168) return 'full'
  if (widthPx >= 64) return 'compact'
  return 'minimal'
}

// -----------------------------------------------------------------------------
// The day's operations
// -----------------------------------------------------------------------------

export interface DayOperations {
  readonly pickups: readonly RentalScheduleEntry[]
  readonly returns: readonly RentalScheduleEntry[]
  readonly out: readonly RentalScheduleEntry[]
  readonly overdue: readonly RentalScheduleEntry[]
}

/**
 * Splits the day's bookings into the four questions a rental desk actually asks.
 *
 * A rental can appear in more than one group — a same-day hire is both a pickup
 * and a return — because those are two separate jobs for the counter, and
 * making the groups exclusive would hide one of them.
 */
export function dayOperations(
  rentals: readonly RentalScheduleEntry[],
  dayStart: Date,
  dayEnd: Date,
  now: Date,
): DayOperations {
  const from = dayStart.getTime()
  const to = dayEnd.getTime()
  const inDay = (iso: string | null): boolean => {
    if (iso === null) return false
    const time = Date.parse(iso)
    return time >= from && time < to
  }

  const byTime =
    (key: 'starts_at' | 'ends_at') => (a: RentalScheduleEntry, b: RentalScheduleEntry) =>
      Date.parse(a[key]) - Date.parse(b[key])

  return {
    // Still to be handed over: a collection due today that has not happened yet
    // is the counter's job; one already handed over is not.
    pickups: rentals
      .filter((rental) => rental.status === 'reserved' && inDay(rental.starts_at))
      .sort(byTime('starts_at')),

    returns: rentals
      .filter(
        (rental) =>
          rental.status === 'active' && rental.returned_at === null && inDay(rental.ends_at),
      )
      .sort(byTime('ends_at')),

    out: rentals
      .filter(
        (rental) =>
          rental.status === 'active' &&
          Date.parse(rental.starts_at) < to &&
          Date.parse(rental.ends_at) > from,
      )
      .sort(byTime('ends_at')),

    overdue: rentals.filter((rental) => isOverdue(rental, now)).sort(byTime('ends_at')),
  }
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

/**
 * Matches a booking against a typed term.
 *
 * Applied to the rows already fetched for the visible window rather than
 * issuing a query: the desk is looking for something on the board in front of
 * them, and searching the whole history from here would answer a different
 * question than the one they asked.
 */
export function matchesSearch(rental: RentalScheduleEntry, term: string): boolean {
  const needle = term.trim().toLowerCase()
  if (needle === '') return true

  return [
    rental.reference,
    rental.customer_name,
    rental.primary_driver_name,
    rental.vehicle_plate,
    rental.vehicle_make,
    rental.vehicle_model,
  ].some((value) => value !== null && value.toLowerCase().includes(needle))
}
