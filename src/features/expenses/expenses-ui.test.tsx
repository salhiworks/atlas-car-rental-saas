import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import type {
  ExpenseCategoryBreakdownRow,
  ExpenseChangeEvent,
  ExpenseLedgerEntry,
  ExpenseSummaryRow,
} from '@/types/database'

import { CategoryBreakdown } from './components/CategoryBreakdown'
import { ChangeHistory } from './components/ChangeHistory'
import { AllocationCell, ExpenseStatusBadge } from './components/ExpenseBadges'
import { ExpenseSummaryStrip } from './components/ExpenseSummary'

/**
 * What the Expenses screens actually put in front of a person.
 *
 * These render for real rather than asserting on props, because the claims
 * being tested are claims about what a manager reads: that two currencies are
 * never added, that a voided cost is unmistakable, and that a correction shows
 * the figure it replaced.
 */

const LOCALE = 'en-GB'

function summaryRow(overrides: Partial<ExpenseSummaryRow> = {}): ExpenseSummaryRow {
  return {
    currency: 'MAD',
    total_minor: 1000000,
    overhead_minor: 400000,
    vehicle_minor: 500000,
    rental_minor: 100000,
    tax_minor: 160000,
    expense_count: 9,
    voided_count: 0,
    ...overrides,
  }
}

function ledgerEntry(overrides: Partial<ExpenseLedgerEntry> = {}): ExpenseLedgerEntry {
  return {
    id: 'expense-1',
    organization_id: 'org-1',
    incurred_on: '2026-07-14',
    description: 'Front brake pads',
    amount_minor: 184000,
    tax_amount_minor: 30667,
    net_amount_minor: 153333,
    tax_rate_bps: 2000,
    tax_label: 'VAT',
    currency: 'MAD',
    status: 'recorded',
    source: 'manual',
    allocation: 'vehicle',
    payment_method: 'card',
    reference: 'INV-184',
    notes: null,
    odometer: null,
    category_id: 'cat-1',
    category_name: 'Repairs',
    category_system_key: 'repairs',
    category_archived: false,
    vendor_id: 'vendor-1',
    vendor_name: 'Garage Atlas',
    vendor_archived: false,
    effective_vehicle_id: 'vehicle-1',
    vehicle_plate: '12-A-34567',
    vehicle_make: 'Renault',
    vehicle_model: 'Clio',
    vehicle_archived: false,
    rental_id: null,
    rental_reference: null,
    attachment_count: 0,
    voided_at: null,
    void_reason: null,
    created_by: 'user-1',
    created_at: '2026-07-14T09:00:00.000Z',
    updated_by: null,
    updated_at: '2026-07-14T09:00:00.000Z',
    ...overrides,
  }
}

describe('the period summary', () => {
  it('shows one headline when the agency spent in one currency', () => {
    render(
      <ExpenseSummaryStrip
        rows={[summaryRow()]}
        locale={LOCALE}
        isLoading={false}
        active={null}
        onSelect={() => undefined}
        onClear={() => undefined}
      />,
    )

    expect(screen.getByText(/Total spent/)).toBeInTheDocument()
    expect(screen.getByText(/Agency overhead/)).toBeInTheDocument()
  })

  it('refuses to add two currencies together, and says why', () => {
    render(
      <ExpenseSummaryStrip
        rows={[summaryRow(), summaryRow({ currency: 'EUR', total_minor: 250000 })]}
        locale={LOCALE}
        isLoading={false}
        active={null}
        onSelect={() => undefined}
        onClear={() => undefined}
      />,
    )

    expect(screen.getByText('Spending in more than one currency')).toBeInTheDocument()
    expect(screen.getByText(/holds no exchange rate/)).toBeInTheDocument()
    expect(screen.getByText('MAD')).toBeInTheDocument()
    expect(screen.getByText('EUR')).toBeInTheDocument()
    // No combined figure anywhere.
    expect(screen.queryByText(/Total spent/)).not.toBeInTheDocument()
  })

  it('renders nothing at all rather than a strip of zeros', () => {
    const { container } = render(
      <ExpenseSummaryStrip
        rows={[]}
        locale={LOCALE}
        isLoading={false}
        active={null}
        onSelect={() => undefined}
        onClear={() => undefined}
      />,
    )

    // Zeros would be a lie about a period nobody has recorded anything in, and
    // a bordered box saying so is the page's own empty state said twice.
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Agency overhead')).not.toBeInTheDocument()
  })

  it('filters on a tile, and clears when the same tile is pressed again', async () => {
    const onSelect = vi.fn()
    const onClear = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(
      <ExpenseSummaryStrip
        rows={[summaryRow()]}
        locale={LOCALE}
        isLoading={false}
        active={null}
        onSelect={onSelect}
        onClear={onClear}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Vehicle costs/ }))
    expect(onSelect).toHaveBeenCalledWith('vehicle')

    rerender(
      <ExpenseSummaryStrip
        rows={[summaryRow()]}
        locale={LOCALE}
        isLoading={false}
        active="vehicle"
        onSelect={onSelect}
        onClear={onClear}
      />,
    )

    const tile = screen.getByRole('button', { name: /Vehicle costs/ })
    expect(tile).toHaveAttribute('aria-pressed', 'true')
    await user.click(tile)
    expect(onClear).toHaveBeenCalled()
  })
})

describe('the category breakdown', () => {
  const rows: ExpenseCategoryBreakdownRow[] = [
    {
      category_id: 'cat-1',
      category_name: 'Repairs',
      currency: 'MAD',
      total_minor: 600000,
      expense_count: 4,
    },
    {
      category_id: 'cat-2',
      category_name: 'Fuel',
      currency: 'MAD',
      total_minor: 200000,
      expense_count: 6,
    },
  ]

  it('lists categories largest first', () => {
    render(
      <CategoryBreakdown
        rows={rows}
        locale={LOCALE}
        isLoading={false}
        onSelect={() => undefined}
        activeCategoryId={null}
      />,
    )

    const labels = screen.getAllByText(/Repairs|Fuel/).map((node) => node.textContent)
    expect(labels[0]).toBe('Repairs')
  })

  it('keeps each currency’s shares separate', () => {
    render(
      <CategoryBreakdown
        rows={[
          ...rows,
          { ...rows[0]!, category_id: 'cat-3', currency: 'EUR', total_minor: 100000 },
        ]}
        locale={LOCALE}
        isLoading={false}
        onSelect={() => undefined}
        activeCategoryId={null}
      />,
    )

    expect(screen.getByText('EUR')).toBeInTheDocument()
    expect(screen.getByText('MAD')).toBeInTheDocument()
  })

  it('narrows the ledger when a category is chosen', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()

    render(
      <CategoryBreakdown
        rows={rows}
        locale={LOCALE}
        isLoading={false}
        onSelect={onSelect}
        activeCategoryId={null}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Repairs/ }))
    expect(onSelect).toHaveBeenCalledWith('cat-1')
  })
})

describe('what a cost belongs to, on screen', () => {
  it('links a vehicle cost to its car', () => {
    render(
      <MemoryRouter>
        <AllocationCell expense={ledgerEntry()} />
      </MemoryRouter>,
    )

    const link = screen.getByRole('link', { name: 'Renault Clio' })
    expect(link).toHaveAttribute('href', '/vehicles/vehicle-1')
    expect(screen.getByText(/12-A-34567/)).toBeInTheDocument()
  })

  it('links a rental cost to the contract, and shows the car it implies', () => {
    render(
      <MemoryRouter>
        <AllocationCell
          expense={ledgerEntry({
            allocation: 'rental',
            rental_id: 'rental-7',
            rental_reference: 'R-2026-0007',
          })}
        />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'R-2026-0007' })).toHaveAttribute(
      'href',
      '/rentals/rental-7',
    )
    expect(screen.getByText('12-A-34567')).toBeInTheDocument()
  })

  it('points an overhead at nothing at all', () => {
    render(
      <MemoryRouter>
        <AllocationCell
          expense={ledgerEntry({
            allocation: 'overhead',
            effective_vehicle_id: null,
            vehicle_plate: null,
            vehicle_make: null,
            vehicle_model: null,
          })}
        />
      </MemoryRouter>,
    )

    expect(screen.getByText('Agency overhead')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('marks a retired car so a stale figure is not mistaken for a live one', () => {
    render(
      <MemoryRouter>
        <AllocationCell expense={ledgerEntry({ vehicle_archived: true })} />
      </MemoryRouter>,
    )

    expect(screen.getByText(/retired/)).toBeInTheDocument()
  })
})

describe('the status badge', () => {
  it('says nothing about an ordinary recorded cost', () => {
    const { container } = render(<ExpenseStatusBadge status="recorded" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('marks a voided one, because that is the exception', () => {
    render(<ExpenseStatusBadge status="voided" />)
    expect(screen.getByText('Voided')).toBeInTheDocument()
  })
})

describe('the change history', () => {
  const event = (overrides: Partial<ExpenseChangeEvent> = {}): ExpenseChangeEvent => ({
    id: 'event-1',
    organization_id: 'org-1',
    expense_id: 'expense-1',
    kind: 'correction',
    changes: { amount_minor: { from: 120000, to: 12000 } },
    changed_by: 'user-1',
    changed_at: '2026-07-15T10:00:00.000Z',
    reason: null,
    ...overrides,
  })

  it('says a cost has never been corrected rather than showing an empty list', () => {
    render(
      <ChangeHistory events={[]} currency="MAD" locale={LOCALE} timeZone="Africa/Casablanca" />,
    )
    expect(screen.getByText('Never corrected')).toBeInTheDocument()
  })

  it('shows the figure that was replaced, not only the one that replaced it', () => {
    render(
      <ChangeHistory
        events={[event()]}
        currency="MAD"
        locale={LOCALE}
        timeZone="Africa/Casablanca"
      />,
    )

    expect(screen.getByText('Corrected')).toBeInTheDocument()
    expect(screen.getByText(/1,200\.00/)).toBeInTheDocument()
    expect(screen.getByText(/120\.00/)).toBeInTheDocument()
  })

  it('keeps a void distinguishable from a correction', () => {
    render(
      <ChangeHistory
        events={[
          event({
            id: 'event-2',
            kind: 'void',
            changes: { status: { from: 'recorded', to: 'voided' } },
            reason: 'Entered twice',
          }),
        ]}
        currency="MAD"
        locale={LOCALE}
        timeZone="Africa/Casablanca"
      />,
    )

    expect(screen.getByText('Voided')).toBeInTheDocument()
    expect(screen.queryByText('Corrected')).not.toBeInTheDocument()
    expect(screen.getByText('Entered twice')).toBeInTheDocument()
  })

  it('names the field in the agency’s words, not the column’s', () => {
    render(
      <ChangeHistory
        events={[
          event({
            changes: {
              allocation: { from: 'overhead', to: 'vehicle' },
              incurred_on: { from: '2026-07-01', to: '2026-07-14' },
            },
          }),
        ]}
        currency="MAD"
        locale={LOCALE}
        timeZone="Africa/Casablanca"
      />,
    )

    expect(screen.getByText('Belongs to:')).toBeInTheDocument()
    expect(screen.getByText('Agency overhead')).toBeInTheDocument()
    expect(screen.getByText('A vehicle')).toBeInTheDocument()
    expect(screen.getByText('Date incurred:')).toBeInTheDocument()
  })

  it('reports an id as a changed record rather than as a uuid', () => {
    render(
      <ChangeHistory
        events={[
          event({
            changes: {
              vendor_id: { from: '2f1c8e00-0000-4000-8000-000000000001', to: null },
            },
          }),
        ]}
        currency="MAD"
        locale={LOCALE}
        timeZone="Africa/Casablanca"
      />,
    )

    expect(screen.getByText('another record')).toBeInTheDocument()
    expect(screen.getByText('nothing')).toBeInTheDocument()
    expect(screen.queryByText(/2f1c8e00/)).not.toBeInTheDocument()
  })
})
