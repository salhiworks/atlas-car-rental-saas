import { describe, expect, it } from 'vitest'

import {
  PERIODS_PER_YEAR,
  annuityPayment,
  dueDate,
  projectSchedule,
  scheduleTotals,
} from './amortization'
import {
  cashContribution,
  canTransition,
  costExplanation,
  describeTerm,
  formatRate,
  isTerminal,
  parseRatePercent,
  paymentBlockedReason,
  payoffBlockedReason,
  principalExplanation,
  principalState,
  termsAreFrozen,
  termsFrozenReason,
  urgencyOf,
} from './domain'
import {
  buildAgreementSchema,
  buildFinancingPaymentSchema,
  emptyAgreementForm,
  emptyPaymentForm,
  lenderSchema,
  unallocatedOf,
} from './schemas'

/**
 * The financing arithmetic, and the rules about what may be said out loud.
 *
 * Weighted towards the two ways a financing module lies to people: by turning
 * something nobody knows into a confident zero, and by drifting a schedule into
 * the wrong month because a date library rolled 31 January into 3 March.
 */

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

describe('when a payment falls due', () => {
  it('clamps a month-end anchor instead of rolling into the next month', () => {
    // The bug this prevents moves every remaining payment of a 48-month
    // agreement one month out, silently, from the second instalment onwards.
    expect(dueDate('2027-01-31', 31, 'monthly', 1)).toBe('2027-02-28')
    expect(dueDate('2027-01-31', 31, 'monthly', 2)).toBe('2027-03-31')
    expect(dueDate('2027-01-31', 31, 'monthly', 3)).toBe('2027-04-30')
    expect(dueDate('2027-01-31', 31, 'monthly', 4)).toBe('2027-05-31')
  })

  it('knows February has 29 days in a leap year', () => {
    expect(dueDate('2028-01-31', 31, 'monthly', 1)).toBe('2028-02-29')
    expect(dueDate('2028-01-30', 30, 'monthly', 1)).toBe('2028-02-29')
  })

  it('returns to the anchor day once the short month is behind it', () => {
    expect(dueDate('2027-01-30', 30, 'monthly', 1)).toBe('2027-02-28')
    expect(dueDate('2027-01-30', 30, 'monthly', 2)).toBe('2027-03-30')
  })

  it('steps a quarter at a time, with the same clamping', () => {
    expect(dueDate('2027-01-31', 31, 'quarterly', 1)).toBe('2027-04-30')
    expect(dueDate('2027-01-31', 31, 'quarterly', 2)).toBe('2027-07-31')
    expect(dueDate('2027-01-31', 31, 'quarterly', 4)).toBe('2028-01-31')
  })

  it('counts weeks in days, where months have nothing to say', () => {
    expect(dueDate('2027-01-31', 31, 'weekly', 1)).toBe('2027-02-07')
    expect(dueDate('2027-01-31', 31, 'biweekly', 2)).toBe('2027-02-28')
  })

  it('crosses a year boundary without losing the anchor', () => {
    expect(dueDate('2027-12-31', 31, 'monthly', 1)).toBe('2028-01-31')
    expect(dueDate('2027-12-31', 31, 'monthly', 2)).toBe('2028-02-29')
  })
})

// -----------------------------------------------------------------------------
// Amortization
// -----------------------------------------------------------------------------

describe('the annuity payment', () => {
  it('is the textbook figure for an ordinary loan', () => {
    // 150,000.00 at 7.25% over 48 monthly payments.
    expect(
      annuityPayment({
        financedMinor: 15_000_000,
        rateBps: 725,
        installments: 48,
        frequency: 'monthly',
      }),
    ).toBe(360_936)
  })

  it('divides evenly at zero interest, rounding up so nothing falls short', () => {
    expect(
      annuityPayment({
        financedMinor: 12_000_000,
        rateBps: 0,
        installments: 12,
        frequency: 'monthly',
      }),
    ).toBe(1_000_000)
    expect(
      annuityPayment({
        financedMinor: 12_000_001,
        rateBps: 0,
        installments: 12,
        frequency: 'monthly',
      }),
    ).toBe(1_000_001)
  })

  it('is smaller when a balloon carries part of the principal', () => {
    const plain = annuityPayment({
      financedMinor: 15_000_000,
      rateBps: 725,
      installments: 48,
      frequency: 'monthly',
    })!
    const withBalloon = annuityPayment({
      financedMinor: 15_000_000,
      rateBps: 725,
      installments: 48,
      frequency: 'monthly',
      balloonMinor: 3_000_000,
    })!
    expect(withBalloon).toBeLessThan(plain)
    expect(withBalloon).toBe(306_874)
  })

  it('refuses a balloon that is the whole loan', () => {
    expect(
      annuityPayment({
        financedMinor: 15_000_000,
        rateBps: 725,
        installments: 48,
        frequency: 'monthly',
        balloonMinor: 15_000_000,
      }),
    ).toBeNull()
  })

  it('knows how many periods a year each frequency has', () => {
    expect(PERIODS_PER_YEAR).toEqual({ weekly: 52, biweekly: 26, monthly: 12, quarterly: 4 })
  })
})

describe('an amortising schedule', () => {
  const loan = (overrides: Partial<Parameters<typeof projectSchedule>[0]> = {}) =>
    projectSchedule({
      mode: 'amortizing',
      financedMinor: 15_000_000,
      rateBps: 725,
      installments: 48,
      installmentMinor: null,
      firstPaymentOn: '2027-01-31',
      frequency: 'monthly',
      ...overrides,
    })

  it('repays exactly what was borrowed and closes at zero', () => {
    for (const installments of [12, 36, 48, 60]) {
      const { rows } = loan({ installments })
      expect(rows).toHaveLength(installments)
      expect(rows.at(-1)!.remaining_principal_minor).toBe(0)
      expect(rows.reduce((sum, row) => sum + (row.expected_principal_minor ?? 0), 0)).toBe(
        15_000_000,
      )
    }
  })

  it('holds at zero interest, with the remainder on the last instalment', () => {
    const { rows } = loan({ financedMinor: 12_000_001, rateBps: 0, installments: 12 })
    expect(rows.every((row) => row.expected_interest_minor === 0)).toBe(true)
    expect(rows.reduce((sum, row) => sum + (row.expected_principal_minor ?? 0), 0)).toBe(12_000_001)
    expect(rows.at(-1)!.remaining_principal_minor).toBe(0)
  })

  it('keeps every ordinary instalment level and reconciles on the last one', () => {
    const { rows } = loan({ financedMinor: 100_001, rateBps: 999, installments: 36 })
    const ordinary = new Set(rows.slice(0, -1).map((row) => row.expected_total_minor))
    expect(ordinary.size).toBe(1)
    expect(rows.at(-1)!.remaining_principal_minor).toBe(0)
  })

  it('amortises down to the balloon and shows the balloon separately', () => {
    const { rows } = loan({ balloonMinor: 3_000_000 })
    expect(rows).toHaveLength(49)

    const balloon = rows.at(-1)!
    expect(balloon.is_balloon).toBe(true)
    expect(balloon.expected_total_minor).toBe(3_000_000)
    // Same day as the final ordinary payment, and its own row — a balloon
    // hidden inside the last instalment is a surprise nobody can plan for.
    expect(balloon.due_on).toBe(rows.at(-2)!.due_on)
    expect(rows.at(-2)!.remaining_principal_minor).toBe(3_000_000)
  })

  it('takes the contract at its word when it states an instalment', () => {
    const result = loan({ installmentMinor: 361_000 })
    expect(result.rows[0]!.expected_total_minor).toBe(361_000)
    expect(result.computedPaymentMinor).toBe(360_936)
    expect(result.contractDiffersBy).toBe(64)
    // Still repays exactly the principal; the last payment absorbs the rest.
    expect(result.rows.reduce((sum, row) => sum + (row.expected_principal_minor ?? 0), 0)).toBe(
      15_000_000,
    )
    expect(result.rows.at(-1)!.expected_total_minor).not.toBe(361_000)
  })

  it('refuses terms whose payment never repays anything', () => {
    const result = loan({ installmentMinor: 10_000 })
    expect(result.problem).toBe('payment-below-interest')
    expect(result.rows).toHaveLength(0)
  })

  it('says what is still missing rather than producing half a schedule', () => {
    expect(
      projectSchedule({
        mode: 'amortizing',
        financedMinor: null,
        rateBps: 725,
        installments: 48,
        installmentMinor: null,
        firstPaymentOn: '2027-01-31',
        frequency: 'monthly',
      }).problem,
    ).toBe('no-financed-amount')

    expect(loan({ rateBps: null }).problem).toBe('no-rate')
    expect(loan({ installments: null }).problem).toBe('no-term')
    expect(loan({ firstPaymentOn: null }).problem).toBe('no-first-payment')
    expect(loan({ balloonMinor: 15_000_000 }).problem).toBe('balloon-too-large')
  })

  it('works at every frequency', () => {
    const weekly = projectSchedule({
      mode: 'amortizing',
      financedMinor: 5_000_000,
      rateBps: 600,
      installments: 52,
      installmentMinor: null,
      firstPaymentOn: '2032-01-05',
      frequency: 'weekly',
    })
    expect(weekly.rows.at(-1)!.remaining_principal_minor).toBe(0)

    const quarterly = projectSchedule({
      mode: 'amortizing',
      financedMinor: 5_000_000,
      rateBps: 600,
      installments: 8,
      installmentMinor: null,
      firstPaymentOn: '2032-01-31',
      frequency: 'quarterly',
    })
    expect(quarterly.rows[1]!.due_on).toBe('2032-04-30')
    expect(quarterly.rows.at(-1)!.remaining_principal_minor).toBe(0)
  })

  it('is unaffected by how many decimals a currency has', () => {
    // Minor units are integers whatever the currency; a three-decimal currency
    // simply has more of them. The arithmetic must not notice.
    const { rows } = loan({ financedMinor: 12_345_678, rateBps: 437, installments: 36 })
    expect(rows.reduce((sum, row) => sum + (row.expected_principal_minor ?? 0), 0)).toBe(12_345_678)
    expect(rows.at(-1)!.remaining_principal_minor).toBe(0)
  })

  it('runs a month-end schedule through February without drifting', () => {
    const { rows } = loan({
      financedMinor: 9_999_999,
      rateBps: 512,
      installments: 14,
      firstPaymentOn: '2032-01-31',
    })
    expect(rows[1]!.due_on).toBe('2032-02-29')
    expect(rows[2]!.due_on).toBe('2032-03-31')
    expect(rows.reduce((sum, row) => sum + (row.expected_principal_minor ?? 0), 0)).toBe(9_999_999)
  })
})

describe('a simple payment plan', () => {
  const plan = (overrides: Partial<Parameters<typeof projectSchedule>[0]> = {}) =>
    projectSchedule({
      mode: 'simple',
      financedMinor: null,
      rateBps: null,
      installments: 48,
      installmentMinor: 430_000,
      firstPaymentOn: '2027-01-31',
      frequency: 'monthly',
      ...overrides,
    })

  it('produces the obligations and invents nothing else', () => {
    const { rows } = plan()
    expect(rows).toHaveLength(48)
    expect(rows.every((row) => row.expected_total_minor === 430_000)).toBe(true)
    // The whole point. Nobody said how much of 4,300 is interest.
    expect(rows.every((row) => row.expected_principal_minor === null)).toBe(true)
    expect(rows.every((row) => row.expected_interest_minor === null)).toBe(true)
    expect(rows.every((row) => row.remaining_principal_minor === null)).toBe(true)
  })

  it('adds a balloon as its own obligation', () => {
    const { rows } = plan({ installments: 6, balloonMinor: 900_000 })
    expect(rows).toHaveLength(7)
    expect(rows.at(-1)!.is_balloon).toBe(true)
    expect(rows.at(-1)!.expected_total_minor).toBe(900_000)
  })

  it('says what it needs rather than guessing', () => {
    expect(plan({ installmentMinor: null }).problem).toBe('no-installment')
    expect(plan({ installments: null }).problem).toBe('no-term')
  })
})

describe('a schedule total', () => {
  it('reports a split only when every row has one', () => {
    const amortizing = scheduleTotals(
      projectSchedule({
        mode: 'amortizing',
        financedMinor: 1_200_000,
        rateBps: 900,
        installments: 12,
        installmentMinor: null,
        firstPaymentOn: '2032-01-15',
        frequency: 'monthly',
      }).rows,
    )
    expect(amortizing.principalMinor).toBe(1_200_000)
    expect(amortizing.interestMinor).toBeGreaterThan(0)
    expect(amortizing.totalMinor).toBe(amortizing.principalMinor! + amortizing.interestMinor!)

    const simple = scheduleTotals(
      projectSchedule({
        mode: 'simple',
        financedMinor: null,
        rateBps: null,
        installments: 4,
        installmentMinor: 100_000,
        firstPaymentOn: '2032-01-15',
        frequency: 'monthly',
      }).rows,
    )
    expect(simple.totalMinor).toBe(400_000)
    // Not zero. Unknown.
    expect(simple.principalMinor).toBeNull()
    expect(simple.interestMinor).toBeNull()
  })

  it('has nothing to say about no rows', () => {
    expect(scheduleTotals([]).installmentCount).toBe(0)
    expect(scheduleTotals([]).firstDueOn).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// What may honestly be said
// -----------------------------------------------------------------------------

describe('whether a principal balance can be stated', () => {
  it('is unknown when nobody recorded what was financed', () => {
    expect(principalState({ financed_amount_minor: null, unallocated_minor: 0 })).toBe('unknown')
    expect(principalExplanation('unknown')).toMatch(/never recorded/i)
  })

  it('is incomplete when some payment has not been split', () => {
    expect(principalState({ financed_amount_minor: 1_000_000, unallocated_minor: 5_000 })).toBe(
      'incomplete',
    )
    expect(principalExplanation('incomplete')).toMatch(/at most/i)
  })

  it('is known only when both halves are', () => {
    expect(principalState({ financed_amount_minor: 1_000_000, unallocated_minor: 0 })).toBe('known')
  })
})

describe('the financing cost', () => {
  it('is described as a floor when the split is incomplete', () => {
    expect(costExplanation(false)).toMatch(/at least/i)
    expect(costExplanation(true)).toMatch(/Principal is excluded/i)
  })
})

describe('cash after financing', () => {
  it('subtracts what went to the lender from the operating contribution', () => {
    const result = cashContribution(
      { currency: 'MAD', operating_contribution_minor: 2_800_000 },
      { currency: 'MAD', cash_paid_minor: 800_000 },
    )
    expect(result).toEqual({
      operatingContributionMinor: 2_800_000,
      financingCashMinor: 800_000,
      afterFinancingMinor: 2_000_000,
    })
  })

  it('refuses to combine two currencies', () => {
    // No exchange rate exists in this product, and a tidier number that is wrong
    // is worse than two numbers that are right.
    expect(
      cashContribution(
        { currency: 'MAD', operating_contribution_minor: 2_800_000 },
        { currency: 'EUR', cash_paid_minor: 80_000 },
      ),
    ).toBeNull()
  })

  it('has nothing to say when either half is missing', () => {
    expect(cashContribution(null, { currency: 'MAD', cash_paid_minor: 1 })).toBeNull()
    expect(cashContribution({ currency: 'MAD', operating_contribution_minor: 1 }, null)).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

describe('the agreement lifecycle', () => {
  it('mirrors the database transitions exactly', () => {
    expect(canTransition('draft', 'active')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('draft', 'paid_off')).toBe(false)

    expect(canTransition('active', 'paid_off')).toBe(true)
    expect(canTransition('active', 'closed')).toBe(true)
    expect(canTransition('active', 'draft')).toBe(false)

    expect(canTransition('paid_off', 'closed')).toBe(true)
    expect(canTransition('paid_off', 'active')).toBe(false)
    expect(canTransition('closed', 'active')).toBe(false)
    expect(canTransition('cancelled', 'active')).toBe(false)
  })

  it('knows which states are the end of the road', () => {
    expect(isTerminal('paid_off')).toBe(true)
    expect(isTerminal('closed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('active')).toBe(false)
    expect(isTerminal('draft')).toBe(false)
  })

  it('will not offer payoff while anything is outstanding', () => {
    const base = {
      agreement_status: 'active' as const,
      installment_rows: 12,
      remaining_scheduled_minor: 0,
      principal_known: true,
      remaining_principal_minor: 0,
    }
    expect(payoffBlockedReason(base)).toBeNull()
    expect(payoffBlockedReason({ ...base, remaining_scheduled_minor: 100 })).toMatch(
      /still payments outstanding/i,
    )
    expect(payoffBlockedReason({ ...base, remaining_principal_minor: 5 })).toMatch(/Principal/i)
    expect(payoffBlockedReason({ ...base, installment_rows: 0 })).toMatch(/no schedule/i)
    expect(payoffBlockedReason({ ...base, agreement_status: 'draft' })).toMatch(/live agreement/i)
  })

  it('will not offer payoff on a balance nobody knows, either way', () => {
    // An underivable balance cannot contradict a settled schedule, so payoff is
    // allowed — the schedule is the only evidence there is.
    expect(
      payoffBlockedReason({
        agreement_status: 'active',
        installment_rows: 6,
        remaining_scheduled_minor: 0,
        principal_known: false,
        remaining_principal_minor: null,
      }),
    ).toBeNull()
  })

  it('blocks payments on a draft and on a cancelled agreement', () => {
    expect(paymentBlockedReason({ agreement_status: 'draft' })).toMatch(/still a draft/i)
    expect(paymentBlockedReason({ agreement_status: 'cancelled' })).toMatch(/cancelled/i)
    // A final settlement often arrives after an agreement is filed away.
    expect(paymentBlockedReason({ agreement_status: 'closed' })).toBeNull()
    expect(paymentBlockedReason({ agreement_status: 'paid_off' })).toBeNull()
  })

  it('freezes terms the moment money has been paid against them', () => {
    expect(termsAreFrozen({ payment_count: 0 })).toBe(false)
    expect(termsAreFrozen({ payment_count: 1 })).toBe(true)
    expect(termsFrozenReason({ payment_count: 1, agreement_status: 'active' })).toMatch(/fixed/i)
    expect(termsFrozenReason({ payment_count: 0, agreement_status: 'draft' })).toBeNull()
    expect(termsFrozenReason({ payment_count: 0, agreement_status: 'closed' })).toMatch(/ended/i)
  })
})

describe('what a row should shout about', () => {
  const base = { agreement_status: 'active' as const, overdue_minor: 0, next_due_on: null }

  it('leads with overdue', () => {
    expect(urgencyOf({ ...base, overdue_minor: 100 }, '2032-06-01')).toBe('overdue')
  })

  it('flags a payment inside the week', () => {
    expect(urgencyOf({ ...base, next_due_on: '2032-06-05' }, '2032-06-01')).toBe('due_soon')
    expect(urgencyOf({ ...base, next_due_on: '2032-06-20' }, '2032-06-01')).toBe('none')
  })

  it('says nothing about an agreement that has ended', () => {
    expect(
      urgencyOf({ ...base, agreement_status: 'paid_off', overdue_minor: 999 }, '2032-06-01'),
    ).toBe('settled')
  })
})

// -----------------------------------------------------------------------------
// Rates
// -----------------------------------------------------------------------------

describe('rates', () => {
  it('reads what a person typed, in either decimal convention', () => {
    expect(parseRatePercent('7.25')).toBe(725)
    expect(parseRatePercent('7,25')).toBe(725)
    expect(parseRatePercent('12%')).toBe(1200)
    expect(parseRatePercent('0')).toBe(0)
  })

  it('treats a blank rate as unknown, never as zero', () => {
    // The single most important line in this file.
    expect(parseRatePercent('')).toBeNull()
    expect(parseRatePercent('   ')).toBeNull()
    expect(parseRatePercent('0')).toBe(0)
  })

  it('refuses nonsense', () => {
    expect(parseRatePercent('abc')).toBeNull()
    expect(parseRatePercent('-1')).toBeNull()
    expect(parseRatePercent('900')).toBeNull()
  })

  it('shows a whole rate without a false precision', () => {
    expect(formatRate(2000)).toBe('20%')
    expect(formatRate(725)).toBe('7.25%')
    expect(formatRate(1960)).toBe('19.6%')
    expect(formatRate(0)).toBe('0%')
    expect(formatRate(null)).toBeNull()
  })

  it('describes a term the way a person would say it', () => {
    expect(describeTerm(48, 'monthly')).toBe('48 monthly payments')
    expect(describeTerm(1, 'quarterly')).toBe('1 quarterly payment')
    expect(describeTerm(null, 'monthly')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

describe('recording an agreement', () => {
  const schema = buildAgreementSchema('EUR')
  const valid = {
    ...emptyAgreementForm('EUR', '2032-01-15'),
    vehicleId: 'vehicle-1',
    lenderId: 'lender-1',
    installmentAmount: '4300.00',
    installmentsCount: '48',
  }

  it('accepts a payment plan with only what a plan needs', () => {
    const result = schema.safeParse(valid)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.installmentAmount).toBe(430_000)
      expect(result.data.installmentsCount).toBe(48)
      // Everything unstated stays null rather than becoming zero.
      expect(result.data.financedAmount).toBeNull()
      expect(result.data.rateBps).toBeNull()
      expect(result.data.balloon).toBeNull()
      expect(result.data.downPayment).toBeNull()
    }
  })

  it('refuses a payment plan with no payment', () => {
    const result = schema.safeParse({ ...valid, installmentAmount: '' })
    expect(result.success).toBe(false)
  })

  it('asks an amortising loan for the three things it cannot work without', () => {
    const result = schema.safeParse({ ...valid, mode: 'amortizing', installmentsCount: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path[0])
      expect(paths).toContain('financedAmount')
      expect(paths).toContain('rateBps')
      expect(paths).toContain('installmentsCount')
    }
  })

  it('accepts a genuine 0% loan, which is not the same as an unknown rate', () => {
    const result = schema.safeParse({
      ...valid,
      mode: 'amortizing',
      financedAmount: '10000.00',
      rateBps: 0,
      installmentsCount: '12',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.rateBps).toBe(0)
  })

  it('refuses a balloon as large as the loan', () => {
    const result = schema.safeParse({
      ...valid,
      mode: 'amortizing',
      financedAmount: '10000.00',
      rateBps: 500,
      installmentsCount: '12',
      balloon: '10000.00',
    })
    expect(result.success).toBe(false)
  })

  it('refuses a first payment before the agreement starts', () => {
    const result = schema.safeParse({
      ...valid,
      startsOn: '2032-02-01',
      firstPaymentOn: '2032-01-01',
    })
    expect(result.success).toBe(false)
  })
})

describe('recording a lender payment', () => {
  const schema = buildFinancingPaymentSchema('EUR')
  // A payment already made, because one dated in the future is refused below.
  const pastIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const valid = { ...emptyPaymentForm(pastIso), amount: '4300.00' }

  it('saves a payment nobody can split', () => {
    const result = schema.safeParse(valid)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.amount).toBe(430_000)
      expect(result.data.principal).toBeNull()
      expect(result.data.interest).toBeNull()
      expect(result.data.fees).toBeNull()
    }
  })

  it('refuses an allocation larger than the payment', () => {
    const result = schema.safeParse({
      ...valid,
      amount: '100.00',
      principal: '80.00',
      interest: '50.00',
    })
    expect(result.success).toBe(false)
  })

  it('refuses a payment dated in the future', () => {
    expect(schema.safeParse({ ...valid, paidOn: '2099-01-01' }).success).toBe(false)
  })

  it('leaves the rest unallocated, and says how much', () => {
    expect(
      unallocatedOf({ amount: 430_000, principal: 300_000, interest: 100_000, fees: null }),
    ).toBe(30_000)
    expect(unallocatedOf({ amount: 430_000, principal: null, interest: null, fees: null })).toBe(
      430_000,
    )
    expect(unallocatedOf({ amount: 430_000, principal: 400_000, interest: 30_000, fees: 0 })).toBe(
      0,
    )
  })
})

describe('recording a lender', () => {
  it('needs only a name', () => {
    const result = lenderSchema.safeParse({
      name: 'Banque Atlas',
      kind: 'bank',
      email: '',
      phone: '',
      taxIdentifier: '',
      accountReference: '',
      address: '',
      notes: '',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.email).toBeNull()
      expect(result.data.taxIdentifier).toBeNull()
    }
  })

  it('refuses an email that is not one', () => {
    const result = lenderSchema.safeParse({
      name: 'Banque Atlas',
      kind: 'bank',
      email: 'not-an-email',
      phone: '',
      taxIdentifier: '',
      accountReference: '',
      address: '',
      notes: '',
    })
    expect(result.success).toBe(false)
  })
})
