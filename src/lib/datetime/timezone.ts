/**
 * Time zone aware date handling.
 *
 * A rental starts and ends at a wall-clock time in the agency's own zone. The
 * database stores instants (`timestamptz`); the interface shows and collects
 * wall-clock time. Everything that crosses that boundary goes through this
 * module, so `new Date(...)` never has to be trusted to mean the right thing in
 * a component.
 *
 * Built on Intl, which carries the IANA database the platform already ships —
 * no dependency, and no second copy of tzdata to keep current.
 */

export interface ZonedDateParts {
  readonly year: number
  readonly month: number // 1-12
  readonly day: number // 1-31
  readonly hour: number // 0-23
  readonly minute: number
  readonly second: number
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`Unknown time zone: ${timeZone}`)
    this.name = 'InvalidTimeZoneError'
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Every IANA zone the platform knows, for settings pickers. */
export function listTimeZones(): string[] {
  const supported = Intl.supportedValuesOf?.('timeZone')
  if (supported && supported.length > 0) return [...supported]
  return ['UTC']
}

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatterCache.get(timeZone)
  if (cached) return cached

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new InvalidTimeZoneError(timeZone)
  }

  partsFormatterCache.set(timeZone, formatter)
  return formatter
}

/** The wall-clock reading a given instant produces in a given zone. */
export function getZonedParts(instant: Date, timeZone: string): ZonedDateParts {
  const parts = getPartsFormatter(timeZone).formatToParts(instant)
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value
    return value === undefined ? 0 : Number(value)
  }

  // Some implementations render midnight as hour 24 under h23; normalise it.
  const hour = lookup('hour')

  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: hour === 24 ? 0 : hour,
    minute: lookup('minute'),
    second: lookup('second'),
  }
}

function partsToPseudoUtc(parts: ZonedDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

/**
 * The zone's UTC offset, in milliseconds, at a given instant.
 * Positive east of Greenwich. Accounts for daylight saving.
 */
export function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  return partsToPseudoUtc(getZonedParts(instant, timeZone)) - instant.getTime()
}

/**
 * Converts a wall-clock reading in a zone to the instant it denotes.
 *
 * Two candidate instants are produced: one using the offset in force at the
 * naive timestamp, one using the offset in force at that first guess. Whichever
 * of them actually reads back as the requested wall time is the answer, and on
 * an ordinary day both agree.
 *
 * On the two days a year the clocks move, they do not:
 *
 *   SPRING FORWARD — the wall time never happens. Both candidates read back as
 *   something else, and the later one is taken, so the reading lands just after
 *   the transition. This is what booking systems and the iCalendar rules do,
 *   and it is the only choice that keeps a date where it belongs: in zones that
 *   move the clocks at midnight — Havana, Santiago — taking the earlier
 *   candidate put "the start of the 12th" at 23:00 on the 11th, which silently
 *   moved a whole day column on the schedule and shifted every day-boundary
 *   query with it.
 *
 *   FALL BACK — the wall time happens twice. The first occurrence is taken,
 *   which is the convention everywhere and the one a customer means when they
 *   say they will collect the car at half past one.
 */
export function zonedPartsToInstant(parts: ZonedDateParts, timeZone: string): Date {
  const naive = partsToPseudoUtc(parts)

  // The offsets in force on either side of the reading. Twelve hours is well
  // clear of any real transition (the largest is an hour) while staying inside
  // the same day, so these two are the only offsets the reading can have.
  const HALF_DAY = 43_200_000
  const before = getTimeZoneOffsetMs(new Date(naive - HALF_DAY), timeZone)
  const after = getTimeZoneOffsetMs(new Date(naive + HALF_DAY), timeZone)

  const candidates = [new Date(naive - before), new Date(naive - after)].sort(
    (a, b) => a.getTime() - b.getTime(),
  )

  const readsBack = (candidate: Date): boolean =>
    partsToPseudoUtc(getZonedParts(candidate, timeZone)) === naive

  const valid = candidates.filter(readsBack)

  // Ambiguous readings give two valid candidates; the earliest is the first
  // occurrence. A gap gives none, and the latest lands just after the jump.
  return valid[0] ?? candidates[candidates.length - 1]!
}

/** Midnight, in the given zone, on the day containing `instant`. */
export function startOfDayInTimeZone(instant: Date, timeZone: string): Date {
  const parts = getZonedParts(instant, timeZone)
  return zonedPartsToInstant({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone)
}

/** Midnight, in the given zone, on the first day of the containing month. */
export function startOfMonthInTimeZone(instant: Date, timeZone: string): Date {
  const parts = getZonedParts(instant, timeZone)
  return zonedPartsToInstant({ ...parts, day: 1, hour: 0, minute: 0, second: 0 }, timeZone)
}

/** Midnight, in the given zone, on the first day of the month `count` months away. */
export function addMonthsInTimeZone(instant: Date, timeZone: string, count: number): Date {
  const parts = getZonedParts(instant, timeZone)
  const zeroBased = parts.month - 1 + count
  const year = parts.year + Math.floor(zeroBased / 12)
  const month = ((zeroBased % 12) + 12) % 12

  // Clamp so that 31 January + 1 month lands on 28/29 February rather than
  // silently rolling into March.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

  return zonedPartsToInstant(
    { ...parts, year, month: month + 1, day: Math.min(parts.day, lastDay) },
    timeZone,
  )
}

export function addDaysInTimeZone(instant: Date, timeZone: string, count: number): Date {
  const parts = getZonedParts(instant, timeZone)
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + count))
  return zonedPartsToInstant(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second,
    },
    timeZone,
  )
}

/**
 * Whole days between two instants as counted in the agency's zone.
 * Rental pricing counts calendar days, not 24-hour blocks.
 */
export function countDaysInTimeZone(from: Date, to: Date, timeZone: string): number {
  const fromMidnight = startOfDayInTimeZone(from, timeZone)
  const toMidnight = startOfDayInTimeZone(to, timeZone)
  return Math.round((toMidnight.getTime() - fromMidnight.getTime()) / 86_400_000)
}

/** ISO date (`YYYY-MM-DD`) for an instant, as read in the given zone. */
export function toIsoDateInTimeZone(instant: Date, timeZone: string): string {
  const { year, month, day } = getZonedParts(instant, timeZone)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Value for an `<input type="datetime-local">`, expressed in the agency's zone. */
export function toDateTimeLocalValue(instant: Date, timeZone: string): string {
  const { hour, minute } = getZonedParts(instant, timeZone)
  return `${toIsoDateInTimeZone(instant, timeZone)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Reads an `<input type="datetime-local">` value as a wall time in the agency's zone. */
export function fromDateTimeLocalValue(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) return null

  const [, year, month, day, hour, minute, second] = match
  const parts: ZonedDateParts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: second ? Number(second) : 0,
  }

  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null

  return zonedPartsToInstant(parts, timeZone)
}
