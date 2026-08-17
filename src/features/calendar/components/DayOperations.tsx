import { ArrowDownLeft, ArrowUpRight, CarFront, Clock, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Skeleton } from '@/components/ui'
import { formatTime } from '@/lib/datetime/format'
import { cn } from '@/lib/utils/cn'
import type { RentalScheduleEntry } from '@/types/database'

import type { DayOperations as DayOperationsData } from '../schedule'

export type DayGroup = 'pickups' | 'returns' | 'out' | 'overdue' | 'free'

export interface DayOperationsStripProps {
  operations: DayOperationsData
  /** Vehicles with nothing booked and nothing wrong with them, for the day. */
  freeVehicleCount: number | null
  active: DayGroup | null
  onSelect: (group: DayGroup) => void
  onClear: () => void
  isLoading: boolean
}

const GROUPS: ReadonlyArray<{
  readonly key: DayGroup
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
}> = [
  { key: 'pickups', label: 'Going out', icon: ArrowUpRight, tone: 'text-info-600' },
  { key: 'returns', label: 'Due back', icon: ArrowDownLeft, tone: 'text-brand-600' },
  { key: 'out', label: 'Out now', icon: Clock, tone: 'text-ink-muted' },
  { key: 'overdue', label: 'Overdue', icon: TriangleAlert, tone: 'text-critical-600' },
  { key: 'free', label: 'Free', icon: CarFront, tone: 'text-positive-600' },
]

/**
 * The selected day in five numbers, each of which is also a filter.
 *
 * Five counts on one strip rather than five cards down the page: this sits
 * above a scheduler that needs the vertical space, and a rental desk reads it
 * in one glance before looking at the board itself.
 */
export function DayOperationsStrip({
  operations,
  freeVehicleCount,
  active,
  onSelect,
  onClear,
  isLoading,
}: DayOperationsStripProps) {
  const counts: Record<DayGroup, number | null> = {
    pickups: operations.pickups.length,
    returns: operations.returns.length,
    out: operations.out.length,
    overdue: operations.overdue.length,
    free: freeVehicleCount,
  }

  return (
    <div className="border-line bg-surface flex flex-wrap divide-x divide-[var(--color-line)] rounded-lg border">
      {GROUPS.map((group) => {
        const isActive = active === group.key
        const value = counts[group.key]
        const Icon = group.icon

        return (
          <button
            key={group.key}
            type="button"
            onClick={() => (isActive ? onClear() : onSelect(group.key))}
            aria-pressed={isActive}
            className={cn(
              'hover:bg-surface-muted flex min-w-[7.5rem] flex-1 items-center gap-2.5 px-4 py-2.5 text-start transition-colors',
              'focus-visible:outline-brand-500 first:rounded-s-lg last:rounded-e-lg focus-visible:outline-2 focus-visible:-outline-offset-2',
              isActive && 'bg-brand-50/50',
            )}
          >
            <Icon className={cn('size-4 shrink-0', group.tone)} aria-hidden="true" />
            <span className="min-w-0">
              {isLoading ? (
                <Skeleton className="h-5 w-6" />
              ) : (
                <span
                  data-numeric=""
                  className={cn(
                    'block text-[1.125rem] leading-6 font-semibold',
                    group.key === 'overdue' && (value ?? 0) > 0 ? 'text-critical-700' : 'text-ink',
                  )}
                >
                  {value ?? '—'}
                </span>
              )}
              <span className="text-ink-subtle block truncate text-[0.6875rem]">{group.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export interface DayOperationsListProps {
  operations: DayOperationsData
  locale: string
  timeZone: string
  onOpen: (rental: RentalScheduleEntry) => void
}

/**
 * The same day as a worklist.
 *
 * What the counter reads down: who is collecting, at what time, in which car.
 * On a phone this replaces the timeline entirely, because a Gantt chart squeezed
 * onto a 390-pixel screen answers nothing.
 */
export function DayOperationsList({
  operations,
  locale,
  timeZone,
  onOpen,
}: DayOperationsListProps) {
  const sections: ReadonlyArray<{
    key: DayGroup
    title: string
    rentals: readonly RentalScheduleEntry[]
    timeKey: 'starts_at' | 'ends_at'
  }> = [
    { key: 'overdue', title: 'Overdue', rentals: operations.overdue, timeKey: 'ends_at' },
    { key: 'pickups', title: 'Going out', rentals: operations.pickups, timeKey: 'starts_at' },
    { key: 'returns', title: 'Due back', rentals: operations.returns, timeKey: 'ends_at' },
    { key: 'out', title: 'Out now', rentals: operations.out, timeKey: 'ends_at' },
  ]

  const nonEmpty = sections.filter((section) => section.rentals.length > 0)

  if (nonEmpty.length === 0) {
    return (
      <p className="text-ink-subtle px-4 py-8 text-center text-[0.8125rem]">
        Nothing scheduled for this day.
      </p>
    )
  }

  return (
    <div className="divide-line divide-y">
      {nonEmpty.map((section) => (
        <section key={section.key}>
          <h3 className="eyebrow bg-surface-muted px-4 py-1.5">{section.title}</h3>
          <ul className="divide-line divide-y">
            {section.rentals.map((rental) => (
              <li key={`${section.key}-${rental.id}`}>
                <button
                  type="button"
                  onClick={() => onOpen(rental)}
                  className="hover:bg-surface-muted focus-visible:outline-brand-500 flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <span
                    data-numeric=""
                    className={cn(
                      // Wide enough for a 12-hour clock: "01:39 PM" wraps at 48px.
                      'w-[4.25rem] shrink-0 text-[0.8125rem] font-medium whitespace-nowrap',
                      section.key === 'overdue' ? 'text-critical-700' : 'text-ink',
                    )}
                  >
                    {formatTime(new Date(rental[section.timeKey]), { locale, timeZone })}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-ink block truncate text-[0.8125rem]">
                      {rental.customer_name}
                    </span>
                    <span className="text-ink-subtle block truncate text-[0.6875rem]">
                      {rental.vehicle_make} {rental.vehicle_model} · {rental.vehicle_plate}
                    </span>
                  </span>
                  <span className="identifier text-ink-subtle shrink-0 text-[0.6875rem]">
                    {rental.reference}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
