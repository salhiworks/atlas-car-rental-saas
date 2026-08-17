import type {
  ReportComplianceRow,
  ReportExpenseDimension,
  ReportGpsCoverageRow,
} from '@/types/database'

/**
 * The rules a reporting workspace has to hold to, expressed once.
 *
 * Almost all of it is about two words the product refuses to say loosely:
 *
 *   PROFIT — nothing here computes one. There is no depreciation model, no
 *   overhead allocation to a vehicle, no accounting period. What exists is an
 *   OPERATING RESULT (rental revenue less recorded operating cost) and, per
 *   vehicle, an OPERATING CONTRIBUTION. Both are named that way everywhere.
 *
 *   TOTAL — there is no exchange rate anywhere in this product, so two
 *   currencies never make one number. A report either speaks in one currency or
 *   it shows the currencies side by side and says how many there are.
 */

/** Every monetary figure is scoped to one of these. */
export interface CurrencyScope {
  /** The currency being shown, or null when the agency has none in this period. */
  readonly currency: string | null
  /** Every currency the selected data actually contains. */
  readonly available: readonly string[]
  readonly isMixed: boolean
}

export function resolveCurrencyScope(
  available: readonly string[],
  requested: string | null,
  defaultCurrency: string,
): CurrencyScope {
  const unique = [...new Set(available)].sort()

  if (unique.length === 0) {
    return { currency: null, available: [], isMixed: false }
  }

  /*
   * A requested currency that is not in the data is not an error and not a
   * reason to show nothing — it usually means somebody changed the period. Fall
   * back to the agency's own currency where it is present, and otherwise to the
   * first one there is.
   */
  const chosen =
    requested && unique.includes(requested)
      ? requested
      : unique.includes(defaultCurrency)
        ? defaultCurrency
        : unique[0]!

  return { currency: chosen, available: unique, isMixed: unique.length > 1 }
}

/**
 * A share of a total, or nothing.
 *
 * A percentage of zero is not zero percent, and a percentage of a negative
 * total is arithmetic without a meaning. Both return null so the interface
 * prints a dash rather than a number somebody would read.
 */
export function shareOfTotal(amountMinor: number, totalMinor: number): number | null {
  if (totalMinor <= 0) return null
  return amountMinor / totalMinor
}

export function formatShare(share: number | null, locale: string): string {
  if (share === null) return '—'
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(share)
}

/** Basis points as a percentage. Utilisation, repeat rate, cancellation rate. */
export function formatBps(bps: number | null | undefined, locale: string): string {
  if (bps === null || bps === undefined) return '—'
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(bps / 10_000)
}

export function formatDays(days: number | null | undefined, locale: string): string {
  if (days === null || days === undefined) return '—'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(days)
}

export function formatCount(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat(locale).format(value)
}

/**
 * How a financing cost figure should be read.
 *
 * `incomplete` is the state that matters. It means somebody recorded a payment
 * without saying how much of it was interest, so the cost figure is a floor and
 * the interface has to say "at least". Printing it as a settled number would be
 * the most expensive kind of wrong: a manager comparing lenders on a cost that
 * is missing an unknown amount.
 */
export type CostCompleteness = 'complete' | 'incomplete'

export function costCompleteness(complete: boolean): CostCompleteness {
  return complete ? 'complete' : 'incomplete'
}

export const COST_INCOMPLETE_NOTE =
  'Some payments were recorded without stating how much was interest, so this is at least the figure shown.'

/**
 * What a report may claim about tracking.
 *
 * The GPS module refreshes while somebody has its workspace open and there is
 * no scheduler on this deployment, so nothing is collected overnight. That
 * makes every tracking figure a snapshot: there is no uptime, no average
 * position age for a month, and no count of vehicles that went offline last
 * night, because none of it was ever recorded.
 */
export const GPS_SNAPSHOT_NOTE =
  'Tracking figures are a snapshot taken when this report loaded. Positions refresh while somebody has the tracking workspace open — nothing is collected overnight, so there is no history to report.'

export function trackedShare(coverage: ReportGpsCoverageRow | null): number | null {
  if (!coverage) return null
  const total = Number(coverage.vehicles_total)
  if (total <= 0) return null
  return Number(coverage.vehicles_tracked) / total
}

export const COMPLIANCE_LABELS: Readonly<Record<ReportComplianceRow['document_kind'], string>> = {
  insurance: 'Insurance',
  inspection: 'Inspection',
  registration: 'Registration',
}

/**
 * Compliance needing action.
 *
 * An unrecorded date is a data gap, not a breach — a vehicle whose insurance
 * expiry nobody has typed in is not a vehicle driving uninsured, and folding the
 * two together would turn a filing habit into an alarm. It is counted, shown,
 * and kept out of this number.
 */
export function complianceNeedingAttention(rows: readonly ReportComplianceRow[]): number {
  return rows.reduce((sum, row) => sum + Number(row.expired) + Number(row.due_soon), 0)
}

/** Sections of the workspace. One page, not seven products. */
export const REPORT_SECTIONS = [
  { key: 'business', label: 'Business' },
  { key: 'fleet', label: 'Fleet' },
  { key: 'rentals', label: 'Rentals' },
  { key: 'customers', label: 'Customers' },
  { key: 'costs', label: 'Costs' },
  { key: 'financing', label: 'Financing' },
  { key: 'tracking', label: 'Tracking' },
] as const

export type ReportSection = (typeof REPORT_SECTIONS)[number]['key']

export function isReportSection(value: string): value is ReportSection {
  return REPORT_SECTIONS.some((section) => section.key === value)
}

/** Vehicle rankings. Financial ones are only ever ranked inside one currency. */
export const FLEET_SORTS = {
  revenue: { label: 'Highest revenue', monetary: true },
  contribution: { label: 'Highest contribution', monetary: true },
  utilisation: { label: 'Highest utilisation', monetary: false },
  idle: { label: 'Lowest utilisation', monetary: false },
  cost: { label: 'Highest direct cost', monetary: true },
  hires: { label: 'Most hires', monetary: false },
} as const

export type FleetSort = keyof typeof FLEET_SORTS

export function isFleetSort(value: string): value is FleetSort {
  return value in FLEET_SORTS
}

/**
 * Cost breakdown dimensions the database accepts.
 *
 * Validated rather than cast: the value comes from the URL, and a colleague
 * guessing `?by=supplier` from the on-screen label "By supplier" would otherwise
 * send the database a breakdown it refuses — which the interface then rendered
 * as "no costs recorded in this period" for a month with six figures of spend.
 */
export function isExpenseDimension(value: string): value is ReportExpenseDimension {
  return value === 'category' || value === 'vendor' || value === 'allocation'
}
