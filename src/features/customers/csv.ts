import { buildCsv, normaliseImportedDate } from '@/lib/import/csv'
import type { ParsedCsv } from '@/lib/import/csv'
import type { ColumnMapping, ImportField } from '@/lib/import/mapping'
import { guessColumnMapping as guessMapping } from '@/lib/import/mapping'
import type {
  ImportAdapter,
  ImportRow,
  ImportRowIssue,
  ImportValidation,
} from '@/lib/import/validate'
import { issuesFromZod, validateImportRows as validateRows } from '@/lib/import/validate'

import { documentNumberKey } from './identity'
import { customerSchema, type CustomerFormValues } from './schemas'

/**
 * Customer CSV import.
 *
 * Built on the shared import core, so parsing, column matching, duplicate
 * detection and the preview model are the same code Vehicles uses. Only the
 * field list and the customer-specific glue live here.
 *
 * The rule that matters is unchanged: an imported row goes through the *same*
 * schema as one typed into the form, and its identifiers through the same
 * normalisation as one entered by hand. A spreadsheet is not a way around
 * validation, uniqueness, permissions or RLS.
 */

export { parseCsv } from '@/lib/import/csv'
export { isImportable } from '@/lib/import/validate'
export type { ParsedCsv } from '@/lib/import/csv'
export type { ColumnMapping } from '@/lib/import/mapping'
export type { ImportRow, ImportRowIssue } from '@/lib/import/validate'

export const CUSTOMER_IMPORT_FIELDS = [
  {
    key: 'firstName',
    label: 'First name',
    required: false,
    aliases: ['first name', 'firstname', 'given name', 'forename'],
  },
  {
    key: 'lastName',
    label: 'Last name',
    required: false,
    aliases: ['last name', 'lastname', 'surname', 'family name'],
  },
  {
    key: 'companyName',
    label: 'Company',
    required: false,
    aliases: ['company', 'company name', 'organisation', 'organization', 'business'],
  },
  { key: 'email', label: 'Email', required: false, aliases: ['email', 'e mail', 'email address'] },
  {
    key: 'phone',
    label: 'Phone',
    required: false,
    aliases: ['phone', 'telephone', 'mobile', 'phone number', 'tel'],
  },
  {
    key: 'secondaryPhone',
    label: 'Second phone',
    required: false,
    aliases: ['second phone', 'secondary phone', 'alternate phone', 'phone 2'],
  },
  {
    key: 'dateOfBirth',
    label: 'Date of birth',
    required: false,
    aliases: ['date of birth', 'birth date', 'dob', 'birthday'],
  },
  {
    key: 'nationalityCountryCode',
    label: 'Nationality',
    required: false,
    aliases: ['nationality', 'nationality country', 'citizenship'],
  },
  {
    key: 'addressLine1',
    label: 'Address',
    required: false,
    aliases: ['address', 'address line 1', 'street', 'address1'],
  },
  { key: 'city', label: 'City', required: false, aliases: ['city', 'town'] },
  {
    key: 'region',
    label: 'Region',
    required: false,
    aliases: ['region', 'state', 'province', 'county'],
  },
  {
    key: 'postalCode',
    label: 'Postal code',
    required: false,
    aliases: ['postal code', 'postcode', 'zip', 'zip code'],
  },
  {
    key: 'countryCode',
    label: 'Country',
    required: false,
    aliases: ['country', 'country code', 'address country'],
  },
  {
    key: 'documentType',
    label: 'ID type',
    required: false,
    aliases: ['id type', 'document type', 'identity type'],
  },
  {
    key: 'documentNumber',
    label: 'ID number',
    required: false,
    aliases: ['id number', 'document number', 'passport', 'passport number', 'national id'],
  },
  {
    key: 'documentCountry',
    label: 'ID issuing country',
    required: false,
    aliases: ['id country', 'issuing country', 'document country', 'passport country'],
  },
  {
    key: 'documentExpiresOn',
    label: 'ID expiry',
    required: false,
    aliases: ['id expiry', 'document expiry', 'passport expiry', 'id expires'],
  },
  {
    key: 'licenseNumber',
    label: 'Licence number',
    required: false,
    aliases: ['licence number', 'license number', 'driving licence', 'driver license', 'dl number'],
  },
  {
    key: 'licenseCountry',
    label: 'Licence country',
    required: false,
    aliases: ['licence country', 'license country', 'dl country'],
  },
  {
    key: 'licenseExpiresOn',
    label: 'Licence expiry',
    required: false,
    aliases: ['licence expiry', 'license expiry', 'dl expiry', 'licence expires'],
  },
  { key: 'notes', label: 'Notes', required: false, aliases: ['notes', 'comment', 'comments'] },
] as const satisfies readonly ImportField[]

export type CustomerImportFieldKey = (typeof CUSTOMER_IMPORT_FIELDS)[number]['key']

const DOCUMENT_TYPE_SYNONYMS: Record<
  string,
  'national_id' | 'passport' | 'residence_permit' | 'other'
> = {
  passport: 'passport',
  'passport number': 'passport',
  'national id': 'national_id',
  nationalid: 'national_id',
  'identity card': 'national_id',
  'id card': 'national_id',
  cin: 'national_id',
  cnie: 'national_id',
  'residence permit': 'residence_permit',
  residency: 'residence_permit',
  'residence card': 'residence_permit',
  other: 'other',
}

/**
 * A row's worth of customer, plus the identification it carries.
 *
 * Identity and licence arrive as flat columns because that is how agencies
 * export them, and are turned into `customer_documents` rows on insert.
 */
export interface CustomerImportValues {
  readonly customer: CustomerFormValues
  readonly identityDocument: {
    documentType: 'national_id' | 'passport' | 'residence_permit' | 'other'
    documentNumber: string
    issuingCountry: string | null
    expiresOn: string | null
  } | null
  readonly driverLicense: {
    documentNumber: string
    issuingCountry: string | null
    expiresOn: string | null
  } | null
}

export function guessCustomerColumnMapping(
  headers: readonly string[],
): ColumnMapping<CustomerImportFieldKey> {
  return guessMapping(CUSTOMER_IMPORT_FIELDS, headers)
}

export interface ValidateCustomerImportOptions {
  /** Normalised identifier keys already present in the agency. */
  readonly existingDocumentKeys: ReadonlySet<string>
}

/**
 * The duplicate key for an imported customer.
 *
 * Deliberately an *identifier*, never a name: two people called Mohamed Alami
 * are two people, and refusing the second would be worse than the duplicate. A
 * repeated passport number is the collision that actually causes harm.
 */
export function importDedupeKey(values: CustomerImportValues | null): string | null {
  if (!values) return null

  if (values.identityDocument) {
    const key = documentNumberKey(values.identityDocument.documentNumber)
    if (key) {
      return `${values.identityDocument.documentType}:${values.identityDocument.issuingCountry ?? '~~'}:${key}`
    }
  }

  if (values.driverLicense) {
    const key = documentNumberKey(values.driverLicense.documentNumber)
    if (key) {
      return `driver_license:${values.driverLicense.issuingCountry ?? '~~'}:${key}`
    }
  }

  return null
}

function upperOrNull(value: string): string | null {
  const trimmed = value.trim().toUpperCase()
  return trimmed === '' ? null : trimmed
}

function buildAdapter(): ImportAdapter<CustomerImportFieldKey, CustomerImportValues> {
  return {
    fields: CUSTOMER_IMPORT_FIELDS,

    buildCandidate(read) {
      const issues: ImportRowIssue[] = []

      for (const key of ['dateOfBirth', 'documentExpiresOn', 'licenseExpiresOn'] as const) {
        const cell = read(key)
        if (cell !== '' && normaliseImportedDate(cell) === null) {
          issues.push({
            field: key,
            message: `"${cell}" is not a date we can read. Use YYYY-MM-DD or DD/MM/YYYY.`,
          })
        }
      }

      const documentNumber = read('documentNumber')
      const documentTypeCell = read('documentType').toLowerCase().trim()

      if (
        documentNumber !== '' &&
        documentTypeCell !== '' &&
        !(documentTypeCell in DOCUMENT_TYPE_SYNONYMS)
      ) {
        issues.push({
          field: 'documentType',
          message: `"${documentTypeCell}" is not a document type we recognise.`,
        })
      }

      const companyName = read('companyName')

      return {
        issues,
        candidate: {
          customerType: companyName !== '' ? 'company' : 'individual',
          firstName: read('firstName'),
          lastName: read('lastName'),
          companyName,
          email: read('email'),
          phone: read('phone'),
          secondaryPhone: read('secondaryPhone'),
          dateOfBirth: normaliseImportedDate(read('dateOfBirth')) ?? '',
          nationalityCountryCode: read('nationalityCountryCode'),
          preferredLocale: '',
          addressLine1: read('addressLine1'),
          addressLine2: '',
          city: read('city'),
          region: read('region'),
          postalCode: read('postalCode'),
          countryCode: read('countryCode'),
          notes: read('notes'),
        },
      }
    },

    parse(candidate) {
      const result = customerSchema.safeParse(candidate)
      if (!result.success) return { ok: false, issues: issuesFromZod(result.error) }

      return {
        ok: true,
        values: { customer: result.data, identityDocument: null, driverLicense: null },
      }
    },

    dedupeKey(_values, read) {
      // The parse step does not see the document columns, so the key is built
      // from the raw cells and normalised the same way the database does.
      const documentNumber = documentNumberKey(read('documentNumber'))
      if (documentNumber) {
        const type =
          DOCUMENT_TYPE_SYNONYMS[read('documentType').toLowerCase().trim()] ??
          (documentNumber.length >= 6 ? 'passport' : 'national_id')
        return `${type}:${upperOrNull(read('documentCountry')) ?? '~~'}:${documentNumber}`
      }

      const licence = documentNumberKey(read('licenseNumber'))
      if (licence) {
        return `driver_license:${upperOrNull(read('licenseCountry')) ?? '~~'}:${licence}`
      }

      return null
    },

    identifier(values, read) {
      if (values) {
        const customer = values.customer
        if (customer.customerType === 'company') return customer.companyName ?? '—'
        return [customer.firstName, customer.lastName].filter(Boolean).join(' ') || '—'
      }
      return (
        [read('firstName'), read('lastName')].filter(Boolean).join(' ') ||
        read('companyName') ||
        '—'
      )
    },
  }
}

/**
 * Validates every row, then attaches the identification each one carries.
 *
 * Documents are resolved after parsing rather than inside it because the
 * customer schema deliberately knows nothing about documents — they are separate
 * records with their own uniqueness rules.
 */
export function validateCustomerImport(
  parsed: ParsedCsv,
  mapping: ColumnMapping<CustomerImportFieldKey>,
  options: ValidateCustomerImportOptions,
): ImportValidation<CustomerImportValues> {
  const validation = validateRows(parsed, mapping, buildAdapter(), {
    existingKeys: options.existingDocumentKeys,
  })

  const rows = validation.rows.map((row) => {
    if (!row.values) return row

    const read = (key: CustomerImportFieldKey): string => {
      const index = mapping[key]
      if (index == null) return ''
      return (row.raw[index] ?? '').trim()
    }

    const documentNumber = read('documentNumber')
    const licenseNumber = read('licenseNumber')

    const identityDocument = documentNumber
      ? {
          documentType:
            DOCUMENT_TYPE_SYNONYMS[read('documentType').toLowerCase().trim()] ??
            (documentNumberKey(documentNumber).length >= 6
              ? ('passport' as const)
              : ('national_id' as const)),
          documentNumber,
          issuingCountry: upperOrNull(read('documentCountry')),
          expiresOn: normaliseImportedDate(read('documentExpiresOn')),
        }
      : null

    const driverLicense = licenseNumber
      ? {
          documentNumber: licenseNumber,
          issuingCountry: upperOrNull(read('licenseCountry')),
          expiresOn: normaliseImportedDate(read('licenseExpiresOn')),
        }
      : null

    return { ...row, values: { ...row.values, identityDocument, driverLicense } }
  })

  return { ...validation, rows }
}

export function buildCustomerImportTemplate(): string {
  return buildCsv(
    CUSTOMER_IMPORT_FIELDS.map((field) => field.label),
    [
      [
        'Amina',
        'Benali',
        '',
        'amina.benali@example.com',
        '+212 600 112233',
        '',
        '1990-04-12',
        'MA',
        '14 Rue des Orangers',
        'Casablanca',
        'Casablanca-Settat',
        '20000',
        'MA',
        'National ID',
        'AB123456',
        'MA',
        '2030-04-12',
        'DL8842197',
        'MA',
        '2029-09-30',
        'Prefers automatic vehicles',
      ],
    ],
  )
}

export type CustomerImportRow = ImportRow<CustomerImportValues>
