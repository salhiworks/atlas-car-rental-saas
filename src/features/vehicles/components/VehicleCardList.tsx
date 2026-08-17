import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Badge, Skeleton } from '@/components/ui'
import { evaluateVehicleCompliance, type ComplianceOptions } from '@/lib/compliance/expiry'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { VehicleFleetEntry } from '@/types/database'

import { VehicleStatusBadge } from './VehicleStatusBadge'
import { VehicleThumbnail } from './VehicleThumbnail'

export interface VehicleCardListProps {
  vehicles: readonly VehicleFleetEntry[]
  thumbnails: Map<string, string>
  compliance: ComplianceOptions
  locale: string
  distanceUnit: 'km' | 'mi'
  isLoading?: boolean
}

/**
 * The fleet below the table breakpoint.
 *
 * Not the table squeezed into a phone and not an e-commerce card grid: a
 * compact list row carrying the same facts in a shape that reads down a narrow
 * screen. Plate and status stay prominent because those are what someone at the
 * counter is matching against.
 */
export function VehicleCardList({
  vehicles,
  thumbnails,
  compliance,
  locale,
  distanceUnit,
  isLoading = false,
}: VehicleCardListProps) {
  if (isLoading) {
    return (
      <ul className="divide-line divide-y lg:hidden">
        {Array.from({ length: 5 }).map((_, index) => (
          <li key={index} className="flex gap-3 px-4 py-3.5">
            <Skeleton className="h-12 w-[72px] shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul className="divide-line divide-y lg:hidden">
      {vehicles.map((vehicle) => {
        const state = evaluateVehicleCompliance(vehicle, compliance)

        return (
          <li key={vehicle.vehicle_id}>
            <Link
              to={`${paths.vehicles}/${vehicle.vehicle_id}`}
              className={cn(
                'hover:bg-surface-muted flex gap-3 px-4 py-3.5 transition-colors',
                vehicle.archived_at && 'opacity-60',
              )}
            >
              <VehicleThumbnail
                url={thumbnails.get(vehicle.vehicle_id)}
                make={vehicle.make}
                model={vehicle.model}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-ink truncate text-[0.8125rem] font-medium">
                    {vehicle.make} {vehicle.model}
                  </p>
                  <span data-numeric="" className="text-ink shrink-0 text-[0.8125rem] font-medium">
                    {formatMoney(vehicle.daily_rate_minor, vehicle.currency, { locale })}
                  </span>
                </div>

                <p className="identifier text-ink-muted mt-0.5">{vehicle.registration_plate}</p>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <VehicleStatusBadge status={vehicle.effective_status} />
                  {state.needsAttention ? (
                    <Badge
                      tone={state.overall === 'expired' ? 'critical' : 'caution'}
                      className="gap-1"
                    >
                      <AlertTriangle className="size-3" aria-hidden="true" />
                      {state.overall === 'expired' ? 'Expired' : 'Due soon'}
                    </Badge>
                  ) : null}
                  <span data-numeric="" className="text-ink-subtle text-[0.75rem]">
                    {new Intl.NumberFormat(locale).format(vehicle.odometer)} {distanceUnit}
                  </span>
                </div>
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
