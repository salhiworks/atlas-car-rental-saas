import { assertSafeMinor } from '@/lib/money/money'
import type { RentalChargeKind, RentalLineItem } from '@/types/database'

/**
 * Rental pricing.
 *
 * Everything here mirrors what the database does, so the desk sees the same
 * numbers before saving that the contract will carry afterwards. The database
 * remains the authority: `app.recalculate_rental_totals()` recomputes on every
 * line-item change, and these functions exist so the quote on screen is not a
 * guess.
 */

// -----------------------------------------------------------------------------
// Days
// -----------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Chargeable days for a period.
 *
 * Counted from elapsed time rather than calendar dates. A hire from Friday 18:00
 * to Sunday 10:00 is two days in every country; subtracting local dates would
 * make it two in one time zone and three in another, and would gain or lose a
 * day whenever the clocks changed mid-hire. Any started day is chargeable, which
 * is how rental desks price, and the minimum is one.
 *
 * This is the TypeScript twin of public.rental_billable_days(); the two are
 * asserted against each other in the test suite.
 */
export function billableDays(startsAt: Date, endsAt: Date): number {
  const elapsed = endsAt.getTime() - startsAt.getTime()
  if (!Number.isFinite(elapsed)) return 1
  return Math.max(1, Math.ceil(elapsed / MS_PER_DAY))
}

/** How the day count was reached, for the sentence shown under the quote. */
export function describeDayRounding(startsAt: Date, endsAt: Date): string {
  const hours = (endsAt.getTime() - startsAt.getTime()) / (60 * 60 * 1000)
  const days = billableDays(startsAt, endsAt)
  const rounded = Math.round(hours * 10) / 10
  const plural = days === 1 ? 'day' : 'days'
  return `${rounded} hours counts as ${days} ${plural}. A started day is charged in full.`
}

// -----------------------------------------------------------------------------
// Line items
// -----------------------------------------------------------------------------

export const CHARGE_KIND_LABELS: Readonly<Record<RentalChargeKind, string>> = {
  base_rental: 'Rental',
  additional_driver: 'Additional driver',
  delivery: 'Delivery',
  collection: 'Collection',
  child_seat: 'Child seat',
  insurance: 'Insurance',
  cleaning: 'Cleaning',
  late_return: 'Late return',
  fuel: 'Fuel',
  damage: 'Damage',
  adjustment: 'Adjustment',
  discount: 'Discount',
  other: 'Other',
}

/** Kinds a person can add by hand. `base_rental` comes from the period and rate. */
export const ADDABLE_CHARGE_KINDS: readonly RentalChargeKind[] = [
  'additional_driver',
  'delivery',
  'collection',
  'child_seat',
  'insurance',
  'cleaning',
  'late_return',
  'fuel',
  'damage',
  'adjustment',
  'other',
]

export interface QuoteLine {
  readonly kind: RentalChargeKind
  readonly description: string
  readonly quantity: number
  readonly unitAmountMinor: number
  /** Signed: a discount is negative, exactly as the column stores it. */
  readonly amountMinor: number
  readonly isTaxable: boolean
}

export interface Quote {
  readonly currency: string
  readonly lines: readonly QuoteLine[]
  readonly subtotalMinor: number
  readonly extrasMinor: number
  readonly discountMinor: number
  readonly taxableMinor: number
  readonly taxMinor: number
  readonly taxRateBps: number
  readonly totalMinor: number
}

/**
 * Totals for a set of lines.
 *
 * Deliberately the same arithmetic as app.recalculate_rental_totals(): base and
 * extras are separated, discounts are summed as a positive figure, and tax
 * applies to the taxable lines net of any taxable discount. Rounding is
 * half-up on the minor unit, matching Postgres `round()` on the same integers.
 */
export function quoteFromLines(
  lines: readonly QuoteLine[],
  currency: string,
  taxRateBps: number,
): Quote {
  let base = 0
  let extras = 0
  let discount = 0
  let taxable = 0

  for (const line of lines) {
    assertSafeMinor(line.amountMinor)
    if (line.amountMinor < 0) {
      discount -= line.amountMinor
    } else if (line.kind === 'base_rental') {
      base += line.amountMinor
    } else {
      extras += line.amountMinor
    }
    if (line.isTaxable) taxable += line.amountMinor
  }

  const taxMinor = Math.round((Math.max(taxable, 0) * taxRateBps) / 10000)

  return {
    currency,
    lines,
    subtotalMinor: base,
    extrasMinor: extras,
    discountMinor: discount,
    taxableMinor: Math.max(taxable, 0),
    taxMinor,
    taxRateBps,
    totalMinor: base + extras - discount + taxMinor,
  }
}

/** The opening line of a quote: so many days at the vehicle's rate. */
export function baseRentalLine(days: number, dailyRateMinor: number, isTaxable = true): QuoteLine {
  const plural = days === 1 ? 'day' : 'days'
  return {
    kind: 'base_rental',
    description: `${days} ${plural} of hire`,
    quantity: days,
    unitAmountMinor: dailyRateMinor,
    amountMinor: days * dailyRateMinor,
    isTaxable,
  }
}

export function quoteFromRows(
  rows: readonly RentalLineItem[],
  currency: string,
  taxRateBps: number,
): Quote {
  return quoteFromLines(
    rows.map((row) => ({
      kind: row.kind,
      description: row.description,
      quantity: Number(row.quantity),
      unitAmountMinor: row.unit_amount_minor,
      amountMinor: row.amount_minor,
      isTaxable: row.is_taxable,
    })),
    currency,
    taxRateBps,
  )
}

/** A tax rate as a percentage string for display: 2000 bps reads as "20%". */
export function formatTaxRate(taxRateBps: number): string {
  const percent = taxRateBps / 100
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`
}

export function parseTaxRatePercent(input: string): number | null {
  const cleaned = input.replace(/%/g, '').replace(/,/g, '.').trim()
  if (cleaned === '') return 0
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value < 0 || value > 1000) return null
  return Math.round(value * 100)
}
