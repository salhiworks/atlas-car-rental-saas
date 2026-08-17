import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import type { ComplianceOptions } from '@/lib/compliance/expiry'
import type { FleetStatusCountsRow, VehicleFleetEntry, VehicleStatus } from '@/types/database'

import { FleetSummary } from './FleetSummary'
import { VehicleCardList } from './VehicleCardList'
import { VehicleStatusBadge, vehicleStatusLabel } from './VehicleStatusBadge'
import { VehicleTable } from './VehicleTable'

const COMPLIANCE: ComplianceOptions = {
  timeZone: 'Europe/Paris',
  leadDays: 30,
  now: new Date('2026-06-15T12:00:00Z'),
}

function makeVehicle(overrides: Partial<VehicleFleetEntry> = {}): VehicleFleetEntry {
  return {
    vehicle_id: 'vehicle-1',
    organization_id: 'org-1',
    make: 'Renault',
    model: 'Clio',
    model_year: 2023,
    registration_plate: '12-A-34567',
    vin: null,
    color: 'White',
    category: 'Economy',
    fuel_type: 'diesel',
    transmission: 'manual',
    seats: 5,
    odometer: 42150,
    daily_rate_minor: 35_000,
    currency: 'EUR',
    insurance_expires_on: '2027-04-30',
    inspection_expires_on: '2027-01-15',
    registration_expires_on: '2027-06-30',
    next_service_on: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    operational_status: 'available',
    current_rental_id: null,
    current_rental_reference: null,
    current_customer_id: null,
    current_rental_ends_at: null,
    next_rental_id: null,
    next_rental_reference: null,
    next_customer_id: null,
    next_rental_starts_at: null,
    effective_status: 'available',
    is_available_now: true,
    acquisition_method: null,
    acquired_on: null,
    acquisition_price_minor: null,
    acquisition_currency: null,
    acquisition_supplier: null,
    acquisition_notes: null,
    ...overrides,
  }
}

function renderTable(vehicles: VehicleFleetEntry[]) {
  return render(
    <MemoryRouter>
      <VehicleTable
        vehicles={vehicles}
        thumbnails={new Map()}
        compliance={COMPLIANCE}
        locale="en"
        distanceUnit="km"
      />
    </MemoryRouter>,
  )
}

describe('VehicleStatusBadge', () => {
  it.each([
    ['available', 'Available'],
    ['rented', 'Rented'],
    ['reserved', 'Reserved'],
    ['maintenance', 'In maintenance'],
    ['unavailable', 'Off the road'],
  ] as [VehicleStatus, string][])('names %s consistently as "%s"', (status, label) => {
    // One definition, so a status reads identically in the table, on the detail
    // page and on the dashboard.
    expect(vehicleStatusLabel(status)).toBe(label)

    render(<VehicleStatusBadge status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

describe('VehicleTable', () => {
  it('shows the facts a manager scans for', () => {
    renderTable([makeVehicle()])

    expect(screen.getByText('Renault Clio')).toBeInTheDocument()
    expect(screen.getByText('12-A-34567')).toBeInTheDocument()
    expect(screen.getByText('42,150 km')).toBeInTheDocument()
    expect(screen.getByText('€350.00')).toBeInTheDocument()
    expect(screen.getByText('Available')).toBeInTheDocument()
  })

  it('links each row to its vehicle', () => {
    renderTable([makeVehicle({ vehicle_id: 'abc-123' })])

    expect(screen.getByRole('link', { name: /Renault Clio/ })).toHaveAttribute(
      'href',
      '/vehicles/abc-123',
    )
  })

  it('warns when a compliance date has passed', () => {
    renderTable([makeVehicle({ inspection_expires_on: '2026-01-01' })])
    expect(screen.getByText('Expired')).toBeInTheDocument()
  })

  it('warns when a compliance date is inside the agency’s window', () => {
    renderTable([makeVehicle({ insurance_expires_on: '2026-07-01' })])
    expect(screen.getByText('Due soon')).toBeInTheDocument()
  })

  it('says records are incomplete without raising an alarm', () => {
    renderTable([
      makeVehicle({
        insurance_expires_on: null,
        inspection_expires_on: null,
        registration_expires_on: null,
      }),
    ])

    expect(screen.getByText('Incomplete')).toBeInTheDocument()
    expect(screen.queryByText('Expired')).not.toBeInTheDocument()
  })

  it('shows when a rented vehicle is due back, from the contract', () => {
    renderTable([
      makeVehicle({
        effective_status: 'rented',
        current_rental_ends_at: '2026-06-20T09:00:00Z',
      }),
    ])

    expect(screen.getByText('Rented')).toBeInTheDocument()
    // Exact date formatting is Intl's business and varies by platform; that the
    // return date is shown, and comes from the contract, is ours.
    expect(screen.getByText(/^Back .*2026/)).toBeInTheDocument()
  })

  it('shows nothing about contracts when there are none', () => {
    renderTable([makeVehicle()])
    expect(screen.queryByText(/Back |Out /)).not.toBeInTheDocument()
  })

  it('renders a loading table without inventing rows', () => {
    render(
      <MemoryRouter>
        <VehicleTable
          vehicles={[]}
          thumbnails={new Map()}
          compliance={COMPLIANCE}
          locale="en"
          distanceUnit="km"
          isLoading
        />
      </MemoryRouter>,
    )

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})

describe('VehicleCardList', () => {
  it('carries the same facts as the table for narrow screens', () => {
    render(
      <MemoryRouter>
        <VehicleCardList
          vehicles={[makeVehicle()]}
          thumbnails={new Map()}
          compliance={COMPLIANCE}
          locale="en"
          distanceUnit="km"
        />
      </MemoryRouter>,
    )

    const link = screen.getByRole('link')
    expect(within(link).getByText('Renault Clio')).toBeInTheDocument()
    expect(within(link).getByText('12-A-34567')).toBeInTheDocument()
    expect(within(link).getByText('€350.00')).toBeInTheDocument()
    expect(within(link).getByText('42,150 km')).toBeInTheDocument()
  })

  it('respects the agency’s distance unit', () => {
    render(
      <MemoryRouter>
        <VehicleCardList
          vehicles={[makeVehicle()]}
          thumbnails={new Map()}
          compliance={COMPLIANCE}
          locale="en"
          distanceUnit="mi"
        />
      </MemoryRouter>,
    )

    expect(screen.getByText('42,150 mi')).toBeInTheDocument()
  })
})

describe('FleetSummary', () => {
  const counts: FleetStatusCountsRow = {
    total: 12,
    available: 5,
    rented: 4,
    reserved: 1,
    maintenance: 2,
    unavailable: 0,
    archived: 3,
  }

  it('shows the real composition of the fleet', () => {
    render(
      <FleetSummary
        counts={counts}
        isLoading={false}
        activeStatuses={[]}
        onToggleStatus={() => undefined}
        onClear={() => undefined}
      />,
    )

    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    // A state with none of the fleet in it still reports zero rather than hiding.
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('filters by a status when its figure is activated', async () => {
    const onToggleStatus = vi.fn()
    const user = userEvent.setup()

    render(
      <FleetSummary
        counts={counts}
        isLoading={false}
        activeStatuses={[]}
        onToggleStatus={onToggleStatus}
        onClear={() => undefined}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Maintenance/ }))
    expect(onToggleStatus).toHaveBeenCalledWith('maintenance')
  })

  it('clears the filter when the active figure is activated again', async () => {
    const onClear = vi.fn()
    const user = userEvent.setup()

    render(
      <FleetSummary
        counts={counts}
        isLoading={false}
        activeStatuses={['rented']}
        onToggleStatus={() => undefined}
        onClear={onClear}
      />,
    )

    const rented = screen.getByRole('button', { name: /Rented/ })
    expect(rented).toHaveAttribute('aria-pressed', 'true')

    await user.click(rented)
    expect(onClear).toHaveBeenCalled()
  })

  it('does not make the total a filter', () => {
    render(
      <FleetSummary
        counts={counts}
        isLoading={false}
        activeStatuses={[]}
        onToggleStatus={() => undefined}
        onClear={() => undefined}
      />,
    )

    expect(screen.queryByRole('button', { name: /Vehicles/ })).not.toBeInTheDocument()
  })

  it('hides figures while loading rather than showing zeros', () => {
    render(
      <FleetSummary
        counts={undefined}
        isLoading
        activeStatuses={[]}
        onToggleStatus={() => undefined}
        onClear={() => undefined}
      />,
    )

    expect(screen.queryByText('12')).not.toBeInTheDocument()
    expect(screen.getByText('Available')).toBeInTheDocument()
  })
})
