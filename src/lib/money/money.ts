/**
 * Monetary arithmetic and formatting.
 *
 * Money is represented everywhere — database, network, application state — as
 * an integer number of MINOR units (cents, centimes, fils) paired with an ISO
 * 4217 code. Fractional currency amounts are never held in a JS number, because
 * `0.1 + 0.2 !== 0.3` is not an acceptable property for an accounting record.
 *
 * Amounts arrive from PostgREST as JSON numbers. That is exact for integers up
 * to Number.MAX_SAFE_INTEGER — roughly 90 trillion units in a two-decimal
 * currency — which is far beyond any real agency's books. `assertSafeMinor`
 * guards the boundary rather than trusting it silently.
 */

export type CurrencyCode = string

export interface MoneyAmount {
  readonly amountMinor: number
  readonly currency: CurrencyCode
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly expected: CurrencyCode,
    readonly received: CurrencyCode,
  ) {
    super(`Cannot combine amounts in ${expected} and ${received}.`)
    this.name = 'CurrencyMismatchError'
  }
}

const FALLBACK_FRACTION_DIGITS = 2
const fractionDigitsCache = new Map<string, number>()

export function isValidCurrencyCode(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency)
}

/**
 * Minor units per major unit, as an exponent.
 *
 * Derived from Intl rather than a hand-maintained table, so JPY (0), most
 * currencies (2) and KWD/BHD/TND (3) are all correct without this module
 * needing to know about them individually.
 */
export function getCurrencyFractionDigits(currency: CurrencyCode): number {
  const key = currency.toUpperCase()
  const cached = fractionDigitsCache.get(key)
  if (cached !== undefined) return cached

  let digits = FALLBACK_FRACTION_DIGITS
  if (isValidCurrencyCode(key)) {
    try {
      const resolved = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: key,
      }).resolvedOptions()
      digits = resolved.maximumFractionDigits ?? FALLBACK_FRACTION_DIGITS
    } catch {
      digits = FALLBACK_FRACTION_DIGITS
    }
  }

  fractionDigitsCache.set(key, digits)
  return digits
}

export function assertSafeMinor(amountMinor: number): void {
  if (!Number.isFinite(amountMinor) || !Number.isInteger(amountMinor)) {
    throw new TypeError(`Monetary minor units must be an integer, received ${amountMinor}.`)
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError(`Monetary amount ${amountMinor} exceeds safe integer precision.`)
  }
}

export function money(amountMinor: number, currency: CurrencyCode): MoneyAmount {
  assertSafeMinor(amountMinor)
  return { amountMinor, currency: currency.toUpperCase() }
}

export function addMoney(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency)
  return money(a.amountMinor + b.amountMinor, a.currency)
}

export function subtractMoney(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency)
  return money(a.amountMinor - b.amountMinor, a.currency)
}

export function sumMoney(amounts: readonly MoneyAmount[], currency: CurrencyCode): MoneyAmount {
  return amounts.reduce<MoneyAmount>((total, amount) => addMoney(total, amount), money(0, currency))
}

/**
 * Multiplies by a plain quantity (rental days, unit count) and rounds
 * half-away-from-zero, which is what invoices are expected to do.
 */
export function multiplyMoney(amount: MoneyAmount, factor: number): MoneyAmount {
  if (!Number.isFinite(factor)) throw new TypeError('Factor must be a finite number.')
  const product = amount.amountMinor * factor
  const rounded = product < 0 ? -Math.round(-product) : Math.round(product)
  return money(rounded, amount.currency)
}

/**
 * Converts minor units to a major-unit number.
 *
 * For display and form editing only — never accumulate with the result. The
 * division reintroduces binary floating point, which is exactly what the minor
 * unit representation exists to avoid.
 */
export function minorToMajor(amountMinor: number, currency: CurrencyCode): number {
  return amountMinor / 10 ** getCurrencyFractionDigits(currency)
}

/** Renders minor units as a plain decimal string, e.g. 123456 EUR -> "1234.56". */
export function minorToDecimalString(amountMinor: number, currency: CurrencyCode): string {
  assertSafeMinor(amountMinor)
  const digits = getCurrencyFractionDigits(currency)
  if (digits === 0) return String(amountMinor)

  const negative = amountMinor < 0
  const absolute = Math.abs(amountMinor)
    .toString()
    .padStart(digits + 1, '0')
  const whole = absolute.slice(0, absolute.length - digits)
  const fraction = absolute.slice(absolute.length - digits)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

/**
 * Parses user input into minor units without ever going through a float.
 *
 * Accepts the shapes a person actually types: "1234.56", "1 234,56",
 * "1,234.56", "-45", "€12.30". Grouping separators are inferred from position
 * rather than from locale, because a browser locale does not reliably predict
 * what a given user types into a given field.
 *
 * Returns null when the input cannot be understood — callers surface a
 * validation message rather than guessing.
 */
export function parseMoneyToMinor(input: string, currency: CurrencyCode): number | null {
  const raw = input.trim()
  if (raw === '') return null

  const negative = /^[-(]/.test(raw) || raw.endsWith('-')
  // Keep digits and the two candidate separators; drop currency symbols, spaces,
  // non-breaking spaces, apostrophe grouping and parentheses.
  const cleaned = raw.replace(/[^\d.,]/g, '')
  if (cleaned === '') return null

  const lastDot = cleaned.lastIndexOf('.')
  const lastComma = cleaned.lastIndexOf(',')

  let decimalSeparator: '.' | ',' | null = null
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSeparator = lastDot > lastComma ? '.' : ','
  } else if (lastDot >= 0) {
    decimalSeparator = '.'
  } else if (lastComma >= 0) {
    decimalSeparator = ','
  }

  const digits = getCurrencyFractionDigits(currency)

  let wholePart: string
  let fractionPart: string

  if (decimalSeparator === null) {
    wholePart = cleaned
    fractionPart = ''
  } else {
    const index = decimalSeparator === '.' ? lastDot : lastComma
    const tail = cleaned.slice(index + 1)

    // A single separator followed by exactly three digits is ambiguous:
    // "1.005" is one thousand and five under one convention and an
    // over-precise 1.005 under another. The currency settles it — three
    // trailing digits are a real fraction in a three-decimal currency (KWD,
    // BHD, TND) and a thousands group in every other, which is also the far
    // more common intent for the two-decimal case.
    const isGrouping = digits !== 3 && /^\d{3}$/.test(tail) && index > 0
    if (isGrouping) {
      wholePart = cleaned
      fractionPart = ''
    } else {
      wholePart = cleaned.slice(0, index)
      fractionPart = tail
    }
  }

  wholePart = wholePart.replace(/[.,]/g, '')
  if (fractionPart.includes('.') || fractionPart.includes(',')) return null
  if (wholePart === '' && fractionPart === '') return null
  if (!/^\d*$/.test(wholePart) || !/^\d*$/.test(fractionPart)) return null

  let scaled: string
  if (fractionPart.length <= digits) {
    scaled = wholePart + fractionPart.padEnd(digits, '0')
  } else {
    // Round half-up on the string, so no float ever touches the value.
    const kept = wholePart + fractionPart.slice(0, digits)
    const nextDigit = fractionPart.charCodeAt(digits) - 48
    scaled = nextDigit >= 5 ? (BigInt(kept || '0') + 1n).toString() : kept
  }

  const normalised = scaled.replace(/^0+(?=\d)/, '')
  if (normalised === '') return null

  const value = Number(normalised)
  if (!Number.isSafeInteger(value)) return null

  return negative && value !== 0 ? -value : value
}

export interface FormatMoneyOptions {
  readonly locale?: string
  /** Renders "1 234,56" style output with no currency symbol — for input fields. */
  readonly withoutSymbol?: boolean
  /** Abbreviates large figures (1.2M) for dense dashboard tiles. */
  readonly compact?: boolean
}

/**
 * Formats minor units for display.
 *
 * The division to major units happens inside Intl's formatter at the last
 * possible moment; the value is never carried around as a float.
 */
export function formatMoney(
  amountMinor: number,
  currency: CurrencyCode,
  options: FormatMoneyOptions = {},
): string {
  const { locale = 'en', withoutSymbol = false, compact = false } = options
  const code = currency.toUpperCase()
  const digits = getCurrencyFractionDigits(code)
  const major = amountMinor / 10 ** digits

  const base: Intl.NumberFormatOptions = compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { minimumFractionDigits: digits, maximumFractionDigits: digits }

  try {
    if (withoutSymbol) {
      return new Intl.NumberFormat(locale, base).format(major)
    }
    return new Intl.NumberFormat(locale, {
      ...base,
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).format(major)
  } catch {
    // An unknown or malformed code must not blank out a financial figure.
    return `${new Intl.NumberFormat(locale, base).format(major)} ${code}`
  }
}

export function formatMoneyAmount(amount: MoneyAmount, options?: FormatMoneyOptions): string {
  return formatMoney(amount.amountMinor, amount.currency, options)
}

/** The symbol alone, for input adornments. Falls back to the code itself. */
export function getCurrencySymbol(currency: CurrencyCode, locale = 'en'): string {
  const code = currency.toUpperCase()
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0)
    return parts.find((part) => part.type === 'currency')?.value ?? code
  } catch {
    return code
  }
}
