import {
  addMonthsInTimeZone,
  getZonedParts,
  startOfMonthInTimeZone,
  toIsoDateInTimeZone,
  zonedPartsToInstant,
} from '@/lib/datetime/timezone'

export type PeriodKey = 'this-month' | 'last-month' | 'last-3-months' | 'this-year'

export type SeriesGranularity = 'day' | 'week' | 'month'

export interface ResolvedPeriod {
  readonly key: PeriodKey
  readonly label: string
  /** Inclusive start of the window. */
  readonly from: Date
  /** Exclusive end of the window. */
  readonly to: Date
  readonly granularity: SeriesGranularity
}

export const PERIOD_OPTIONS: readonly { value: PeriodKey; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'last-3-months', label: 'Last 3 months' },
  { value: 'this-year', label: 'This year' },
]

export function isPeriodKey(value: string): value is PeriodKey {
  return PERIOD_OPTIONS.some((option) => option.value === value)
}

function startOfYear(instant: Date, timeZone: string): Date {
  const parts = getZonedParts(instant, timeZone)
  return zonedPartsToInstant(
    { year: parts.year, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  )
}

/**
 * Turns a period choice into an instant range in the agency's own time zone.
 *
 * "This month" has to mean the month as the agency reckons it — a Casablanca
 * agency's month does not begin when a UTC clock says so, and a dashboard that
 * quietly used UTC boundaries would misplace every transaction near midnight.
 */
export function resolvePeriod(
  key: PeriodKey,
  timeZone: string,
  now: Date = new Date(),
): ResolvedPeriod {
  const monthStart = startOfMonthInTimeZone(now, timeZone)

  switch (key) {
    case 'this-month':
      return {
        key,
        label: 'This month',
        from: monthStart,
        to: addMonthsInTimeZone(monthStart, timeZone, 1),
        granularity: 'day',
      }
    case 'last-month': {
      const from = addMonthsInTimeZone(monthStart, timeZone, -1)
      return { key, label: 'Last month', from, to: monthStart, granularity: 'day' }
    }
    case 'last-3-months':
      return {
        key,
        label: 'Last 3 months',
        from: addMonthsInTimeZone(monthStart, timeZone, -2),
        to: addMonthsInTimeZone(monthStart, timeZone, 1),
        granularity: 'month',
      }
    case 'this-year': {
      const from = startOfYear(now, timeZone)
      return {
        key,
        label: 'This year',
        from,
        to: addMonthsInTimeZone(from, timeZone, 12),
        granularity: 'month',
      }
    }
  }
}

/** The `date` bounds the series function expects, resolved in the agency zone. */
export function periodToDateRange(
  period: ResolvedPeriod,
  timeZone: string,
): { from: string; to: string } {
  return {
    from: toIsoDateInTimeZone(period.from, timeZone),
    to: toIsoDateInTimeZone(period.to, timeZone),
  }
}
