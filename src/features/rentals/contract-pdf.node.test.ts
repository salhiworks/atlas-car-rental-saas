// @vitest-environment node
/**
 * The contract PDF is rendered here, in Node, into real bytes.
 *
 * The point is that "the PDF works" is a checkable claim rather than something
 * seen once in a browser: the file is produced, its header and trailer are
 * inspected, and the text the agreement must legally carry is found inside the
 * decompressed content streams.
 */
import { inflateSync } from 'node:zlib'

import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'

import type { ContractSnapshot } from '@/types/database'

import { contractElement, contractFileName } from './contract-pdf'

function snapshot(overrides: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    issued_at: '2028-04-02T09:15:00.000Z',
    version: 1,
    contract_number: 'ATL-2028-00042',
    agency: {
      name: 'Atlas Rentals',
      legal_name: 'Atlas Rentals SARL',
      tax_identifier: 'MA-9981726',
      email: 'desk@atlasrentals.example',
      phone: '+212 522 000 000',
      website: 'atlasrentals.example',
      address_line1: '14 Boulevard Zerktouni',
      address_line2: null,
      city: 'Casablanca',
      region: null,
      postal_code: '20250',
      country_code: 'MA',
      logo_path: null,
      time_zone: 'Africa/Casablanca',
      locale: 'en',
    },
    vehicle: {
      id: '11111111-1111-4111-8111-111111111111',
      make: 'Peugeot',
      model: '208',
      model_year: 2027,
      registration_plate: '12345-A-6',
      vin: 'VF3CCHMZ0KT012345',
      color: 'Slate',
      fuel_type: 'diesel',
      transmission: 'manual',
      seats: 5,
    },
    renter: {
      id: '22222222-2222-4222-8222-222222222222',
      display_name: 'Amina Tazi',
      customer_type: 'individual',
      email: 'amina@example.test',
      phone: '+212 600 000 000',
      date_of_birth: '1992-06-14',
      nationality_country_code: 'MA',
      address_line1: '8 Rue des Orangers',
      address_line2: null,
      city: 'Rabat',
      region: null,
      postal_code: '10000',
      country_code: 'MA',
      identity_documents: [
        {
          document_type: 'passport',
          document_number: 'PA9930187',
          issuing_country: 'MA',
          expires_on: '2031-02-28',
        },
      ],
    },
    drivers: [
      {
        customer_id: '22222222-2222-4222-8222-222222222222',
        display_name: 'Amina Tazi',
        role: 'primary',
        license_number: 'DL-4471902',
        license_country: 'MA',
        license_expires_on: '2030-09-30',
        license_classes: ['B'],
      },
      {
        customer_id: '33333333-3333-4333-8333-333333333333',
        display_name: 'Youssef Bennani',
        role: 'additional',
        license_number: 'DL-2210457',
        license_country: 'MA',
        license_expires_on: '2029-01-15',
        license_classes: ['B', 'C'],
      },
    ],
    rental: {
      starts_at: '2028-04-03T09:00:00.000Z',
      ends_at: '2028-04-08T09:00:00.000Z',
      original_ends_at: '2028-04-06T09:00:00.000Z',
      pickup_location: 'Casablanca Mohammed V Airport',
      return_location: 'Casablanca city desk',
      billable_days: 5,
      daily_rate_minor: 45000,
      notes: null,
    },
    pricing: {
      currency: 'MAD',
      subtotal_minor: 225000,
      discount_minor: 10000,
      tax_minor: 46000,
      tax_rate_bps: 2000,
      tax_label: 'VAT',
      total_minor: 291000,
      deposit_minor: 500000,
      line_items: [
        {
          kind: 'base_rental',
          description: '5 days of hire',
          quantity: 5,
          unit_amount_minor: 45000,
          amount_minor: 225000,
          is_taxable: true,
        },
        {
          kind: 'additional_driver',
          description: 'Second driver',
          quantity: 1,
          unit_amount_minor: 15000,
          amount_minor: 15000,
          is_taxable: true,
        },
        {
          kind: 'delivery',
          description: 'Airport delivery',
          quantity: 1,
          unit_amount_minor: 10000,
          amount_minor: 10000,
          is_taxable: true,
        },
        {
          kind: 'discount',
          description: 'Returning customer',
          quantity: 1,
          unit_amount_minor: -10000,
          amount_minor: -10000,
          is_taxable: true,
        },
      ],
    },
    handover: {
      picked_up_at: '2028-04-03T09:20:00.000Z',
      pickup_odometer: 41250,
      pickup_fuel_percent: 100,
      pickup_condition_notes: 'Clean, no visible damage.',
      returned_at: null,
      return_odometer: null,
      return_fuel_percent: null,
      return_condition_notes: null,
    },
    terms: {
      version: 3,
      contract_terms:
        'The renter agrees to return the vehicle in the condition described above, at the time and place stated.',
      fuel_policy: 'Return with the same fuel level as at collection.',
      mileage_policy: 'Unlimited mileage within Morocco.',
      late_return_policy: 'A late return is charged at one further rental day per started day.',
      damage_policy: 'Damage is charged at cost against the deposit.',
      deposit_policy: 'The deposit is returned within seven days of settlement.',
      footer: 'Atlas Rentals SARL · RC 448192 · Casablanca',
    },
    units: { distance: 'km', volume: 'litre' },
    ...overrides,
  }
}

async function render(input: ContractSnapshot): Promise<Buffer> {
  return renderToBuffer(await contractElement(input))
}

/**
 * Pulls the readable text out of a PDF.
 *
 * @react-pdf compresses its content streams and writes text as hex strings, so
 * a naive search of the raw bytes finds nothing. Every FlateDecode stream is
 * inflated and the text-showing operands are decoded — roughly what a PDF
 * reader does, which means these assertions are about what a person would
 * actually see on the page.
 */
function decodeHexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  let out = ''
  for (let index = 0; index + 1 < clean.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(clean.slice(index, index + 2), 16))
  }
  return out
}

function decodeLiteralString(value: string): string {
  return value.replace(/\\([()\\])/g, '$1')
}

function showOperations(block: string): string {
  const pieces: Array<{ index: number; text: string }> = []

  for (const show of block.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    pieces.push({ index: show.index, text: decodeLiteralString(show[1]!) })
  }
  for (const show of block.matchAll(/<([0-9a-fA-F\s]*)>\s*Tj/g)) {
    pieces.push({ index: show.index, text: decodeHexString(show[1]!) })
  }
  // Kerned runs: [ <54> -160 <45> … ] TJ, which is what @react-pdf emits.
  for (const array of block.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
    let run = ''
    for (const piece of array[1]!.matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]*)>/g)) {
      run += piece[1] === undefined ? decodeHexString(piece[2]!) : decodeLiteralString(piece[1])
    }
    pieces.push({ index: array.index, text: run })
  }

  return pieces
    .sort((a, b) => a.index - b.index)
    .map((piece) => piece.text)
    .join('')
}

function extractText(pdf: Buffer): string {
  const parts: string[] = []
  const raw = pdf.toString('latin1')
  const streamPattern = /stream\r?\n/g

  let match: RegExpExecArray | null
  while ((match = streamPattern.exec(raw)) !== null) {
    const start = match.index + match[0].length
    const end = raw.indexOf('endstream', start)
    if (end === -1) continue

    let inflated: Buffer
    try {
      inflated = inflateSync(pdf.subarray(start, end))
    } catch {
      continue
    }

    // Runs inside one BT…ET are one piece of text on the page; kerning splits
    // them into several operators, so they are joined without a separator.
    const content = inflated.toString('latin1')
    for (const block of content.matchAll(/BT\b([\s\S]*?)\bET\b/g)) {
      const text = showOperations(block[1]!)
      if (text.trim() !== '') parts.push(text)
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * The same text with every space removed.
 *
 * @react-pdf emits one text object per word with its own translation matrix, so
 * where a word sits on the page is recoverable but where one word ends and the
 * next begins is not. For values written without spaces — a plate, a VIN, a
 * contract number — comparing the spaceless form is the accurate check.
 */
function compact(text: string): string {
  return text.replace(/\s+/g, '')
}

describe('the contract PDF', () => {
  it('produces a real PDF file', async () => {
    const pdf = await render(snapshot())

    expect(pdf.byteLength).toBeGreaterThan(2000)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF')
  }, 30_000)

  it('carries the parties, the vehicle and the contract number', async () => {
    const text = extractText(await render(snapshot()))

    expect(text).toContain('Atlas Rentals SARL')
    expect(text).toContain('Amina Tazi')
    expect(text).toContain('Peugeot')
    expect(compact(text)).toContain('ATL-2028-00042')
    expect(compact(text)).toContain('12345-A-6')
    expect(compact(text)).toContain('VF3CCHMZ0KT012345')
  }, 30_000)

  it('lists every authorised driver with their licence', async () => {
    const text = extractText(await render(snapshot()))

    expect(text).toContain('Youssef Bennani')
    expect(compact(text)).toContain('DL-2210457')
    expect(compact(text)).toContain('DL-4471902')
    expect(text).toContain('Primary')
    expect(text).toContain('Additional')
  }, 30_000)

  it('shows each charge and the total the customer is asked for', async () => {
    const text = extractText(await render(snapshot()))

    expect(text).toContain('5 days of hire')
    expect(text).toContain('Airport delivery')
    expect(text).toContain('Returning customer')
    // 291000 minor units of MAD, and the deposit stated separately from it.
    expect(compact(text)).toContain('2,910.00')
    expect(compact(text)).toContain('5,000.00')
  }, 30_000)

  it('prints the agency wording and nothing invented', async () => {
    const text = extractText(await render(snapshot()))

    expect(text).toContain('Unlimited mileage within Morocco')
    expect(text).toContain('Return with the same fuel level')
  }, 30_000)

  /*
   * The branding rule, held to by the one document that leaves the building.
   *
   * A rental agreement is between an agency and its renter. Neither the product
   * nor the company that wrote it is a party to it, and a renter in Casablanca
   * has no reason to find a software publisher printed on their car hire
   * contract. The agency's name is on it; ours is not.
   */
  it('carries the agency’s identity and names neither the product nor its publisher', async () => {
    const text = extractText(await render(snapshot()))

    // The agency, on its own paperwork.
    expect(text).toContain('Atlas Rentals SARL')
    expect(text).toContain('desk@atlasrentals.example')

    // And nobody else. `Atlas Rentals` is the agency in this fixture, so the
    // product name is searched for as a standalone word rather than a substring.
    expect(text).not.toMatch(/Profit Studio/i)
    expect(text).not.toMatch(/profitstudio/i)
    expect(text).not.toMatch(/\bAtlas\b(?!\s+Rentals)/)
  }, 30_000)

  it('renders an agency that has written no terms at all', async () => {
    const bare = snapshot({
      terms: {
        version: 1,
        contract_terms: null,
        fuel_policy: null,
        mileage_policy: null,
        late_return_policy: null,
        damage_policy: null,
        deposit_policy: null,
        footer: null,
      },
    })

    const pdf = await render(bare)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    const text = extractText(pdf)
    // No invented legal wording where the agency supplied none.
    expect(text).not.toMatch(/terms and conditions/i)
    expect(compact(text)).toContain('ATL-2028-00042')
  }, 30_000)

  it('renders a contract with no handover recorded yet', async () => {
    const pdf = await render(
      snapshot({
        handover: {
          picked_up_at: null,
          pickup_odometer: null,
          pickup_fuel_percent: null,
          pickup_condition_notes: null,
          returned_at: null,
          return_odometer: null,
          return_fuel_percent: null,
          return_condition_notes: null,
        },
      }),
    )
    expect(pdf.byteLength).toBeGreaterThan(2000)
  }, 30_000)

  it('names the file the way an agency would file it', () => {
    expect(contractFileName(snapshot())).toBe('ATL-2028-00042.pdf')
    expect(contractFileName(snapshot({ version: 3 }))).toBe('ATL-2028-00042-v3.pdf')
  })
})
