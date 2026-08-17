import {
  addDaysInTimeZone,
  addMonthsInTimeZone,
  getZonedParts,
  startOfDayInTimeZone,
  startOfMonthInTimeZone,
  toIsoDateInTimeZone,
  zonedPartsToInstant,
} from '@/lib/datetime/timezone'

/**
 * What the timeline is looking at, and how you move it.
 *
 * Four spans, each earning its place at a rental desk rather than filling out a
 * menu:
 *
 *   Day        the counter's own day, at hour resolution — who collects at 09:00
 *              and who is due back at 18:00.
 *   Week       the planning horizon almost every scheduling question is asked in.
 *   Fortnight  long enough to see turnarounds and the shape of the coming weeks.
 *   Month      "is this car free the weekend after next", and how busy the
 *              month is overall.
 *
 * Three days was considered and dropped: it sits between Day and Week without
 * answering a question neither of them answers.
 *
 * Every boundary is agency-local. A week starts on whichever weekday the agency
 * set in its own settings, and "today" is the agency's today.
 */

export const CALENDAR_VIEWS = ['day', 'week', 'fortnight', 'month'] as const
export type CalendarView = (typeof CALENDAR_VIEWS)[number]

export const CALENDAR_VIEW_LABELS: Readonly<Record<CalendarView, string>> = {
  day: 'Day',
  week: 'Week',
  fortnight: '2 weeks',
  month: 'Month',
}

export function isCalendarView(value: string): value is CalendarView {
  return (CALENDAR_VIEWS as readonly string[]).includes(value)
}

export interface CalendarRange {
  readonly view: CalendarView
  /** Instant of agency-local midnight opening the window. */
  readonly start: Date
  /** Instant of agency-local midnight closing it — exclusive, matching the schema. */
  readonly end: Date
  readonly dayCount: number
  /** The date the window is anchored on, for the URL. */
  readonly anchorIso: string
}

function daysInMonth(anchor: Date, timeZone: string): number {
  const first = startOfMonthInTimeZone(anchor, timeZone)
  const next = addMonthsInTimeZone(first, timeZone, 1)
  // Counted from the local calendar, so a clock change inside the month cannot
  // make February look 27.96 days long.
  const firstParts = getZonedParts(first, timeZone)
  const nextParts = getZonedParts(next, timeZone)
  return Math.round(
    (Date.UTC(nextParts.year, nextParts.month - 1, nextParts.day) -
      Date.UTC(firstParts.year, firstParts.month - 1, firstParts.day)) /
      86_400_000,
  )
}

/**
 * Midnight on the first day of the week containing `anchor`.
 *
 * `firstDayOfWeek` is the agency's own setting — 0 for Sunday through 6 for
 * Saturday — because a Monday-first board is wrong in half the world and a
 * Sunday-first board is wrong in the other half.
 */
export function startOfWeekInTimeZone(
  anchor: Date,
  timeZone: string,
  firstDayOfWeek: number,
): Date {
  const parts = getZonedParts(anchor, timeZone)
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  const normalised = ((firstDayOfWeek % 7) + 7) % 7
  const back = (weekday - normalised + 7) % 7
  return startOfDayInTimeZone(addDaysInTimeZone(anchor, timeZone, -back), timeZone)
}

export function buildRange(
  view: CalendarView,
  anchor: Date,
  timeZone: string,
  firstDayOfWeek: number,
): CalendarRange {
  let start: Date
  let dayCount: number

  switch (view) {
    case 'day':
      start = startOfDayInTimeZone(anchor, timeZone)
      dayCount = 1
      break
    case 'week':
      start = startOfWeekInTimeZone(anchor, timeZone, firstDayOfWeek)
      dayCount = 7
      break
    case 'fortnight':
      start = startOfWeekInTimeZone(anchor, timeZone, firstDayOfWeek)
      dayCount = 14
      break
    case 'month':
      start = startOfMonthInTimeZone(anchor, timeZone)
      dayCount = daysInMonth(anchor, timeZone)
      break
  }

  return {
    view,
    start,
    end: addDaysInTimeZone(start, timeZone, dayCount),
    dayCount,
    anchorIso: toIsoDateInTimeZone(start, timeZone),
  }
}

/** The anchor for the window one step earlier or later. */
export function stepRange(range: CalendarRange, timeZone: string, direction: -1 | 1): Date {
  if (range.view === 'month') {
    return addMonthsInTimeZone(range.start, timeZone, direction)
  }
  return addDaysInTimeZone(range.start, timeZone, direction * range.dayCount)
}

/** Reads an agency-local `YYYY-MM-DD` from the URL back into an instant. */
export function anchorFromIso(value: string | null, timeZone: string, fallback: Date): Date {
  if (!value) return fallback

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return fallback

  const [, year, month, day] = match
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: 0,
    minute: 0,
    second: 0,
  }
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return fallback

  const instant = zonedPartsToInstant(parts, timeZone)
  return Number.isNaN(instant.getTime()) ? fallback : instant
}

/**
 * The window widened by a day at each end.
 *
 * The query asks for slightly more than the screen shows so that a booking
 * touching the very edge is fetched, and so stepping one day does not always
 * mean a fresh round trip.
 */
export function queryWindow(range: CalendarRange, timeZone: string): { from: string; to: string } {
  return {
    from: addDaysInTimeZone(range.start, timeZone, -1).toISOString(),
    to: addDaysInTimeZone(range.end, timeZone, 1).toISOString(),
  }
}
