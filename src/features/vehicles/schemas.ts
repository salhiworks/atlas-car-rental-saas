import { z } from 'zod'

import { isValidCurrencyCode, parseMoneyToMinor } from '@/lib/money/money'

import { isPlausibleVin, modelYearRange, normalisePlate, normaliseVin } from './normalise'

/**
 * Vehicle validation.
 *
 * Every rule here has a matching CHECK constraint or unique index in the
 * schema — this layer exists so a person sees the problem on the field they are
 * typing in, not so the database can be trusted less.
 */

/** Empty text means "not recorded", never an empty string in a nullable column. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
}

/** An optional `date` column: '' becomes null, anything present must be a real date. */
const optionalDate = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine((value) => {
    if (value === null) return true
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && value === parsed.toISOString().slice(0, 10)
  }, 'Enter a valid date, or leave it blank.')

const optionalWholeNumber = (max: number, label: string) =>
  z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine((value) => value === null || /^\d+$/.test(value), `${label} must be a whole number.`)
    .refine((value) => value === null || Number(value) <= max, `${label} looks too large.`)
    .transform((value) => (value === null ? null : Number(value)))

export const VEHICLE_STATUS_OPTIONS = [
  { value: 'available', label: 'In service' },
  { value: 'maintenance', label: 'In maintenance' },
  { value: 'unavailable', label: 'Off the road' },
] as const

export const FUEL_TYPE_OPTIONS = [
  { value: 'petrol', label: 'Petrol' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'plug_in_hybrid', label: 'Plug-in hybrid' },
  { value: 'electric', label: 'Electric' },
  { value: 'lpg', label: 'LPG' },
  { value: 'cng', label: 'CNG' },
  { value: 'other', label: 'Other' },
] as const

export const TRANSMISSION_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'automatic', label: 'Automatic' },
] as const

/**
 * Builds the schema for one agency.
 *
 * The currency is needed to parse the daily rate into the right number of minor
 * units — 45.5 is 4550 in EUR and 45 in JPY — so the schema is a function of the
 * agency rather than a module-level constant.
 */
export function buildVehicleSchema(currency: string, now: Date = new Date()) {
  const years = modelYearRange(now)

  const dailyRate = z
    .string()
    .trim()
    .min(1, 'Enter a daily rate, or 0 if it is not for hire.')
    .transform((value, ctx) => {
      const minor = parseMoneyToMinor(value, currency)
      if (minor === null) {
        ctx.addIssue({ code: 'custom', message: 'Enter an amount, for example 450 or 450.00.' })
        return z.NEVER
      }
      if (minor < 0) {
        ctx.addIssue({ code: 'custom', message: 'A daily rate cannot be negative.' })
        return z.NEVER
      }
      return minor
    })

  return z
    .object({
      make: z.string().trim().min(1, 'Enter the make.').max(60, 'That make is too long.'),
      model: z.string().trim().min(1, 'Enter the model.').max(60, 'That model is too long.'),
      modelYear: z
        .string()
        .trim()
        .transform((value) => (value === '' ? null : value))
        .nullable()
        .refine((value) => value === null || /^\d{4}$/.test(value), 'Enter a four-digit year.')
        .refine((value) => {
          if (value === null) return true
          const year = Number(value)
          return year >= years.min && year <= years.max
        }, `Enter a year between ${years.min} and ${years.max}.`)
        .transform((value) => (value === null ? null : Number(value))),

      registrationPlate: z
        .string()
        .trim()
        .min(1, 'Enter the registration plate.')
        .max(24, 'That plate is too long.')
        .transform(normalisePlate),

      vin: z
        .string()
        .trim()
        .transform((value) => (value === '' ? null : normaliseVin(value)))
        .nullable()
        .refine(
          (value) => value === null || isPlausibleVin(value),
          'A VIN uses letters and digits only, and never the letters I, O or Q.',
        ),

      color: optionalText(40),
      category: optionalText(60),
      fuelType: z
        .enum(['petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'lpg', 'cng', 'other'])
        .nullable(),
      transmission: z.enum(['manual', 'automatic']).nullable(),
      seats: optionalWholeNumber(99, 'Seats'),

      odometer: z
        .string()
        .trim()
        .min(1, 'Enter the current odometer reading.')
        .refine(
          (value) => /^\d+$/.test(value),
          'The odometer must be a whole number, with no sign.',
        )
        .refine((value) => Number(value) <= 9_999_999, 'That odometer reading looks too large.')
        .transform(Number),

      dailyRate,
      currency: z.string().refine(isValidCurrencyCode, 'Choose a currency.'),
      status: z.enum(['available', 'maintenance', 'unavailable']),

      insuranceExpiresOn: optionalDate,
      inspectionExpiresOn: optionalDate,
      registrationExpiresOn: optionalDate,
      nextServiceOn: optionalDate,

      notes: optionalText(4000),
    })
    .superRefine((values, ctx) => {
      // Mirrors the vehicles_acquisition_currency_required spirit: a plate must
      // stay distinguishable once normalised.
      if (values.registrationPlate.replace(/[^A-Z0-9]/g, '').length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['registrationPlate'],
          message: 'A plate must contain at least one letter or digit.',
        })
      }
    })
}

export type VehicleFormInput = z.input<ReturnType<typeof buildVehicleSchema>>
export type VehicleFormValues = z.output<ReturnType<typeof buildVehicleSchema>>

/** Blank form state for a new vehicle, seeded from the agency defaults. */
export function emptyVehicleForm(currency: string): VehicleFormInput {
  return {
    make: '',
    model: '',
    modelYear: '',
    registrationPlate: '',
    vin: '',
    color: '',
    category: '',
    fuelType: null,
    transmission: null,
    seats: '',
    odometer: '0',
    dailyRate: '',
    currency,
    status: 'available',
    insuranceExpiresOn: '',
    inspectionExpiresOn: '',
    registrationExpiresOn: '',
    nextServiceOn: '',
    notes: '',
  }
}
