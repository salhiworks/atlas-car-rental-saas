import {
  addDaysInTimeZone,
  addMonthsInTimeZone,
  countDaysInTimeZone,
  getZonedParts,
  startOfDayInTimeZone,
  startOfMonthInTimeZone,
  toIsoDateInTimeZone,
  zonedPartsToInstant,
} from '@/lib/datetime/timezone'

/**
 * One period model, used by every report.
 *
 * Seven presets and a custom range, which is the number a person can scan. The
 * temptation in a reporting workspace is to offer twenty windows; what that
 * actually produces is a control nobody reads and two colleagues comparing
 * figures from ranges neither of them chose deliberately.
 *
 * EVERY BOUNDARY IS THE AGENCY'S, NOT THE BROWSER'S. "This month" for an agency
 * in Casablanca does not begin when a laptop set to UTC says it does, and a
 * report that used the browser's midnight would move every transaction taken
 * near it into the wrong month. The zone comes from the organization record and
 * is threaded through every function here.
 *
 * The window is half-open — `[from, to)` — matching every read model in the
 * product. A month ends at the first instant of the next one, never at
 * 23:59:59, which is the classic way to lose a payment.
 */

export type ReportPeriodKey =
  | 'this-month'
  | 'last-month'
  | 'last-30-days'
  | 'this-quarter'
  | 'last-quarter'
  | 'this-year'
  | 'custom'

export type ReportGranularity = 'day' | 'week' | 'month'

export interface ReportPeriod {
  readonly key: ReportPeriodKey
  readonly label: string
  /** Inclusive start. */
  readonly from: Date
  /** Exclusive end. */
  readonly to: Date
  /** Whole days in the window, in the agency's zone. */
  readonly days: number
  readonly granularity: ReportGranularity
  /**
   * True when the requested range was longer than the report can resolve and
   * was shortened. The interface has to say so — a silently truncated window
   * shows six years of missing revenue beside dates that claim to include it.
   */
  readonly truncated: boolean
  /** The last day inside the window, for a date picker that reads inclusively. */
  readonly inclusiveEnd: Date
}

export const REPORT_PERIODS: readonly { value: ReportPeriodKey; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-30-days', label: 'Last 30 days' },
  { value: 'this-quarter', label: 'This quarter' },
  { value: 'last-quarter', label: 'Last quarter' },
  { value: 'this-year', label: 'This year' },
  { value: 'custom', label: 'Custom range' },
]

export function isReportPeriodKey(value: string): value is ReportPeriodKey {
  return REPORT_PERIODS.some((option) => option.value === value)
}

function startOfYear(instant: Date, timeZone: string): Date {
  const parts = getZonedParts(instant, timeZone)
  return zonedPartsToInstant(
    { year: parts.year, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  )
}

function startOfQuarter(instant: Date, timeZone: string): Date {
  const parts = getZonedParts(instant, timeZone)
  const firstMonth = Math.floor((parts.month - 1) / 3) * 3 + 1
  return zonedPartsToInstant(
    { year: parts.year, month: firstMonth, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  )
}

/**
 * Granularity that keeps a chart readable.
 *
 * A three-year window at daily resolution is eleven hundred bars, which is a
 * texture rather than a chart and takes a second to lay out. The rule is one
 * place so every chart in the workspace buckets the same way and two reports of
 * the same period never disagree about what a point means.
 */
export function granularityForSpan(days: number): ReportGranularity {
  if (days <= 62) return 'day'
  if (days <= 200) return 'week'
  return 'month'
}

export interface CustomRange {
  /** ISO `YYYY-MM-DD`, inclusive. */
  readonly from: string
  /** ISO `YYYY-MM-DD`, inclusive — the last day the user picked. */
  readonly to: string
}

/** The longest window a report will resolve. Beyond it the buckets are useless. */
export const MAX_CUSTOM_DAYS = 1830

export function resolveReportPeriod(
  key: ReportPeriodKey,
  timeZone: string,
  now: Date,
  custom?: CustomRange | null,
): ReportPeriod {
  const monthStart = startOfMonthInTimeZone(now, timeZone)

  const build = (label: string, from: Date, to: Date, truncated = false): ReportPeriod => {
    const days = Math.max(1, countDaysInTimeZone(from, to, timeZone))
    return {
      key,
      label,
      from,
      to,
      days,
      granularity: granularityForSpan(days),
      truncated,
      inclusiveEnd: addDaysInTimeZone(to, timeZone, -1),
    }
  }

  switch (key) {
    case 'this-month':
      return build('This month', monthStart, addMonthsInTimeZone(monthStart, timeZone, 1))
    case 'last-month':
      return build('Last month', addMonthsInTimeZone(monthStart, timeZone, -1), monthStart)
    case 'last-30-days': {
      // Ends at the start of tomorrow, so today's activity is inside the window.
      const to = addDaysInTimeZone(startOfDayInTimeZone(now, timeZone), timeZone, 1)
      return build('Last 30 days', addDaysInTimeZone(to, timeZone, -30), to)
    }
    case 'this-quarter': {
      const from = startOfQuarter(now, timeZone)
      return build('This quarter', from, addMonthsInTimeZone(from, timeZone, 3))
    }
    case 'last-quarter': {
      const currentQuarter = startOfQuarter(now, timeZone)
      const from = addMonthsInTimeZone(currentQuarter, timeZone, -3)
      return build('Last quarter', from, currentQuarter)
    }
    case 'this-year': {
      const from = startOfYear(now, timeZone)
      return build('This year', from, addMonthsInTimeZone(from, timeZone, 12))
    }
    case 'custom': {
      const fallback = resolveReportPeriod('this-month', timeZone, now)
      if (!custom) return { ...fallback, key: 'custom', label: 'Custom range' }

      const from = isoToInstant(custom.from, timeZone)
      const inclusiveEnd = isoToInstant(custom.to, timeZone)
      if (!from || !inclusiveEnd) return { ...fallback, key: 'custom', label: 'Custom range' }

      // The picker's end date is the last day somebody wants to see, so the
      // exclusive bound is the day after it.
      const to = addDaysInTimeZone(inclusiveEnd, timeZone, 1)
      if (to <= from) return { ...fallback, key: 'custom', label: 'Custom range' }

      const days = countDaysInTimeZone(from, to, timeZone)
      if (days > MAX_CUSTOM_DAYS) {
        // Shortened, and said so. A window that quietly stops five years early
        // shows figures the dates beside them claim to include.
        const capped = addDaysInTimeZone(from, timeZone, MAX_CUSTOM_DAYS)
        return build('Custom range', from, capped, true)
      }

      return build('Custom range', from, to)
    }
  }
}

/** Parses `YYYY-MM-DD` as the first instant of that day in the agency's zone. */
export function isoToInstant(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const instant = zonedPartsToInstant({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone)
  // Rejects 31 February and friends, which the constructor would roll forward.
  const parts = getZonedParts(instant, timeZone)
  if (parts.year !== year || parts.month !== month || parts.day !== day) return null
  return instant
}

/** The `date` bounds every report function takes, resolved in the agency zone. */
export function periodBounds(period: ReportPeriod, timeZone: string): { from: string; to: string } {
  return {
    from: toIsoDateInTimeZone(period.from, timeZone),
    to: toIsoDateInTimeZone(period.to, timeZone),
  }
}

/**
 * The window immediately before this one, of the same length.
 *
 * Length in days, not "the previous calendar month" — a twenty-day custom range
 * compares against the preceding twenty days, and a comparison between a
 * 28-day February and a 31-day January is arithmetic nobody asked for. For the
 * calendar presets the two definitions coincide anyway, because the preceding
 * window of the same length IS the previous month for a full month.
 */
export function previousPeriod(period: ReportPeriod, timeZone: string): ReportPeriod {
  if (period.key === 'this-month' || period.key === 'last-month') {
    const from = addMonthsInTimeZone(period.from, timeZone, -1)
    return {
      ...period,
      label: 'Previous month',
      from,
      to: period.from,
      days: Math.max(1, countDaysInTimeZone(from, period.from, timeZone)),
    }
  }

  if (period.key === 'this-quarter' || period.key === 'last-quarter') {
    const from = addMonthsInTimeZone(period.from, timeZone, -3)
    return {
      ...period,
      label: 'Previous quarter',
      from,
      to: period.from,
      days: Math.max(1, countDaysInTimeZone(from, period.from, timeZone)),
    }
  }

  if (period.key === 'this-year') {
    const from = addMonthsInTimeZone(period.from, timeZone, -12)
    return {
      ...period,
      label: 'Previous year',
      from,
      to: period.from,
      days: Math.max(1, countDaysInTimeZone(from, period.from, timeZone)),
    }
  }

  const from = addDaysInTimeZone(period.from, timeZone, -period.days)
  return {
    ...period,
    label: `Previous ${period.days} days`,
    from,
    to: period.from,
    days: period.days,
  }
}

/**
 * How a figure moved, when the comparison means anything.
 *
 * A previous period of zero has no percentage — the answer is not infinity and
 * it is certainly not "+100%". It is that there is nothing to compare against,
 * and the interface says so in words.
 */
export type ChangeState = 'up' | 'down' | 'flat' | 'new' | 'no-baseline' | 'ended'

export interface Change {
  readonly state: ChangeState
  /** Absolute difference in minor units, or in whole units for counts. */
  readonly delta: number
  /** Basis points, only when a proportional change is meaningful. */
  readonly bps: number | null
  readonly label: string
}

export function compareValues(current: number, previous: number): Change {
  const delta = current - previous

  if (previous === 0 && current === 0) {
    return { state: 'flat', delta: 0, bps: null, label: 'No change' }
  }

  if (previous === 0) {
    // Something from nothing. A percentage here would be a division by zero
    // dressed up as insight.
    return { state: 'new', delta, bps: null, label: 'New activity' }
  }

  if (current === 0) {
    return { state: 'ended', delta, bps: null, label: 'None this period' }
  }

  // A sign change makes a percentage meaningless: -200 to +100 is not "+150%"
  // of anything a person can act on.
  if (previous < 0 !== current < 0) {
    return {
      state: current > previous ? 'up' : 'down',
      delta,
      bps: null,
      label: current > previous ? 'Turned positive' : 'Turned negative',
    }
  }

  const bps = Math.round((delta / Math.abs(previous)) * 10_000)
  if (bps === 0) return { state: 'flat', delta, bps: 0, label: 'No change' }

  return {
    state: bps > 0 ? 'up' : 'down',
    delta,
    bps,
    label: `${bps > 0 ? '+' : ''}${(bps / 100).toFixed(1)}%`,
  }
}
