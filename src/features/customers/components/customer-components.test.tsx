import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import type { ComplianceOptions } from '@/lib/compliance/expiry'
import type { CustomerDirectoryEntry } from '@/types/database'

import { CustomerCardList } from './CustomerCardList'
import { CustomerTable } from './CustomerTable'
import { SensitiveValue } from './SensitiveValue'

const COMPLIANCE: ComplianceOptions = {
  timeZone: 'Europe/Lisbon',
  leadDays: 30,
  now: new Date('2026-06-15T12:00:00Z'),
}

function makeCustomer(overrides: Partial<CustomerDirectoryEntry> = {}): CustomerDirectoryEntry {
  return {
    customer_id: 'customer-1',
    organization_id: 'org-1',
    customer_type: 'individual',
    display_name: 'Amina Benali',
    first_name: 'Amina',
    last_name: 'Benali',
    company_name: null,
    email: 'amina@example.com',
    phone: '+212 600 112233',
    secondary_phone: null,
    date_of_birth: '1990-04-12',
    nationality_country_code: 'MA',
    country_code: 'MA',
    city: 'Casablanca',
    region: null,
    postal_code: null,
    address_line1: null,
    address_line2: null,
    preferred_locale: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    identity_document_count: 1,
    document_count: 2,
    identity_expires_on: '2030-04-12',
    driver_license_id: 'licence-1',
    driver_license_country: 'MA',
    driver_license_issued_on: '2015-01-01',
    driver_license_expires_on: '2030-09-30',
    driver_license_classes: ['B'],
    has_driver_license: true,
    rental_count: 3,
    first_rental_at: '2025-01-01T00:00:00Z',
    last_rental_ends_at: '2026-05-01T00:00:00Z',
    active_rental_id: null,
    active_rental_reference: null,
    active_rental_ends_at: null,
    upcoming_rental_id: null,
    upcoming_rental_reference: null,
    upcoming_rental_starts_at: null,
    outstanding_currency_count: 0,
    outstanding_minor: null,
    outstanding_currency: null,
    ...overrides,
  }
}

function renderTable(customers: CustomerDirectoryEntry[]) {
  return render(
    <MemoryRouter>
      <CustomerTable customers={customers} compliance={COMPLIANCE} locale="en" />
    </MemoryRouter>,
  )
}

describe('CustomerTable', () => {
  it('shows what a person at the counter is matching against', () => {
    renderTable([makeCustomer()])

    expect(screen.getByText('Amina Benali')).toBeInTheDocument()
    expect(screen.getByText('+212 600 112233')).toBeInTheDocument()
    expect(screen.getByText('amina@example.com')).toBeInTheDocument()
    expect(screen.getByText('Morocco')).toBeInTheDocument()
  })

  it('never puts a document number in the list', () => {
    // The list answers "who is this and can they drive". Reading an identifier
    // is something you do on the profile, having opened it on purpose.
    const { container } = renderTable([makeCustomer()])
    expect(container.textContent).not.toMatch(/AB123456|DL8842197/)
  })

  it('links each row to the profile', () => {
    renderTable([makeCustomer({ customer_id: 'abc-123' })])

    expect(screen.getByRole('link', { name: /Amina Benali/ })).toHaveAttribute(
      'href',
      '/customers/abc-123',
    )
  })

  it('reports a valid licence as able to drive', () => {
    renderTable([makeCustomer()])
    expect(screen.getByText('Can drive')).toBeInTheDocument()
  })

  it('reports an expired licence distinctly from a missing one', () => {
    renderTable([makeCustomer({ driver_license_expires_on: '2020-01-01' })])
    expect(screen.getByText('Licence expired')).toBeInTheDocument()

    renderTable([
      makeCustomer({
        customer_id: 'customer-2',
        has_driver_license: false,
        driver_license_expires_on: null,
      }),
    ])
    expect(screen.getAllByText('No licence on file').length).toBeGreaterThan(0)
  })

  it('flags a licence expiring inside the agency window', () => {
    renderTable([makeCustomer({ driver_license_expires_on: '2026-07-01' })])
    expect(screen.getByText('Licence expiring soon')).toBeInTheDocument()
  })

  it('says when a customer is out on a contract', () => {
    renderTable([
      makeCustomer({ active_rental_id: 'rental-1', active_rental_reference: 'RNT-00001' }),
    ])
    expect(screen.getByText('Renting now')).toBeInTheDocument()
  })

  it('marks an archived customer without hiding them', () => {
    renderTable([makeCustomer({ archived_at: '2026-05-01T00:00:00Z' })])

    expect(screen.getByText('Amina Benali')).toBeInTheDocument()
    expect(screen.getByText('Archived')).toBeInTheDocument()
  })

  it('notes when no identification is on file', () => {
    renderTable([makeCustomer({ identity_document_count: 0 })])
    expect(screen.getByText('No ID on file')).toBeInTheDocument()
  })
})

describe('outstanding balance', () => {
  it('shows the amount when exactly one currency is involved', () => {
    renderTable([
      makeCustomer({
        outstanding_currency_count: 1,
        outstanding_minor: 50_000,
        outstanding_currency: 'EUR',
      }),
    ])

    expect(screen.getByText('€500.00')).toBeInTheDocument()
  })

  it('refuses to state a total once currencies are mixed', () => {
    // Adding EUR to MAD would be a confident lie, and this product holds no
    // exchange rate.
    renderTable([makeCustomer({ outstanding_currency_count: 2, outstanding_minor: null })])

    expect(screen.getByText('2 currencies')).toBeInTheDocument()
    expect(screen.queryByText(/€|\$/)).not.toBeInTheDocument()
  })

  it('shows a dash when nothing is owed', () => {
    renderTable([makeCustomer({ outstanding_currency_count: 0 })])
    const row = screen.getByRole('row', { name: /Amina Benali/ })
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0)
  })
})

describe('CustomerCardList', () => {
  it('carries the same facts for narrow screens', () => {
    render(
      <MemoryRouter>
        <CustomerCardList customers={[makeCustomer()]} compliance={COMPLIANCE} locale="en" />
      </MemoryRouter>,
    )

    const link = screen.getByRole('link')
    expect(within(link).getByText('Amina Benali')).toBeInTheDocument()
    expect(within(link).getByText('+212 600 112233')).toBeInTheDocument()
    expect(within(link).getByText('Can drive')).toBeInTheDocument()
  })

  it('does not expose identifiers on mobile either', () => {
    const { container } = render(
      <MemoryRouter>
        <CustomerCardList customers={[makeCustomer()]} compliance={COMPLIANCE} locale="en" />
      </MemoryRouter>,
    )
    expect(container.textContent).not.toMatch(/AB123456/)
  })
})

describe('SensitiveValue', () => {
  it('masks the identifier by default', () => {
    render(<SensitiveValue value="AB123456" />)

    expect(screen.getByText('•••• 3456')).toBeInTheDocument()
    expect(screen.queryByText('AB123456')).not.toBeInTheDocument()
  })

  it('reveals the full value only when asked', async () => {
    const user = userEvent.setup()
    render(<SensitiveValue value="AB123456" />)

    await user.click(screen.getByRole('button', { name: /show the full/i }))
    expect(screen.getByText('AB123456')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /hide the full/i }))
    expect(screen.getByText('•••• 3456')).toBeInTheDocument()
  })

  it('offers no reveal control when the viewer may not see the value', () => {
    render(<SensitiveValue value="AB123456" canReveal={false} />)

    expect(screen.getByText('•••• 3456')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders a dash for an absent value', () => {
    render(<SensitiveValue value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
