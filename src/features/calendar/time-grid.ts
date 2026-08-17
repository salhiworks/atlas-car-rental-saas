import {
  addDaysInTimeZone,
  getZonedParts,
  startOfDayInTimeZone,
  toIsoDateInTimeZone,
  zonedPartsToInstant,
} from '@/lib/datetime/timezone'

/**
 * The scheduler's geometry, in one place.
 *
 * Every position on the timeline — a rental block, a day boundary, the "now"
 * marker, the instant under a drag — is computed here. Nothing else in the
 * Calendar does date arithmetic, because the moment two components each work
 * out "where does 14:00 sit" they will eventually disagree by an hour, twice a
 * year, in a way nobody notices until a customer arrives at the wrong time.
 *
 * WHY A DAY IS NOT 86 400 000 MILLISECONDS HERE
 *
 * On the day the clocks change, an agency-local day is 23 or 25 hours long.
 * Positioning by elapsed milliseconds across the whole window would smear that
 * hour across every column, so day gridlines would drift away from the day
 * labels above them and a rental would render in the wrong column.
 *
 * Instead the grid is built from real agency-local day boundaries and every
 * position is `(dayIndex + fractionThroughThatDay) / dayCount`. Each day gets
 * an equal share of the width — which is what a fleet board should show, since
 * a day is a day — and the hour inside it is interpolated against that day's
 * actual length. A 23-hour Sunday is simply a day whose hours are very slightly
 * wider apart, and nothing lands in the wrong column.
 */

export interface GridDay {
  /** Instant of agency-local midnight opening this day. */
  readonly start: Date
  /** Instant of agency-local midnight opening the next day. */
  readonly end: Date
  readonly isoDate: string
  readonly weekday: number
  readonly isWeekend: boolean
  readonly isToday: boolean
  /** 23 or 25 on the days the clocks change; 24 otherwise. */
  readonly hours: number
}

export interface TimeGrid {
  readonly timeZone: string
  readonly start: Date
  readonly end: Date
  readonly days: readonly GridDay[]
  /** Hour marks per day column, or 0 where the scale is too coarse for them. */
  readonly hourStep: number
}

export interface Placement {
  /** Percentage from the left edge of the grid. */
  readonly leftPct: number
  readonly widthPct: number
  /** True when the interval begins before the window and has been clipped. */
  readonly clippedStart: boolean
  readonly clippedEnd: boolean
}

const MS_PER_HOUR = 3_600_000

/**
 * How many hour marks a day column can carry before they become noise.
 * A month of columns has room for none; a single day has room for every hour.
 */
function hourStepForDayCount(dayCount: number): number {
  if (dayCount <= 1) return 1
  if (dayCount <= 3) return 3
  if (dayCount <= 7) return 6
  if (dayCount <= 14) return 12
  return 0
}

export function buildTimeGrid(
  start: Date,
  dayCount: number,
  timeZone: string,
  now: Date,
): TimeGrid {
  const first = startOfDayInTimeZone(start, timeZone)
  const todayIso = toIsoDateInTimeZone(now, timeZone)

  const days: GridDay[] = []

  for (let index = 0; index < dayCount; index += 1) {
    // Each boundary is re-anchored to its own local midnight rather than
    // carried forward from the previous one. Accumulating would propagate a
    // single odd boundary through the rest of the window: in a zone that moves
    // its clocks at midnight the start of that day is 01:00, and every later
    // column would then have started at 01:00 too and been labelled wrongly.
    const cursor = startOfDayInTimeZone(addDaysInTimeZone(first, timeZone, index), timeZone)
    const next = startOfDayInTimeZone(addDaysInTimeZone(first, timeZone, index + 1), timeZone)
    const parts = getZonedParts(cursor, timeZone)
    // Weekday from the local calendar date, so it is the agency's Saturday and
    // not the browser's.
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
    const isoDate = toIsoDateInTimeZone(cursor, timeZone)

    days.push({
      start: cursor,
      end: next,
      isoDate,
      weekday,
      isWeekend: weekday === 0 || weekday === 6,
      isToday: isoDate === todayIso,
      hours: Math.round((next.getTime() - cursor.getTime()) / MS_PER_HOUR),
    })
  }

  return {
    timeZone,
    start: first,
    end: startOfDayInTimeZone(addDaysInTimeZone(first, timeZone, dayCount), timeZone),
    days,
    hourStep: hourStepForDayCount(dayCount),
  }
}

/**
 * Where an instant sits across the grid, as a fraction from 0 to 1.
 *
 * Outside the window it returns a value beyond that range rather than clamping,
 * so callers can tell "before the window" from "at the very start of it".
 */
export function fractionForInstant(grid: TimeGrid, instant: Date): number {
  const dayCount = grid.days.length
  if (dayCount === 0) return 0

  const time = instant.getTime()
  if (time <= grid.start.getTime()) {
    const firstDay = grid.days[0]!
    return (
      (time - firstDay.start.getTime()) /
      (firstDay.end.getTime() - firstDay.start.getTime()) /
      dayCount
    )
  }
  if (time >= grid.end.getTime()) {
    const lastDay = grid.days[dayCount - 1]!
    const overshoot =
      (time - lastDay.start.getTime()) / (lastDay.end.getTime() - lastDay.start.getTime())
    return (dayCount - 1 + overshoot) / dayCount
  }

  for (let index = 0; index < dayCount; index += 1) {
    const day = grid.days[index]!
    if (time < day.end.getTime()) {
      const through = (time - day.start.getTime()) / (day.end.getTime() - day.start.getTime())
      return (index + through) / dayCount
    }
  }

  return 1
}

/** The instant a fraction of the way across the grid denotes. */
export function instantForFraction(grid: TimeGrid, fraction: number): Date {
  const dayCount = grid.days.length
  if (dayCount === 0) return grid.start

  const scaled = fraction * dayCount
  const index = Math.min(dayCount - 1, Math.max(0, Math.floor(scaled)))
  const day = grid.days[index]!
  const through = Math.min(1, Math.max(0, scaled - index))

  return new Date(day.start.getTime() + through * (day.end.getTime() - day.start.getTime()))
}

/**
 * Places an interval on the grid.
 *
 * Returns null only when the interval does not touch the window at all. A
 * rental that starts before the window and ends inside it — or spans the whole
 * window — is clipped and flagged, never dropped: the desk needs to see that
 * the car is already out even when the hire began last month.
 */
export function placeInterval(grid: TimeGrid, startsAt: Date, endsAt: Date): Placement | null {
  const windowStart = grid.start.getTime()
  const windowEnd = grid.end.getTime()
  const from = startsAt.getTime()
  const to = endsAt.getTime()

  // Half-open, matching rentals_no_vehicle_overlap: a booking ending exactly as
  // the window opens does not appear in it, and one starting exactly as the
  // window closes belongs to the next window.
  if (to <= windowStart || from >= windowEnd) return null

  const clippedStart = from < windowStart
  const clippedEnd = to > windowEnd

  const left = clippedStart ? 0 : fractionForInstant(grid, startsAt)
  const right = clippedEnd ? 1 : fractionForInstant(grid, endsAt)

  return {
    leftPct: left * 100,
    widthPct: Math.max(0, right - left) * 100,
    clippedStart,
    clippedEnd,
  }
}

/**
 * Rounds an instant to the nearest step of agency-local wall time.
 *
 * Snapping in UTC would put a drag on the half hour in a zone offset by
 * forty-five minutes — India, Nepal, the Chatham Islands — so the rounding is
 * done on the local reading and converted back.
 */
export function snapInstant(instant: Date, timeZone: string, stepMinutes: number): Date {
  if (stepMinutes <= 0) return instant

  const parts = getZonedParts(instant, timeZone)
  const minutesOfDay = parts.hour * 60 + parts.minute + parts.second / 60
  const snapped = Math.round(minutesOfDay / stepMinutes) * stepMinutes

  return zonedPartsToInstant(
    {
      ...parts,
      hour: Math.floor(snapped / 60),
      minute: snapped % 60,
      second: 0,
    },
    timeZone,
  )
}

/** How fine a drag should snap, given how much time one screen covers. */
export function snapStepForGrid(grid: TimeGrid): number {
  const dayCount = grid.days.length
  if (dayCount <= 1) return 15
  if (dayCount <= 3) return 30
  if (dayCount <= 14) return 60
  // Beyond a fortnight a pixel is worth hours, so a drag sets the day and keeps
  // the time of day it already had.
  return 0
}

/**
 * Moves an interval by a number of milliseconds, keeping its agency-local time
 * of day.
 *
 * Shifting by raw milliseconds across a clock change would move a 09:00
 * collection to 08:00 or 10:00. Whole-day moves therefore go through the local
 * calendar; sub-day moves are genuine time changes and stay in elapsed time.
 */
export function shiftInterval(
  startsAt: Date,
  endsAt: Date,
  deltaMs: number,
  timeZone: string,
  { wholeDays }: { wholeDays: boolean },
): { startsAt: Date; endsAt: Date } {
  if (!wholeDays) {
    return {
      startsAt: new Date(startsAt.getTime() + deltaMs),
      endsAt: new Date(endsAt.getTime() + deltaMs),
    }
  }

  const days = Math.round(deltaMs / 86_400_000)
  return {
    startsAt: addDaysInTimeZone(startsAt, timeZone, days),
    endsAt: addDaysInTimeZone(endsAt, timeZone, days),
  }
}
