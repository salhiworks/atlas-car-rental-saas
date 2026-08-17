import { describe, expect, it } from 'vitest'

import {
  buildCustomerImportTemplate,
  guessCustomerColumnMapping,
  isImportable,
  parseCsv,
  validateCustomerImport,
} from './csv'
import {
  documentNumberKey,
  driverEligibility,
  maskDocumentNumber,
  normaliseDocumentNumber,
  phoneKey,
} from './identity'
import { customerDocumentSchema, customerSchema, emptyCustomerForm } from './schemas'

describe('identifier normalisation', () => {
  it('compares document numbers without spacing or case', () => {
    // Must agree with document_number_normalized in the database, or the client
    // accepts what the unique index then rejects.
    expect(documentNumberKey('AB 123 456')).toBe('AB123456')
    expect(documentNumberKey('ab-123-456')).toBe('AB123456')
    expect(documentNumberKey(' ab123456 ')).toBe('AB123456')
  })

  it('keeps the number as presented for storage', () => {
    expect(normaliseDocumentNumber('  AB  123  456  ')).toBe('AB 123 456')
  })

  it('compares phone numbers on their digits', () => {
    expect(phoneKey('+212 600 112233')).toBe('212600112233')
    expect(phoneKey('(212) 600-112233')).toBe('212600112233')
  })
})

describe('masking', () => {
  it('shows only the last four characters', () => {
    expect(maskDocumentNumber('AB123456')).toBe('•••• 3456')
    expect(maskDocumentNumber('DL8842197')).toBe('•••• 2197')
  })

  it('does not mask a value too short to be worth masking', () => {
    expect(maskDocumentNumber('123')).toBe('123')
  })

  it('renders an absent value as a dash rather than empty mask characters', () => {
    expect(maskDocumentNumber(null)).toBe('—')
    expect(maskDocumentNumber('')).toBe('—')
  })
})

describe('driver eligibility', () => {
  it('distinguishes a missing licence from an expired one', () => {
    // "Unknown" is never treated as valid: one is a records gap staff can fix,
    // the other is a person who must not be handed keys.
    expect(driverEligibility({ hasLicence: false, expiresOn: null }, 'unrecorded')).toBe(
      'no-licence',
    )
    expect(driverEligibility({ hasLicence: true, expiresOn: '2020-01-01' }, 'expired')).toBe(
      'expired',
    )
    expect(driverEligibility({ hasLicence: true, expiresOn: null }, 'unrecorded')).toBe(
      'expiry-unknown',
    )
  })

  it('treats a valid or soon-expiring licence as eligible to drive', () => {
    expect(driverEligibility({ hasLicence: true, expiresOn: '2030-01-01' }, 'valid')).toBe(
      'eligible',
    )
    expect(driverEligibility({ hasLicence: true, expiresOn: '2026-07-01' }, 'due-soon')).toBe(
      'eligible',
    )
  })
})

describe('customer validation', () => {
  const valid = { ...emptyCustomerForm(), firstName: 'Amina', lastName: 'Benali' }

  it('accepts a customer with only a name', () => {
    // Deliberate: a booking is often taken by phone before any document exists.
    expect(customerSchema.safeParse(valid).success).toBe(true)
  })

  it('requires a name appropriate to the customer type', () => {
    expect(
      customerSchema.safeParse({ ...emptyCustomerForm(), firstName: '', lastName: '' }).success,
    ).toBe(false)

    expect(
      customerSchema.safeParse({ ...emptyCustomerForm(), customerType: 'company' }).success,
    ).toBe(false)

    expect(
      customerSchema.safeParse({
        ...emptyCustomerForm(),
        customerType: 'company',
        companyName: 'Northbound Logistics',
      }).success,
    ).toBe(true)
  })

  it('refuses a birth date in the future', () => {
    const nextYear = String(new Date().getUTCFullYear() + 1)
    expect(customerSchema.safeParse({ ...valid, dateOfBirth: `${nextYear}-01-01` }).success).toBe(
      false,
    )
  })

  it('refuses a birth date before 1900 or one that does not exist', () => {
    expect(customerSchema.safeParse({ ...valid, dateOfBirth: '1899-01-01' }).success).toBe(false)
    expect(customerSchema.safeParse({ ...valid, dateOfBirth: '2026-02-30' }).success).toBe(false)
  })

  it('accepts international phone numbers without assuming a format', () => {
    for (const phone of [
      '+212 600 112233',
      '06 00 11 22 33',
      '+1 (555) 010-9999',
      '00212600112233',
    ]) {
      expect(customerSchema.safeParse({ ...valid, phone }).success, phone).toBe(true)
    }
  })

  it('refuses a phone number with no digits at all', () => {
    expect(customerSchema.safeParse({ ...valid, phone: 'call the hotel' }).success).toBe(false)
  })

  it('refuses a malformed email but allows none', () => {
    expect(customerSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false)
    expect(customerSchema.safeParse({ ...valid, email: '' }).success).toBe(true)
  })

  it('turns blank optional fields into null rather than empty strings', () => {
    const result = customerSchema.parse(valid)
    expect(result.email).toBeNull()
    expect(result.city).toBeNull()
    expect(result.nationalityCountryCode).toBeNull()
  })

  it('refuses a country that is not a real ISO code', () => {
    expect(customerSchema.safeParse({ ...valid, nationalityCountryCode: 'ZZ' }).success).toBe(false)
    expect(customerSchema.safeParse({ ...valid, nationalityCountryCode: 'ma' }).success).toBe(true)
  })
})

describe('document validation', () => {
  const valid = {
    documentType: 'passport' as const,
    documentNumber: 'AB123456',
    issuingCountry: 'MA',
    issuedOn: '',
    expiresOn: '',
    licenseClasses: '',
    notes: '',
  }

  it('accepts a document with just a type and number', () => {
    expect(customerDocumentSchema.safeParse(valid).success).toBe(true)
  })

  it('refuses an expiry before the issue date', () => {
    const result = customerDocumentSchema.safeParse({
      ...valid,
      issuedOn: '2026-06-01',
      expiresOn: '2026-01-01',
    })
    expect(result.success).toBe(false)
  })

  it('accepts an expiry equal to the issue date', () => {
    expect(
      customerDocumentSchema.safeParse({
        ...valid,
        issuedOn: '2026-06-01',
        expiresOn: '2026-06-01',
      }).success,
    ).toBe(true)
  })

  it('parses licence classes into an array', () => {
    const result = customerDocumentSchema.parse({
      ...valid,
      documentType: 'driver_license',
      licenseClasses: 'b, c1 , d',
    })
    expect(result.licenseClasses).toEqual(['B', 'C1', 'D'])
  })

  it('refuses vehicle classes on a document that is not a licence', () => {
    expect(
      customerDocumentSchema.safeParse({ ...valid, documentType: 'passport', licenseClasses: 'B' })
        .success,
    ).toBe(false)
  })

  it('refuses a number with no letters or digits', () => {
    expect(customerDocumentSchema.safeParse({ ...valid, documentNumber: '----' }).success).toBe(
      false,
    )
  })
})

describe('customer CSV import', () => {
  function validate(csv: string, existing: string[] = []) {
    const parsed = parseCsv(csv)
    return validateCustomerImport(parsed, guessCustomerColumnMapping(parsed.headers), {
      existingDocumentKeys: new Set(existing),
    })
  }

  it('recognises the column names other systems use', () => {
    const mapping = guessCustomerColumnMapping([
      'Given name',
      'Surname',
      'E mail',
      'Mobile',
      'Passport number',
      'DOB',
    ])

    expect(mapping.firstName).toBe(0)
    expect(mapping.lastName).toBe(1)
    expect(mapping.email).toBe(2)
    expect(mapping.phone).toBe(3)
    expect(mapping.documentNumber).toBe(4)
    expect(mapping.dateOfBirth).toBe(5)
  })

  it('imports rows that would pass the form', () => {
    const result = validate(
      'First name,Last name,Email,Phone\nAmina,Benali,amina@example.com,+212600112233\nJoão,Silva,joao@example.com,+351910000000\n',
    )

    expect(result.validCount).toBe(2)
    expect(result.errorCount).toBe(0)
    expect(result.rows[0]?.values?.customer.firstName).toBe('Amina')
  })

  it('applies exactly the same rules as the form', () => {
    // A spreadsheet must not be a way around validation.
    const result = validate('First name,Last name,Email\nAmina,Benali,not-an-email\n')

    expect(result.validCount).toBe(0)
    expect(result.rows[0]?.issues.some((issue) => issue.field === 'email')).toBe(true)
  })

  it('reports the file line number a person can find in their spreadsheet', () => {
    const result = validate('First name,Last name\nAmina,Benali\n,\n')
    expect(result.rows[1]?.line).toBe(3)
    expect(result.rows[1]?.issues.length).toBeGreaterThan(0)
  })

  it('attaches identity and licence documents from flat columns', () => {
    const result = validate(
      'First name,Last name,ID type,ID number,ID country,Licence number,Licence country\nAmina,Benali,Passport,AB123456,MA,DL8842197,MA\n',
    )

    expect(result.rows[0]?.values?.identityDocument).toMatchObject({
      documentType: 'passport',
      documentNumber: 'AB123456',
      issuingCountry: 'MA',
    })
    expect(result.rows[0]?.values?.driverLicense).toMatchObject({ documentNumber: 'DL8842197' })
  })

  it('catches the same document repeated inside the file', () => {
    const result = validate(
      'First name,Last name,ID type,ID number,ID country\nAmina,Benali,Passport,AB 123 456,MA\nOther,Person,Passport,ab123456,ma\n',
    )

    expect(result.rows[1]?.duplicateOfLine).toBe(2)
    expect(isImportable(result.rows[1]!)).toBe(false)
    expect(result.validCount).toBe(1)
  })

  it('catches a document already on file', () => {
    const result = validate(
      'First name,Last name,ID type,ID number,ID country\nAmina,Benali,Passport,AB123456,MA\n',
      ['passport:MA:AB123456'],
    )

    expect(result.rows[0]?.conflictsWithExisting).toBe(true)
    expect(result.validCount).toBe(0)
  })

  it('does not treat two people with the same name as duplicates', () => {
    // Two customers can genuinely be called the same thing; only an identifier
    // collision is a duplicate.
    const result = validate('First name,Last name\nMohamed,Alami\nMohamed,Alami\n')

    expect(result.validCount).toBe(2)
    expect(result.duplicateCount).toBe(0)
  })

  it('reads the document type words other systems use', () => {
    const result = validate(
      'First name,Last name,ID type,ID number\nAmina,Benali,Identity card,AB123456\n',
    )
    expect(result.rows[0]?.values?.identityDocument?.documentType).toBe('national_id')
  })

  it('rejects a document type it cannot place rather than guessing', () => {
    const result = validate(
      'First name,Last name,ID type,ID number\nAmina,Benali,Frobnicated,AB123456\n',
    )
    expect(result.rows[0]?.issues.some((issue) => issue.field === 'documentType')).toBe(true)
    expect(isImportable(result.rows[0]!)).toBe(false)
  })

  it('reads the date shapes spreadsheets export', () => {
    const result = validate('First name,Last name,DOB\nAmina,Benali,12/04/1990\n')
    expect(result.rows[0]?.values?.customer.dateOfBirth).toBe('1990-04-12')
  })

  it('names an unreadable date instead of dropping it', () => {
    const result = validate('First name,Last name,DOB\nAmina,Benali,sometime in 1990\n')
    expect(result.rows[0]?.issues.some((issue) => issue.field === 'dateOfBirth')).toBe(true)
  })

  it('treats a row with a company name as a company', () => {
    const result = validate('Company,Email\nNorthbound Logistics,ops@northbound.example\n')
    expect(result.rows[0]?.values?.customer.customerType).toBe('company')
    expect(isImportable(result.rows[0]!)).toBe(true)
  })

  it('lets good rows through a file that also contains bad ones', () => {
    const result = validate(
      'First name,Last name,Email\nAmina,Benali,amina@example.com\n,,\nJoão,Silva,joao@example.com\n',
    )

    expect(result.validCount).toBe(2)
    expect(result.errorCount).toBe(1)
  })

  it('produces a template that imports cleanly against itself', () => {
    const result = validate(buildCustomerImportTemplate())
    expect(result.validCount).toBe(1)
    expect(result.errorCount).toBe(0)
  })
})
