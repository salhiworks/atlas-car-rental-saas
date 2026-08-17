import { CarFront, MapPin, MapPinOff } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { GpsFleetRow } from '@/types/database'

import { formatAge, formatSpeed } from '../domain'

import { PositionFreshnessBadge } from './GpsBadges'

/**
 * The fleet as a list, beside the fleet as a map.
 *
 * The list is the authoritative one. Every tracked vehicle appears here,
 * including the ones the map cannot draw because no usable position exists — a
 * vehicle missing from both would be a vehicle the agency forgets it is paying
 * for. Selecting in either place selects in the other.
 *
 * It carries no customer name. A tracked vehicle on hire is somebody's
 * movements, and a list of plates against people's names, open on a screen at
 * the counter, is not something this product creates. The contract reference is
 * shown so an authorised person can open Rentals and ask there.
 */

export interface FleetListProps {
  rows: readonly GpsFleetRow[]
  selectedVehicleId: string | null
  onSelect: (vehicleId: string) => void
  locale: string
  timeZone: string
  className?: string
}

export function FleetList({
  rows,
  selectedVehicleId,
  onSelect,
  locale,
  timeZone,
  className,
}: FleetListProps) {
  const selectedRef = useRef<HTMLButtonElement | null>(null)

  // Selecting on the map has to bring the row into view, or the two halves of
  // the workspace disagree about what is selected.
  useEffect(() => {
    const element = selectedRef.current
    // Guarded because not every rendering environment implements it, and a
    // missing scroll must not take the list down with it.
    if (typeof element?.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedVehicleId])

  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
    timeZone,
  })

  return (
    <ul className={cn('divide-line divide-y', className)} aria-label="Tracked vehicles">
      {rows.map((row) => {
        const selected = row.vehicle_id === selectedVehicleId
        const plotted =
          row.latitude !== null && row.longitude !== null && row.position_valid === true

        return (
          <li key={row.vehicle_id}>
            <button
              type="button"
              ref={selected ? selectedRef : undefined}
              onClick={() => onSelect(row.vehicle_id)}
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'focus-visible:ring-brand-500 w-full px-4 py-3 text-start transition-colors outline-none',
                'hover:bg-surface-inset focus-visible:ring-2 focus-visible:-ring-offset-1',
                selected && 'bg-brand-50 hover:bg-brand-50',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[0.8125rem] font-semibold">{row.vehicle_plate}</p>
                  <p className="text-ink-muted truncate text-[0.75rem]">
                    {row.vehicle_make} {row.vehicle_model}
                  </p>
                </div>
                {plotted ? (
                  <MapPin className="text-ink-subtle mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <MapPinOff
                    className="text-ink-subtle mt-0.5 size-3.5 shrink-0"
                    aria-label="No position on the map"
                  />
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <PositionFreshnessBadge
                  freshness={row.position_freshness}
                  ageSeconds={row.position_age_seconds}
                />
                {row.current_rental_id ? (
                  <Badge tone="info" title="This vehicle is out on a contract right now.">
                    On hire
                  </Badge>
                ) : null}
              </div>

              <dl className="text-ink-muted mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[0.75rem]">
                <div className="flex items-baseline gap-1">
                  <dt className="sr-only">Speed</dt>
                  <dd className="tabular-nums">{formatSpeed(row.speed_kph, locale)}</dd>
                </div>
                <div className="flex items-baseline gap-1">
                  <dt className="sr-only">Last reported</dt>
                  <dd className="tabular-nums">
                    {row.observed_at
                      ? `${time.format(new Date(row.observed_at))} · ${formatAge(row.position_age_seconds)}`
                      : 'Never reported'}
                  </dd>
                </div>
              </dl>
            </button>
          </li>
        )
      })}

      {rows.length === 0 ? (
        <li className="text-ink-muted flex flex-col items-center gap-2 px-6 py-10 text-center">
          <CarFront className="text-ink-subtle size-5" aria-hidden="true" />
          <p className="text-[0.8125rem]">No tracked vehicle matches this search.</p>
        </li>
      ) : null}
    </ul>
  )
}
