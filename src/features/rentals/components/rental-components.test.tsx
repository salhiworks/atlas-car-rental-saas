import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import type { RentalBoardEntry } from '@/types/database'

import { quoteFromLines, type QuoteLine } from '../pricing'
import { QuoteSummary } from './QuoteSummary'
import { RentalCardList } from './RentalCardList'
import { RentalTable } from './RentalTable'

function makeRental(overrides: Partial<RentalBoardEntry> = {}): RentalBoardEntry {
  return {
    id: 'rental-1',
    organization_id: 'org-1',
    reference: 'RNT-2028-00007',
    status: 'reserved',
    starts_at: '2028-06-01T09:00:00Z',
    ends_at: '2028-06-05T09:00:00Z',
    pickup_location: 'Airport',
    return_location: null,
    currency: 'EUR',
    total_minor: 24000,
    amount_paid_minor: 10000,
    balance_due_minor: 14000,
    deposit_minor: 30000,
    deposit_held_minor: 30000,
    payment_status: 'partially_paid',
    picked_up_at: null,
    returned_at: null,
    extension_count: 0,
    created_at: '2028-05-20T09:00:00Z',
    vehicle_id: 'vehicle-1',
    vehicle_make: 'Peugeot',
    vehicle_model: '208',
    vehicle_model_year: 2027,
    vehicle_plate: '12345-A-6',
    customer_id: 'customer-1',
    customer_name: 'Amina Tazi',
    customer_type: 'individual',
    primary_driver_id: 'customer-1',
    primary_driver_name: 'Amina Tazi',
    renter_is_not_driver: false,
    driver_count: 1,
    is_overdue: false,
    contract_version: null,
    contract_status: null,
    contract_pdf_path: null,
    contract_signed_at: null,
    ...overrides,
  }
}

function renderTable(rentals: RentalBoardEntry[]) {
  return render(
    <MemoryRouter>
      <RentalTable rentals={rentals} locale="en" timeZone="Europe/Paris" />
    </MemoryRouter>,
  )
}

describe('the rentals table', () => {
  it('shows the contract, the renter and the vehicle', () => {
    renderTable([makeRental()])

    expect(screen.getByRole('link', { name: 'RNT-2028-00007' })).toHaveAttribute(
      'href',
      '/rentals/rental-1',
    )
    expect(screen.getByText('Amina Tazi')).toBeInTheDocument()
    expect(screen.getByText('12345-A-6')).toBeInTheDocument()
  })

  it('says who is driving when it is not the renter', () => {
    renderTable([
      makeRental({
        renter_is_not_driver: true,
        primary_driver_id: 'customer-2',
        primary_driver_name: 'Youssef Bennani',
        driver_count: 2,
      }),
    ])

    expect(screen.getByText(/Youssef Bennani driving/)).toBeInTheDocument()
  })

  it('flags a rental that is past its return time', () => {
    renderTable([makeRental({ status: 'active', is_overdue: true })])
    expect(screen.getByText('Overdue')).toBeInTheDocument()
  })

  it('shows the deposit held apart from what is owed', () => {
    const { container } = renderTable([makeRental()])
    const row = within(container).getByRole('row', { name: /RNT-2028-00007/ })

    // The balance is what the customer still owes for the hire; the deposit is
    // reported separately because it is their money, held.
    expect(within(row).getByText(/€140\.00/)).toBeInTheDocument()
    expect(within(row).getByText(/€300\.00 held/)).toBeInTheDocument()
  })

  it('marks a cancelled contract without hiding it', () => {
    renderTable([makeRental({ status: 'cancelled' })])
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'RNT-2028-00007' })).toBeInTheDocument()
  })
})

describe('the rentals card list', () => {
  it('renders the same contract on a small screen', () => {
    render(
      <MemoryRouter>
        <RentalCardList rentals={[makeRental()]} locale="en" timeZone="Europe/Paris" />
      </MemoryRouter>,
    )

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/rentals/rental-1')
    expect(within(link).getByText('Amina Tazi')).toBeInTheDocument()
  })
})

describe('the quote', () => {
  const lines: QuoteLine[] = [
    {
      kind: 'base_rental',
      description: '4 days of hire',
      quantity: 4,
      unitAmountMinor: 5000,
      amountMinor: 20000,
      isTaxable: true,
    },
    {
      kind: 'child_seat',
      description: 'Child seat',
      quantity: 1,
      unitAmountMinor: 2000,
      amountMinor: 2000,
      isTaxable: true,
    },
    {
      kind: 'discount',
      description: 'Returning customer',
      quantity: 1,
      unitAmountMinor: -2000,
      amountMinor: -2000,
      isTaxable: true,
    },
  ]

  it('keeps the deposit out of the total', () => {
    const quote = quoteFromLines(lines, 'EUR', 2000)

    render(<QuoteSummary quote={quote} locale="en" depositMinor={30000} taxLabel="VAT" />)

    // 200 + 20 − 20 = 200, plus 20% tax = 240. The 300 deposit is stated, never added.
    expect(screen.getByText('€240.00')).toBeInTheDocument()
    expect(screen.getByText(/Refundable deposit/)).toBeInTheDocument()
    expect(screen.getByText('€300.00')).toBeInTheDocument()
  })

  it('names the tax the agency calls it', () => {
    const quote = quoteFromLines(lines, 'EUR', 750)
    render(<QuoteSummary quote={quote} locale="en" depositMinor={0} taxLabel="TVA" />)

    expect(screen.getByText(/TVA \(7\.50%\)/)).toBeInTheDocument()
  })

  it('says plainly when nothing is charged', () => {
    const quote = quoteFromLines([], 'EUR', 0)
    render(<QuoteSummary quote={quote} locale="en" depositMinor={0} taxLabel={null} />)

    expect(screen.getByText('Nothing charged yet.')).toBeInTheDocument()
  })
})
