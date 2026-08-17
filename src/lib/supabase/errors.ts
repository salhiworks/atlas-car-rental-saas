/**
 * Turns database and auth failures into messages a rental agency can act on.
 *
 * Raw Postgres text ("new row violates row-level security policy for table
 * \"vehicles\"") is precise and useless to the person at the front desk. Every
 * constraint this schema can realistically trip is named here and given a
 * sentence that says what happened and what to do.
 */

export type AppErrorKind =
  | 'auth'
  | 'permission'
  | 'validation'
  | 'conflict'
  | 'notFound'
  | 'network'
  | 'configuration'
  | 'unknown'

/**
 * A failure with a message that is safe and useful to show a person.
 *
 * A real Error subclass, not a plain object: these values are thrown, and a
 * thrown non-Error loses its stack trace and defeats `instanceof` checks in
 * every handler downstream.
 */
export class AppError extends Error {
  readonly kind: AppErrorKind
  /** Postgres SQLSTATE or provider error code, kept for logging and support. */
  readonly code: string | undefined

  constructor(
    kind: AppErrorKind,
    message: string,
    options: { code?: string | undefined; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'AppError'
    this.kind = kind
    this.code = options.code
  }
}

interface PostgresLikeError {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
}

function isPostgresLikeError(error: unknown): error is PostgresLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  )
}

/**
 * Constraint-specific messages. Matched against the raw error text, which
 * includes the constraint or index name for integrity violations.
 */
const CONSTRAINT_MESSAGES: ReadonlyArray<readonly [RegExp, string, AppErrorKind]> = [
  [
    /rentals_no_vehicle_overlap/i,
    'This vehicle is already committed to another contract that overlaps these dates. Choose a different vehicle or adjust the period.',
    'conflict',
  ],
  [
    /vehicles_plate_unique_idx/i,
    'A vehicle with this registration plate is already in your fleet.',
    'conflict',
  ],
  [/vehicles_vin_unique_idx/i, 'A vehicle with this VIN is already in your fleet.', 'conflict'],
  [
    /rentals_reference_unique/i,
    'That contract reference is already in use. Refresh and try again.',
    'conflict',
  ],
  [
    /organization_members_unique_membership/i,
    'This person is already a member of your agency.',
    'conflict',
  ],
  [
    /organizations_slug_key/i,
    'Could not generate a unique address for that agency name. Try a slightly different name.',
    'conflict',
  ],
  [
    /rentals_period_valid/i,
    'The return date and time must be after the pick-up date and time.',
    'validation',
  ],
  [
    /rentals_odometer_progression/i,
    'The return odometer reading cannot be lower than the reading at pick-up.',
    'validation',
  ],
  [
    /rentals_discount_within_charges/i,
    'The discount cannot be larger than the total charges.',
    'validation',
  ],
  [
    /customers_name_present/i,
    'Enter a name: individuals need a first and last name, companies need a company name.',
    'validation',
  ],
  [
    /customers_license_period_valid/i,
    'The driving licence expiry date must be after its issue date.',
    'validation',
  ],
  [
    /does not match the contract currency/i,
    'This payment is in a different currency from the contract. Record it in the contract currency.',
    'validation',
  ],
  [
    /at least one active owner/i,
    'Every agency must keep at least one active owner. Promote another member to owner first.',
    'validation',
  ],
  [
    /cannot change your own role/i,
    'You cannot change your own role. Ask another owner or administrator to make the change.',
    'permission',
  ],
  [
    /only an owner can (add|remove) another owner|only an owner can grant or revoke/i,
    'Only an owner can manage other owners.',
    'permission',
  ],
  [
    /organizations_time_zone_check|is_valid_time_zone/i,
    'That is not a recognised time zone. Pick one from the list.',
    'validation',
  ],
  [
    /currency_code_format|value for domain public\.currency_code/i,
    'Enter a valid three-letter currency code, such as USD or EUR.',
    'validation',
  ],
  [
    /country_code_format|value for domain public\.country_code/i,
    'Enter a valid two-letter country code.',
    'validation',
  ],
  [
    /email_address_format|value for domain public\.email_address/i,
    'Enter a valid email address.',
    'validation',
  ],
  [
    /not a member of this organization/i,
    'You no longer have access to this agency. Sign out and back in, or ask an administrator.',
    'permission',
  ],

  // The rental lifecycle raises 23514 with wording written for the front desk.
  // Without these, the generic check-constraint fallback would replace a clear
  // sentence with "some of the values entered are not valid".
  [
    /a draft can only be confirmed or cancelled/i,
    'Only a draft can be confirmed. Refresh the page to see the current status.',
    'conflict',
  ],
  [
    /a reservation can only be checked out or cancelled/i,
    'This reservation has already moved on. Refresh the page to see its current status.',
    'conflict',
  ],
  [
    /must be returned and completed/i,
    'The vehicle is out with the customer. Record the return instead of cancelling.',
    'conflict',
  ],
  [/cannot change status again/i, 'This rental is closed and cannot be changed.', 'conflict'],
  [
    /name the primary driver/i,
    'Name the primary driver before confirming this reservation.',
    'validation',
  ],
  [
    /below the vehicle's recorded mileage/i,
    'That odometer reading is below the vehicle’s recorded mileage. Correct the vehicle’s odometer first if it is wrong.',
    'validation',
  ],
  [
    /below the reading at hand-over/i,
    'The return reading cannot be lower than the reading at pick-up.',
    'validation',
  ],
  [
    /record the (pick-up time|odometer reading|vehicle's return|the return)/i,
    'Record the odometer reading before continuing.',
    'validation',
  ],
  [
    /is still held\. refund or retain it/i,
    'A deposit is still being held on this contract. Refund or retain it before completing the rental.',
    'validation',
  ],
  [
    /is held as a deposit on this contract/i,
    'You cannot refund more than the deposit being held.',
    'validation',
  ],
  [
    /this reservation was cancelled\. record a refund/i,
    'This reservation was cancelled. Record a refund rather than a new payment.',
    'validation',
  ],
  [/that payment has already been voided/i, 'That payment has already been voided.', 'conflict'],
  [
    /an extension must end after/i,
    'An extension has to end after the current return date.',
    'validation',
  ],
  [
    /before the customer collects it/i,
    'The vehicle can only be changed before the customer collects it.',
    'conflict',
  ],
  [
    /retired from the fleet|not in service/i,
    'That vehicle is not available to rent.',
    'validation',
  ],
  [
    /confirm the reservation before issuing a contract/i,
    'Confirm the reservation before issuing a contract.',
    'conflict',
  ],
  [
    /a cancelled reservation has no contract/i,
    'A cancelled reservation has no contract to issue.',
    'conflict',
  ],
  [
    /the discount on this contract exceeds its charges/i,
    'The discount is larger than everything being charged on this contract.',
    'validation',
  ],
  [
    /a signed contract cannot be returned to unsigned/i,
    'A signed contract cannot be marked unsigned.',
    'conflict',
  ],
]

/** SQLSTATE fallbacks when no constraint-specific message matched. */
const SQLSTATE_MESSAGES: Readonly<Record<string, readonly [string, AppErrorKind]>> = {
  '23505': ['That record already exists.', 'conflict'],
  '23503': [
    'This record is still referenced elsewhere and cannot be removed. Archive it instead.',
    'conflict',
  ],
  '23514': [
    'Some of the values entered are not valid. Check the highlighted fields.',
    'validation',
  ],
  '23P01': ['This conflicts with an existing record for the same period.', 'conflict'],
  '22004': ['A required value was missing.', 'validation'],
  '22023': ['One of the values entered is not valid.', 'validation'],
  '42501': ['You do not have permission to do that.', 'permission'],
  '42P01': ['The database schema is out of date. Apply the pending migrations.', 'configuration'],
  '42883': ['The database schema is out of date. Apply the pending migrations.', 'configuration'],
  P0002: ['That record could not be found.', 'notFound'],
  PGRST116: ['That record could not be found.', 'notFound'],
  PGRST301: ['Your session has expired. Sign in again.', 'auth'],
}

/** Supabase Auth failures, matched on message because codes vary by provider. */
const AUTH_MESSAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/invalid login credentials/i, 'That email and password combination is not recognised.'],
  [/email not confirmed/i, 'Confirm your email address first — check your inbox for the link.'],
  [
    /user already registered|already been registered/i,
    'An account already exists for this email address.',
  ],
  [/password should be at least/i, 'Choose a longer password.'],
  [
    /for security purposes, you can only request this after/i,
    'Please wait a moment before trying again.',
  ],
  [
    /email rate limit exceeded|over_email_send_rate_limit/i,
    'Too many emails requested. Try again in a few minutes.',
  ],
  [/token has expired or is invalid|invalid_token/i, 'That link has expired. Request a new one.'],
  [/same as the old password/i, 'Choose a password you have not used before.'],
  [
    /signups not allowed|signup_disabled/i,
    'New registrations are currently disabled for this deployment.',
  ],
]

export function toAppError(error: unknown): AppError {
  // Already mapped — re-mapping would discard the specific message.
  if (error instanceof AppError) return error

  if (error instanceof Error && error.name === 'SupabaseNotConfiguredError') {
    return new AppError('configuration', 'The application is not connected to a database yet.', {
      cause: error,
    })
  }

  if (!isPostgresLikeError(error)) {
    return new AppError('unknown', 'Something went wrong. Please try again.', { cause: error })
  }

  const raw = [error.message, error.details ?? '', error.hint ?? ''].join(' ')
  const code = typeof error.code === 'string' ? error.code : undefined

  if (/failed to fetch|networkerror|network request failed|load failed/i.test(error.message)) {
    return new AppError(
      'network',
      'Could not reach the server. Check your connection and try again.',
      { code, cause: error },
    )
  }

  for (const [pattern, message, kind] of CONSTRAINT_MESSAGES) {
    if (pattern.test(raw)) return new AppError(kind, message, { code, cause: error })
  }

  for (const [pattern, message] of AUTH_MESSAGES) {
    if (pattern.test(error.message)) return new AppError('auth', message, { code, cause: error })
  }

  if (/row-level security/i.test(raw)) {
    return new AppError('permission', 'You do not have permission to do that in this agency.', {
      code,
      cause: error,
    })
  }

  if (code) {
    const mapped = SQLSTATE_MESSAGES[code]
    if (mapped) return new AppError(mapped[1], mapped[0], { code, cause: error })
  }

  return new AppError('unknown', 'Something went wrong. Please try again.', { code, cause: error })
}

/** Convenience for toasts and inline alerts. */
export function toErrorMessage(error: unknown): string {
  return toAppError(error).message
}
