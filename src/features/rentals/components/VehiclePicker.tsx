import { CarFront, Check } from 'lucide-react'

import { Alert, Skeleton } from '@/components/ui'
import { useVehicleList } from '@/features/vehicles/queries'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { VehicleFleetEntry } from '@/types/database'

import { useAvailableVehicles } from '../queries'

export interface VehiclePickerProps {
  /** ISO instants. Availability is only asked once both ends are known. */
  from: string | null
  to: string | null
  selectedId: string | null
  onSelect: (vehicle: VehicleFleetEntry) => void
  locale: string
  /** Lets a contract being rescheduled keep its own vehicle. */
  excludeRentalId?: string
}

/**
 * Choosing a vehicle for a period.
 *
 * Only vehicles the database says are free are offered, and the list comes from
 * the same rows the exclusion constraint protects. It is still an answer as of
 * now — somebody else may take the last car between this screen and the save —
 * so the constraint, not this list, is what actually prevents a double booking.
 */
export function VehiclePicker({
  from,
  to,
  selectedId,
  onSelect,
  locale,
  excludeRentalId,
}: VehiclePickerProps) {
  const availabilityQuery = useAvailableVehicles(from, to, excludeRentalId)
  const fleetQuery = useVehicleList({ sort: 'newest', pageSize: 100 })

  if (!from || !to) {
    return (
      <p className="text-ink-subtle border-line rounded-md border border-dashed px-4 py-6 text-center text-[0.8125rem]">
        Choose the collection and return times first — availability depends on them.
      </p>
    )
  }

  if (availabilityQuery.isPending || fleetQuery.isPending) {
    return (
      <ul className="grid gap-2 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <li key={index} className="border-line rounded-md border p-3">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-2 h-3 w-24" />
          </li>
        ))}
      </ul>
    )
  }

  const availableIds = new Set(availabilityQuery.data ?? [])
  const vehicles = (fleetQuery.data?.rows ?? []).filter(
    (vehicle) => availableIds.has(vehicle.vehicle_id) && vehicle.archived_at === null,
  )

  if (vehicles.length === 0) {
    return (
      <Alert tone="caution" title="Nothing is free for these dates">
        Every vehicle in service is either committed to another contract over this period or off the
        road. Adjust the dates, or free a vehicle up first.
      </Alert>
    )
  }

  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {vehicles.map((vehicle) => {
        const isSelected = vehicle.vehicle_id === selectedId

        return (
          <li key={vehicle.vehicle_id}>
            <button
              type="button"
              onClick={() => onSelect(vehicle)}
              aria-pressed={isSelected}
              className={cn(
                'border-line hover:border-line-strong flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-start transition-colors',
                'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2',
                isSelected && 'border-brand-400 bg-brand-50/40',
              )}
            >
              <CarFront className="text-ink-subtle size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="text-ink block truncate text-[0.8125rem] font-medium">
                  {vehicle.make} {vehicle.model}
                  {vehicle.model_year ? ` ${vehicle.model_year}` : ''}
                </span>
                <span className="identifier text-ink-subtle block truncate text-[0.6875rem]">
                  {vehicle.registration_plate}
                </span>
              </span>
              <span data-numeric="" className="text-ink shrink-0 text-[0.8125rem]">
                {formatMoney(vehicle.daily_rate_minor, vehicle.currency, { locale })}
                <span className="text-ink-subtle text-[0.6875rem]">/day</span>
              </span>
              {isSelected ? (
                <Check className="text-brand-600 size-4 shrink-0" aria-hidden="true" />
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
