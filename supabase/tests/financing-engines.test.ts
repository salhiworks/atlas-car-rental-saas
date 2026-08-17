// @vitest-environment node
/**
 * The two schedule engines must agree.
 *
 * The wizard draws a schedule in the browser so it can keep up with typing, and
 * the database writes one when an agreement is activated. If those two ever
 * disagreed, an agency would approve one set of obligations and be given
 * another — which is exactly the kind of quiet financial defect this product
 * exists to avoid.
 *
 * So they are asserted equal, row for row, across every shape the domain
 * produces: both modes, every frequency, zero interest, odd principals, a
 * contract instalment that differs from the formula, balloons, month-end
 * anchoring and a leap year.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { projectSchedule } from '../../src/features/financing/amortization'
import type { FinancingFrequency, FinancingMode } from '../../src/types/database'

import { TestDatabase } from './support/harness'

let db: TestDatabase

interface Case {
  readonly name: string
  readonly mode: FinancingMode
  readonly financed: number | null
  readonly rate: number | null
  readonly installments: number
  readonly installment: number | null
  readonly first: string
  readonly frequency: FinancingFrequency
  readonly balloon: number
}

const CASES: readonly Case[] = [
  {
    name: 'an ordinary 48-month loan anchored to a month end',
    mode: 'amortizing',
    financed: 15_000_000,
    rate: 725,
    installments: 48,
    installment: null,
    first: '2027-01-31',
    frequency: 'monthly',
    balloon: 0,
  },
  {
    name: 'the same loan with the contract’s own instalment',
    mode: 'amortizing',
    financed: 15_000_000,
    rate: 725,
    installments: 48,
    installment: 361_000,
    first: '2027-01-31',
    frequency: 'monthly',
    balloon: 0,
  },
  {
    name: 'a loan that ends in a balloon',
    mode: 'amortizing',
    financed: 15_000_000,
    rate: 725,
    installments: 48,
    installment: null,
    first: '2027-01-31',
    frequency: 'monthly',
    balloon: 3_000_000,
  },
  {
    name: 'a zero-interest plan starting on a leap day',
    mode: 'amortizing',
    financed: 12_000_001,
    rate: 0,
    installments: 12,
    installment: null,
    first: '2028-02-29',
    frequency: 'monthly',
    balloon: 0,
  },
  {
    name: 'an odd principal at an odd rate',
    mode: 'amortizing',
    financed: 100_001,
    rate: 999,
    installments: 36,
    installment: null,
    first: '2027-02-28',
    frequency: 'monthly',
    balloon: 0,
  },
  {
    name: 'a three-decimal currency’s worth of minor units',
    mode: 'amortizing',
    financed: 12_345_678,
    rate: 437,
    installments: 36,
    installment: null,
    first: '2031-12-31',
    frequency: 'monthly',
    balloon: 0,
  },
  {
    name: 'a weekly schedule over a year',
    mode: 'amortizing',
    financed: 5_000_000,
    rate: 600,
    installments: 52,
    installment: null,
    first: '2032-01-05',
    frequency: 'weekly',
    balloon: 0,
  },
  {
    name: 'a quarterly schedule from a month end',
    mode: 'amortizing',
    financed: 5_000_000,
    rate: 600,
    installments: 8,
    installment: null,
    first: '2032-01-31',
    frequency: 'quarterly',
    balloon: 0,
  },
  {
    name: 'a fortnightly schedule with a balloon',
    mode: 'amortizing',
    financed: 7_777_777,
    rate: 1234,
    installments: 60,
    installment: null,
    first: '2029-08-30',
    frequency: 'biweekly',
    balloon: 500_000,
  },
  {
    name: 'a schedule running through a February from the 31st',
    mode: 'amortizing',
    financed: 9_999_999,
    rate: 512,
    installments: 14,
    installment: null,
    first: '2032-01-31',
    frequency: 'monthly',
    balloon: 0,
  },
  {
    name: 'a payment plan nobody can split',
    mode: 'simple',
    financed: null,
    rate: null,
    installments: 48,
    installment: 430_000,
    first: '2027-01-31',
    frequency: 'monthly',
    balloon: 0,
  },
  {
    name: 'a payment plan ending in a balloon',
    mode: 'simple',
    financed: null,
    rate: null,
    installments: 6,
    installment: 250_000,
    first: '2027-01-31',
    frequency: 'monthly',
    balloon: 900_000,
  },
]

interface ScheduleRow {
  sequence: number
  due_on: string
  expected_total_minor: number
  expected_principal_minor: number | null
  expected_interest_minor: number | null
  remaining_principal_minor: number | null
  is_balloon: boolean
}

/** One comparable line per instalment, so a mismatch names itself. */
function fingerprint(row: ScheduleRow): string {
  return [
    row.sequence,
    row.due_on,
    row.expected_total_minor,
    row.expected_principal_minor ?? 'null',
    row.expected_interest_minor ?? 'null',
    row.remaining_principal_minor ?? 'null',
    row.is_balloon,
  ].join('|')
}

beforeAll(async () => {
  db = await TestDatabase.create()
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('the browser and the database produce the same schedule', () => {
  it.each(CASES.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    const fromDatabase = await db.sql<ScheduleRow>(
      `select sequence, due_on::text as due_on, expected_total_minor,
              expected_principal_minor, expected_interest_minor,
              remaining_principal_minor, is_balloon
         from public.financing_projected_schedule(
           $1::public.financing_mode, $2, $3, $4, $5, $6::date,
           extract(day from $6::date)::smallint, $7::public.financing_frequency, $8)`,
      [
        entry.mode,
        entry.financed,
        entry.rate,
        entry.installments,
        entry.installment,
        entry.first,
        entry.frequency,
        entry.balloon,
      ],
    )

    const fromBrowser = projectSchedule({
      mode: entry.mode,
      financedMinor: entry.financed,
      rateBps: entry.rate,
      installments: entry.installments,
      installmentMinor: entry.installment,
      firstPaymentOn: entry.first,
      frequency: entry.frequency,
      balloonMinor: entry.balloon,
    })

    expect(fromBrowser.problem).toBeNull()
    expect(fromBrowser.rows.map(fingerprint)).toEqual(
      fromDatabase.map((row) => fingerprint({ ...row, sequence: Number(row.sequence) })),
    )
  })

  it('refuses the same impossible terms on both sides', async () => {
    // A payment that does not cover the interest never repays anything, and
    // both engines say so rather than emitting a schedule that grows forever.
    await db.expectRejection(
      () =>
        db.sql(
          `select * from public.financing_projected_schedule(
             'amortizing', 15000000, 725, 48, 10000, '2027-01-31'::date, 31::smallint, 'monthly', 0)`,
        ),
      /does not cover the interest/i,
    )

    expect(
      projectSchedule({
        mode: 'amortizing',
        financedMinor: 15_000_000,
        rateBps: 725,
        installments: 48,
        installmentMinor: 10_000,
        firstPaymentOn: '2027-01-31',
        frequency: 'monthly',
      }).problem,
    ).toBe('payment-below-interest')
  })

  it('computes the same annuity payment on both sides', async () => {
    const cases: readonly [number, number, number, FinancingFrequency, number][] = [
      [15_000_000, 725, 48, 'monthly', 0],
      [15_000_000, 725, 48, 'monthly', 3_000_000],
      [12_000_000, 0, 12, 'monthly', 0],
      [5_000_000, 600, 52, 'weekly', 0],
      [7_777_777, 1234, 60, 'biweekly', 500_000],
    ]

    for (const [financed, rate, installments, frequency, balloon] of cases) {
      const [row] = await db.sql<{ payment: number }>(
        `select public.financing_annuity_payment($1, $2, $3, $4::public.financing_frequency, $5) as payment`,
        [financed, rate, installments, frequency, balloon],
      )

      const { annuityPayment } = await import('../../src/features/financing/amortization')
      expect(
        annuityPayment({
          financedMinor: financed,
          rateBps: rate,
          installments,
          frequency,
          balloonMinor: balloon,
        }),
      ).toBe(Number(row!.payment))
    }
  })
})
