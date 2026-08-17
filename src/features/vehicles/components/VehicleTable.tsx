import { AlertTriangle, ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Badge, Skeleton } from '@/components/ui'
import { evaluateVehicleCompliance, type ComplianceOptions } from '@/lib/compliance/expiry'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { VehicleFleetEntry } from '@/types/database'

import { VehicleStatusBadge } from './VehicleStatusBadge'
import { VehicleThumbnail } from './VehicleThumbnail'

export interface VehicleTableProps {
  vehicles: readonly VehicleFleetEntry[]
  thumbnails: Map<string, string>
  compliance: ComplianceOptions
  locale: string
  distanceUnit: 'km' | 'mi'
  isLoading?: boolean
}

function formatOdometer(value: number, locale: string, unit: 'km' | 'mi'): string {
  return `${new Intl.NumberFormat(locale).format(value)} ${unit}`
}

/**
 * Rental context in one line: what the vehicle is doing and until when.
 * Only ever built from contracts that exist — never inferred or invented.
 */
function rentalContext(vehicle: VehicleFleetEntry, options: ComplianceOptions, locale: string) {
  if (vehicle.current_rental_ends_at) {
    return `Back ${formatDate(new Date(vehicle.current_rental_ends_at), { locale, timeZone: options.timeZone })}`
  }
  if (vehicle.next_rental_starts_at) {
    return `Out ${formatDate(new Date(vehicle.next_rental_starts_at), { locale, timeZone: options.timeZone })}`
  }
  return null
}

/**
 * The fleet as an operational table.
 *
 * Information density is the point: a manager scanning forty rows wants plate,
 * status, mileage and rate aligned in columns they can run an eye down. Large
 * photo cards would show six vehicles per screen and bury the numbers.
 */
export function VehicleTable({
  vehicles,
  thumbnails,
  compliance,
  locale,
  distanceUnit,
  isLoading = false,
}: VehicleTableProps) {
  return (
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full min-w-[880px] border-collapse text-start">
        <thead>
          <tr className="border-line border-b">
            <th scope="col" className="eyebrow px-5 py-2.5 text-start font-semibold">
              Vehicle
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Plate
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Status
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end font-semibold">
              Odometer
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end font-semibold">
              Daily rate
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Compliance
            </th>
            <th scope="col" className="w-10 px-3 py-2.5">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>

        <tbody className="divide-line divide-y">
          {isLoading
            ? Array.from({ length: 6 }).map((_, index) => (
                <tr key={index}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-12 w-[72px]" />
                      <div className="space-y-1.5">
                        <Skeleton className="h-3.5 w-36" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-5 w-20 rounded-full" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="ms-auto h-4 w-16" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="ms-auto h-4 w-16" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </td>
                  <td />
                </tr>
              ))
            : vehicles.map((vehicle) => {
                const state = evaluateVehicleCompliance(vehicle, compliance)
                const context = rentalContext(vehicle, compliance, locale)

                return (
                  <tr
                    key={vehicle.vehicle_id}
                    className={cn(
                      'group hover:bg-surface-muted transition-colors',
                      vehicle.archived_at && 'opacity-60',
                    )}
                  >
                    {/* `relative` scopes the stretched link below to this cell,
                        so the vehicle name is clickable across the whole cell
                        without nesting interactive elements. */}
                    <td className="relative px-5 py-3">
                      <div className="flex items-center gap-3">
                        <VehicleThumbnail
                          url={thumbnails.get(vehicle.vehicle_id)}
                          make={vehicle.make}
                          model={vehicle.model}
                        />
                        <div className="min-w-0">
                          <Link
                            to={`${paths.vehicles}/${vehicle.vehicle_id}`}
                            className="text-ink block truncate text-[0.875rem] leading-5 font-medium hover:underline"
                          >
                            {vehicle.make} {vehicle.model}
                            <span className="absolute inset-0" aria-hidden="true" />
                          </Link>
                          <p className="text-ink-subtle truncate text-[0.75rem]">
                            {[vehicle.model_year, vehicle.color, vehicle.category]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </p>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3">
                      <span className="identifier text-ink">{vehicle.registration_plate}</span>
                    </td>

                    <td className="px-3 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <VehicleStatusBadge status={vehicle.effective_status} />
                        {context ? (
                          <span className="text-ink-subtle text-[0.6875rem]">{context}</span>
                        ) : null}
                      </div>
                    </td>

                    <td data-numeric="" className="text-ink px-3 py-3 text-end text-[0.8125rem]">
                      {formatOdometer(vehicle.odometer, locale, distanceUnit)}
                    </td>

                    <td data-numeric="" className="text-ink px-3 py-3 text-end text-[0.8125rem]">
                      {formatMoney(vehicle.daily_rate_minor, vehicle.currency, { locale })}
                    </td>

                    <td className="px-3 py-3">
                      {state.needsAttention ? (
                        <Badge
                          tone={state.overall === 'expired' ? 'critical' : 'caution'}
                          className="gap-1"
                        >
                          <AlertTriangle className="size-3" aria-hidden="true" />
                          {state.overall === 'expired' ? 'Expired' : 'Due soon'}
                        </Badge>
                      ) : state.overall === 'unrecorded' ? (
                        <span className="text-ink-subtle text-[0.75rem]">Incomplete</span>
                      ) : (
                        <span className="text-ink-subtle text-[0.75rem]">In order</span>
                      )}
                    </td>

                    <td className="px-3 py-3">
                      <ChevronRight
                        className="text-ink-subtle group-hover:text-ink size-4 transition-colors"
                        aria-hidden="true"
                      />
                    </td>
                  </tr>
                )
              })}
        </tbody>
      </table>
    </div>
  )
}
