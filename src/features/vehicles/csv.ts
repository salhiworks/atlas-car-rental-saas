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

import { plateComparisonKey } from './normalise'
import { buildVehicleSchema, type VehicleFormValues } from './schemas'

/**
 * Vehicle CSV import: the field list and the entity-specific glue.
 *
 * Parsing, column matching, duplicate detection and the row/preview model live
 * in `src/lib/import` and are shared with Customers. Only what is genuinely
 * particular to a vehicle is here.
 */

export { normaliseImportedDate, parseCsv } from '@/lib/import/csv'
export type { ParsedCsv } from '@/lib/import/csv'
export type { ColumnMapping } from '@/lib/import/mapping'
export { isImportable } from '@/lib/import/validate'
export type { ImportRow, ImportRowIssue } from '@/lib/import/validate'

export const IMPORT_FIELDS = [
  { key: 'make', label: 'Make', required: true, aliases: ['make', 'brand', 'manufacturer'] },
  { key: 'model', label: 'Model', required: true, aliases: ['model'] },
  {
    key: 'registrationPlate',
    label: 'Registration plate',
    required: true,
    aliases: [
      'registration plate',
      'plate',
      'registration',
      'licence plate',
      'license plate',
      'reg',
    ],
  },
  { key: 'modelYear', label: 'Model year', required: false, aliases: ['model year', 'year', 'yr'] },
  { key: 'vin', label: 'VIN', required: false, aliases: ['vin', 'chassis', 'chassis number'] },
  { key: 'color', label: 'Colour', required: false, aliases: ['colour', 'color'] },
  {
    key: 'category',
    label: 'Category',
    required: false,
    aliases: ['category', 'segment', 'class'],
  },
  {
    key: 'odometer',
    label: 'Odometer',
    required: false,
    aliases: ['odometer', 'mileage', 'km', 'kilometres', 'kilometers', 'miles'],
  },
  {
    key: 'dailyRate',
    label: 'Daily rate',
    required: false,
    aliases: ['daily rate', 'rate', 'price per day', 'daily price', 'price'],
  },
  { key: 'fuelType', label: 'Fuel type', required: false, aliases: ['fuel type', 'fuel'] },
  {
    key: 'transmission',
    label: 'Transmission',
    required: false,
    aliases: ['transmission', 'gearbox'],
  },
  { key: 'seats', label: 'Seats', required: false, aliases: ['seats', 'passengers'] },
  {
    key: 'status',
    label: 'Status',
    required: false,
    aliases: ['status', 'state', 'operational status'],
  },
  {
    key: 'insuranceExpiresOn',
    label: 'Insurance expiry',
    required: false,
    aliases: ['insurance expiry', 'insurance', 'insurance expires', 'insurance expiry date'],
  },
  {
    key: 'inspectionExpiresOn',
    label: 'Inspection expiry',
    required: false,
    aliases: ['inspection expiry', 'inspection', 'technical inspection', 'mot', 'roadworthiness'],
  },
  {
    key: 'registrationExpiresOn',
    label: 'Registration expiry',
    required: false,
    aliases: ['registration expiry', 'road tax', 'tax expiry', 'registration expires'],
  },
  { key: 'notes', label: 'Notes', required: false, aliases: ['notes', 'comment', 'comments'] },
] as const satisfies readonly ImportField[]

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key']

const STATUS_SYNONYMS: Record<string, 'available' | 'maintenance' | 'unavailable'> = {
  available: 'available',
  active: 'available',
  'in service': 'available',
  ready: 'available',
  free: 'available',
  maintenance: 'maintenance',
  'in maintenance': 'maintenance',
  servicing: 'maintenance',
  repair: 'maintenance',
  unavailable: 'unavailable',
  'off the road': 'unavailable',
  inactive: 'unavailable',
  retired: 'unavailable',
  // Occupancy is derived from contracts, never imported. A file that says a
  // vehicle is rented describes something this column does not hold, so it is
  // read as in-service rather than rejected.
  rented: 'available',
  reserved: 'available',
  booked: 'available',
}

const FUEL_SYNONYMS: Record<string, string> = {
  petrol: 'petrol',
  gasoline: 'petrol',
  gas: 'petrol',
  essence: 'petrol',
  diesel: 'diesel',
  gasoil: 'diesel',
  hybrid: 'hybrid',
  'plug-in hybrid': 'plug_in_hybrid',
  'plug in hybrid': 'plug_in_hybrid',
  phev: 'plug_in_hybrid',
  electric: 'electric',
  ev: 'electric',
  lpg: 'lpg',
  cng: 'cng',
}

const TRANSMISSION_SYNONYMS: Record<string, string> = {
  manual: 'manual',
  stick: 'manual',
  mt: 'manual',
  automatic: 'automatic',
  auto: 'automatic',
  at: 'automatic',
}

export function guessColumnMapping(headers: readonly string[]): ColumnMapping<ImportFieldKey> {
  return guessMapping(IMPORT_FIELDS, headers)
}

export interface ValidateImportOptions {
  readonly currency: string
  /** Comparison keys of plates already in the agency's fleet. */
  readonly existingPlateKeys: ReadonlySet<string>
  readonly now?: Date
}

function buildAdapter(
  currency: string,
  now?: Date,
): ImportAdapter<ImportFieldKey, VehicleFormValues> {
  const schema = buildVehicleSchema(currency, now)

  return {
    fields: IMPORT_FIELDS,

    buildCandidate(read) {
      const issues: ImportRowIssue[] = []

      const statusCell = read('status').toLowerCase()
      const fuelCell = read('fuelType').toLowerCase()
      const transmissionCell = read('transmission').toLowerCase()

      if (statusCell !== '' && !(statusCell in STATUS_SYNONYMS)) {
        issues.push({ field: 'status', message: `"${statusCell}" is not a status we recognise.` })
      }
      if (fuelCell !== '' && !(fuelCell in FUEL_SYNONYMS)) {
        issues.push({
          field: 'fuelType',
          message: `"${fuelCell}" is not a fuel type we recognise.`,
        })
      }
      if (transmissionCell !== '' && !(transmissionCell in TRANSMISSION_SYNONYMS)) {
        issues.push({
          field: 'transmission',
          message: `"${transmissionCell}" is not a transmission we recognise.`,
        })
      }

      for (const key of [
        'insuranceExpiresOn',
        'inspectionExpiresOn',
        'registrationExpiresOn',
      ] as const) {
        const cell = read(key)
        if (cell !== '' && normaliseImportedDate(cell) === null) {
          issues.push({
            field: key,
            message: `"${cell}" is not a date we can read. Use YYYY-MM-DD or DD/MM/YYYY.`,
          })
        }
      }

      const odometerCell = read('odometer').replace(/[\s,]/g, '')

      return {
        issues,
        candidate: {
          make: read('make'),
          model: read('model'),
          modelYear: read('modelYear'),
          registrationPlate: read('registrationPlate'),
          vin: read('vin'),
          color: read('color'),
          category: read('category'),
          fuelType: FUEL_SYNONYMS[fuelCell] ?? null,
          transmission: TRANSMISSION_SYNONYMS[transmissionCell] ?? null,
          seats: read('seats'),
          odometer: odometerCell === '' ? '0' : odometerCell,
          dailyRate: read('dailyRate') || '0',
          currency,
          status: STATUS_SYNONYMS[statusCell] ?? 'available',
          insuranceExpiresOn: normaliseImportedDate(read('insuranceExpiresOn')) ?? '',
          inspectionExpiresOn: normaliseImportedDate(read('inspectionExpiresOn')) ?? '',
          registrationExpiresOn: normaliseImportedDate(read('registrationExpiresOn')) ?? '',
          nextServiceOn: '',
          notes: read('notes'),
        },
      }
    },

    parse(candidate) {
      const result = schema.safeParse(candidate)
      return result.success
        ? { ok: true, values: result.data }
        : { ok: false, issues: issuesFromZod(result.error) }
    },

    dedupeKey(values, read) {
      const key = plateComparisonKey(values?.registrationPlate ?? read('registrationPlate'))
      return key === '' ? null : key
    },

    identifier(values, read) {
      return values?.registrationPlate ?? read('registrationPlate')
    },
  }
}

export function validateImportRows(
  parsed: ParsedCsv,
  mapping: ColumnMapping<ImportFieldKey>,
  options: ValidateImportOptions,
): ImportValidation<VehicleFormValues> {
  return validateRows(parsed, mapping, buildAdapter(options.currency, options.now), {
    existingKeys: options.existingPlateKeys,
  })
}

/** The template offered for download, with one illustrative row. */
export function buildImportTemplate(): string {
  return buildCsv(
    IMPORT_FIELDS.map((field) => field.label),
    [
      [
        'Renault',
        'Clio',
        '12-A-34567',
        '2023',
        'VF15RJL0X12345678',
        'White',
        'Economy',
        '42150',
        '350',
        'Diesel',
        'Manual',
        '5',
        'Available',
        '2027-04-30',
        '2027-01-15',
        '2027-06-30',
        'Winter tyres fitted',
      ],
    ],
  )
}

export type VehicleImportRow = ImportRow<VehicleFormValues>
