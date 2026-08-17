import type {
  FinancingAgreementOverview,
  FinancingAgreementStatus,
  FinancingAgreementType,
  FinancingDocumentKind,
  FinancingFrequency,
  FinancingInstallmentState,
  FinancingMode,
  FinancingPaymentPurpose,
  LenderKind,
  VehicleAcquisitionMethod,
} from '@/types/database'

/**
 * The words this module uses, and the rules behind them.
 *
 * THE THREE FIGURES, AND WHY THEY ARE THREE
 *
 * Financing cash paid — every dirham that went to the lender, whatever it was
 * for. It is what the bank account felt. It is not a cost.
 *
 * Financing cost — interest plus fees. The actual price of borrowing. Principal
 * is excluded because repaying a debt is not spending money on anything; it
 * converts one position into another.
 *
 * Remaining principal — what is still owed. Derivable only when the amount
 * financed is known and every payment on file has been split. Otherwise it is
 * genuinely unknown, and this module says so instead of guessing.
 *
 * None of the three is profit, and nothing here is ever labelled as such.
 */

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

export const ACQUISITION_METHOD_LABELS: Readonly<Record<VehicleAcquisitionMethod, string>> = {
  cash: 'Bought outright',
  financed: 'Financed',
  leased: 'Leased',
  other: 'Another arrangement',
}

export const ACQUISITION_METHOD_HINTS: Readonly<Record<VehicleAcquisitionMethod, string>> = {
  cash: 'Paid for in full. No lender, no instalments.',
  financed: 'A loan or instalment plan against the vehicle.',
  leased: 'Used under a lease rather than owned.',
  other: 'Something that does not fit the three above.',
}

export const AGREEMENT_TYPE_LABELS: Readonly<Record<FinancingAgreementType, string>> = {
  loan: 'Loan',
  lease: 'Lease',
  installment_plan: 'Instalment plan',
  other: 'Other arrangement',
}

export const AGREEMENT_STATUS_LABELS: Readonly<Record<FinancingAgreementStatus, string>> = {
  draft: 'Draft',
  active: 'Active',
  paid_off: 'Paid off',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export const AGREEMENT_STATUS_HINTS: Readonly<Record<FinancingAgreementStatus, string>> = {
  draft: 'Not live yet. Terms can still be corrected freely.',
  active: 'Running. Payments are due on the schedule below.',
  paid_off: 'Every obligation was met and the agreement is finished.',
  closed: 'Ended for another reason, with that reason on the record.',
  cancelled: 'Never came into effect.',
}

export const MODE_LABELS: Readonly<Record<FinancingMode, string>> = {
  simple: 'Payment plan',
  amortizing: 'Amortising loan',
}

export const MODE_HINTS: Readonly<Record<FinancingMode, string>> = {
  simple: 'You know what you pay and when. Nothing is invented about the rest.',
  amortizing: 'The rate and the amount financed are known, so every payment can be split.',
}

export const FREQUENCY_LABELS: Readonly<Record<FinancingFrequency, string>> = {
  weekly: 'Every week',
  biweekly: 'Every two weeks',
  monthly: 'Every month',
  quarterly: 'Every quarter',
}

export const FREQUENCY_SHORT: Readonly<Record<FinancingFrequency, string>> = {
  weekly: 'weekly',
  biweekly: 'fortnightly',
  monthly: 'monthly',
  quarterly: 'quarterly',
}

export const LENDER_KIND_LABELS: Readonly<Record<LenderKind, string>> = {
  bank: 'Bank',
  finance_company: 'Finance company',
  leasing_company: 'Leasing company',
  dealer: 'Dealer finance',
  private: 'Private lender',
  other: 'Other',
}

export const PAYMENT_PURPOSE_LABELS: Readonly<Record<FinancingPaymentPurpose, string>> = {
  installment: 'Scheduled payment',
  extra: 'Extra payment',
  payoff: 'Payoff',
  fee: 'Fee',
}

export const DOCUMENT_KIND_LABELS: Readonly<Record<FinancingDocumentKind, string>> = {
  agreement: 'Agreement',
  statement: 'Lender statement',
  payoff_letter: 'Payoff letter',
  receipt: 'Receipt',
  other: 'Other',
}

export const INSTALLMENT_STATE_LABELS: Readonly<Record<FinancingInstallmentState, string>> = {
  upcoming: 'Upcoming',
  due_today: 'Due today',
  partially_paid: 'Part paid',
  paid: 'Paid',
  overdue: 'Overdue',
  closed: 'Closed',
}

export const AGREEMENT_TYPES: readonly FinancingAgreementType[] = [
  'loan',
  'lease',
  'installment_plan',
  'other',
]

export const FREQUENCIES: readonly FinancingFrequency[] = [
  'monthly',
  'quarterly',
  'biweekly',
  'weekly',
]

export const LENDER_KINDS: readonly LenderKind[] = [
  'bank',
  'finance_company',
  'leasing_company',
  'dealer',
  'private',
  'other',
]

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

/** Mirrors app.guard_financing_agreement_status(). */
const TRANSITIONS: Readonly<Record<FinancingAgreementStatus, readonly FinancingAgreementStatus[]>> =
  {
    draft: ['active', 'cancelled'],
    active: ['paid_off', 'closed', 'cancelled'],
    paid_off: ['closed'],
    closed: [],
    cancelled: [],
  }

export function canTransition(
  from: FinancingAgreementStatus,
  to: FinancingAgreementStatus,
): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isLive(status: FinancingAgreementStatus): boolean {
  return status === 'active'
}

/** A terminal agreement is history: nothing about it may be rewritten. */
export function isTerminal(status: FinancingAgreementStatus): boolean {
  return status === 'paid_off' || status === 'closed' || status === 'cancelled'
}

export function canRecordPayment(agreement: {
  agreement_status: FinancingAgreementStatus
}): boolean {
  // Payments against a closed agreement are legitimate — a final settlement
  // often arrives after the desk has filed it away — but a draft has no
  // obligations to settle yet.
  return agreement.agreement_status !== 'draft' && agreement.agreement_status !== 'cancelled'
}

export function paymentBlockedReason(agreement: {
  agreement_status: FinancingAgreementStatus
}): string | null {
  if (agreement.agreement_status === 'draft') {
    return 'This agreement is still a draft. Activate it to start recording payments.'
  }
  if (agreement.agreement_status === 'cancelled') {
    return 'This agreement was cancelled, so there is nothing to pay against it.'
  }
  return null
}

/** Terms freeze the moment money has been paid against them. */
export function termsAreFrozen(agreement: { payment_count: number }): boolean {
  return agreement.payment_count > 0
}

export function termsFrozenReason(agreement: {
  payment_count: number
  agreement_status: FinancingAgreementStatus
}): string | null {
  if (isTerminal(agreement.agreement_status)) {
    return 'This agreement has ended, so its terms are part of the record.'
  }
  if (agreement.payment_count > 0) {
    return 'Payments have been recorded against these terms, so they are fixed. Close this agreement and record the replacement if the contract itself changed.'
  }
  return null
}

/**
 * Whether an agreement can honestly be marked paid off.
 *
 * Mirrors the RPC, which is the authority. This exists so the interface can
 * explain why the option is unavailable instead of offering a button that will
 * be refused.
 */
export function payoffBlockedReason(agreement: {
  agreement_status: FinancingAgreementStatus
  installment_rows: number
  remaining_scheduled_minor: number
  principal_known: boolean
  remaining_principal_minor: number | null
}): string | null {
  if (agreement.agreement_status !== 'active') {
    return 'Only a live agreement can be paid off.'
  }
  if (agreement.installment_rows === 0) {
    return 'This agreement has no schedule, so there is nothing to say it has been paid off.'
  }
  if (agreement.remaining_scheduled_minor > 0) {
    return 'There are still payments outstanding on the schedule.'
  }
  if (agreement.principal_known && (agreement.remaining_principal_minor ?? 0) > 0) {
    return 'Principal is still outstanding under this agreement’s own figures.'
  }
  return null
}

// -----------------------------------------------------------------------------
// What is knowable
// -----------------------------------------------------------------------------

export type KnownState = 'known' | 'unknown' | 'incomplete'

/**
 * Whether a principal balance can honestly be stated.
 *
 * `unknown` — nobody said what was financed, so there is no balance to reduce.
 * `incomplete` — the amount is known, but some payment's split is not, so what
 *   can be said is an upper bound rather than a figure.
 */
export function principalState(agreement: {
  financed_amount_minor: number | null
  unallocated_minor: number
}): KnownState {
  if (agreement.financed_amount_minor === null) return 'unknown'
  return agreement.unallocated_minor > 0 ? 'incomplete' : 'known'
}

export function principalExplanation(state: KnownState): string {
  switch (state) {
    case 'known':
      return 'What was financed, less the principal actually repaid.'
    case 'incomplete':
      return 'Some payments have not been split, so the balance cannot be stated exactly. At most this much remains.'
    case 'unknown':
      return 'The amount financed was never recorded, so there is no balance to derive. What is known is the cash paid and the payments still scheduled.'
  }
}

export function costExplanation(complete: boolean): string {
  return complete
    ? 'Interest and fees actually paid. Principal is excluded — repaying a debt is not a cost.'
    : 'Interest and fees so far. Some payments have not been split, so the true cost is at least this much.'
}

// -----------------------------------------------------------------------------
// Cash contribution
// -----------------------------------------------------------------------------

export interface CashContribution {
  readonly operatingContributionMinor: number
  readonly financingCashMinor: number
  readonly afterFinancingMinor: number
}

/**
 * Operating contribution less what actually went to the lender.
 *
 * A CASH figure, and labelled as one everywhere it appears. It is useful for
 * "can this car pay for itself this month"; it is not profit, because principal
 * repayment is in it and depreciation, overhead and tax are not.
 *
 * Returns null when the two halves are in different currencies. There is no
 * exchange rate in this product and inventing one to produce a tidier number
 * would be worse than showing two.
 */
export function cashContribution(
  operating: { currency: string; operating_contribution_minor: number } | null | undefined,
  financing: { currency: string; cash_paid_minor: number } | null | undefined,
): CashContribution | null {
  if (!operating || !financing) return null
  if (operating.currency !== financing.currency) return null

  return {
    operatingContributionMinor: operating.operating_contribution_minor,
    financingCashMinor: financing.cash_paid_minor,
    afterFinancingMinor: operating.operating_contribution_minor - financing.cash_paid_minor,
  }
}

// -----------------------------------------------------------------------------
// Presentation helpers
// -----------------------------------------------------------------------------

export function formatRate(rateBps: number | null): string | null {
  if (rateBps === null) return null
  const percent = rateBps / 100
  if (Number.isInteger(percent)) return `${percent}%`
  return `${percent.toFixed(2).replace(/0$/, '')}%`
}

export function parseRatePercent(input: string): number | null {
  const cleaned = input.replace(/%/g, '').replace(/,/g, '.').trim()
  if (cleaned === '') return null

  const value = Number(cleaned)
  if (!Number.isFinite(value) || value < 0 || value > 100) return null
  return Math.round(value * 100)
}

/** How a term reads to a person: "48 monthly payments". */
export function describeTerm(
  installments: number | null,
  frequency: FinancingFrequency,
): string | null {
  if (!installments) return null
  return `${installments} ${FREQUENCY_SHORT[frequency]} payment${installments === 1 ? '' : 's'}`
}

export type AgreementUrgency = 'overdue' | 'due_soon' | 'settled' | 'none'

/** What the row should shout about, if anything. */
export function urgencyOf(
  agreement: Pick<FinancingAgreementOverview, 'agreement_status' | 'overdue_minor' | 'next_due_on'>,
  today: string,
): AgreementUrgency {
  if (agreement.agreement_status !== 'active') return 'settled'
  if (agreement.overdue_minor > 0) return 'overdue'
  if (!agreement.next_due_on) return 'none'

  const days = Math.round(
    (new Date(`${agreement.next_due_on}T00:00:00Z`).getTime() -
      new Date(`${today}T00:00:00Z`).getTime()) /
      86_400_000,
  )
  return days <= 7 ? 'due_soon' : 'none'
}
