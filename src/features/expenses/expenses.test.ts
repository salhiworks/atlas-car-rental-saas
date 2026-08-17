import { describe, expect, it } from 'vitest'

import type { ExpenseLedgerEntry, ExpenseSummaryRow } from '@/types/database'

import {
  ALLOCATION_LABELS,
  allocationIsComplete,
  canEdit,
  canVoid,
  countsTowardsTotals,
  editBlockedReason,
  relationColumns,
  requiredRelation,
} from './allocation'
import {
  type ImportLookups,
  buildImportTemplate,
  expenseDocumentKey,
  guessColumnMapping,
  isImportable,
  parseCsv,
  validateImportRows,
} from './csv'
import {
  describeCurrencies,
  parseTaxInput,
  parseTaxRatePercent,
  presentCurrencies,
  shareOfTotal,
  taxFromGross,
  totalExpenseCount,
  formatTaxRate,
} from './money'
import { buildExpenseSchema, emptyExpenseForm } from './schemas'

/**
 * The Expenses module's arithmetic and its rules about what may be recorded.
 *
 * Weighted towards the three things that go wrong quietly in cost accounting: a
 * cost attributed to two places at once, a tax figure computed on the wrong
 * basis, and two currencies added together.
 */

// -----------------------------------------------------------------------------
// Allocation
// -----------------------------------------------------------------------------

describe('what a cost belongs to', () => {
  it('asks for a vehicle only when the cost is a vehicle’s', () => {
    expect(requiredRelation('overhead')).toBeNull()
    expect(requiredRelation('vehicle')).toBe('vehicle')
    expect(requiredRelation('rental')).toBe('rental')
  })

  it('refuses a rental cost that also names a vehicle', () => {
    // The car on a rental cost is read through the contract. Storing it twice
    // creates two answers to one question, and the database refuses it too.
    expect(allocationIsComplete('rental', { rentalId: 'rental-1', vehicleId: 'vehicle-1' })).toBe(
      false,
    )
    expect(allocationIsComplete('rental', { rentalId: 'rental-1', vehicleId: null })).toBe(true)
  })

  it('refuses an overhead that points at anything', () => {
    expect(allocationIsComplete('overhead', { rentalId: null, vehicleId: null })).toBe(true)
    expect(allocationIsComplete('overhead', { rentalId: null, vehicleId: 'v' })).toBe(false)
    expect(allocationIsComplete('overhead', { rentalId: 'r', vehicleId: null })).toBe(false)
  })

  it('refuses a vehicle cost with no vehicle', () => {
    expect(allocationIsComplete('vehicle', { rentalId: null, vehicleId: null })).toBe(false)
    expect(allocationIsComplete('vehicle', { rentalId: null, vehicleId: 'v' })).toBe(true)
    expect(allocationIsComplete('vehicle', { rentalId: 'r', vehicleId: 'v' })).toBe(false)
  })

  it('clears the columns the allocation forbids, whatever the form still held', () => {
    // A person who picks a vehicle, then switches to overhead, must not leave a
    // stale vehicle id behind in the row that gets written.
    expect(relationColumns('overhead', { vehicleId: 'v', rentalId: 'r' })).toEqual({
      vehicle_id: null,
      rental_id: null,
    })
    expect(relationColumns('vehicle', { vehicleId: 'v', rentalId: 'r' })).toEqual({
      vehicle_id: 'v',
      rental_id: null,
    })
    expect(relationColumns('rental', { vehicleId: 'v', rentalId: 'r' })).toEqual({
      vehicle_id: null,
      rental_id: 'r',
    })
  })

  it('names all three allocations for a person', () => {
    expect(ALLOCATION_LABELS.overhead).toBe('Agency overhead')
    expect(ALLOCATION_LABELS.vehicle).toBe('A vehicle')
    expect(ALLOCATION_LABELS.rental).toBe('A rental')
  })
})

describe('what may still be done to a recorded cost', () => {
  const base = { status: 'recorded', source: 'manual' } as const

  it('lets an ordinary cost be edited and voided', () => {
    expect(canEdit(base)).toBe(true)
    expect(canVoid(base)).toBe(true)
    expect(editBlockedReason(base)).toBeNull()
  })

  it('freezes a voided cost, because it is the record of a correction', () => {
    const voided = { status: 'voided', source: 'manual' } as const
    expect(canEdit(voided)).toBe(false)
    expect(canVoid(voided)).toBe(false)
    expect(editBlockedReason(voided)).toBe('A voided cost is kept exactly as it was.')
  })

  it('leaves a financing cost to the module that owns it', () => {
    const financed = { status: 'recorded', source: 'financing' } as const
    expect(canEdit(financed)).toBe(false)
    expect(canVoid(financed)).toBe(false)
    expect(editBlockedReason(financed)).toMatch(/financing agreement/)
  })

  it('counts a recorded cost and only a recorded cost', () => {
    expect(countsTowardsTotals('recorded')).toBe(true)
    expect(countsTowardsTotals('voided')).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Money
// -----------------------------------------------------------------------------

describe('the tax inside a gross amount', () => {
  it('computes tax on the gross basis, not on the net', () => {
    // 1200 gross at 20% contains 200 of tax, not 240. Getting this backwards
    // overstates tax on every receipt in the agency.
    expect(taxFromGross(120000, 2000)).toBe(20000)
    expect(taxFromGross(120000, 2000)).not.toBe(24000)
  })

  it('is zero at a zero rate', () => {
    expect(taxFromGross(120000, 0)).toBe(0)
    expect(taxFromGross(120000, -100)).toBe(0)
  })

  it('rounds to the minor unit', () => {
    // 100.00 at 20% → 16.666… → 16.67
    expect(taxFromGross(10000, 2000)).toBe(1667)
  })

  it('reads a rate a person typed, in either decimal convention', () => {
    expect(parseTaxRatePercent('20')).toBe(2000)
    expect(parseTaxRatePercent('19,6')).toBe(1960)
    expect(parseTaxRatePercent('7.5%')).toBe(750)
    expect(parseTaxRatePercent('')).toBe(0)
    expect(parseTaxRatePercent('nonsense')).toBeNull()
    expect(parseTaxRatePercent('-1')).toBeNull()
  })

  it('shows a whole rate without a false precision', () => {
    expect(formatTaxRate(2000)).toBe('20%')
    expect(formatTaxRate(1960)).toBe('19.6%')
    expect(formatTaxRate(1975)).toBe('19.75%')
  })

  it('refuses a tax larger than the amount it is part of', () => {
    expect(parseTaxInput('100', '120', 'EUR')).toBeNull()
    expect(parseTaxInput('100', '20', 'EUR')).toEqual({
      grossMinor: 10000,
      taxMinor: 2000,
      netMinor: 8000,
    })
  })

  it('treats a blank tax as none rather than as an error', () => {
    expect(parseTaxInput('100', '', 'EUR')).toEqual({
      grossMinor: 10000,
      taxMinor: 0,
      netMinor: 10000,
    })
  })
})

describe('several currencies', () => {
  const rows: ExpenseSummaryRow[] = [
    {
      currency: 'MAD',
      total_minor: 500000,
      overhead_minor: 200000,
      vehicle_minor: 250000,
      rental_minor: 50000,
      tax_minor: 80000,
      expense_count: 12,
      voided_count: 1,
    },
    {
      currency: 'EUR',
      total_minor: 900000,
      overhead_minor: 900000,
      vehicle_minor: 0,
      rental_minor: 0,
      tax_minor: 0,
      expense_count: 3,
      voided_count: 0,
    },
  ]

  it('gives one headline only when one currency can honestly produce one', () => {
    expect(presentCurrencies([rows[0]!]).headline?.currency).toBe('MAD')
    expect(presentCurrencies(rows).headline).toBeNull()
    expect(presentCurrencies(rows).isMixed).toBe(true)
  })

  it('orders by size, so the currency that matters reads first', () => {
    expect(presentCurrencies(rows).rows.map((row) => row.currency)).toEqual(['EUR', 'MAD'])
  })

  it('adds the counts, which carry no currency, and never the amounts', () => {
    expect(totalExpenseCount(rows)).toBe(15)
  })

  it('lists every currency rather than inventing a rate between them', () => {
    const described = describeCurrencies(rows, 'en-GB')
    expect(described).toContain('MAD')
    expect(described).toContain('€')
    expect(described).toContain('·')
  })

  it('has nothing to show for no rows', () => {
    expect(describeCurrencies([], 'en-GB')).toBe('—')
    expect(presentCurrencies([]).headline).toBeNull()
  })

  it('returns nothing rather than a meaningless zero percent', () => {
    expect(shareOfTotal(500, 0)).toBeNull()
    expect(shareOfTotal(2500, 10000)).toBe(25)
  })
})

// -----------------------------------------------------------------------------
// The form's rules
// -----------------------------------------------------------------------------

describe('recording a cost', () => {
  const schema = buildExpenseSchema('EUR')
  const valid = {
    ...emptyExpenseForm('EUR', '2026-05-04'),
    description: 'Front brake pads',
    amount: '184.00',
    categoryId: 'category-1',
  }

  it('accepts a cost with a date, a description, an amount and a category', () => {
    const result = schema.safeParse(valid)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.amount).toBe(18400)
      expect(result.data.taxAmount).toBe(0)
      expect(result.data.allocation).toBe('overhead')
      expect(result.data.vehicleId).toBeNull()
      expect(result.data.rentalId).toBeNull()
    }
  })

  it('refuses a cost of nothing', () => {
    const result = schema.safeParse({ ...valid, amount: '0' })
    expect(result.success).toBe(false)
  })

  it('refuses tax larger than the amount that contains it', () => {
    const result = schema.safeParse({ ...valid, amount: '100', taxAmount: '120' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'taxAmount')).toBe(true)
    }
  })

  it('refuses a vehicle cost with no vehicle, mirroring the constraint', () => {
    const result = schema.safeParse({ ...valid, allocation: 'vehicle' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'vehicleId')).toBe(true)
    }
  })

  it('refuses a rental cost with no rental', () => {
    const result = schema.safeParse({ ...valid, allocation: 'rental' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'rentalId')).toBe(true)
    }
  })

  it('refuses a date in the future, which is almost always a mistyped year', () => {
    const result = schema.safeParse({ ...valid, incurredOn: '2099-01-01' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'incurredOn')).toBe(true)
    }
  })

  it('refuses a date that does not exist', () => {
    expect(schema.safeParse({ ...valid, incurredOn: '2026-02-30' }).success).toBe(false)
  })

  it('turns blank optional fields into nothing rather than empty strings', () => {
    const result = schema.safeParse(valid)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reference).toBeNull()
      expect(result.data.notes).toBeNull()
      expect(result.data.vendorId).toBeNull()
      expect(result.data.paymentMethod).toBeNull()
      expect(result.data.odometer).toBeNull()
    }
  })

  it('reads a zero-decimal currency in whole units', () => {
    const yen = buildExpenseSchema('JPY')
    const result = yen.safeParse({ ...valid, currency: 'JPY', amount: '1840' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.amount).toBe(1840)
  })
})

// -----------------------------------------------------------------------------
// Import
// -----------------------------------------------------------------------------

const LOOKUPS: ImportLookups = {
  categoriesByName: new Map([
    ['REPAIRS', 'cat-repairs'],
    ['RENT', 'cat-rent'],
    ['CLEANING', 'cat-cleaning'],
  ]),
  archivedCategoryNames: new Set(['TOLLS']),
  vehiclesByPlate: new Map([
    ['12A34567', 'vehicle-1'],
    ['99B11111', 'vehicle-2'],
  ]),
  rentalsByReference: new Map([['R-2026-0007', 'rental-7']]),
  vendorsByName: new Map([
    ['GARAGE ATLAS', ['vendor-1']],
    ['SOCIÉTÉ GÉNÉRALE', ['vendor-2', 'vendor-3']],
  ]),
}

const HEADER =
  'Date,Description,Amount,Category,Belongs to,Plate,Contract,Supplier,Invoice,Paid by\n'

function importRows(body: string, existingKeys = new Set<string>()) {
  const parsed = parseCsv(HEADER + body)
  const mapping = guessColumnMapping(parsed.headers)
  return validateImportRows(parsed, mapping, {
    defaultCurrency: 'MAD',
    lookups: LOOKUPS,
    existingKeys,
  })
}

describe('importing costs from a spreadsheet', () => {
  it('lines up the columns a real export actually uses', () => {
    const mapping = guessColumnMapping([
      'Date',
      'Description',
      'Amount',
      'Category',
      'Plate',
      'Supplier',
      'Invoice',
    ])
    expect(mapping.incurredOn).toBe(0)
    expect(mapping.description).toBe(1)
    expect(mapping.amount).toBe(2)
    expect(mapping.category).toBe(3)
    expect(mapping.vehiclePlate).toBe(4)
    expect(mapping.vendor).toBe(5)
    expect(mapping.reference).toBe(6)
  })

  it('imports a plain overhead row', () => {
    const result = importRows('02/07/2026,Office rent,6000.00,Rent,,,,,,\n')
    const row = result.rows[0]!

    expect(row.issues).toEqual([])
    expect(isImportable(row)).toBe(true)
    expect(row.values?.incurredOn).toBe('2026-07-02')
    expect(row.values?.amount).toBe(600000)
    expect(row.values?.currency).toBe('MAD')
    expect(row.values?.allocation).toBe('overhead')
    expect(row.values?.categoryId).toBe('cat-rent')
  })

  it('reads what a row belongs to from what it points at, not from its wording', () => {
    const result = importRows(
      '14/07/2026,Brake pads,1840.00,Repairs,,12-A-34567,,,,\n' +
        '15/07/2026,Valet after return,180.00,Cleaning,,,R-2026-0007,,,\n',
    )

    expect(result.rows[0]?.values?.allocation).toBe('vehicle')
    expect(result.rows[0]?.values?.vehicleId).toBe('vehicle-1')
    expect(result.rows[1]?.values?.allocation).toBe('rental')
    expect(result.rows[1]?.values?.rentalId).toBe('rental-7')
    // A rental cost carries no vehicle of its own, even though one is knowable.
    expect(result.rows[1]?.values?.vehicleId).toBeNull()
  })

  it('matches a plate whatever punctuation the other system used', () => {
    const result = importRows('14/07/2026,Tyres,900.00,Repairs,Vehicle,12a34567,,,,\n')
    expect(result.rows[0]?.values?.vehicleId).toBe('vehicle-1')
  })

  it('refuses a row that names both a vehicle and a contract', () => {
    const result = importRows('14/07/2026,Brake pads,1840.00,Repairs,,12-A-34567,R-2026-0007,,,\n')
    const row = result.rows[0]!
    expect(isImportable(row)).toBe(false)
    expect(row.issues.some((issue) => /never both/.test(issue.message))).toBe(true)
  })

  it('refuses an overhead that points at a car', () => {
    const result = importRows('14/07/2026,Brake pads,1840.00,Repairs,Agency,12-A-34567,,,,\n')
    expect(isImportable(result.rows[0]!)).toBe(false)
    expect(
      result.rows[0]!.issues.some((issue) => /belongs to no vehicle/.test(issue.message)),
    ).toBe(true)
  })

  it('invents nothing: an unknown category is an error, not a new category', () => {
    const result = importRows('14/07/2026,Something,100.00,Sponsorship,,,,,,\n')
    expect(isImportable(result.rows[0]!)).toBe(false)
    expect(
      result.rows[0]!.issues.some((issue) =>
        /no category called "Sponsorship"/.test(issue.message),
      ),
    ).toBe(true)
  })

  it('says when a category exists but has been retired', () => {
    const result = importRows('14/07/2026,Motorway,60.00,Tolls,,,,,,\n')
    expect(result.rows[0]!.issues.some((issue) => /retired category/.test(issue.message))).toBe(
      true,
    )
  })

  it('refuses an unknown plate rather than recording the cost against nothing', () => {
    const result = importRows('14/07/2026,Tyres,900.00,Repairs,,ZZ-000,,,,\n')
    expect(
      result.rows[0]!.issues.some((issue) => /No vehicle in the fleet/.test(issue.message)),
    ).toBe(true)
  })

  it('refuses to choose between two suppliers that share a name', () => {
    // A name identifies nothing on its own. Picking one at random would attach
    // real money to the wrong company.
    const result = importRows('14/07/2026,Bank charges,50.00,Rent,,,,Société Générale,,\n')
    expect(isImportable(result.rows[0]!)).toBe(false)
    expect(
      result.rows[0]!.issues.some((issue) => /2 suppliers are called/.test(issue.message)),
    ).toBe(true)
  })

  it('resolves a supplier when exactly one answers to the name', () => {
    const result = importRows('14/07/2026,Brake pads,1840.00,Repairs,,12-A-34567,,Garage Atlas,,\n')
    expect(result.rows[0]?.values?.vendorId).toBe('vendor-1')
  })

  it('reads the payment method words other systems use', () => {
    const result = importRows(
      '14/07/2026,Brake pads,1840.00,Repairs,,,,,,Credit card\n' +
        '14/07/2026,Rent,100.00,Rent,,,,,,virement\n',
    )
    expect(result.rows[0]?.values?.paymentMethod).toBe('card')
    expect(result.rows[1]?.values?.paymentMethod).toBe('bank_transfer')
  })

  it('flags the same invoice twice in one file', () => {
    const result = importRows(
      '14/07/2026,Brake pads,1840.00,Repairs,,,,Garage Atlas,INV-184,\n' +
        '20/07/2026,Brake pads again,1840.00,Repairs,,,,Garage Atlas,INV-184,\n',
    )
    expect(isImportable(result.rows[0]!)).toBe(true)
    expect(result.rows[1]?.duplicateOfLine).toBe(2)
    expect(isImportable(result.rows[1]!)).toBe(false)
    expect(result.duplicateCount).toBe(1)
  })

  it('does not call two costs the same just because they match', () => {
    // Without a document number there is no key at all: an agency really can
    // buy two identical things on one day.
    const result = importRows(
      '14/07/2026,Car wash,80.00,Cleaning,,,,,,\n' + '14/07/2026,Car wash,80.00,Cleaning,,,,,,\n',
    )
    expect(result.rows[0]?.dedupeKey).toBeNull()
    expect(result.rows[1]?.duplicateOfLine).toBeNull()
    expect(result.duplicateCount).toBe(0)
    expect(result.validCount).toBe(2)
  })

  it('flags an invoice already recorded against that supplier', () => {
    const existing = new Set([expenseDocumentKey('Garage Atlas', 'INV-184', 'MAD')!])
    const result = importRows(
      '14/07/2026,Brake pads,1840.00,Repairs,,,,Garage Atlas,INV-184,\n',
      existing,
    )
    expect(result.rows[0]?.conflictsWithExisting).toBe(true)
    expect(isImportable(result.rows[0]!)).toBe(false)
  })

  it('keys a document by supplier, number and currency together', () => {
    expect(expenseDocumentKey('Garage Atlas', 'inv-184', 'mad')).toBe('GARAGE ATLAS|INV-184|MAD')
    expect(expenseDocumentKey('Garage Atlas', '', 'MAD')).toBeNull()
    expect(expenseDocumentKey(null, 'INV-184', 'MAD')).toBeNull()
  })

  it('reports an unreadable date on the row rather than guessing one', () => {
    const result = importRows('last Tuesday,Brake pads,1840.00,Repairs,,,,,,\n')
    expect(
      result.rows[0]!.issues.some((issue) => /not a date we can read/.test(issue.message)),
    ).toBe(true)
  })

  it('counts what is ready, what is broken and what is already recorded', () => {
    const result = importRows(
      '02/07/2026,Office rent,6000.00,Rent,,,,,,\n' +
        '14/07/2026,Mystery,100.00,Sponsorship,,,,,,\n' +
        '14/07/2026,Brake pads,1840.00,Repairs,,,,Garage Atlas,INV-9,\n' +
        '15/07/2026,Brake pads,1840.00,Repairs,,,,Garage Atlas,INV-9,\n',
    )
    // Ready counts only what will actually be written: the rent and the first
    // invoice. The unknown category is an error and the repeated invoice is a
    // duplicate, and neither imports.
    expect(result.validCount).toBe(2)
    expect(result.errorCount).toBe(1)
    expect(result.duplicateCount).toBe(1)
  })

  it('offers a template whose own rows import cleanly', () => {
    const parsed = parseCsv(buildImportTemplate('MAD'))
    const mapping = guessColumnMapping(parsed.headers)

    // The template names a supplier and a category the reader is expected to
    // create, so it is checked for shape rather than for resolution.
    expect(parsed.rows).toHaveLength(2)
    expect(mapping.incurredOn).toBe(0)
    expect(mapping.amount).toBe(2)
    expect(mapping.category).toBe(4)

    const result = validateImportRows(parsed, mapping, {
      defaultCurrency: 'MAD',
      lookups: {
        categoriesByName: new Map([
          ['REPAIRS', 'cat-repairs'],
          ['RENT', 'cat-rent'],
        ]),
        archivedCategoryNames: new Set(),
        vehiclesByPlate: new Map([['12A34567', 'vehicle-1']]),
        rentalsByReference: new Map(),
        vendorsByName: new Map([
          ['GARAGE ATLAS', ['vendor-1']],
          ['IMMOBILIER ZERKTOUNI', ['vendor-2']],
        ]),
      },
      existingKeys: new Set(),
    })

    expect(result.errorCount).toBe(0)
    expect(result.validCount).toBe(2)
    expect(result.rows[0]?.values?.allocation).toBe('vehicle')
    expect(result.rows[0]?.values?.taxAmount).toBe(30667)
    expect(result.rows[1]?.values?.allocation).toBe('overhead')
  })
})

// -----------------------------------------------------------------------------
// The ledger row a page reads
// -----------------------------------------------------------------------------

describe('a ledger entry', () => {
  const entry = {
    status: 'recorded',
    source: 'manual',
  } satisfies Pick<ExpenseLedgerEntry, 'status' | 'source'>

  it('is editable while it is an ordinary recorded cost', () => {
    expect(canEdit(entry)).toBe(true)
  })
})
