import { describe, expect, it } from 'vitest'

import {
  buildReportCsv,
  csvDate,
  csvMoney,
  csvNumber,
  csvPercent,
  csvText,
  guardCsvCell,
  reportFilename,
} from './csv'
import {
  COMPLIANCE_LABELS,
  FLEET_SORTS,
  REPORT_SECTIONS,
  complianceNeedingAttention,
  formatBps,
  formatShare,
  isExpenseDimension,
  isFleetSort,
  isReportSection,
  resolveCurrencyScope,
  shareOfTotal,
  trackedShare,
} from './domain'
import { exportBusinessSummary, exportCustomerBalances } from './exports'
import {
  MAX_CUSTOM_DAYS,
  compareValues,
  granularityForSpan,
  isReportPeriodKey,
  isoToInstant,
  periodBounds,
  previousPeriod,
  resolveReportPeriod,
} from './period'
import { reportKeys } from './queries'
import { toIsoDateInTimeZone } from '@/lib/datetime/timezone'
import type { ReportBusinessSummaryRow, ReportCustomerBalanceRow } from '@/types/database'

/**
 * The claims Reports makes, tested as claims.
 *
 * Three of them decide whether the whole module is trustworthy:
 *
 *   a period boundary belongs to the agency, not to the browser
 *   two currencies never become one number
 *   an exported cell is never a program
 *
 * Everything else here is a consequence of one of those.
 */

const LISBON = 'Europe/Lisbon'
const CASABLANCA = 'Africa/Casablanca'
const LOCALE = 'en-GB'

// -----------------------------------------------------------------------------
// The period
// -----------------------------------------------------------------------------

describe('the report period', () => {
  it('resolves a month in the agency zone, not the browser zone', () => {
    // 1 July 2032 in Lisbon (UTC+1 in summer) begins at 30 June 23:00 UTC. An
    // implementation that used a UTC midnight would put every payment taken in
    // that hour into the wrong month.
    const now = new Date('2032-07-15T12:00:00Z')
    const period = resolveReportPeriod('this-month', LISBON, now)

    expect(period.from.toISOString()).toBe('2032-06-30T23:00:00.000Z')
    expect(period.to.toISOString()).toBe('2032-07-31T23:00:00.000Z')
  })

  it('resolves the same month differently for an agency in another zone', () => {
    // Lisbon and Casablanca happen to share an offset in July, which is exactly
    // why a zone comparison needs a pair that genuinely differs.
    const now = new Date('2032-07-15T12:00:00Z')
    const lisbon = resolveReportPeriod('this-month', LISBON, now)
    const tokyo = resolveReportPeriod('this-month', 'Asia/Tokyo', now)

    expect(lisbon.from.toISOString()).toBe('2032-06-30T23:00:00.000Z')
    expect(tokyo.from.toISOString()).toBe('2032-06-30T15:00:00.000Z')
    expect(lisbon.from.toISOString()).not.toBe(tokyo.from.toISOString())
  })

  it('agrees with an agency that shares its offset', () => {
    const now = new Date('2032-07-15T12:00:00Z')
    expect(resolveReportPeriod('this-month', LISBON, now).from.toISOString()).toBe(
      resolveReportPeriod('this-month', CASABLANCA, now).from.toISOString(),
    )
  })

  it('makes the window half-open, so a month ends where the next begins', () => {
    const now = new Date('2032-07-15T12:00:00Z')
    const july = resolveReportPeriod('this-month', LISBON, now)
    const june = resolveReportPeriod('last-month', LISBON, now)

    // No gap and no overlap: the classic 23:59:59 end loses a payment.
    expect(june.to.toISOString()).toBe(july.from.toISOString())
  })

  it('counts the days a month really has', () => {
    const now = new Date('2032-02-15T12:00:00Z')
    // 2032 is a leap year.
    expect(resolveReportPeriod('this-month', LISBON, now).days).toBe(29)
    expect(resolveReportPeriod('this-month', LISBON, new Date('2032-07-15T12:00:00Z')).days).toBe(
      31,
    )
  })

  it('includes today in the last 30 days', () => {
    const now = new Date('2032-07-15T12:00:00Z')
    const period = resolveReportPeriod('last-30-days', LISBON, now)

    expect(period.days).toBe(30)
    // The window ends at the start of tomorrow, so a payment taken this morning
    // is inside it.
    expect(period.to.getTime()).toBeGreaterThan(now.getTime())
  })

  it('resolves a quarter from its own first month', () => {
    const period = resolveReportPeriod('this-quarter', LISBON, new Date('2032-08-20T12:00:00Z'))
    expect(period.from.toISOString()).toBe('2032-06-30T23:00:00.000Z')
    expect(period.days).toBe(92)
  })

  it('treats a custom end date as the last day somebody wants to see', () => {
    const period = resolveReportPeriod('custom', LISBON, new Date('2032-07-15T12:00:00Z'), {
      from: '2032-07-01',
      to: '2032-07-10',
    })
    // Ten days inclusive, so the exclusive bound is the 11th.
    expect(period.days).toBe(10)
    expect(periodBounds(period, LISBON)).toEqual({ from: '2032-07-01', to: '2032-07-11' })
  })

  it('falls back rather than resolving a nonsense custom range', () => {
    const now = new Date('2032-07-15T12:00:00Z')
    for (const range of [
      { from: '2032-07-10', to: '2032-07-01' },
      { from: 'not-a-date', to: '2032-07-01' },
      { from: '2032-02-31', to: '2032-03-01' },
    ]) {
      const period = resolveReportPeriod('custom', LISBON, now, range)
      expect(period.days).toBeGreaterThan(0)
      expect(period.from.getTime()).toBeLessThan(period.to.getTime())
    }
  })

  it('caps a pathological range rather than generating thousands of buckets', () => {
    const period = resolveReportPeriod('custom', LISBON, new Date('2032-07-15T12:00:00Z'), {
      from: '2000-01-01',
      to: '2032-01-01',
    })
    expect(period.days).toBeLessThanOrEqual(MAX_CUSTOM_DAYS)
  })

  it('rejects a date that does not exist', () => {
    expect(isoToInstant('2032-02-31', LISBON)).toBeNull()
    expect(isoToInstant('2032-13-01', LISBON)).toBeNull()
    expect(isoToInstant('nonsense', LISBON)).toBeNull()
    expect(isoToInstant('2032-02-29', LISBON)).not.toBeNull()
  })

  it('coarsens the buckets as the window grows', () => {
    // Five thousand daily points is a texture, not a chart.
    expect(granularityForSpan(31)).toBe('day')
    expect(granularityForSpan(92)).toBe('week')
    expect(granularityForSpan(365)).toBe('month')
    expect(granularityForSpan(1800)).toBe('month')
  })

  it('recognises only the periods it offers', () => {
    expect(isReportPeriodKey('this-month')).toBe(true)
    expect(isReportPeriodKey('last-fortnight')).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

describe('the comparison period', () => {
  it('is the previous calendar month for a month', () => {
    const july = resolveReportPeriod('this-month', LISBON, new Date('2032-07-15T12:00:00Z'))
    const before = previousPeriod(july, LISBON)

    expect(before.to.toISOString()).toBe(july.from.toISOString())
    expect(before.days).toBe(30)
  })

  it('is the preceding interval of the same length for a custom range', () => {
    // A twenty-day range compares against the preceding twenty days — not
    // against "last month", which is a different number of days.
    const period = resolveReportPeriod('custom', LISBON, new Date('2032-07-25T12:00:00Z'), {
      from: '2032-07-01',
      to: '2032-07-20',
    })
    const before = previousPeriod(period, LISBON)

    expect(period.days).toBe(20)
    expect(before.days).toBe(20)
    expect(before.to.toISOString()).toBe(period.from.toISOString())
  })

  it('never leaves a gap between the two windows', () => {
    const now = new Date('2032-07-15T12:00:00Z')
    for (const key of ['this-month', 'last-30-days', 'this-quarter', 'this-year'] as const) {
      const period = resolveReportPeriod(key, LISBON, now)
      expect(previousPeriod(period, LISBON).to.toISOString()).toBe(period.from.toISOString())
    }
  })
})

describe('percent change', () => {
  it('never renders infinity when there was no baseline', () => {
    const change = compareValues(5_000, 0)
    expect(change.state).toBe('new')
    expect(change.bps).toBeNull()
    expect(change.label).toBe('New activity')
    expect(change.label).not.toContain('∞')
    expect(change.label).not.toContain('Infinity')
  })

  it('says nothing happened rather than -100%', () => {
    const change = compareValues(0, 5_000)
    expect(change.state).toBe('ended')
    expect(change.bps).toBeNull()
  })

  it('is neutral when both periods are zero', () => {
    const change = compareValues(0, 0)
    expect(change.state).toBe('flat')
    expect(change.label).toBe('No change')
  })

  it('computes an honest percentage when both sides are real', () => {
    expect(compareValues(150, 100).bps).toBe(5_000)
    expect(compareValues(50, 100).bps).toBe(-5_000)
    expect(compareValues(100, 100).state).toBe('flat')
  })

  it('refuses a percentage across a sign change', () => {
    // -200 to +100 is not "+150%" of anything a person can act on.
    const change = compareValues(100, -200)
    expect(change.bps).toBeNull()
    expect(change.state).toBe('up')
    expect(change.label).toBe('Turned positive')
  })

  it('compares two negatives by magnitude, not by sign confusion', () => {
    // A loss that shrank from -200 to -100 is an improvement.
    const change = compareValues(-100, -200)
    expect(change.state).toBe('up')
    expect(change.bps).toBe(5_000)
  })
})

// -----------------------------------------------------------------------------
// Currency
// -----------------------------------------------------------------------------

describe('currency scope', () => {
  it('uses the only currency there is without asking', () => {
    const scope = resolveCurrencyScope(['EUR'], null, 'EUR')
    expect(scope.currency).toBe('EUR')
    expect(scope.isMixed).toBe(false)
  })

  it('prefers the agency default when several exist', () => {
    const scope = resolveCurrencyScope(['USD', 'MAD', 'EUR'], null, 'MAD')
    expect(scope.currency).toBe('MAD')
    expect(scope.isMixed).toBe(true)
    expect(scope.available).toEqual(['EUR', 'MAD', 'USD'])
  })

  it('honours an explicit choice', () => {
    expect(resolveCurrencyScope(['EUR', 'USD'], 'USD', 'EUR').currency).toBe('USD')
  })

  it('falls back rather than showing nothing when the choice is not in the data', () => {
    // Usually means the period changed under a saved link.
    const scope = resolveCurrencyScope(['EUR'], 'JPY', 'EUR')
    expect(scope.currency).toBe('EUR')
  })

  it('reports no currency at all for an empty period', () => {
    const scope = resolveCurrencyScope([], 'EUR', 'EUR')
    expect(scope.currency).toBeNull()
    expect(scope.isMixed).toBe(false)
  })
})

describe('shares and ratios', () => {
  it('has no percentage of nothing', () => {
    expect(shareOfTotal(100, 0)).toBeNull()
    expect(shareOfTotal(100, -50)).toBeNull()
    expect(formatShare(null, LOCALE)).toBe('—')
  })

  it('formats basis points as a percentage', () => {
    expect(formatBps(10_000, LOCALE)).toBe('100%')
    expect(formatBps(5_000, LOCALE)).toBe('50%')
    expect(formatBps(null, LOCALE)).toBe('—')
  })

  it('has no tracked share without a fleet', () => {
    expect(trackedShare(null)).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// CSV — the part that is a security control
// -----------------------------------------------------------------------------

describe('CSV export', () => {
  it('neutralises every character a spreadsheet would execute', () => {
    // Real values from real free-text fields: a supplier, a customer, a note.
    for (const dangerous of [
      '=HYPERLINK("http://evil.test","Click me")',
      '+1+1',
      '-2+3',
      '@SUM(A1:A9)',
      '\t=1+1',
      '\r=1+1',
      "=cmd|'/c calc'!A0",
    ]) {
      const guarded = guardCsvCell(dangerous)
      expect(guarded.startsWith("'")).toBe(true)
      // The value itself survives — nothing is stripped or rewritten.
      expect(guarded.slice(1)).toBe(dangerous)
    }
  })

  it('leaves an ordinary value exactly as it was', () => {
    for (const safe of ['Garage Atlas', '12345-A-6', 'Peugeot Citroën', '1234.56', '']) {
      expect(guardCsvCell(safe)).toBe(safe)
    }
  })

  it('guards every text cell that reaches a file', () => {
    expect(csvText('=1+1')).toBe("'=1+1")
    expect(csvText(null)).toBe('')
    expect(csvText(undefined)).toBe('')
  })

  it('writes money as a plain decimal, never through a locale', () => {
    // 1.234,56 and 1,234.56 are the same amount and different files.
    expect(csvMoney(123_456, 'EUR')).toBe('1234.56')
    expect(csvMoney(123_456, 'JPY')).toBe('123456')
    expect(csvMoney(123_456, 'KWD')).toBe('123.456')
    expect(csvMoney(null, 'EUR')).toBe('')
  })

  it('writes dates unambiguously', () => {
    expect(csvDate('2032-07-15')).toBe('2032-07-15')
    expect(csvDate('2032-07-15T10:00:00Z')).toBe('2032-07-15')
    expect(csvDate(null)).toBe('')
  })

  it('writes a percentage without a symbol or a separator', () => {
    expect(csvPercent(5_250)).toBe('52.50')
    expect(csvPercent(null)).toBe('')
    expect(csvNumber(3.14159, 2)).toBe('3.14')
  })

  it('opens with a byte order mark so Excel does not guess the code page', () => {
    const csv = buildReportCsv(
      {
        agencyName: 'Atlas',
        reportName: 'Business',
        periodLabel: 'July',
        from: '2032-07-01',
        to: '2032-08-01',
        currency: 'EUR',
        generatedAt: '2032-08-02',
      },
      ['A'],
      [['1']],
    )
    expect(csv.charCodeAt(0)).toBe(0xfeff)
  })

  it('states what the file represents before the first figure', () => {
    const csv = buildReportCsv(
      {
        agencyName: 'Atlas Motors',
        reportName: 'Fleet performance',
        periodLabel: 'Last month',
        from: '2032-07-01',
        to: '2032-08-01',
        currency: 'EUR',
        generatedAt: '2032-08-02',
        filters: ['Contribution excludes overhead'],
      },
      ['Registration'],
      [['12345-A-6']],
    )

    expect(csv).toContain('Atlas Motors')
    expect(csv).toContain('Fleet performance')
    expect(csv).toContain('From (inclusive),2032-07-01')
    expect(csv).toContain('To (exclusive),2032-08-01')
    expect(csv).toContain('Currency,EUR')
    expect(csv).toContain('Contribution excludes overhead')
  })

  it('guards the provenance block too, because an agency names itself', () => {
    const csv = buildReportCsv(
      {
        agencyName: '=cmd|calc',
        reportName: 'Business',
        periodLabel: 'July',
        from: '2032-07-01',
        to: '2032-08-01',
        currency: 'EUR',
        generatedAt: '2032-08-02',
      },
      ['A'],
      [['1']],
    )
    expect(csv).toContain("'=cmd|calc")
  })

  it('names the file after the report and the period, never after a person', () => {
    const name = reportFilename('Outstanding balances', '2032-07-01', '2032-08-01')
    expect(name).toBe('atlas-outstanding-balances-2032-07-01-to-2032-08-01.csv')
    expect(name).not.toMatch(/[A-Z]/)
  })
})

describe('what an export contains', () => {
  const context = {
    agencyName: 'Atlas Motors',
    reportName: 'Outstanding balances',
    periodLabel: 'This month',
    from: '2032-07-01',
    to: '2032-08-01',
    currency: 'EUR',
    generatedAt: '2032-08-02',
  }

  function balanceRow(overrides: Partial<ReportCustomerBalanceRow> = {}): ReportCustomerBalanceRow {
    return {
      customer_id: 'customer-1',
      display_name: 'Yasmine Cherkaoui',
      customer_type: 'individual',
      archived_at: null,
      currency: 'EUR',
      rental_count: 3,
      charged_minor: 90_000,
      paid_minor: 60_000,
      outstanding_minor: 30_000,
      deposits_held_minor: 0,
      last_rental_starts_at: '2032-07-05T09:00:00Z',
      total_rows: 1,
      ...overrides,
    }
  }

  it('carries a name and money, and no contact detail at all', () => {
    const { contents } = exportCustomerBalances(context, [balanceRow()])

    expect(contents).toContain('Yasmine Cherkaoui')
    expect(contents).toContain('300.00')
    // Every field the read model deliberately never selected.
    for (const forbidden of ['@', 'passport', 'licence', 'license', 'birth', 'address', 'phone']) {
      expect(contents.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('defuses a customer name that is a formula', () => {
    const { contents } = exportCustomerBalances(context, [
      balanceRow({ display_name: '=HYPERLINK("http://evil.test","x")' }),
    ])
    expect(contents).toContain("'=HYPERLINK")
  })

  it('writes an underivable balance as words, not as an empty cell', () => {
    function summaryRow(currency: string): ReportBusinessSummaryRow {
      return {
        currency,
        is_default_currency: currency === 'EUR',
        rental_revenue_minor: 100_000,
        rental_charges_in_minor: 100_000,
        rental_refunds_out_minor: 0,
        deposit_in_minor: 0,
        deposit_out_minor: 0,
        operating_expense_minor: 20_000,
        operating_expense_tax_minor: 0,
        operating_result_minor: 80_000,
        financing_cash_paid_minor: 0,
        financing_principal_minor: 0,
        financing_cost_minor: 0,
        financing_unallocated_minor: 0,
        financing_cost_complete: true,
        after_financing_minor: 80_000,
        rental_payment_count: 2,
        expense_count: 1,
        financing_payment_count: 0,
      }
    }

    const { contents } = exportBusinessSummary(
      context,
      [summaryRow('EUR')],
      [
        {
          currency: 'EUR',
          is_default_currency: true,
          computed_at: '2032-08-02T00:00:00Z',
          outstanding_minor: 5_000,
          outstanding_rental_count: 1,
          deposits_held_minor: 0,
          deposits_rental_count: 0,
          remaining_principal_minor: null,
          principal_known_count: 0,
          principal_unknown_count: 1,
          financing_overdue_minor: 0,
          financing_overdue_count: 0,
        },
      ],
    )

    // An empty cell would be summed as zero by a spreadsheet.
    expect(contents).toContain('not derivable')
  })

  it('keeps two currencies on two rows and never adds them', () => {
    function summaryRow(currency: string, revenue: number): ReportBusinessSummaryRow {
      return {
        currency,
        is_default_currency: currency === 'EUR',
        rental_revenue_minor: revenue,
        rental_charges_in_minor: revenue,
        rental_refunds_out_minor: 0,
        deposit_in_minor: 0,
        deposit_out_minor: 0,
        operating_expense_minor: 0,
        operating_expense_tax_minor: 0,
        operating_result_minor: revenue,
        financing_cash_paid_minor: 0,
        financing_principal_minor: 0,
        financing_cost_minor: 0,
        financing_unallocated_minor: 0,
        financing_cost_complete: true,
        after_financing_minor: revenue,
        rental_payment_count: 1,
        expense_count: 0,
        financing_payment_count: 0,
      }
    }

    const { contents } = exportBusinessSummary(
      context,
      [summaryRow('MAD', 100_000), summaryRow('EUR', 50_000)],
      [],
    )

    const lines = contents.split('\n').filter((line) => /^(MAD|EUR),/.test(line))
    expect(lines).toHaveLength(2)
    // 1,000 MAD and 500 EUR never make 1,500 of anything.
    expect(contents).not.toContain('1500.00')
  })
})

// -----------------------------------------------------------------------------
// The cache boundary between agencies
// -----------------------------------------------------------------------------

describe('query keys', () => {
  it('start with the organization, so a workspace switch cannot leak figures', () => {
    /*
     * The most damaging bug this module could have: one agency's revenue,
     * customer names and vehicle economics rendered under another agency's name
     * because the cache key did not mention which agency was being looked at.
     * The workspace switcher invalidates exactly ['organization'].
     */
    const keys = [
      reportKeys.all('org-a'),
      reportKeys.business('org-a', '2032-07-01', '2032-08-01'),
      reportKeys.positions('org-a'),
      reportKeys.series('org-a', '2032-07-01', '2032-08-01', 'day', 'EUR'),
      reportKeys.fleet('org-a', '2032-07-01', '2032-08-01'),
      reportKeys.utilisation('org-a', '2032-07-01', '2032-08-01', 'day'),
      reportKeys.expenses('org-a', '2032-07-01', '2032-08-01', 'category'),
      reportKeys.rentalOperations('org-a', '2032-07-01', '2032-08-01'),
      reportKeys.rentalValues('org-a', '2032-07-01', '2032-08-01'),
      reportKeys.cohorts('org-a', '2032-07-01', '2032-08-01'),
      reportKeys.balances('org-a', 'EUR', 1),
      reportKeys.customerRevenue('org-a', '2032-07-01', '2032-08-01'),
      reportKeys.financing('org-a'),
      reportKeys.gps('org-a'),
      reportKeys.compliance('org-a'),
    ]

    for (const key of keys) {
      expect(key[0]).toBe('organization')
      expect(key[1]).toBe('org-a')
      expect(key[2]).toBe('reports')
    }
  })

  it('produce a different key for the same question in another agency', () => {
    expect(reportKeys.business('org-a', '2032-07-01', '2032-08-01')).not.toEqual(
      reportKeys.business('org-b', '2032-07-01', '2032-08-01'),
    )
    expect(reportKeys.financing('org-a')).not.toEqual(reportKeys.financing('org-b'))
  })

  it('separate one period from another', () => {
    expect(reportKeys.business('org-a', '2032-07-01', '2032-08-01')).not.toEqual(
      reportKeys.business('org-a', '2032-06-01', '2032-07-01'),
    )
  })

  it('separate one currency from another in the trend', () => {
    expect(reportKeys.series('org-a', 'a', 'b', 'day', 'EUR')).not.toEqual(
      reportKeys.series('org-a', 'a', 'b', 'day', 'USD'),
    )
  })

  it('separate one currency from another in the balances page', () => {
    // Balances are paginated inside one currency, so the currency is part of
    // what a page means.
    expect(reportKeys.balances('org-a', 'EUR', 1)).not.toEqual(
      reportKeys.balances('org-a', 'USD', 1),
    )
  })
})

// -----------------------------------------------------------------------------
// The defects an adversarial review found
// -----------------------------------------------------------------------------

describe('regressions', () => {
  it('says when a range was too long to resolve, rather than shortening it quietly', () => {
    /*
     * The cap used to replace the end date and return an ordinary period, while
     * the date inputs went on displaying the range the user asked for. Eleven
     * years of dates sat beside figures that stopped after five.
     */
    const period = resolveReportPeriod('custom', LISBON, new Date('2032-07-15T12:00:00Z'), {
      from: '2015-01-01',
      to: '2032-07-14',
    })
    expect(period.truncated).toBe(true)
    expect(period.days).toBe(MAX_CUSTOM_DAYS)

    const ordinary = resolveReportPeriod('this-month', LISBON, new Date('2032-07-15T12:00:00Z'))
    expect(ordinary.truncated).toBe(false)
  })

  it('offers a date picker the last day inside the window, not the day after it', () => {
    // The exclusive bound in an inclusive picker told somebody that August ends
    // on 1 September, and accepting that prefill produced a 32-day August.
    const july = resolveReportPeriod('this-month', LISBON, new Date('2032-07-15T12:00:00Z'))
    expect(toIsoDateInTimeZone(july.to, LISBON)).toBe('2032-08-01')
    expect(toIsoDateInTimeZone(july.inclusiveEnd, LISBON)).toBe('2032-07-31')

    // And feeding that value straight back reproduces the same window.
    const round = resolveReportPeriod('custom', LISBON, new Date('2032-07-15T12:00:00Z'), {
      from: toIsoDateInTimeZone(july.from, LISBON),
      to: toIsoDateInTimeZone(july.inclusiveEnd, LISBON),
    })
    expect(round.days).toBe(july.days)
    expect(round.to.toISOString()).toBe(july.to.toISOString())
  })

  it('validates the cost breakdown from the URL rather than casting it', () => {
    /*
     * `?by=supplier` is a natural guess from the on-screen label "By supplier",
     * and the database refuses it. Cast rather than validated, the refusal
     * rendered as "no costs recorded in this period" for a month with six
     * figures of spend.
     */
    expect(isExpenseDimension('category')).toBe(true)
    expect(isExpenseDimension('vendor')).toBe(true)
    expect(isExpenseDimension('allocation')).toBe(true)
    expect(isExpenseDimension('supplier')).toBe(false)
    expect(isExpenseDimension('')).toBe(false)
  })

  it('guards a CSV header, because one header comes from the URL', () => {
    // The cost breakdown names its first column after the dimension chosen.
    const csv = buildReportCsv(
      {
        agencyName: 'Atlas',
        reportName: 'Costs',
        periodLabel: 'July',
        from: '2032-07-01',
        to: '2032-08-01',
        currency: 'EUR',
        generatedAt: '2032-08-02',
      },
      ['=cmd|calc', 'Currency'],
      [['1', 'EUR']],
    )
    expect(csv).toContain("'=cmd|calc")
  })

  it('does not stamp a single currency on the export that writes every currency', () => {
    const rows: ReportBusinessSummaryRow[] = ['EUR', 'MAD'].map((currency) => ({
      currency,
      is_default_currency: currency === 'MAD',
      rental_revenue_minor: 100_000,
      rental_charges_in_minor: 100_000,
      rental_refunds_out_minor: 0,
      deposit_in_minor: 0,
      deposit_out_minor: 0,
      operating_expense_minor: 0,
      operating_expense_tax_minor: 0,
      operating_result_minor: 100_000,
      financing_cash_paid_minor: 0,
      financing_principal_minor: 0,
      financing_cost_minor: 0,
      financing_unallocated_minor: 0,
      financing_cost_complete: true,
      after_financing_minor: 100_000,
      rental_payment_count: 1,
      expense_count: 0,
      financing_payment_count: 0,
    }))

    const { contents } = exportBusinessSummary(
      {
        agencyName: 'Atlas',
        reportName: 'Business',
        periodLabel: 'July',
        from: '2032-07-01',
        to: '2032-08-01',
        currency: 'MAD',
        generatedAt: '2032-08-02',
        filters: ['Currency filter: MAD'],
      },
      rows,
      [],
    )

    // A header reading "Currency,MAD" above a MAD row and a EUR row invites the
    // reader to total the column — the one sum this product refuses to make.
    expect(contents).toContain('Currency,Not applicable')
    expect(contents).not.toContain('Currency filter: MAD')
    expect(contents).toContain('never added together')
  })

  it('writes a hire date in the agency zone, not in UTC', () => {
    /*
     * `last_rental_starts_at` is a timestamp, not a date column. Sliced in UTC
     * it reported a hire that began at 00:30 in Casablanca as the previous day.
     */
    const { contents } = exportCustomerBalances(
      {
        agencyName: 'Atlas',
        reportName: 'Balances',
        periodLabel: 'July',
        from: '2032-07-01',
        to: '2032-08-01',
        currency: 'MAD',
        generatedAt: '2032-08-02',
      },
      [
        {
          customer_id: 'c1',
          display_name: 'Omar Benali',
          customer_type: 'individual',
          archived_at: null,
          currency: 'MAD',
          rental_count: 1,
          charged_minor: 10_000,
          paid_minor: 0,
          outstanding_minor: 10_000,
          deposits_held_minor: 0,
          // 00:30 on 1 July in Casablanca is 23:30 on 30 June in UTC.
          last_rental_starts_at: '2032-06-30T23:30:00Z',
          total_rows: 1,
        },
      ],
      { timeZone: 'Africa/Casablanca' },
    )

    expect(contents).toContain('2032-07-01')
    expect(contents).not.toContain('2032-06-30')
  })
})

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

describe('what the workspace calls things', () => {
  it('offers seven sections in one workspace', () => {
    expect(REPORT_SECTIONS).toHaveLength(7)
    expect(isReportSection('business')).toBe(true)
    expect(isReportSection('accounting')).toBe(false)
  })

  it('never uses the word profit', () => {
    const vocabulary = [
      ...REPORT_SECTIONS.map((section) => section.label),
      ...Object.values(FLEET_SORTS).map((sort) => sort.label),
      ...Object.values(COMPLIANCE_LABELS),
    ].join(' ')

    // The product does not model depreciation or overhead allocation, so it
    // cannot compute a profit and does not claim to.
    expect(vocabulary.toLowerCase()).not.toContain('profit')
  })

  it('recognises only the rankings it offers', () => {
    expect(isFleetSort('contribution')).toBe(true)
    expect(isFleetSort('vibes')).toBe(false)
  })

  it('counts a missing document apart from an expired one', () => {
    const needing = complianceNeedingAttention([
      {
        document_kind: 'insurance',
        lead_days: 30,
        expired: 2,
        due_soon: 1,
        valid: 5,
        unrecorded: 9,
      },
      {
        document_kind: 'inspection',
        lead_days: 30,
        expired: 0,
        due_soon: 0,
        valid: 8,
        unrecorded: 4,
      },
    ])
    // Thirteen unrecorded dates are a filing gap, not thirteen breaches.
    expect(needing).toBe(3)
  })
})
