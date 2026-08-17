import { buildCsv, normaliseImportedDate } from '@/lib/import/csv'
import type { ParsedCsv } from '@/lib/import/csv'
import type { ColumnMapping, ImportField } from '@/lib/import/mapping'
import { guessColumnMapping as guessMapping, normaliseHeader } from '@/lib/import/mapping'
import type {
  ImportAdapter,
  ImportRow,
  ImportRowIssue,
  ImportValidation,
} from '@/lib/import/validate'
import { issuesFromZod, validateImportRows as validateRows } from '@/lib/import/validate'
import type { ExpenseAllocation } from '@/types/database'

import { buildExpenseSchema, PAYMENT_METHOD_VALUES, type ExpenseFormValues } from './schemas'

/**
 * Expense CSV import: the field list and the expense-specific glue.
 *
 * Parsing, column matching and the row model are shared with Vehicles and
 * Customers. What is particular here is that a cost points at things that
 * already exist — a category, a vehicle, a contract, a supplier — and a
 * spreadsheet only has their names. Every one of those is resolved against the
 * agency's own records, and a name that resolves to nothing, or to two things,
 * is an error on that row rather than a guess.
 *
 * Nothing is created as a side effect of an import. A file naming a category
 * that does not exist does not quietly invent one: the taxonomy is an
 * administrator's decision, not a consequence of a paste.
 */

export { normaliseImportedDate, parseCsv } from '@/lib/import/csv'
export type { ParsedCsv } from '@/lib/import/csv'
export type { ColumnMapping } from '@/lib/import/mapping'
export { isImportable } from '@/lib/import/validate'
export type { ImportRow, ImportRowIssue } from '@/lib/import/validate'

export const IMPORT_FIELDS = [
  {
    key: 'incurredOn',
    label: 'Date incurred',
    required: true,
    aliases: ['date incurred', 'date', 'incurred on', 'expense date', 'transaction date'],
  },
  {
    key: 'description',
    label: 'Description',
    required: true,
    aliases: ['description', 'what for', 'details', 'label', 'memo', 'narrative'],
  },
  {
    key: 'amount',
    label: 'Amount',
    required: true,
    aliases: ['amount', 'total', 'amount paid', 'gross', 'value', 'cost'],
  },
  {
    key: 'currency',
    label: 'Currency',
    required: false,
    aliases: ['currency', 'ccy'],
  },
  {
    key: 'category',
    label: 'Category',
    required: true,
    aliases: ['category', 'expense category', 'type', 'kind'],
  },
  {
    key: 'allocation',
    label: 'Belongs to',
    required: false,
    aliases: ['belongs to', 'allocation', 'attributed to', 'cost centre', 'cost center'],
  },
  {
    key: 'vehiclePlate',
    label: 'Vehicle plate',
    required: false,
    aliases: ['vehicle plate', 'plate', 'registration', 'vehicle', 'registration plate', 'car'],
  },
  {
    key: 'rentalReference',
    label: 'Rental reference',
    required: false,
    aliases: ['rental reference', 'rental', 'contract', 'contract reference', 'booking'],
  },
  {
    key: 'vendor',
    label: 'Supplier',
    required: false,
    aliases: ['supplier', 'vendor', 'payee', 'merchant', 'paid to'],
  },
  {
    key: 'taxAmount',
    label: 'Tax included',
    required: false,
    aliases: ['tax included', 'tax', 'vat', 'tva', 'iva', 'tax amount'],
  },
  {
    key: 'taxLabel',
    label: 'Tax called',
    required: false,
    aliases: ['tax called', 'tax label', 'tax name'],
  },
  {
    key: 'paymentMethod',
    label: 'Paid by',
    required: false,
    aliases: ['paid by', 'payment method', 'method', 'payment'],
  },
  {
    key: 'reference',
    label: 'Invoice number',
    required: false,
    aliases: ['invoice number', 'reference', 'invoice', 'receipt number', 'document number', 'ref'],
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    aliases: ['notes', 'comment', 'comments'],
  },
] as const satisfies readonly ImportField[]

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key']

const ALLOCATION_SYNONYMS: Readonly<Record<string, ExpenseAllocation>> = {
  overhead: 'overhead',
  'agency overhead': 'overhead',
  agency: 'overhead',
  business: 'overhead',
  general: 'overhead',
  company: 'overhead',
  vehicle: 'vehicle',
  car: 'vehicle',
  fleet: 'vehicle',
  'a vehicle': 'vehicle',
  rental: 'rental',
  contract: 'rental',
  hire: 'rental',
  booking: 'rental',
  'a rental': 'rental',
}

const PAYMENT_SYNONYMS: Readonly<Record<string, string>> = {
  cash: 'cash',
  card: 'card',
  'credit card': 'card',
  'debit card': 'card',
  visa: 'card',
  mastercard: 'card',
  'bank transfer': 'bank_transfer',
  transfer: 'bank_transfer',
  wire: 'bank_transfer',
  bank: 'bank_transfer',
  virement: 'bank_transfer',
  cheque: 'cheque',
  check: 'cheque',
  online: 'online',
  other: 'other',
}

export function guessColumnMapping(headers: readonly string[]): ColumnMapping<ImportFieldKey> {
  return guessMapping(IMPORT_FIELDS, headers)
}

/** Case- and spacing-insensitive, so "  Fuel " and "fuel" are the same name. */
function nameKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ')
}

/** Plates differ across systems in punctuation only; compare on the characters. */
function plateKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export interface ImportLookups {
  /** Active categories by name. */
  readonly categoriesByName: ReadonlyMap<string, string>
  /** Retired categories by name, so the message can say why it was refused. */
  readonly archivedCategoryNames: ReadonlySet<string>
  /** Vehicle id by plate key. */
  readonly vehiclesByPlate: ReadonlyMap<string, string>
  /** Rental id by reference. */
  readonly rentalsByReference: ReadonlyMap<string, string>
  /**
   * Supplier ids by name. A name is not unique inside an agency, so this holds
   * every match and an ambiguous one is reported rather than resolved.
   */
  readonly vendorsByName: ReadonlyMap<string, readonly string[]>
}

export interface ValidateImportOptions {
  readonly defaultCurrency: string
  readonly lookups: ImportLookups
  /** Keys of costs already recorded, for the supplier + invoice-number check. */
  readonly existingKeys: ReadonlySet<string>
}

/**
 * The only key strong enough to call two costs the same one.
 *
 * A supplier's own document number identifies one document; the same supplier
 * cannot issue two invoices under one number. Without a number there is no
 * duplicate key at all, because an agency really can buy two identical coffees
 * on one day and neither is a mistake.
 */
function documentKey(vendorName: string, reference: string, currency: string): string | null {
  const vendor = nameKey(vendorName)
  const document = nameKey(reference)
  if (vendor === '' || document === '') return null
  return `${vendor}|${document}|${currency.toUpperCase()}`
}

export function expenseDocumentKey(
  vendorName: string | null,
  reference: string | null,
  currency: string,
): string | null {
  return documentKey(vendorName ?? '', reference ?? '', currency)
}

function buildAdapter(
  options: ValidateImportOptions,
): ImportAdapter<ImportFieldKey, ExpenseFormValues> {
  const schemas = new Map<string, ReturnType<typeof buildExpenseSchema>>()
  const schemaFor = (currency: string) => {
    const existing = schemas.get(currency)
    if (existing) return existing
    const created = buildExpenseSchema(currency)
    schemas.set(currency, created)
    return created
  }

  const { lookups } = options

  return {
    fields: IMPORT_FIELDS,

    buildCandidate(read) {
      const issues: ImportRowIssue[] = []

      const dateCell = read('incurredOn')
      const incurredOn = normaliseImportedDate(dateCell)
      if (dateCell !== '' && incurredOn === null) {
        issues.push({
          field: 'incurredOn',
          message: `"${dateCell}" is not a date we can read. Use YYYY-MM-DD or DD/MM/YYYY.`,
        })
      }

      const currency = (read('currency') || options.defaultCurrency).toUpperCase()

      // --- category ---------------------------------------------------------
      const categoryCell = read('category')
      const categoryId = lookups.categoriesByName.get(nameKey(categoryCell)) ?? ''
      if (categoryCell !== '' && categoryId === '') {
        issues.push({
          field: 'categoryId',
          message: lookups.archivedCategoryNames.has(nameKey(categoryCell))
            ? `"${categoryCell}" is a retired category. Restore it, or use a category that is still in use.`
            : `There is no category called "${categoryCell}". Add it first, then import.`,
        })
      }

      // --- what it belongs to ----------------------------------------------
      const plateCell = read('vehiclePlate')
      const rentalCell = read('rentalReference')
      const vehicleId =
        plateCell === '' ? '' : (lookups.vehiclesByPlate.get(plateKey(plateCell)) ?? '')
      const rentalId =
        rentalCell === '' ? '' : (lookups.rentalsByReference.get(nameKey(rentalCell)) ?? '')

      if (plateCell !== '' && vehicleId === '') {
        issues.push({
          field: 'vehicleId',
          message: `No vehicle in the fleet has the plate "${plateCell}".`,
        })
      }
      if (rentalCell !== '' && rentalId === '') {
        issues.push({
          field: 'rentalId',
          message: `No contract has the reference "${rentalCell}".`,
        })
      }
      if (plateCell !== '' && rentalCell !== '') {
        issues.push({
          field: 'allocation',
          message:
            'A cost belongs to a vehicle or to a rental, never both. The vehicle on a rental cost is read from the contract.',
        })
      }

      const allocationCell = normaliseHeader(read('allocation'))
      let allocation: ExpenseAllocation
      if (allocationCell === '') {
        // Inferred from what the row actually points at, never from the words
        // in the category name.
        allocation = rentalCell !== '' ? 'rental' : plateCell !== '' ? 'vehicle' : 'overhead'
      } else if (allocationCell in ALLOCATION_SYNONYMS) {
        allocation = ALLOCATION_SYNONYMS[allocationCell]!
      } else {
        allocation = 'overhead'
        issues.push({
          field: 'allocation',
          message: `"${read('allocation')}" is not something we recognise. Use agency, vehicle or rental.`,
        })
      }

      if (allocation === 'overhead' && (plateCell !== '' || rentalCell !== '')) {
        issues.push({
          field: 'allocation',
          message:
            'An agency overhead belongs to no vehicle and no rental. Remove one or the other.',
        })
      }

      // --- supplier ---------------------------------------------------------
      const vendorCell = read('vendor')
      const vendorMatches =
        vendorCell === '' ? [] : (lookups.vendorsByName.get(nameKey(vendorCell)) ?? [])
      let vendorId = ''
      if (vendorCell !== '') {
        if (vendorMatches.length === 1) {
          vendorId = vendorMatches[0]!
        } else if (vendorMatches.length === 0) {
          issues.push({
            field: 'vendorId',
            message: `There is no supplier called "${vendorCell}". Add it first, or leave the column blank.`,
          })
        } else {
          issues.push({
            field: 'vendorId',
            message: `${vendorMatches.length} suppliers are called "${vendorCell}". Record these by hand so the right one is chosen.`,
          })
        }
      }

      // --- payment method ---------------------------------------------------
      const methodCell = normaliseHeader(read('paymentMethod'))
      let paymentMethod = ''
      if (methodCell !== '') {
        const resolved =
          PAYMENT_SYNONYMS[methodCell] ??
          ((PAYMENT_METHOD_VALUES as readonly string[]).includes(methodCell) ? methodCell : null)
        if (resolved === null) {
          issues.push({
            field: 'paymentMethod',
            message: `"${read('paymentMethod')}" is not a payment method we recognise.`,
          })
        } else {
          paymentMethod = resolved
        }
      }

      return {
        issues,
        candidate: {
          incurredOn: incurredOn ?? dateCell,
          description: read('description'),
          // Left exactly as typed: parseMoneyToMinor already copes with
          // currency symbols, grouping separators and both decimal conventions.
          amount: read('amount'),
          taxAmount: read('taxAmount'),
          taxRateBps: null,
          taxLabel: read('taxLabel'),
          currency,
          categoryId,
          allocation,
          vehicleId: allocation === 'vehicle' ? vehicleId : '',
          rentalId: allocation === 'rental' ? rentalId : '',
          vendorId,
          paymentMethod,
          reference: read('reference'),
          notes: read('notes'),
          odometer: '',
        },
      }
    },

    parse(candidate) {
      const currency =
        typeof (candidate as { currency?: unknown }).currency === 'string'
          ? ((candidate as { currency: string }).currency || options.defaultCurrency).toUpperCase()
          : options.defaultCurrency

      const result = schemaFor(currency).safeParse(candidate)
      return result.success
        ? { ok: true, values: result.data }
        : { ok: false, issues: issuesFromZod(result.error) }
    },

    dedupeKey(values, read) {
      return documentKey(
        read('vendor'),
        values?.reference ?? read('reference'),
        values?.currency ?? options.defaultCurrency,
      )
    },

    identifier(values, read) {
      const description = values?.description ?? read('description')
      return description === '' ? 'Untitled cost' : description
    },
  }
}

export function validateImportRows(
  parsed: ParsedCsv,
  mapping: ColumnMapping<ImportFieldKey>,
  options: ValidateImportOptions,
): ImportValidation<ExpenseFormValues> {
  return validateRows(parsed, mapping, buildAdapter(options), {
    existingKeys: options.existingKeys,
  })
}

/** The template offered for download, with two illustrative rows. */
export function buildImportTemplate(currency: string): string {
  return buildCsv(
    IMPORT_FIELDS.map((field) => field.label),
    [
      [
        '2026-07-14',
        'Front brake pads and labour',
        '1840.00',
        currency,
        'Repairs',
        'Vehicle',
        '12-A-34567',
        '',
        'Garage Atlas',
        '306.67',
        'VAT',
        'Card',
        'INV-2026-0184',
        'Both front discs skimmed',
      ],
      [
        '2026-07-02',
        'Office rent, July',
        '6000.00',
        currency,
        'Rent',
        'Agency',
        '',
        '',
        'Immobilier Zerktouni',
        '',
        '',
        'Bank transfer',
        'RENT-2026-07',
        '',
      ],
    ],
  )
}

export type ExpenseImportRow = ImportRow<ExpenseFormValues>
