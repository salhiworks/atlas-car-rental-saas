import { z } from 'zod'

import { isValidTimeZone } from '@/lib/datetime/timezone'
import { isCountryCode, isSupportedLocale } from '@/lib/i18n/regions'
import { isValidCurrencyCode } from '@/lib/money/money'

/**
 * An empty text input means "no value", not an empty string.
 *
 * Storing `''` in a nullable column makes every later "is this set?" check wrong
 * in a way that is tedious to unpick, so the boundary is normalised here.
 */
function optionalText(max: number, message?: string) {
  return z
    .string()
    .trim()
    .max(max, message ?? `Use ${max} characters or fewer.`)
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

const optionalPhone = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine(
    (value) => value === null || (value.length >= 4 && value.length <= 32),
    'Enter a phone number between 4 and 32 characters, or leave it blank.',
  )

const optionalWebsite = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine((value) => {
    if (value === null) return true
    try {
      const url = new URL(value.startsWith('http') ? value : `https://${value}`)
      return url.hostname.includes('.')
    } catch {
      return false
    }
  }, 'Enter a valid web address, or leave it blank.')

export const agencySettingsSchema = z.object({
  name: z.string().trim().min(2, 'Enter your agency name.').max(120, 'That name is too long.'),
  legalName: optionalText(160),
  taxIdentifier: optionalText(64),

  email: optionalEmail,
  phone: optionalPhone,
  website: optionalWebsite,

  addressLine1: optionalText(160),
  addressLine2: optionalText(160),
  city: optionalText(96),
  region: optionalText(96),
  postalCode: optionalText(24),
  countryCode: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine((value) => value === null || isCountryCode(value), 'Choose a country from the list.'),

  defaultCurrency: z.string().refine(isValidCurrencyCode, 'Choose a currency.'),
  timeZone: z.string().refine(isValidTimeZone, 'Choose a time zone.'),
  locale: z.string().refine(isSupportedLocale, 'Choose a language.'),
})

export type AgencySettingsInput = z.input<typeof agencySettingsSchema>
export type AgencySettingsOutput = z.output<typeof agencySettingsSchema>
