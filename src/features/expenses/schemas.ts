import { z } from 'zod'

import { parseMoneyToMinor } from '@/lib/money/money'

/**
 * Expense validation.
 *
 * Every rule here has a matching CHECK constraint, trigger or policy in the
 * schema. This layer exists so a person sees the problem on the field they are
 * typing in — not so the database can be trusted less.
 */

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
}

/** `YYYY-MM-DD`. A cost is dated, not timestamped — see the business-date note. */
const businessDate = z
  .string()
  .trim()
  .min(1, 'Choose the date the cost was incurred.')
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), 'Choose a valid date.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, 'That date does not exist.')

export const PAYMENT_METHOD_VALUES = [
  'cash',
  'card',
  'bank_transfer',
  'cheque',
  'online',
  'other',
] as const

export const PAYMENT_METHOD_LABELS: Readonly<
  Record<(typeof PAYMENT_METHOD_VALUES)[number], string>
> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  online: 'Online',
  other: 'Other',
}

export function buildExpenseSchema(currency: string) {
  return z
    .object({
      incurredOn: businessDate,
      description: z
        .string()
        .trim()
        .min(1, 'Say what this cost was for.')
        .max(500, 'Use 500 characters or fewer.'),

      amount: z
        .string()
        .trim()
        .min(1, 'Enter the amount.')
        .refine(
          (value) => parseMoneyToMinor(value, currency) !== null,
          'Enter the amount as a number.',
        )
        .transform((value) => parseMoneyToMinor(value, currency) as number)
        .refine((minor) => minor > 0, 'A cost has to be more than nothing.'),

      taxAmount: z
        .string()
        .trim()
        .transform((value) => (value === '' ? '0' : value))
        .refine(
          (value) => parseMoneyToMinor(value, currency) !== null,
          'Enter the tax as a number.',
        )
        .transform((value) => parseMoneyToMinor(value, currency) as number)
        .refine((minor) => minor >= 0, 'Tax cannot be negative.'),

      taxRateBps: z.number().int().min(0).max(100000).nullable(),
      taxLabel: optionalText(40),

      currency: z
        .string()
        .trim()
        .length(3, 'A currency is three letters.')
        .transform((value) => value.toUpperCase()),

      categoryId: z.string().min(1, 'Choose a category.'),
      allocation: z.enum(['overhead', 'vehicle', 'rental']),
      vehicleId: z
        .string()
        .transform((value) => (value === '' ? null : value))
        .nullable(),
      rentalId: z
        .string()
        .transform((value) => (value === '' ? null : value))
        .nullable(),

      vendorId: z
        .string()
        .transform((value) => (value === '' ? null : value))
        .nullable(),
      paymentMethod: z
        .string()
        .transform((value) => (value === '' ? null : value))
        .nullable()
        .refine(
          (value) => value === null || (PAYMENT_METHOD_VALUES as readonly string[]).includes(value),
          'Choose a payment method from the list.',
        ),
      reference: optionalText(96),
      notes: optionalText(2000),
      odometer: z
        .string()
        .trim()
        .transform((value) => (value === '' ? null : Number(value.replace(/[\s,]/g, ''))))
        .nullable()
        .refine(
          (value) =>
            value === null || (Number.isInteger(value) && value >= 0 && value <= 10_000_000),
          'Enter the reading in whole units.',
        ),
    })
    .superRefine((values, ctx) => {
      // Mirrors expenses_tax_within_amount.
      if (values.taxAmount > values.amount) {
        ctx.addIssue({
          code: 'custom',
          path: ['taxAmount'],
          message: 'The tax cannot be more than the amount it is part of.',
        })
      }

      // Mirrors expenses_allocation_consistent. The database refuses these
      // outright; saying so here means the desk finds out before saving.
      if (values.allocation === 'vehicle' && !values.vehicleId) {
        ctx.addIssue({ code: 'custom', path: ['vehicleId'], message: 'Choose the vehicle.' })
      }
      if (values.allocation === 'rental' && !values.rentalId) {
        ctx.addIssue({ code: 'custom', path: ['rentalId'], message: 'Choose the rental.' })
      }

      // A cost dated in the future is almost always a typo in the year.
      const today = new Date().toISOString().slice(0, 10)
      if (values.incurredOn > today) {
        ctx.addIssue({
          code: 'custom',
          path: ['incurredOn'],
          message: 'That date is in the future. Record a cost once it has been incurred.',
        })
      }
    })
}

export type ExpenseFormInput = z.input<ReturnType<typeof buildExpenseSchema>>
export type ExpenseFormValues = z.output<ReturnType<typeof buildExpenseSchema>>

export function emptyExpenseForm(currency: string, todayIso: string): ExpenseFormInput {
  return {
    incurredOn: todayIso,
    description: '',
    amount: '',
    taxAmount: '',
    taxRateBps: null,
    taxLabel: '',
    currency,
    categoryId: '',
    allocation: 'overhead',
    vehicleId: '',
    rentalId: '',
    vendorId: '',
    paymentMethod: '',
    reference: '',
    notes: '',
    odometer: '',
  }
}

// -----------------------------------------------------------------------------
// Vendors and categories
// -----------------------------------------------------------------------------

export const vendorSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the supplier’s name.')
    .max(120, 'Use 120 characters or fewer.'),
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
      (value) => value === null || (value.length >= 4 && value.length <= 32),
      'A phone number is between 4 and 32 characters.',
    ),
  taxIdentifier: optionalText(60),
  address: optionalText(300),
  notes: optionalText(2000),
})

export type VendorFormInput = z.input<typeof vendorSchema>
export type VendorFormValues = z.output<typeof vendorSchema>

export function emptyVendorForm(): VendorFormInput {
  return { name: '', email: '', phone: '', taxIdentifier: '', address: '', notes: '' }
}

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the category a name.')
    .max(60, 'Use 60 characters or fewer.'),
  description: optionalText(300),
  defaultAllocation: z
    .string()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine(
      (value) => value === null || ['overhead', 'vehicle', 'rental'].includes(value),
      'Choose where this kind of cost usually belongs.',
    ),
})

export type CategoryFormInput = z.input<typeof categorySchema>
export type CategoryFormValues = z.output<typeof categorySchema>
