import { z } from 'zod'

import { isCountryCode, isSupportedLocale } from '@/lib/i18n/regions'

import { normaliseDocumentNumber } from './identity'

/**
 * Customer and document validation.
 *
 * Every rule here has a matching CHECK constraint or unique index in the schema.
 * This layer exists so a person sees the problem on the field they are typing
 * in, not so the database can be trusted less.
 */

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
}

const optionalEmail = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine(
    (value) => value === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
    'Enter a valid email address, or leave it blank.',
  )

/**
 * Phone validation stays deliberately loose.
 *
 * Agencies serve visitors from anywhere and record numbers in whatever form the
 * customer gives. Enforcing one country's format would reject correct numbers;
 * matching happens on the digits-only form instead.
 */
function optionalPhone(label: string) {
  return z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine(
      (value) => value === null || (value.length >= 4 && value.length <= 32),
      `${label} must be between 4 and 32 characters, or left blank.`,
    )
    .refine(
      (value) => value === null || /[0-9]/.test(value),
      `${label} must contain at least one digit.`,
    )
}

const optionalCountry = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value.toUpperCase()))
  .nullable()
  .refine((value) => value === null || isCountryCode(value), 'Choose a country from the list.')

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const optionalDate = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine((value) => value === null || isRealDate(value), 'Enter a valid date, or leave it blank.')

const todayIso = () => new Date().toISOString().slice(0, 10)

export const CUSTOMER_TYPE_OPTIONS = [
  { value: 'individual', label: 'Individual' },
  { value: 'company', label: 'Company' },
] as const

export const customerSchema = z
  .object({
    customerType: z.enum(['individual', 'company']),
    firstName: optionalText(80),
    lastName: optionalText(80),
    companyName: optionalText(160),

    email: optionalEmail,
    phone: optionalPhone('Phone'),
    secondaryPhone: optionalPhone('Second phone'),

    dateOfBirth: optionalDate,
    nationalityCountryCode: optionalCountry,
    preferredLocale: z
      .string()
      .trim()
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .refine(
        (value) => value === null || isSupportedLocale(value),
        'Choose a language from the list.',
      ),

    addressLine1: optionalText(160),
    addressLine2: optionalText(160),
    city: optionalText(96),
    // "Region" rather than "State": most of the world does not have states, and
    // a US-shaped address form is wrong nearly everywhere this product runs.
    region: optionalText(96),
    postalCode: optionalText(24),
    countryCode: optionalCountry,

    notes: optionalText(4000),
  })
  .superRefine((values, ctx) => {
    // Mirrors customers_name_present in the schema.
    if (values.customerType === 'company') {
      if (!values.companyName) {
        ctx.addIssue({
          code: 'custom',
          path: ['companyName'],
          message: 'Enter the company name.',
        })
      }
    } else if (!values.firstName && !values.lastName) {
      ctx.addIssue({ code: 'custom', path: ['firstName'], message: 'Enter a first or last name.' })
    }

    if (values.dateOfBirth && values.dateOfBirth > todayIso()) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateOfBirth'],
        message: 'A date of birth cannot be in the future.',
      })
    }

    if (values.dateOfBirth && values.dateOfBirth < '1900-01-01') {
      ctx.addIssue({
        code: 'custom',
        path: ['dateOfBirth'],
        message: 'Enter a date of birth after 1900.',
      })
    }
  })

export type CustomerFormInput = z.input<typeof customerSchema>
export type CustomerFormValues = z.output<typeof customerSchema>

export function emptyCustomerForm(): CustomerFormInput {
  return {
    customerType: 'individual',
    firstName: '',
    lastName: '',
    companyName: '',
    email: '',
    phone: '',
    secondaryPhone: '',
    dateOfBirth: '',
    nationalityCountryCode: '',
    preferredLocale: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: '',
    notes: '',
  }
}

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

export const customerDocumentSchema = z
  .object({
    documentType: z.enum([
      'national_id',
      'passport',
      'residence_permit',
      'driver_license',
      'other',
    ]),
    documentNumber: z
      .string()
      .trim()
      .min(2, 'Enter the document number.')
      .max(64, 'That document number is too long.')
      .transform(normaliseDocumentNumber),
    issuingCountry: optionalCountry,
    issuedOn: optionalDate,
    expiresOn: optionalDate,
    /** Comma-separated on entry; stored as an array. */
    licenseClasses: z
      .string()
      .trim()
      .transform((value) =>
        value === ''
          ? null
          : value
              .split(',')
              .map((entry) => entry.trim().toUpperCase())
              .filter((entry) => entry.length > 0)
              .slice(0, 20),
      )
      .nullable(),
    notes: optionalText(2000),
  })
  .superRefine((values, ctx) => {
    if (values.issuedOn && values.expiresOn && values.expiresOn < values.issuedOn) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresOn'],
        message: 'The expiry date must be on or after the issue date.',
      })
    }

    if (values.licenseClasses && values.documentType !== 'driver_license') {
      ctx.addIssue({
        code: 'custom',
        path: ['licenseClasses'],
        message: 'Vehicle classes apply to a driving licence only.',
      })
    }

    if (values.documentNumber.replace(/[^A-Za-z0-9]/g, '').length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentNumber'],
        message: 'A document number must contain letters or digits.',
      })
    }
  })

export type CustomerDocumentFormInput = z.input<typeof customerDocumentSchema>
export type CustomerDocumentFormValues = z.output<typeof customerDocumentSchema>

export function emptyDocumentForm(
  documentType: CustomerDocumentFormInput['documentType'] = 'passport',
): CustomerDocumentFormInput {
  return {
    documentType,
    documentNumber: '',
    issuingCountry: '',
    issuedOn: '',
    expiresOn: '',
    licenseClasses: '',
    notes: '',
  }
}
