import type {
  FinancingFrequency,
  FinancingMode,
  FinancingProjectedInstallment,
} from '@/types/database'

/**
 * The schedule a set of terms implies.
 *
 * This is a deliberate mirror of `public.financing_projected_schedule`, and the
 * test suite asserts the two agree row for row. It exists so the wizard can
 * show a schedule while somebody is still typing, without a round trip per
 * keystroke — and so what they are shown before saving is what gets saved.
 *
 * ARITHMETIC
 *
 * Every amount is an integer number of minor units held in `bigint`. The rate
 * is the only quantity that is not naturally an integer, and it is handled as a
 * scaled integer rather than as a JS number: a periodic rate is
 * `rate_bps / (10000 × periods per year)`, so the interest on a balance is
 *
 *     round(balance × rate_bps / (10000 × periods))
 *
 * which is exact integer arithmetic with a single rounding at the end. Binary
 * floating point never touches a monetary value. The one place a non-integer
 * intermediate is unavoidable — the annuity payment's `(1+i)^n` — is computed
 * at a fixed scale of 24 decimal digits, and any error there is absorbed by the
 * final instalment, which closes the balance exactly by construction.
 */

export const PERIODS_PER_YEAR: Readonly<Record<FinancingFrequency, number>> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
}

/** Fixed-point scale for the rate maths. 24 digits is far beyond any contract. */
const SCALE = 10n ** 24n

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  // Half away from zero, which is what an invoice is expected to do.
  const negative = numerator < 0n !== denominator < 0n
  const a = numerator < 0n ? -numerator : numerator
  const b = denominator < 0n ? -denominator : denominator
  const quotient = (2n * a + b) / (2n * b)
  return negative ? -quotient : quotient
}

/** `base^exponent` in fixed point, by repeated squaring. */
function fixedPow(base: bigint, exponent: number): bigint {
  let result = SCALE
  let factor = base
  let remaining = exponent

  while (remaining > 0) {
    if (remaining % 2 === 1) result = (result * factor) / SCALE
    factor = (factor * factor) / SCALE
    remaining = Math.floor(remaining / 2)
  }

  return result
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * The nth due date of a schedule.
 *
 * THE RULE, ONCE: monthly and quarterly schedules are anchored to the day of
 * the month of the first payment, clamped to the length of the month they land
 * in. A schedule first paid on the 31st pays on the 28th in February — the 29th
 * in a leap year — and on the 31st again in March. It never rolls forward into
 * the next month, which is what naive date arithmetic does and what would move
 * every remaining payment of the agreement into the wrong month.
 */
export function dueDate(
  firstPaymentOn: string,
  anchorDay: number,
  frequency: FinancingFrequency,
  index: number,
): string {
  const first = new Date(`${firstPaymentOn}T00:00:00Z`)

  if (frequency === 'weekly' || frequency === 'biweekly') {
    const step = frequency === 'weekly' ? 7 : 14
    const shifted = new Date(first)
    shifted.setUTCDate(shifted.getUTCDate() + index * step)
    return shifted.toISOString().slice(0, 10)
  }

  const monthStep = frequency === 'quarterly' ? 3 : 1
  const target = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index * monthStep, 1),
  )
  const day = Math.min(anchorDay, daysInMonth(target.getUTCFullYear(), target.getUTCMonth()))
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day))
    .toISOString()
    .slice(0, 10)
}

// -----------------------------------------------------------------------------
// The level payment
// -----------------------------------------------------------------------------

export interface AnnuityInput {
  readonly financedMinor: number
  readonly rateBps: number
  readonly installments: number
  readonly frequency: FinancingFrequency
  readonly balloonMinor?: number
}

/**
 * The payment an annuity implies: `i·(P·f − B) / (f − 1)`, `f = (1+i)^n`.
 *
 * Support, never authority. When a contract states its own instalment that
 * number is what the agency pays, and this one is used only to say whether the
 * two agree.
 */
export function annuityPayment(input: AnnuityInput): number | null {
  const { financedMinor, rateBps, installments, frequency } = input
  const balloon = input.balloonMinor ?? 0

  if (financedMinor <= 0 || installments < 1) return null
  if (balloon >= financedMinor) return null

  if (rateBps === 0) {
    // Rounded up, so no instalment falls short and the last one absorbs the rest.
    return Math.ceil((financedMinor - balloon) / installments)
  }

  const periods = BigInt(PERIODS_PER_YEAR[frequency])
  const rate = (BigInt(rateBps) * SCALE) / (10000n * periods)
  const factor = fixedPow(SCALE + rate, installments)

  const numerator = rate * (BigInt(financedMinor) * factor - BigInt(balloon) * SCALE)
  const denominator = SCALE * (factor - SCALE)

  return Number(roundedDivide(numerator, denominator))
}

// -----------------------------------------------------------------------------
// The schedule
// -----------------------------------------------------------------------------

export interface ScheduleTerms {
  readonly mode: FinancingMode
  readonly financedMinor: number | null
  readonly rateBps: number | null
  readonly installments: number | null
  readonly installmentMinor: number | null
  readonly firstPaymentOn: string | null
  readonly anchorDay?: number | null
  readonly frequency: FinancingFrequency
  readonly balloonMinor?: number | null
}

export type ScheduleProblem =
  | 'no-first-payment'
  | 'no-installment'
  | 'no-term'
  | 'no-financed-amount'
  | 'no-rate'
  | 'balloon-too-large'
  | 'payment-below-interest'

export interface ScheduleResult {
  readonly rows: readonly FinancingProjectedInstallment[]
  /** What the terms are still missing, or why they cannot produce a schedule. */
  readonly problem: ScheduleProblem | null
  /** The level payment the formula produces, when one can be computed. */
  readonly computedPaymentMinor: number | null
  /**
   * Set when the contract's own instalment differs from the computed one. Not
   * an error — lender rounding, a folded-in fee and irregular first periods all
   * cause it — but worth saying out loud rather than hiding.
   */
  readonly contractDiffersBy: number | null
}

const EMPTY: ScheduleResult = {
  rows: [],
  problem: 'no-first-payment',
  computedPaymentMinor: null,
  contractDiffersBy: null,
}

export function projectSchedule(terms: ScheduleTerms): ScheduleResult {
  const {
    mode,
    financedMinor,
    rateBps,
    installments,
    installmentMinor,
    firstPaymentOn,
    frequency,
  } = terms
  const balloon = terms.balloonMinor ?? 0

  if (!firstPaymentOn) return EMPTY

  const anchorDay = terms.anchorDay ?? Number(new Date(`${firstPaymentOn}T00:00:00Z`).getUTCDate())

  const at = (index: number) => dueDate(firstPaymentOn, anchorDay, frequency, index)

  // ------------------------------------------------------------------ simple
  if (mode === 'simple') {
    if (!installmentMinor || installmentMinor <= 0) {
      return { ...EMPTY, problem: 'no-installment' }
    }
    if (!installments || installments < 1) return { ...EMPTY, problem: 'no-term' }

    const rows: FinancingProjectedInstallment[] = []
    for (let k = 1; k <= installments; k += 1) {
      rows.push({
        sequence: k,
        due_on: at(k - 1),
        expected_total_minor: installmentMinor,
        // Unknown, and it stays unknown.
        expected_principal_minor: null,
        expected_interest_minor: null,
        remaining_principal_minor: null,
        is_balloon: false,
      })
    }
    if (balloon > 0) {
      rows.push({
        sequence: installments + 1,
        due_on: at(installments - 1),
        expected_total_minor: balloon,
        expected_principal_minor: null,
        expected_interest_minor: null,
        remaining_principal_minor: null,
        is_balloon: true,
      })
    }

    return { rows, problem: null, computedPaymentMinor: null, contractDiffersBy: null }
  }

  // ------------------------------------------------------------- amortizing
  if (!financedMinor || financedMinor <= 0) return { ...EMPTY, problem: 'no-financed-amount' }
  if (rateBps === null || rateBps === undefined) return { ...EMPTY, problem: 'no-rate' }
  if (!installments || installments < 1) return { ...EMPTY, problem: 'no-term' }
  if (balloon >= financedMinor) return { ...EMPTY, problem: 'balloon-too-large' }

  const computed = annuityPayment({
    financedMinor,
    rateBps,
    installments,
    frequency,
    balloonMinor: balloon,
  })

  // The contract wins.
  const payment = installmentMinor && installmentMinor > 0 ? installmentMinor : computed
  if (payment === null) return { ...EMPTY, problem: 'no-financed-amount' }

  const periods = BigInt(PERIODS_PER_YEAR[frequency])
  const rateNumerator = BigInt(rateBps)
  const rateDenominator = 10000n * periods

  const interestOn = (balance: bigint) => roundedDivide(balance * rateNumerator, rateDenominator)

  let balance = BigInt(financedMinor)
  const balloonBig = BigInt(balloon)

  if (installments > 1 && BigInt(payment) <= interestOn(balance)) {
    return {
      rows: [],
      problem: 'payment-below-interest',
      computedPaymentMinor: computed,
      contractDiffersBy: null,
    }
  }

  const rows: FinancingProjectedInstallment[] = []
  for (let k = 1; k <= installments; k += 1) {
    const interest = interestOn(balance)

    let principal: bigint
    if (k === installments) {
      // The last instalment closes the balance onto the balloon exactly. Every
      // rounding remainder above lands here on purpose, which is why a schedule
      // always ends at zero rather than at a stray centime.
      principal = balance - balloonBig
    } else {
      const level = BigInt(payment) - interest
      const remaining = balance - balloonBig
      principal = level < remaining ? level : remaining
      if (principal < 0n) principal = 0n
    }

    balance -= principal

    rows.push({
      sequence: k,
      due_on: at(k - 1),
      expected_total_minor: Number(principal + interest),
      expected_principal_minor: Number(principal),
      expected_interest_minor: Number(interest),
      remaining_principal_minor: Number(balance),
      is_balloon: false,
    })
  }

  if (balloon > 0) {
    rows.push({
      sequence: installments + 1,
      due_on: at(installments - 1),
      expected_total_minor: balloon,
      expected_principal_minor: balloon,
      expected_interest_minor: 0,
      remaining_principal_minor: 0,
      is_balloon: true,
    })
  }

  return {
    rows,
    problem: null,
    computedPaymentMinor: computed,
    contractDiffersBy:
      computed !== null && installmentMinor && installmentMinor > 0
        ? installmentMinor - computed
        : null,
  }
}

/** What a schedule adds up to, for the review step. */
export interface ScheduleTotals {
  readonly totalMinor: number
  readonly principalMinor: number | null
  readonly interestMinor: number | null
  readonly installmentCount: number
  readonly firstDueOn: string | null
  readonly lastDueOn: string | null
}

export function scheduleTotals(rows: readonly FinancingProjectedInstallment[]): ScheduleTotals {
  if (rows.length === 0) {
    return {
      totalMinor: 0,
      principalMinor: null,
      interestMinor: null,
      installmentCount: 0,
      firstDueOn: null,
      lastDueOn: null,
    }
  }

  // A split is reported only when every row has one. One unknown row makes the
  // whole total unknown, rather than a sum of the rows that happened to know.
  const splitKnown = rows.every((row) => row.expected_principal_minor !== null)

  return {
    totalMinor: rows.reduce((sum, row) => sum + row.expected_total_minor, 0),
    principalMinor: splitKnown
      ? rows.reduce((sum, row) => sum + (row.expected_principal_minor ?? 0), 0)
      : null,
    interestMinor: splitKnown
      ? rows.reduce((sum, row) => sum + (row.expected_interest_minor ?? 0), 0)
      : null,
    installmentCount: rows.length,
    firstDueOn: rows[0]!.due_on,
    lastDueOn: rows.at(-1)!.due_on,
  }
}
