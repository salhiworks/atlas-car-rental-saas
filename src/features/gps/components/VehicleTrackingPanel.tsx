import { ExternalLink, FileSignature, History, X } from 'lucide-react'
import { Link } from 'react-router-dom'

import { rentalDetailPath, vehicleDetailPath } from '@/app/routes/paths'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { GpsFleetRow } from '@/types/database'

import {
  UNKNOWN,
  describeIgnition,
  formatAge,
  formatCoordinates,
  formatEngineHours,
  formatHeading,
  formatMovement,
  formatOdometer,
  formatSpeed,
  hasCapability,
} from '../domain'

import { NoTelemetryNote, TelemetryFact, TrackingFacts, UnitAvailabilityBadge } from './GpsBadges'

/**
 * One vehicle, in full.
 *
 * Every number here is what the provider reported and nothing else. Where a
 * device does not report a field, the field says so rather than showing a zero —
 * an odometer of "—" means the tracker does not send one, and reading it as
 * "0 km" would be a lie about a vehicle worth twenty thousand euros.
 *
 * Two boundaries are visible in this component and both are deliberate:
 *
 *   THE ODOMETER. The tracker's odometer is displayed as the tracker's
 *   odometer. It never writes to `vehicles.odometer`, which is the reading a
 *   person recorded at a hand-over and the number the agency bills, prices and
 *   services against. Two devices disagreeing by four hundred kilometres is
 *   normal; letting the cheaper one silently overwrite the contract's is not.
 *
 *   THE CONTRACT. If the vehicle is on hire, the contract reference is a link.
 *   Tracking does not restate the rental's status, does not infer that a moving
 *   car has been collected, and cannot change a contract from here.
 */

export interface VehicleTrackingPanelProps {
  row: GpsFleetRow
  locale: string
  timeZone: string
  onClose?: () => void
  onShowHistory?: () => void
  canViewHistory?: boolean
  className?: string
}

export function VehicleTrackingPanel({
  row,
  locale,
  timeZone,
  onClose,
  onShowHistory,
  canViewHistory = false,
  className,
}: VehicleTrackingPanelProps) {
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })

  const reportsNothing =
    row.speed_kph === null &&
    row.heading_deg === null &&
    row.ignition === null &&
    row.odometer_km === null &&
    row.engine_hours === null

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="border-line flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[0.9375rem] leading-5 font-semibold">{row.vehicle_plate}</p>
          <p className="text-ink-muted truncate text-[0.8125rem]">
            {row.vehicle_make} {row.vehicle_model}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close vehicle details"
            className="text-ink-subtle hover:bg-surface-inset hover:text-ink -me-1.5 -mt-1 shrink-0 rounded-md p-1.5 transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <TrackingFacts
          freshness={row.position_freshness}
          ageSeconds={row.position_age_seconds}
          providerOnline={row.provider_online}
          syncHealth={row.sync_health}
        />

        <div className="border-line bg-surface-inset rounded-md border px-3 py-2.5">
          <p className="text-ink-subtle text-2xs tracking-wide uppercase">Last reported position</p>
          <p className="mt-1 font-mono text-[0.8125rem] tabular-nums">
            {formatCoordinates(row.latitude, row.longitude)}
          </p>
          <p className="text-ink-muted mt-1 text-[0.75rem]">
            {row.observed_at
              ? `${dateTime.format(new Date(row.observed_at))} · ${formatAge(row.position_age_seconds)}`
              : 'This device has never reported a position.'}
          </p>
          {row.position_freshness === 'future' ? (
            <p className="text-caution-700 mt-1.5 text-[0.75rem] leading-4">
              The provider timestamped this ahead of the agency clock. Positions more than two
              minutes in the future are flagged rather than accepted as current.
            </p>
          ) : null}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <TelemetryFact
            label="Speed"
            value={formatSpeed(row.speed_kph, locale)}
            unknown={row.speed_kph === null}
            hint={row.speed_kph === null ? 'This device did not report a speed.' : undefined}
          />
          <TelemetryFact
            label="Heading"
            value={formatHeading(row.heading_deg)}
            unknown={row.heading_deg === null}
          />
          <TelemetryFact
            label="Movement"
            value={formatMovement(row.movement)}
            unknown={row.movement === null}
            hint={
              row.movement === null
                ? 'Derived from reported speed. This device did not report one.'
                : undefined
            }
          />
          <TelemetryFact
            label="Ignition"
            value={describeIgnition(row.ignition)}
            unknown={row.ignition === null}
            hint={
              row.ignition === null
                ? 'Ignition is a hardware-specific sensor. This device does not report one we can read reliably.'
                : undefined
            }
          />
          <TelemetryFact
            label="Device odometer"
            value={formatOdometer(row.odometer_km, locale)}
            unknown={row.odometer_km === null}
            hint="Reported by the tracker. The vehicle's recorded mileage is kept separately and is never overwritten from here."
          />
          <TelemetryFact
            label="Engine hours"
            value={formatEngineHours(row.engine_hours, locale)}
            unknown={row.engine_hours === null}
          />
          <TelemetryFact
            label="Satellites"
            value={row.satellites === null ? UNKNOWN : String(row.satellites)}
            unknown={row.satellites === null}
          />
          <TelemetryFact
            label="Altitude"
            value={row.altitude_m === null ? UNKNOWN : `${Math.round(row.altitude_m)} m`}
            unknown={row.altitude_m === null}
          />
        </dl>

        {reportsNothing ? (
          <NoTelemetryNote>
            This device reports a position and nothing else. Speed, ignition and odometer are not
            unavailable because the vehicle is idle — the tracker does not send them.
          </NoTelemetryNote>
        ) : null}

        {/*
          Visible, not a tooltip. The two odometers WILL disagree — trackers are
          refitted, count from installation and drift — and somebody comparing
          this figure with the vehicle's recorded mileage needs to be told which
          one the agency bills against before they go and "correct" the other.
        */}
        {row.odometer_km !== null ? (
          <p className="text-ink-subtle text-[0.75rem] leading-4">
            The device odometer is the tracker&rsquo;s own count. The vehicle&rsquo;s recorded
            mileage is what your team wrote down at hand-over, and tracking never overwrites it.
          </p>
        ) : null}

        <div className="border-line space-y-2 border-t pt-3">
          <p className="text-ink-subtle text-2xs tracking-wide uppercase">Device</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.8125rem]">{row.unit_name}</span>
            <UnitAvailabilityBadge availability={row.unit_availability} />
          </div>
          <p className="text-ink-muted text-[0.75rem]">
            {row.connection_label} · assigned {dateTime.format(new Date(row.assigned_at))}
          </p>
          {row.capabilities.length > 0 ? (
            <p className="text-ink-subtle text-[0.75rem]">Reports: {row.capabilities.join(', ')}</p>
          ) : null}
        </div>

        {row.current_rental_id ? (
          <div className="border-line border-t pt-3">
            <p className="text-ink-subtle text-2xs tracking-wide uppercase">Contract</p>
            <Link
              to={rentalDetailPath(row.current_rental_id)}
              className="text-brand-700 mt-1 inline-flex items-center gap-1.5 text-[0.8125rem] font-medium hover:underline"
            >
              <FileSignature className="size-3.5" aria-hidden="true" />
              {row.current_rental_reference ?? 'Open contract'}
            </Link>
            {row.current_rental_ends_at ? (
              <p className="text-ink-muted mt-1 text-[0.75rem]">
                Due back {dateTime.format(new Date(row.current_rental_ends_at))}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="border-line bg-surface-muted flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        <Link
          to={vehicleDetailPath(row.vehicle_id)}
          className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem]"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          Vehicle record
        </Link>
        {canViewHistory && onShowHistory && hasCapability(row.capabilities, 'history') ? (
          <Button size="sm" variant="secondary" leadingIcon={<History />} onClick={onShowHistory}>
            History
          </Button>
        ) : null}
      </div>
    </div>
  )
}
