import { describe, expect, it } from 'vitest'

import {
  buildImportTemplate,
  guessColumnMapping,
  isImportable,
  normaliseImportedDate,
  parseCsv,
  validateImportRows,
} from './csv'
import {
  isPlausibleVin,
  modelYearRange,
  normalisePlate,
  normaliseVin,
  plateComparisonKey,
} from './normalise'
import { buildVehicleSchema, emptyVehicleForm } from './schemas'

const NOW = new Date('2026-06-15T12:00:00Z')

describe('identifier normalisation', () => {
  it('compares plates without spacing or case, so a duplicate cannot slip through', () => {
    // The database's unique index does the same thing; the client has to agree
    // with it or the interface will accept what the save then rejects.
    expect(plateComparisonKey('12-A-34567')).toBe('12A34567')
    expect(plateComparisonKey('12 a 34567')).toBe('12A34567')
    expect(plateComparisonKey(' 12a34567 ')).toBe('12A34567')
  })

  it('stores plates the way they are printed, just tidied', () => {
    expect(normalisePlate('  12-a-34567 ')).toBe('12-A-34567')
    expect(normalisePlate('AB  12  CD')).toBe('AB 12 CD')
  })

  it('accepts a VIN made only of the characters the standard allows', () => {
    expect(isPlausibleVin('VF15RJL0X12345678')).toBe(true)
    expect(isPlausibleVin('vf15rjl0x12345678')).toBe(true)
  })

  it('rejects the letters the VIN standard excludes', () => {
    // I, O and Q are excluded to avoid confusion with 1 and 0.
    expect(isPlausibleVin('VF15RJL0I12345678')).toBe(false)
    expect(isPlausibleVin('VF15RJL0O12345678')).toBe(false)
    expect(isPlausibleVin('VF15RJL0Q12345678')).toBe(false)
  })

  it('rejects a VIN that is implausibly short or long', () => {
    expect(isPlausibleVin('AB12')).toBe(false)
    expect(isPlausibleVin('A'.repeat(40))).toBe(false)
  })

  it('strips whitespace from a pasted VIN', () => {
    expect(normaliseVin(' vf15 rjl0x1234 5678 ')).toBe('VF15RJL0X12345678')
  })

  it('allows next year’s models but not a mistyped century', () => {
    const range = modelYearRange(NOW)
    expect(range.min).toBe(1950)
    expect(range.max).toBe(2028)
  })
})

describe('vehicle validation', () => {
  const schema = buildVehicleSchema('EUR', NOW)

  const valid = {
    ...emptyVehicleForm('EUR'),
    make: 'Renault',
    model: 'Clio',
    registrationPlate: '12-a-34567',
    odometer: '42150',
    dailyRate: '350',
  }

  it('accepts a minimally complete vehicle', () => {
    const result = schema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('normalises the plate on the way in', () => {
    const result = schema.parse(valid)
    expect(result.registrationPlate).toBe('12-A-34567')
  })

  it('parses the daily rate into minor units for the agency currency', () => {
    expect(schema.parse({ ...valid, dailyRate: '350' }).dailyRate).toBe(35_000)
    expect(schema.parse({ ...valid, dailyRate: '350.50' }).dailyRate).toBe(35_050)

    // A zero-decimal currency scales differently, which is exactly why the
    // schema is built per agency rather than shared.
    const yen = buildVehicleSchema('JPY', NOW)
    expect(yen.parse({ ...valid, currency: 'JPY', dailyRate: '350' }).dailyRate).toBe(350)
  })

  it('requires the fields a vehicle cannot exist without', () => {
    for (const field of ['make', 'model', 'registrationPlate'] as const) {
      const result = schema.safeParse({ ...valid, [field]: '' })
      expect(result.success, field).toBe(false)
    }
  })

  it('refuses a negative or non-integer odometer', () => {
    expect(schema.safeParse({ ...valid, odometer: '-5' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, odometer: '12.5' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, odometer: 'lots' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, odometer: '0' }).success).toBe(true)
  })

  it('refuses a negative daily rate but allows zero', () => {
    expect(schema.safeParse({ ...valid, dailyRate: '-10' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, dailyRate: '0' }).success).toBe(true)
  })

  it('refuses an implausible model year', () => {
    expect(schema.safeParse({ ...valid, modelYear: '1899' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, modelYear: '2040' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, modelYear: '2023' }).success).toBe(true)
    expect(schema.safeParse({ ...valid, modelYear: '' }).success).toBe(true)
  })

  it('refuses a status the database cannot store', () => {
    // 'rented' is derived from contracts and is not a storable operational state.
    const result = schema.safeParse({ ...valid, status: 'rented' })
    expect(result.success).toBe(false)
  })

  it('turns blank optional fields into null rather than empty strings', () => {
    const result = schema.parse({ ...valid, vin: '', color: '', notes: '', insuranceExpiresOn: '' })
    expect(result.vin).toBeNull()
    expect(result.color).toBeNull()
    expect(result.notes).toBeNull()
    expect(result.insuranceExpiresOn).toBeNull()
  })

  it('refuses a date that does not exist', () => {
    expect(schema.safeParse({ ...valid, insuranceExpiresOn: '2026-02-30' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, insuranceExpiresOn: '2026-13-01' }).success).toBe(false)
    expect(schema.safeParse({ ...valid, insuranceExpiresOn: '2026-02-28' }).success).toBe(true)
  })

  it('refuses a plate with no letters or digits at all', () => {
    expect(schema.safeParse({ ...valid, registrationPlate: '---' }).success).toBe(false)
  })
})

describe('CSV parsing', () => {
  it('reads a plain file', () => {
    const { headers, rows } = parseCsv('Make,Model\nRenault,Clio\nDacia,Duster\n')
    expect(headers).toEqual(['Make', 'Model'])
    expect(rows).toEqual([
      ['Renault', 'Clio'],
      ['Dacia', 'Duster'],
    ])
  })

  it('handles quoted fields containing commas, quotes and newlines', () => {
    const { rows } = parseCsv('Make,Notes\nRenault,"Red, with a ""racing"" stripe\nand a dent"\n')
    expect(rows[0]).toEqual(['Renault', 'Red, with a "racing" stripe\nand a dent'])
  })

  it('tolerates what spreadsheets actually emit', () => {
    // BOM, CRLF line endings, and a trailing blank line.
    const { headers, rows } = parseCsv('﻿Make,Model\r\nRenault,Clio\r\n\r\n')
    expect(headers).toEqual(['Make', 'Model'])
    expect(rows).toEqual([['Renault', 'Clio']])
  })

  it('returns no rows for a header-only file', () => {
    expect(parseCsv('Make,Model\n').rows).toEqual([])
  })
})

describe('CSV column mapping', () => {
  it('matches our own template exactly', () => {
    const template = parseCsv(buildImportTemplate())
    const mapping = guessColumnMapping(template.headers)

    expect(mapping.make).toBe(0)
    expect(mapping.model).toBe(1)
    expect(mapping.registrationPlate).toBe(2)
    expect(mapping.notes).toBe(16)
  })

  it('recognises the names other systems use', () => {
    const mapping = guessColumnMapping(['Brand', 'Model', 'License Plate', 'Mileage', 'Year'])
    expect(mapping.make).toBe(0)
    expect(mapping.registrationPlate).toBe(2)
    expect(mapping.odometer).toBe(3)
    expect(mapping.modelYear).toBe(4)
  })

  it('is insensitive to case, underscores and hyphens', () => {
    const mapping = guessColumnMapping(['MAKE', 'model_year', 'registration-plate'])
    expect(mapping.make).toBe(0)
    expect(mapping.modelYear).toBe(1)
    expect(mapping.registrationPlate).toBe(2)
  })

  it('leaves a column it cannot place unmapped rather than guessing', () => {
    const mapping = guessColumnMapping(['Something Unrelated'])
    expect(mapping.make).toBeNull()
  })
})

describe('imported date handling', () => {
  it.each([
    ['2026-04-30', '2026-04-30'],
    ['2026-4-5', '2026-04-05'],
    ['30/04/2026', '2026-04-30'],
    ['30.04.2026', '2026-04-30'],
    ['05/30/2026', '2026-05-30'],
  ])('reads %s as %s', (input, expected) => {
    expect(normaliseImportedDate(input)).toBe(expected)
  })

  it('prefers day-first when both readings are possible', () => {
    // 04/05/2026 is 4 May far more often than 5 April in exported data.
    expect(normaliseImportedDate('04/05/2026')).toBe('2026-05-04')
  })

  it('returns null rather than inventing a date', () => {
    expect(normaliseImportedDate('next Tuesday')).toBeNull()
    expect(normaliseImportedDate('13/13/2026')).toBeNull()
    expect(normaliseImportedDate('')).toBeNull()
  })
})

describe('CSV import validation', () => {
  const options = { currency: 'EUR', existingPlateKeys: new Set<string>(), now: NOW }

  function validate(csv: string, existing: string[] = []) {
    const parsed = parseCsv(csv)
    return validateImportRows(parsed, guessColumnMapping(parsed.headers), {
      ...options,
      existingPlateKeys: new Set(existing),
    })
  }

  it('accepts rows that would pass the Add vehicle form', () => {
    const result = validate(
      'Make,Model,Plate,Odometer,Daily rate\nRenault,Clio,AA-11-BB,42150,350\nDacia,Duster,CC-22-DD,10000,420\n',
    )

    expect(result.validCount).toBe(2)
    expect(result.errorCount).toBe(0)
    expect(result.rows[0]?.values?.dailyRate).toBe(35_000)
  })

  it('applies exactly the same rules as the form', () => {
    // A spreadsheet must not be a way around validation.
    const result = validate('Make,Model,Plate,Odometer\nRenault,Clio,AA-11-BB,-500\n')

    expect(result.validCount).toBe(0)
    expect(result.rows[0]?.issues.some((issue) => issue.field === 'odometer')).toBe(true)
  })

  it('reports the file line number a person can find in their spreadsheet', () => {
    const result = validate('Make,Model,Plate\nRenault,Clio,AA-11-BB\n,Clio,CC-22-DD\n')
    // Header is line 1, so the second data row is line 3.
    expect(result.rows[1]?.line).toBe(3)
    expect(result.rows[1]?.issues.length).toBeGreaterThan(0)
  })

  it('catches a plate repeated inside the file', () => {
    const result = validate('Make,Model,Plate\nRenault,Clio,AA-11-BB\nDacia,Duster,aa 11 bb\n')

    expect(result.rows[1]?.duplicateOfLine).toBe(2)
    expect(isImportable(result.rows[1]!)).toBe(false)
    expect(result.validCount).toBe(1)
  })

  it('catches a plate already in the fleet', () => {
    const result = validate('Make,Model,Plate\nRenault,Clio,AA-11-BB\n', ['AA11BB'])

    expect(result.rows[0]?.conflictsWithExisting).toBe(true)
    expect(result.validCount).toBe(0)
  })

  it('reads the status words other systems use', () => {
    const result = validate(
      'Make,Model,Plate,Status\nRenault,Clio,AA-11-BB,In Service\nDacia,Duster,CC-22-DD,Servicing\n',
    )

    expect(result.rows[0]?.values?.status).toBe('available')
    expect(result.rows[1]?.values?.status).toBe('maintenance')
  })

  it('imports a vehicle marked rented as in service, because occupancy is not a column', () => {
    const result = validate('Make,Model,Plate,Status\nRenault,Clio,AA-11-BB,Rented\n')

    expect(result.rows[0]?.values?.status).toBe('available')
    expect(isImportable(result.rows[0]!)).toBe(true)
  })

  it('rejects a status word it cannot place rather than defaulting silently', () => {
    const result = validate('Make,Model,Plate,Status\nRenault,Clio,AA-11-BB,Frobnicated\n')

    expect(result.rows[0]?.issues.some((issue) => issue.field === 'status')).toBe(true)
    expect(isImportable(result.rows[0]!)).toBe(false)
  })

  it('reads fuel and transmission synonyms', () => {
    const result = validate('Make,Model,Plate,Fuel,Gearbox\nRenault,Clio,AA-11-BB,Gasoline,Auto\n')

    expect(result.rows[0]?.values?.fuelType).toBe('petrol')
    expect(result.rows[0]?.values?.transmission).toBe('automatic')
  })

  it('accepts thousands separators in an odometer column', () => {
    const result = validate('Make,Model,Plate,Mileage\nRenault,Clio,AA-11-BB,"42,150"\n')
    expect(result.rows[0]?.values?.odometer).toBe(42_150)
  })

  it('defaults a missing odometer and rate to zero rather than failing the row', () => {
    const result = validate('Make,Model,Plate\nRenault,Clio,AA-11-BB\n')

    expect(result.rows[0]?.values?.odometer).toBe(0)
    expect(result.rows[0]?.values?.dailyRate).toBe(0)
    expect(isImportable(result.rows[0]!)).toBe(true)
  })

  it('names the unreadable date instead of dropping it', () => {
    const result = validate(
      'Make,Model,Plate,Insurance\nRenault,Clio,AA-11-BB,sometime next year\n',
    )

    expect(result.rows[0]?.issues.some((issue) => issue.field === 'insuranceExpiresOn')).toBe(true)
  })

  it('lets good rows through a file that also contains bad ones', () => {
    // Partial success is the point: 2 of 3 import, and the third is named.
    const result = validate(
      'Make,Model,Plate,Odometer\nRenault,Clio,AA-11-BB,1000\n,Duster,CC-22-DD,2000\nDacia,Sandero,EE-33-FF,3000\n',
    )

    expect(result.validCount).toBe(2)
    expect(result.errorCount).toBe(1)
  })

  it('produces a template that imports cleanly against itself', () => {
    const result = validate(buildImportTemplate())
    expect(result.validCount).toBe(1)
    expect(result.errorCount).toBe(0)
  })
})
