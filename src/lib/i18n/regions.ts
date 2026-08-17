/**
 * Country, currency and locale reference data.
 *
 * Codes are static data; display names come from Intl, so the agency sees them
 * in its own language without this project shipping a translation table.
 *
 * No country is privileged here. The product is configured per agency, and a
 * fleet in Casablanca, Lisbon or Nairobi is equally a first-class case.
 */

/** ISO 3166-1 alpha-2. */
export const COUNTRY_CODES = [
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
] as const

export type CountryCode = (typeof COUNTRY_CODES)[number]

export interface ReferenceOption {
  readonly value: string
  readonly label: string
}

export function isCountryCode(value: string): value is CountryCode {
  return (COUNTRY_CODES as readonly string[]).includes(value)
}

export function getCountryName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

export function listCountries(locale = 'en'): ReferenceOption[] {
  const collator = new Intl.Collator(locale)
  return COUNTRY_CODES.map((value) => ({ value, label: getCountryName(value, locale) })).sort(
    (a, b) => collator.compare(a.label, b.label),
  )
}

export function getCurrencyName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) ?? code
  } catch {
    return code
  }
}

export function listCurrencies(locale = 'en'): ReferenceOption[] {
  const codes = Intl.supportedValuesOf?.('currency') ?? ['USD', 'EUR', 'GBP']
  const collator = new Intl.Collator(locale)
  return codes
    .map((value) => ({ value, label: `${value} — ${getCurrencyName(value, locale)}` }))
    .sort((a, b) => collator.compare(a.value, b.value))
}

/**
 * Interface languages the product ships. Extended as translations are added;
 * the agency's stored locale also drives number, date and currency formatting,
 * so it is meaningful even before every string is translated.
 */
export const SUPPORTED_LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'pt', label: 'Português' },
  { value: 'ar', label: 'العربية' },
] as const satisfies readonly ReferenceOption[]

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]['value']

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => locale.value === value)
}

/**
 * Best-effort defaults for a new agency, taken from the browser. Only ever a
 * starting point — the agency confirms them during sign-up and can change them
 * afterwards in Settings.
 */
export function guessRegionalDefaults(): {
  timeZone: string
  locale: SupportedLocale
  countryCode: string | null
} {
  let timeZone: string
  let countryCode: string | null = null

  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    timeZone = 'UTC'
  }

  const navigatorLocale = typeof navigator !== 'undefined' ? navigator.language : 'en'
  const [language, region] = navigatorLocale.split('-')

  if (region && isCountryCode(region.toUpperCase())) {
    countryCode = region.toUpperCase()
  }

  const locale = language && isSupportedLocale(language) ? language : 'en'

  return { timeZone, locale, countryCode }
}
