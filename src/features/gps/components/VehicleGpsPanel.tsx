import { Gauge, MapPinned } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Card, CardBody, CardHeader, Skeleton } from '@/components/ui'
import { usePermission } from '@/features/workspace/workspace-context'

import {
  UNKNOWN,
  formatAge,
  formatCoordinates,
  formatMovement,
  formatOdometer,
  formatSpeed,
} from '../domain'
import { useVehicleGps } from '../queries'

import { TelemetryFact, TrackingFacts } from './GpsBadges'

/**
 * Tracking, on the vehicle's own record.
 *
 * A summary, not a second workspace: where the vehicle was last seen, how much
 * that is worth trusting, and a way through to the map. Anything more would put
 * a second live-polling map behind every vehicle in the fleet.
 *
 * THE ODOMETER BOUNDARY IS VISIBLE HERE, deliberately. This card can sit
 * directly above the vehicle's recorded mileage, and the two numbers will
 * disagree — trackers drift, are refitted, and count from whenever they were
 * installed. The tracker's figure is labelled as the tracker's and is read-only.
 * `vehicles.odometer` is what a person wrote down at a hand-over; it is what
 * servicing, pricing and the contract's mileage allowance are decided against,
 * and no telemetry writes to it. Where a device's odometer is worth adopting, a
 * person adopts it.
 */

export interface VehicleGpsPanelProps {
  vehicleId: string
  locale: string
  timeZone: string
}

export function VehicleGpsPanel({ vehicleId, locale, timeZone }: VehicleGpsPanelProps) {
  const canView = usePermission('gps.view')
  const query = useVehicleGps(canView ? vehicleId : undefined)

  // Not an error and not an empty card: a role that cannot see tracking simply
  // is not shown that this section exists.
  if (!canView) return null

  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })

  const row = query.data ?? null

  return (
    <Card>
      <CardHeader
        title="Tracking"
        description={row ? row.unit_name : 'Where this vehicle was last reported.'}
        actions={
          row ? (
            <Link
              to={`${paths.gpsTracking}?v=${encodeURIComponent(row.vehicle_id)}`}
              className="text-brand-700 text-[0.8125rem] font-medium hover:underline"
            >
              Open on the map
            </Link>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        {query.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : !row ? (
          <p className="text-ink-muted flex items-start gap-2 text-[0.8125rem] leading-5">
            <MapPinned className="text-ink-subtle mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              No tracking device is assigned to this vehicle. Its position is unknown — which is
              different from it being at the depot.
            </span>
          </p>
        ) : (
          <>
            <TrackingFacts
              freshness={row.position_freshness}
              ageSeconds={row.position_age_seconds}
              providerOnline={row.provider_online}
              syncHealth={row.sync_health}
            />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <TelemetryFact
                label="Position"
                value={formatCoordinates(row.latitude, row.longitude)}
                unknown={row.latitude === null}
              />
              <TelemetryFact
                label="Reported"
                value={row.observed_at ? `${dateTime.format(new Date(row.observed_at))}` : 'Never'}
                hint={
                  row.position_age_seconds !== null
                    ? formatAge(row.position_age_seconds)
                    : undefined
                }
                unknown={row.observed_at === null}
              />
              <TelemetryFact
                label="Speed"
                value={formatSpeed(row.speed_kph, locale)}
                unknown={row.speed_kph === null}
              />
              <TelemetryFact
                label="Movement"
                value={formatMovement(row.movement)}
                unknown={row.movement === null}
              />
            </dl>

            <div className="border-line flex items-start gap-2 border-t pt-3">
              <Gauge className="text-ink-subtle mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-[0.8125rem]">
                  Tracker odometer:{' '}
                  <span className="tabular-nums">
                    {row.odometer_km === null ? UNKNOWN : formatOdometer(row.odometer_km, locale)}
                  </span>
                </p>
                <p className="text-ink-subtle text-[0.75rem] leading-4">
                  Read from the device. The vehicle&rsquo;s recorded mileage above is what your team
                  wrote down at hand-over, and tracking never changes it.
                </p>
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}
