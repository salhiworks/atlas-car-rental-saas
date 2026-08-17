import { z } from 'zod'

import { parseMoneyToMinor } from '@/lib/money/money'

/**
 * Financing validation.
 *
 * Every rule here has a matching CHECK constraint, trigger or policy behind it.
 * This layer exists so a person sees the problem on the field they are typing
 * in — not so the database can be trusted less.
 *
 * One rule is particular to this module and appears nowhere else in the
 * product: a blank money field is NULL, never 0. "I do not know the rate" and
 * "the rate is zero" are different facts about a loan, and a schema that
 * collapses them is the bug this module was written to avoid.
 */

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
}

const businessDate = z
  .string()
  .trim()
  .min(1, 'Choose a date.')
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), 'Choose a valid date.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, 'That date does not exist.')

const optionalBusinessDate = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine(
    (value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value),
    'Choose a valid date, or leave it blank.',
  )

/** Blank means unknown. It never becomes zero. */
function optionalMoney(currency: string, label: string) {
  return z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine(
      (value) => value === null || parseMoneyToMinor(value, currency) !== null,
      `Enter ${label} as a number, or leave it blank.`,
    )
    .transform((value) => (value === null ? null : (parseMoneyToMinor(value, currency) as number)))
    .refine((minor) => minor === null || minor > 0, `${label} has to be more than nothing.`)
}

export const LENDER_KIND_VALUES = [
  'bank',
  'finance_company',
  'leasing_company',
  'dealer',
  'private',
  'other',
] as const

export const lenderSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the lender’s name.')
    .max(160, 'Use 160 characters or fewer.'),
  kind: z.enum(LENDER_KIND_VALUES),
  email: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine(
      (value) => value === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
      'Enter a valid email address, or leave it blank.',
    ),
  phone: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine(
      (value) => value === null || (value.length >= 4 && value.length <= 40),
      'A phone number is between 4 and 40 characters.',
    ),
  taxIdentifier: optionalText(60),
  /** An agreement or customer number. Never a login, never a card number. */
  accountReference: optionalText(96),
  address: optionalText(300),
  notes: optionalText(2000),
})

export type LenderFormInput = z.input<typeof lenderSchema>
export type LenderFormValues = z.output<typeof lenderSchema>

export function emptyLenderForm(): LenderFormInput {
  return {
    name: '',
    kind: 'bank',
    email: '',
    phone: '',
    taxIdentifier: '',
    accountReference: '',
    address: '',
    notes: '',
  }
}

// -----------------------------------------------------------------------------
// The agreement
// -----------------------------------------------------------------------------

export function buildAgreementSchema(currency: string) {
  return z
    .object({
      vehicleId: z.string().min(1, 'Choose the vehicle this finances.'),
      lenderId: z.string().min(1, 'Choose the lender.'),
      agreementType: z.enum(['loan', 'lease', 'installment_plan', 'other']),
      mode: z.enum(['simple', 'amortizing']),
      currency: z
        .string()
        .trim()
        .length(3, 'A currency is three letters.')
        .transform((value) => value.toUpperCase()),
      reference: optionalText(96),

      startsOn: businessDate,
      firstPaymentOn: businessDate,
      paymentFrequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly']),

      financedAmount: optionalMoney(currency, 'the amount financed'),
      downPayment: optionalMoney(currency, 'the down payment'),
      installmentAmount: optionalMoney(currency, 'the payment'),
      balloon: optionalMoney(currency, 'the final payment'),

      // Null is "not known". Zero is a real 0% loan.
      rateBps: z.number().int().min(0).max(10000).nullable(),
      installmentsCount: z
        .string()
        .trim()
        .transform((value) => (value === '' ? null : Number(value.replace(/[\s,]/g, ''))))
        .nullable()
        .refine(
          (value) => value === null || (Number.isInteger(value) && value >= 1 && value <= 600),
          'Enter the number of payments, between 1 and 600.',
        ),

      notes: optionalText(2000),
    })
    .superRefine((values, ctx) => {
      if (values.mode === 'simple') {
        if (values.installmentAmount === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['installmentAmount'],
            message: 'A payment plan needs the amount of each payment.',
          })
        }
        if (values.installmentsCount === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['installmentsCount'],
            message: 'A payment plan needs the number of payments.',
          })
        }
      }

      if (values.mode === 'amortizing') {
        if (values.financedAmount === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['financedAmount'],
            message: 'An amortising loan needs the amount financed.',
          })
        }
        if (values.rateBps === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['rateBps'],
            message:
              'An amortising loan needs a rate. Record a payment plan instead if it is unknown.',
          })
        }
        if (values.installmentsCount === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['installmentsCount'],
            message: 'An amortising loan needs a term.',
          })
        }
        if (
          values.financedAmount !== null &&
          values.balloon !== null &&
          values.balloon >= values.financedAmount
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['balloon'],
            message: 'A final payment cannot be as large as the amount financed.',
          })
        }
      }

      if (values.firstPaymentOn < values.startsOn) {
        ctx.addIssue({
          code: 'custom',
          path: ['firstPaymentOn'],
          message: 'The first payment cannot fall before the agreement starts.',
        })
      }
    })
}

export type AgreementFormInput = z.input<ReturnType<typeof buildAgreementSchema>>
export type AgreementFormValues = z.output<ReturnType<typeof buildAgreementSchema>>

export function emptyAgreementForm(currency: string, todayIso: string): AgreementFormInput {
  return {
    vehicleId: '',
    lenderId: '',
    agreementType: 'loan',
    mode: 'simple',
    currency,
    reference: '',
    startsOn: todayIso,
    firstPaymentOn: todayIso,
    paymentFrequency: 'monthly',
    financedAmount: '',
    downPayment: '',
    installmentAmount: '',
    balloon: '',
    rateBps: null,
    installmentsCount: '',
    notes: '',
  }
}

// -----------------------------------------------------------------------------
// Acquisition
// -----------------------------------------------------------------------------

export function buildAcquisitionSchema(currency: string) {
  return z
    .object({
      acquisitionMethod: z
        .string()
        .transform((value) => (value === '' ? null : value))
        .nullable()
        .refine(
          (value) => value === null || ['cash', 'financed', 'leased', 'other'].includes(value),
          'Choose how the vehicle was acquired.',
        ),
      acquiredOn: optionalBusinessDate,
      acquisitionPrice: optionalMoney(currency, 'the price'),
      acquisitionCurrency: z
        .string()
        .trim()
        .transform((value) => (value === '' ? null : value.toUpperCase()))
        .nullable()
        .refine(
          (value) => value === null || /^[A-Z]{3}$/.test(value),
          'A currency is three letters.',
        ),
      acquisitionSupplier: optionalText(160),
      acquisitionNotes: optionalText(2000),
    })
    .superRefine((values, ctx) => {
      // A price with no currency is a number nobody can read, and the currency
      // is stored per vehicle so changing the agency default never rewrites it.
      if (values.acquisitionPrice !== null && values.acquisitionCurrency === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['acquisitionCurrency'],
          message: 'Say which currency the price is in.',
        })
      }
    })
}

export type AcquisitionFormInput = z.input<ReturnType<typeof buildAcquisitionSchema>>
export type AcquisitionFormValues = z.output<ReturnType<typeof buildAcquisitionSchema>>

// -----------------------------------------------------------------------------
// A lender payment
// -----------------------------------------------------------------------------

export const PAYMENT_PURPOSE_VALUES = ['installment', 'extra', 'payoff', 'fee'] as const

export function buildFinancingPaymentSchema(currency: string) {
  return z
    .object({
      paidOn: businessDate,
      amount: z
        .string()
        .trim()
        .min(1, 'Enter what was paid.')
        .refine(
          (value) => parseMoneyToMinor(value, currency) !== null,
          'Enter the amount as a number.',
        )
        .transform((value) => parseMoneyToMinor(value, currency) as number)
        .refine((minor) => minor > 0, 'A payment has to be more than nothing.'),

      installmentId: z
        .string()
        .transform((value) => (value === '' ? null : value))
        .nullable(),
      purpose: z.enum(PAYMENT_PURPOSE_VALUES),

      /*
       * The split is optional in every sense. Somebody who only knows that
       * 4,300 left the account can save that, and what the components do not
       * explain stays unallocated rather than being guessed at.
       */
      principal: optionalMoney(currency, 'the principal'),
      interest: optionalMoney(currency, 'the interest'),
      fees: optionalMoney(currency, 'the fees'),

      method: z
        .string()
        .transform((value) => (value === '' ? null : value))
        .nullable()
        .refine(
          (value) =>
            value === null ||
            ['cash', 'card', 'bank_transfer', 'cheque', 'online', 'other'].includes(value),
          'Choose a payment method from the list.',
        ),
      reference: optionalText(96),
      notes: optionalText(2000),
    })
    .superRefine((values, ctx) => {
      const allocated = (values.principal ?? 0) + (values.interest ?? 0) + (values.fees ?? 0)
      if (allocated > values.amount) {
        ctx.addIssue({
          code: 'custom',
          path: ['principal'],
          message: 'The principal, interest and fees add up to more than the payment itself.',
        })
      }

      const today = new Date().toISOString().slice(0, 10)
      if (values.paidOn > today) {
        ctx.addIssue({
          code: 'custom',
          path: ['paidOn'],
          message: 'That date is in the future. Record a payment once it has been made.',
        })
      }
    })
}

export type FinancingPaymentFormInput = z.input<ReturnType<typeof buildFinancingPaymentSchema>>
export type FinancingPaymentFormValues = z.output<ReturnType<typeof buildFinancingPaymentSchema>>

export function emptyPaymentForm(todayIso: string): FinancingPaymentFormInput {
  return {
    paidOn: todayIso,
    amount: '',
    installmentId: '',
    purpose: 'installment',
    principal: '',
    interest: '',
    fees: '',
    method: '',
    reference: '',
    notes: '',
  }
}

/** What is left over once the stated components are taken out. */
export function unallocatedOf(values: {
  amount: number
  principal: number | null
  interest: number | null
  fees: number | null
}): number {
  return Math.max(
    0,
    values.amount - ((values.principal ?? 0) + (values.interest ?? 0) + (values.fees ?? 0)),
  )
}
