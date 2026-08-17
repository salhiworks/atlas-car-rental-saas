import { z } from 'zod'

import { isValidTimeZone } from '@/lib/datetime/timezone'
import { isValidCurrencyCode } from '@/lib/money/money'

/**
 * Validation is defence in depth, not the only defence: the same rules exist as
 * CHECK constraints in the schema. These exist so a person gets a useful message
 * on the field they are typing in, rather than a round trip and a database error.
 */

const email = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(320, 'That email address is too long.')
  .email('Enter a valid email address, like name@agency.com.')

/**
 * Supabase enforces a minimum of 6 characters by default. Eight is required
 * here because this account can hold an agency's entire financial record.
 */
const password = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Passwords cannot be longer than 72 characters.')

export const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.'),
})

export type SignInInput = z.infer<typeof signInSchema>

export const signUpSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your name.').max(120, 'That name is too long.'),
    email,
    password,
    confirmPassword: z.string(),
    organizationName: z
      .string()
      .trim()
      .min(2, 'Enter your agency name.')
      .max(120, 'That name is too long.'),
    countryCode: z.string().length(2, 'Choose a country.'),
    defaultCurrency: z.string().refine(isValidCurrencyCode, 'Choose a currency.'),
    timeZone: z.string().refine(isValidTimeZone, 'Choose a time zone.'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Both passwords must match.',
    path: ['confirmPassword'],
  })

export type SignUpInput = z.infer<typeof signUpSchema>

export const forgotPasswordSchema = z.object({ email })
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>

export const resetPasswordSchema = z
  .object({
    password,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'Both passwords must match.',
    path: ['confirmPassword'],
  })

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>

export const createOrganizationSchema = z.object({
  organizationName: z
    .string()
    .trim()
    .min(2, 'Enter your agency name.')
    .max(120, 'That name is too long.'),
  countryCode: z.string().length(2, 'Choose a country.'),
  defaultCurrency: z.string().refine(isValidCurrencyCode, 'Choose a currency.'),
  timeZone: z.string().refine(isValidTimeZone, 'Choose a time zone.'),
})

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
