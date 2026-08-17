import { formatMoney, parseMoneyToMinor } from '@/lib/money/money'
import type { ExpenseSummaryRow } from '@/types/database'

/**
 * The arithmetic of a cost, and the rule about currencies.
 *
 * THE TAX MODEL, ONCE
 *
 * `amount_minor` is the gross total — the money that actually left the agency.
 * `tax_amount_minor` is the part of that which was tax. Net is the difference.
 *
 * Every total in this product uses gross, because gross is what was spent and
 * because a single consistent basis cannot double count. Nothing here claims
 * any of the tax is recoverable or deductible; those are questions for an
 * accountant and for the agency's own jurisdiction, and this module does not
 * pretend to answer them.
 *
 * THE CURRENCY RULE, ONCE
 *
 * Two currencies are never added. A summary is a list of per-currency figures,
 * and a single headline number exists only when there is exactly one currency
 * to make it from.
 */

export interface TaxBreakdown {
  readonly grossMinor: number
  readonly taxMinor: number
  readonly netMinor: number
}

/** Reads what a person typed for the total and the tax within it. */
export function parseTaxInput(amount: string, tax: string, currency: string): TaxBreakdown | null {
  const grossMinor = parseMoneyToMinor(amount, currency)
  if (grossMinor === null || grossMinor <= 0) return null

  const taxMinor = tax.trim() === '' ? 0 : parseMoneyToMinor(tax, currency)
  if (taxMinor === null || taxMinor < 0 || taxMinor > grossMinor) return null

  return { grossMinor, taxMinor, netMinor: grossMinor - taxMinor }
}

/**
 * The tax a rate implies on a gross amount.
 *
 * Gross includes the tax, so the tax inside it is `gross × rate / (1 + rate)`,
 * not `gross × rate`. Getting that backwards overstates the tax on every
 * receipt, which is the kind of error nobody notices until an accountant does.
 */
export function taxFromGross(grossMinor: number, rateBps: number): number {
  if (rateBps <= 0) return 0
  return Math.round((grossMinor * rateBps) / (10000 + rateBps))
}

/** 2000 → "20%", 1960 → "19.6%". A trailing zero is precision nobody stated. */
export function formatTaxRate(rateBps: number): string {
  const percent = rateBps / 100
  if (Number.isInteger(percent)) return `${percent}%`
  return `${percent.toFixed(2).replace(/0$/, '')}%`
}

export function parseTaxRatePercent(input: string): number | null {
  const cleaned = input.replace(/%/g, '').replace(/,/g, '.').trim()
  if (cleaned === '') return 0

  const value = Number(cleaned)
  if (!Number.isFinite(value) || value < 0 || value > 1000) return null
  return Math.round(value * 100)
}

// -----------------------------------------------------------------------------
// Currencies
// -----------------------------------------------------------------------------

export interface CurrencyPresentation {
  /** The single figure, when one currency can honestly produce one. */
  readonly headline: ExpenseSummaryRow | null
  /** Every currency present, largest first. */
  readonly rows: readonly ExpenseSummaryRow[]
  readonly isMixed: boolean
}

/**
 * Decides whether a period can be shown as one number.
 *
 * With one currency it can. With several it cannot, and the interface shows the
 * breakdown instead — because the alternative is inventing an exchange rate,
 * and a wrong total is worse than an honest list.
 */
export function presentCurrencies(rows: readonly ExpenseSummaryRow[]): CurrencyPresentation {
  const ordered = [...rows].sort((a, b) => b.total_minor - a.total_minor)

  return {
    headline: ordered.length === 1 ? ordered[0]! : null,
    rows: ordered,
    isMixed: ordered.length > 1,
  }
}

/** Adds up the counts, which are currency-free and therefore safe to combine. */
export function totalExpenseCount(rows: readonly ExpenseSummaryRow[]): number {
  return rows.reduce((sum, row) => sum + row.expense_count, 0)
}

/**
 * A share of a total, only ever within one currency.
 *
 * Returns null rather than a misleading zero when there is nothing to divide
 * by, so a caller cannot render "0% of nothing" as though it meant something.
 */
export function shareOfTotal(amountMinor: number, totalMinor: number): number | null {
  if (totalMinor <= 0) return null
  return (amountMinor / totalMinor) * 100
}

/** A compact per-currency line, for places with room for one line. */
export function describeCurrencies(rows: readonly ExpenseSummaryRow[], locale: string): string {
  if (rows.length === 0) return '—'
  return rows.map((row) => formatMoney(row.total_minor, row.currency, { locale })).join(' · ')
}
