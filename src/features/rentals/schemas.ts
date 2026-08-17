import { z } from 'zod'

import { parseMoneyToMinor } from '@/lib/money/money'

/**
 * Rental form validation.
 *
 * Each rule here has a matching constraint or trigger in the database. This
 * layer exists so a person sees the problem on the field they are typing in —
 * not so the database can be trusted less.
 */

function moneyField(currency: string, label: string, { allowZero = true } = {}) {
  return z
    .string()
    .trim()
    .transform((value) => (value === '' ? '0' : value))
    .refine((value) => parseMoneyToMinor(value, currency) !== null, `Enter ${label} as a number.`)
    .transform((value) => parseMoneyToMinor(value, currency) as number)
    .refine((minor) => minor >= 0, `${label} cannot be negative.`)
    .refine((minor) => allowZero || minor > 0, `Enter ${label}.`)
}

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
}

/** `datetime-local` gives "YYYY-MM-DDTHH:mm"; the page converts it in the agency zone. */
const localDateTime = z
  .string()
  .trim()
  .min(1, 'Choose a date and time.')
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value), 'Choose a date and time.')

// -----------------------------------------------------------------------------
// The period, which is chosen before anything else
// -----------------------------------------------------------------------------

export const rentalPeriodSchema = z
  .object({
    startsAt: localDateTime,
    endsAt: localDateTime,
    pickupLocation: optionalText(160),
    returnLocation: optionalText(160),
  })
  .superRefine((values, ctx) => {
    if (values.endsAt <= values.startsAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'The return must be after the collection.',
      })
    }
  })

export type RentalPeriodInput = z.input<typeof rentalPeriodSchema>
export type RentalPeriodValues = z.output<typeof rentalPeriodSchema>

// -----------------------------------------------------------------------------
// The whole rental
// -----------------------------------------------------------------------------

export function buildRentalSchema(currency: string) {
  return z
    .object({
      vehicleId: z.string().min(1, 'Choose a vehicle.'),
      customerId: z.string().min(1, 'Choose who is renting.'),
      primaryDriverId: z.string().min(1, 'Name the primary driver.'),
      additionalDriverIds: z.array(z.string()).max(6, 'Six additional drivers is the limit.'),

      startsAt: localDateTime,
      endsAt: localDateTime,
      pickupLocation: optionalText(160),
      returnLocation: optionalText(160),

      dailyRate: moneyField(currency, 'the daily rate'),
      deposit: moneyField(currency, 'the deposit'),
      taxRateBps: z
        .number()
        .int()
        .min(0, 'A tax rate cannot be negative.')
        .max(100000, 'That tax rate is not plausible.'),
      taxLabel: optionalText(40),

      notes: optionalText(4000),
    })
    .superRefine((values, ctx) => {
      if (values.endsAt <= values.startsAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['endsAt'],
          message: 'The return must be after the collection.',
        })
      }
      if (values.additionalDriverIds.includes(values.primaryDriverId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['additionalDriverIds'],
          message: 'The primary driver is already on the contract.',
        })
      }
      if (new Set(values.additionalDriverIds).size !== values.additionalDriverIds.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['additionalDriverIds'],
          message: 'Each driver can only be added once.',
        })
      }
    })
}

export type RentalFormInput = z.input<ReturnType<typeof buildRentalSchema>>
export type RentalFormValues = z.output<ReturnType<typeof buildRentalSchema>>

export function emptyRentalForm(taxRateBps = 0): RentalFormInput {
  return {
    vehicleId: '',
    customerId: '',
    primaryDriverId: '',
    additionalDriverIds: [],
    startsAt: '',
    endsAt: '',
    pickupLocation: '',
    returnLocation: '',
    dailyRate: '',
    deposit: '',
    taxRateBps,
    taxLabel: '',
    notes: '',
  }
}

// -----------------------------------------------------------------------------
// Charges
// -----------------------------------------------------------------------------

export const CHARGE_KIND_VALUES = [
  'base_rental',
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
  'discount',
  'other',
] as const

export function buildChargeSchema(currency: string) {
  return z.object({
    kind: z.enum(CHARGE_KIND_VALUES),
    description: z
      .string()
      .trim()
      .min(1, 'Say what this charge is for.')
      .max(200, 'Use 200 characters or fewer.'),
    quantity: z
      .string()
      .trim()
      .transform((value) => (value === '' ? '1' : value))
      .refine(
        (value) => Number(value) > 0 && Number(value) <= 100000,
        'Enter a quantity above zero.',
      )
      .transform((value) => Number(value)),
    amount: moneyField(currency, 'the amount', { allowZero: false }),
    isTaxable: z.boolean(),
  })
}

export type ChargeFormInput = z.input<ReturnType<typeof buildChargeSchema>>
export type ChargeFormValues = z.output<ReturnType<typeof buildChargeSchema>>

export function emptyChargeForm(): ChargeFormInput {
  return { kind: 'other', description: '', quantity: '1', amount: '', isTaxable: true }
}

// -----------------------------------------------------------------------------
// Money in and out
// -----------------------------------------------------------------------------

export const PAYMENT_METHOD_VALUES = [
  'cash',
  'card',
  'bank_transfer',
  'cheque',
  'online',
  'other',
] as const

export function buildPaymentSchema(currency: string) {
  return z.object({
    direction: z.enum(['inbound', 'outbound']),
    purpose: z.enum(['rental_charge', 'deposit']),
    method: z.enum(PAYMENT_METHOD_VALUES),
    amount: moneyField(currency, 'the amount', { allowZero: false }),
    paidAt: localDateTime,
    reference: optionalText(80),
    notes: optionalText(500),
  })
}

export type PaymentFormInput = z.input<ReturnType<typeof buildPaymentSchema>>
export type PaymentFormValues = z.output<ReturnType<typeof buildPaymentSchema>>

// -----------------------------------------------------------------------------
// Handover
// -----------------------------------------------------------------------------

export const handoverSchema = z.object({
  odometer: z
    .string()
    .trim()
    .min(1, 'Record the odometer reading.')
    .refine(
      (value) => /^\d+$/.test(value.replace(/[\s,]/g, '')),
      'Enter the reading in whole units.',
    )
    .transform((value) => Number(value.replace(/[\s,]/g, '')))
    .refine((value) => value <= 10_000_000, 'That reading is not plausible.'),
  fuelPercent: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : Number(value)))
    .nullable()
    .refine(
      (value) => value === null || (Number.isFinite(value) && value >= 0 && value <= 100),
      'Fuel is a percentage between 0 and 100.',
    ),
  notes: optionalText(4000),
  at: localDateTime,
})

export type HandoverFormInput = z.input<typeof handoverSchema>
export type HandoverFormValues = z.output<typeof handoverSchema>

// -----------------------------------------------------------------------------
// Extension
// -----------------------------------------------------------------------------

export function buildExtensionSchema(currency: string) {
  return z.object({
    newEndsAt: localDateTime,
    charge: moneyField(currency, 'the extension charge'),
    description: optionalText(200),
  })
}

export type ExtensionFormInput = z.input<ReturnType<typeof buildExtensionSchema>>
export type ExtensionFormValues = z.output<ReturnType<typeof buildExtensionSchema>>

// -----------------------------------------------------------------------------
// Agency contract terms
// -----------------------------------------------------------------------------

export const contractTermsSchema = z.object({
  contractTerms: optionalText(20000),
  fuelPolicy: optionalText(2000),
  mileagePolicy: optionalText(2000),
  lateReturnPolicy: optionalText(2000),
  damagePolicy: optionalText(2000),
  depositPolicy: optionalText(2000),
  contractFooter: optionalText(1000),
  taxRateBps: z.number().int().min(0).max(100000),
  taxLabel: optionalText(40),
})

export type ContractTermsInput = z.input<typeof contractTermsSchema>
export type ContractTermsValues = z.output<typeof contractTermsSchema>
