import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import type { GpsFleetRow } from '@/types/database'

import { FleetList } from './FleetList'
import {
  PositionFreshnessBadge,
  ProviderConnectivityBadge,
  SyncHealthBadge,
  TrackingFacts,
} from './GpsBadges'
import { VehicleTrackingPanel } from './VehicleTrackingPanel'

/**
 * What the tracking screens actually put in front of a person.
 *
 * These render for real rather than asserting on props, because the claims
 * being tested are claims about what somebody reads: that a device which reports
 * nothing does not appear to report zeros, that connectivity and freshness and
 * synchronisation are three separate statements, and that a map list never
 * carries a customer's name.
 */

const LOCALE = 'en-GB'
const TIME_ZONE = 'Africa/Casablanca'

function fleetRow(overrides: Partial<GpsFleetRow> = {}): GpsFleetRow {
  return {
    vehicle_id: 'vehicle-1',
    organization_id: 'org-1',
    vehicle_make: 'Dacia',
    vehicle_model: 'Logan',
    vehicle_plate: '12345-A-6',
    vehicle_archived: false,
    assignment_id: 'assignment-1',
    assigned_at: '2026-06-01T09:00:00Z',
    unit_id: 'unit-1',
    unit_external_id: '400000000000001',
    unit_name: 'Logan tracker',
    unit_availability: 'present',
    capabilities: ['position', 'speed', 'history'],
    connection_id: 'connection-1',
    connection_label: 'Wialon',
    provider: 'wialon',
    connection_status: 'healthy',
    observed_at: '2026-08-13T09:55:00Z',
    received_at: '2026-08-13T09:55:10Z',
    latitude: 33.589886,
    longitude: -7.603869,
    position_valid: true,
    speed_kph: 48,
    heading_deg: 92,
    altitude_m: 40,
    satellites: 9,
    ignition: null,
    movement: 'moving',
    odometer_km: null,
    engine_hours: null,
    provider_online: true,
    position_freshness: 'fresh',
    sync_health: 'healthy',
    position_age_seconds: 120,
    current_rental_id: null,
    current_rental_reference: null,
    current_rental_ends_at: null,
    vehicle_status: 'available',
    ...overrides,
  }
}

function renderInRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

// -----------------------------------------------------------------------------
// The three facts
// -----------------------------------------------------------------------------

describe('the status badges', () => {
  it('show connectivity, freshness and synchronisation as three separate things', () => {
    render(
      <TrackingFacts
        freshness="fresh"
        ageSeconds={60}
        providerOnline={false}
        syncHealth="healthy"
      />,
    )

    // The combination that a single dot would render as one lie: the tracker is
    // offline, our synchronisation is fine, and the last position is recent.
    expect(screen.getByText(/Live/)).toBeInTheDocument()
    expect(screen.getByText('Tracker offline')).toBeInTheDocument()
    expect(screen.getByText('Synchronising')).toBeInTheDocument()
  })

  it('does not call an unreported link offline', () => {
    render(<ProviderConnectivityBadge online={null} />)
    expect(screen.getByText('Link not reported')).toBeInTheDocument()
    expect(screen.queryByText('Tracker offline')).not.toBeInTheDocument()
  })

  it('shows the age alongside the freshness so "live" can be checked', () => {
    render(<PositionFreshnessBadge freshness="stale" ageSeconds={2400} />)
    expect(screen.getByText('Delayed · 40 min ago')).toBeInTheDocument()
  })

  it('shows no age for a device that has never reported', () => {
    render(<PositionFreshnessBadge freshness="unknown" ageSeconds={null} />)
    expect(screen.getByText('No position')).toBeInTheDocument()
  })

  it('says plainly when a credential has stopped the whole integration', () => {
    render(<SyncHealthBadge health="auth_error" />)
    expect(screen.getByText('Credential rejected')).toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
// The list
// -----------------------------------------------------------------------------

describe('the fleet list', () => {
  it('lists a vehicle that has no position, because the map cannot', () => {
    renderInRouter(
      <FleetList
        rows={[
          fleetRow({
            vehicle_id: 'vehicle-2',
            vehicle_plate: '99999-B-1',
            latitude: null,
            longitude: null,
            position_valid: null,
            position_freshness: 'unknown',
            position_age_seconds: null,
            speed_kph: null,
          }),
        ]}
        selectedVehicleId={null}
        onSelect={vi.fn()}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    // A vehicle missing from both halves of the workspace is a vehicle the
    // agency forgets it is paying for.
    expect(screen.getByText('99999-B-1')).toBeInTheDocument()
    expect(screen.getByText('No position')).toBeInTheDocument()
    expect(screen.getByLabelText('No position on the map')).toBeInTheDocument()
  })

  it('carries no customer identity', () => {
    const { container } = renderInRouter(
      <FleetList
        rows={[
          fleetRow({
            current_rental_id: 'rental-1',
            current_rental_reference: 'R-2026-0044',
            current_rental_ends_at: '2026-08-20T10:00:00Z',
          }),
        ]}
        selectedVehicleId={null}
        onSelect={vi.fn()}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    // A vehicle on hire is somebody's movements. The list says a contract
    // exists; who is driving is asked of Rentals by somebody authorised to ask.
    expect(screen.getByText('On hire')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/customer/i)
    expect(container.textContent).not.toMatch(/driver/i)
  })

  it('shows an unreported speed as unknown, not as stopped', () => {
    renderInRouter(
      <FleetList
        rows={[fleetRow({ speed_kph: null })]}
        selectedVehicleId={null}
        onSelect={vi.fn()}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('0 km/h')).not.toBeInTheDocument()
  })

  it('reports the selection to the map', async () => {
    const onSelect = vi.fn()
    renderInRouter(
      <FleetList
        rows={[fleetRow()]}
        selectedVehicleId={null}
        onSelect={onSelect}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    await userEvent.click(screen.getByText('12345-A-6'))
    expect(onSelect).toHaveBeenCalledWith('vehicle-1')
  })

  it('marks the selected row for assistive technology, not only with colour', () => {
    renderInRouter(
      <FleetList
        rows={[fleetRow(), fleetRow({ vehicle_id: 'vehicle-2', vehicle_plate: '22222-C-2' })]}
        selectedVehicleId="vehicle-2"
        onSelect={vi.fn()}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    const selected = screen.getByText('22222-C-2').closest('button')
    expect(selected).toHaveAttribute('aria-current', 'true')
  })
})

// -----------------------------------------------------------------------------
// The vehicle panel
// -----------------------------------------------------------------------------

describe('the vehicle panel', () => {
  it('says a device reports nothing rather than showing it reporting zeros', () => {
    renderInRouter(
      <VehicleTrackingPanel
        row={fleetRow({
          speed_kph: null,
          heading_deg: null,
          ignition: null,
          odometer_km: null,
          engine_hours: null,
          movement: null,
          satellites: null,
          altitude_m: null,
        })}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    expect(screen.getByText(/reports a position and nothing else/i)).toBeInTheDocument()
    // Movement and ignition both read "Not reported" — that is the point.
    expect(screen.getAllByText('Not reported', { selector: 'dd' })).toHaveLength(2)
    expect(screen.queryByText('0 km/h')).not.toBeInTheDocument()
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
  })

  it('labels the tracker odometer as the tracker’s, not the vehicle’s', () => {
    renderInRouter(
      <VehicleTrackingPanel
        row={fleetRow({ odometer_km: 84210 })}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    const fact = screen.getByText('Device odometer').closest('div')!
    expect(within(fact).getByText('84,210 km')).toBeInTheDocument()
    // The claim that matters: this figure does not become the vehicle's mileage.
    expect(within(fact).getByTitle(/never overwritten/i)).toBeInTheDocument()
  })

  it('links to the contract without restating its status', () => {
    renderInRouter(
      <VehicleTrackingPanel
        row={fleetRow({
          current_rental_id: 'rental-1',
          current_rental_reference: 'R-2026-0044',
        })}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    const link = screen.getByRole('link', { name: /R-2026-0044/ })
    expect(link).toHaveAttribute('href', '/rentals/rental-1')
    // Tracking does not infer that a moving car has been collected.
    expect(screen.queryByText(/checked out/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/collected/i)).not.toBeInTheDocument()
  })

  it('explains a future timestamp rather than treating it as the freshest fact', () => {
    renderInRouter(
      <VehicleTrackingPanel
        row={fleetRow({ position_freshness: 'future', position_age_seconds: -600 })}
        locale={LOCALE}
        timeZone={TIME_ZONE}
      />,
    )

    expect(screen.getByText(/timestamped this ahead of the agency clock/i)).toBeInTheDocument()
  })

  it('offers history only where the device supports it', () => {
    const onShowHistory = vi.fn()
    const { rerender } = renderInRouter(
      <VehicleTrackingPanel
        row={fleetRow({ capabilities: ['position'] })}
        locale={LOCALE}
        timeZone={TIME_ZONE}
        canViewHistory
        onShowHistory={onShowHistory}
      />,
    )
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument()

    rerender(
      <MemoryRouter>
        <VehicleTrackingPanel
          row={fleetRow({ capabilities: ['position', 'history'] })}
          locale={LOCALE}
          timeZone={TIME_ZONE}
          canViewHistory
          onShowHistory={onShowHistory}
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument()
  })

  it('offers no way to command the tracker', () => {
    const { container } = renderInRouter(
      <VehicleTrackingPanel row={fleetRow()} locale={LOCALE} timeZone={TIME_ZONE} />,
    )

    // This integration is read-only by design. Nothing on this panel may look
    // like it could stop an engine or unlock a door.
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/immobilis|immobiliz|unlock|engine stop|cut fuel|send command/i)
  })
})
