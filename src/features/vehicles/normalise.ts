/**
 * Normalisation for the two identifiers a fleet is searched and deduplicated by.
 *
 * The database enforces uniqueness on `upper(btrim(registration_plate))` per
 * live vehicle, so the client must reason about plates the same way — otherwise
 * "12-A-3456" and "12 a 3456" look distinct in the interface and collide on save.
 */

/**
 * Comparison form of a registration plate: uppercase, no separators.
 *
 * Deliberately *not* what gets stored. Plate formats differ by country and
 * agencies want to see them the way they are printed, so the typed form is kept
 * and only the comparison is normalised.
 */
export function plateComparisonKey(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Storage form: trimmed, uppercased, internal whitespace collapsed. */
export function normalisePlate(plate: string): string {
  return plate.trim().replace(/\s+/g, ' ').toUpperCase()
}

/**
 * VINs are a defined 17-character alphanumeric standard that excludes I, O and Q
 * to avoid confusion with 1 and 0. Older and non-road vehicles carry shorter
 * chassis numbers, so length is validated leniently and only the character set
 * is enforced.
 */
export function normaliseVin(vin: string): string {
  return vin.trim().toUpperCase().replace(/\s+/g, '')
}

const VIN_STANDARD_LENGTH = 17
const VIN_ALLOWED = /^[A-HJ-NPR-Z0-9]+$/

export function isPlausibleVin(vin: string): boolean {
  const normalised = normaliseVin(vin)
  if (normalised.length < 5 || normalised.length > 32) return false
  return VIN_ALLOWED.test(normalised)
}

/** True for a full-length VIN — used to hint rather than to reject. */
export function isStandardLengthVin(vin: string): boolean {
  return normaliseVin(vin).length === VIN_STANDARD_LENGTH
}

/**
 * The plausible range for a model year.
 *
 * Next year is allowed because agencies buy model-year-ahead stock; the lower
 * bound keeps a mistyped "1900" from passing as a classic.
 */
export function modelYearRange(now: Date = new Date()): { min: number; max: number } {
  return { min: 1950, max: now.getUTCFullYear() + 2 }
}
