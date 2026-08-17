import type { CustomerDocumentType } from '@/types/database'

/**
 * Handling of the identifiers a rental agency collects.
 *
 * Two concerns live here and nowhere else: how a document number is normalised
 * for matching, and how much of one is shown on screen.
 *
 * The masking rule is deliberate. A passport number is not a display field — it
 * is evidence, checked once at the counter. Showing it in full on every list row
 * puts it in screenshots, over shoulders and in support tickets for no
 * operational gain, so the default is a masked tail and revealing the whole
 * value is a decision someone makes.
 */

/**
 * Comparison form: uppercase alphanumerics only.
 *
 * Mirrors `document_number_normalized` in the database exactly. A passport
 * written "AB 123 456" and "ab123456" is the same passport, and the client must
 * agree with the unique index or it will accept what the save then rejects.
 */
export function documentNumberKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Storage form: trimmed, internal whitespace collapsed, left as presented otherwise. */
export function normaliseDocumentNumber(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * Digits only, for matching phone numbers typed with different spacing or
 * international prefixes.
 *
 * Deliberately not a full E.164 parse: this product is international, agencies
 * record numbers in whatever form the customer gives, and guessing a country
 * code would corrupt more numbers than it would tidy.
 */
export function phoneKey(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

/**
 * Masks all but the last four characters.
 *
 * Four is the conventional confirmation length — enough for a person to match
 * the document in their hand, not enough to be the identifier.
 */
export function maskDocumentNumber(value: string | null | undefined, visible = 4): string {
  if (!value) return '—'

  const trimmed = value.trim()
  if (trimmed.length <= visible) return trimmed

  const tail = trimmed.slice(-visible)
  return `•••• ${tail}`
}

export const DOCUMENT_TYPE_LABELS: Record<CustomerDocumentType, string> = {
  national_id: 'National ID',
  passport: 'Passport',
  residence_permit: 'Residence permit',
  driver_license: 'Driving licence',
  other: 'Other document',
}

/**
 * Document types offered when adding identification.
 *
 * Country-neutral on purpose: an agency in Morocco, Portugal or Kenya sees the
 * same list. Which document a given country expects is a labelling and defaults
 * question for later configuration, not a rule to encode here.
 */
export const DOCUMENT_TYPE_OPTIONS = (
  ['passport', 'national_id', 'residence_permit', 'driver_license', 'other'] as const
).map((value) => ({ value, label: DOCUMENT_TYPE_LABELS[value] }))

export function isDriverLicence(type: CustomerDocumentType): boolean {
  return type === 'driver_license'
}

/**
 * Driver eligibility, as the Rentals module will need to ask it.
 *
 * "No licence recorded" is kept distinct from "expired": the first is a records
 * gap that staff can fix at the counter, the second is a person who must not be
 * handed keys. Neither is ever treated as valid.
 */
export type DriverEligibility = 'eligible' | 'expired' | 'no-licence' | 'expiry-unknown'

export const DRIVER_ELIGIBILITY_LABELS: Record<DriverEligibility, string> = {
  eligible: 'Can drive',
  expired: 'Licence expired',
  'no-licence': 'No licence on file',
  'expiry-unknown': 'Licence expiry unknown',
}

export interface DriverLicenceFacts {
  readonly hasLicence: boolean
  readonly expiresOn: string | null
}

/**
 * Decides whether a person may be an authorised driver.
 *
 * Takes the already-computed expiry state rather than a date, so this shares the
 * one compliance rule with Vehicles instead of re-deriving "expired" a second,
 * slightly different way.
 */
export function driverEligibility(
  facts: DriverLicenceFacts,
  expiryState: 'valid' | 'due-soon' | 'expired' | 'unrecorded',
): DriverEligibility {
  if (!facts.hasLicence) return 'no-licence'
  if (expiryState === 'expired') return 'expired'
  if (expiryState === 'unrecorded') return 'expiry-unknown'
  return 'eligible'
}
