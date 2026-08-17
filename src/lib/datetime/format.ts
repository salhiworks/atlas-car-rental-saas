/**
 * Presentation of dates and times.
 *
 * Everything here takes an explicit time zone and locale. There is deliberately
 * no "format this in the local zone" helper: for a rental agency, the correct
 * zone is the agency's, not whatever the browser happens to be set to.
 */

import { getZonedParts, isValidTimeZone } from './timezone'

export interface DateDisplayOptions {
  readonly locale?: string
  readonly timeZone: string
}

function safeZone(timeZone: string): string {
  return isValidTimeZone(timeZone) ? timeZone : 'UTC'
}

function format(
  instant: Date,
  { locale = 'en', timeZone }: DateDisplayOptions,
  options: Intl.DateTimeFormatOptions,
): string {
  if (Number.isNaN(instant.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: safeZone(timeZone) }).format(
    instant,
  )
}

/** e.g. "14 Mar 2026" */
export function formatDate(instant: Date, options: DateDisplayOptions): string {
  return format(instant, options, { day: '2-digit', month: 'short', year: 'numeric' })
}

/** e.g. "14 Mar 2026, 09:30" */
export function formatDateTime(instant: Date, options: DateDisplayOptions): string {
  return format(instant, options, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** e.g. "09:30" */
export function formatTime(instant: Date, options: DateDisplayOptions): string {
  return format(instant, options, { hour: '2-digit', minute: '2-digit' })
}

/** e.g. "March 2026" — for chart axes and period headings. */
export function formatMonth(instant: Date, options: DateDisplayOptions): string {
  return format(instant, options, { month: 'long', year: 'numeric' })
}

/** e.g. "Mar" — compact chart axis label. */
export function formatMonthShort(instant: Date, options: DateDisplayOptions): string {
  return format(instant, options, { month: 'short' })
}

/**
 * Parses a `date` column (`YYYY-MM-DD`) into the instant of local midnight in
 * the given zone. Postgres `date` values carry no zone, so interpreting them as
 * UTC and rendering them elsewhere is what makes a date display a day early.
 */
export function parseIsoDate(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const [, year, month, day] = match
  // Imported lazily-free: zonedPartsToInstant lives next door.
  return zonedMidnight(Number(year), Number(month), Number(day), timeZone)
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day)
  const zone = safeZone(timeZone)

  const offsetAt = (instant: Date): number => {
    const parts = getZonedParts(instant, zone)
    return (
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
      instant.getTime()
    )
  }

  const first = offsetAt(new Date(naive))
  const candidate = new Date(naive - first)
  const second = offsetAt(candidate)
  return second === first ? candidate : new Date(naive - second)
}

/**
 * Relative wording for compliance horizons: "in 12 days", "3 days ago".
 * Uses whole days as counted from the given zone.
 */
export function formatRelativeDays(days: number, locale = 'en'): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  if (Math.abs(days) >= 60) {
    return formatter.format(Math.trunc(days / 30), 'month')
  }
  return formatter.format(days, 'day')
}
