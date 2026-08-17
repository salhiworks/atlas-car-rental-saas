import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { FleetStatusCountsRow, VehicleStatus } from '@/types/database'

interface SummaryEntry {
  readonly key: VehicleStatus | 'total'
  readonly label: string
  readonly value: number
  readonly dot?: string
}

export interface FleetSummaryProps {
  counts: FleetStatusCountsRow | undefined
  isLoading: boolean
  activeStatuses: readonly VehicleStatus[]
  onToggleStatus: (status: VehicleStatus) => void
  onClear: () => void
}

/**
 * Fleet composition as one strip of figures, not five dashboard cards.
 *
 * Each figure is also the filter for its own state, which is what a manager
 * wants next after reading "3 in maintenance". Making the numbers inert and
 * putting the same five options in a separate filter menu would say the same
 * thing twice and act on neither.
 */
export function FleetSummary({
  counts,
  isLoading,
  activeStatuses,
  onToggleStatus,
  onClear,
}: FleetSummaryProps) {
  const entries: SummaryEntry[] = [
    { key: 'total', label: 'Vehicles', value: counts?.total ?? 0 },
    { key: 'available', label: 'Available', value: counts?.available ?? 0, dot: 'bg-positive-600' },
    { key: 'rented', label: 'Rented', value: counts?.rented ?? 0, dot: 'bg-info-600' },
    { key: 'reserved', label: 'Reserved', value: counts?.reserved ?? 0, dot: 'bg-caution-600' },
    {
      key: 'maintenance',
      label: 'Maintenance',
      value: counts?.maintenance ?? 0,
      dot: 'bg-critical-600',
    },
    {
      key: 'unavailable',
      label: 'Off the road',
      value: counts?.unavailable ?? 0,
      dot: 'bg-neutral-badge-600',
    },
  ]

  return (
    <div className="bg-surface border-line divide-line grid grid-cols-2 divide-y rounded-lg border shadow-raised sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6 lg:divide-x">
      {entries.map((entry) => {
        // Narrowing rather than asserting: `status` is null exactly when this is
        // the total, which is also the entry that is not a filter button.
        const status: VehicleStatus | null = entry.key === 'total' ? null : entry.key
        const isActive = status !== null && activeStatuses.includes(status)

        const content = (
          <>
            <span className="text-ink-subtle flex items-center gap-1.5 text-[0.6875rem] font-semibold tracking-[0.08em] uppercase">
              {entry.dot ? (
                <span className={cn('size-1.5 rounded-full', entry.dot)} aria-hidden="true" />
              ) : null}
              {entry.label}
            </span>
            {isLoading ? (
              <Skeleton className="mt-2 h-6 w-10" />
            ) : (
              <span data-numeric="" className="mt-1 block text-xl leading-7 font-semibold">
                {entry.value}
              </span>
            )}
          </>
        )

        if (status === null) {
          return (
            <div key={entry.key} className="px-4 py-3.5">
              {content}
            </div>
          )
        }

        return (
          <button
            key={entry.key}
            type="button"
            onClick={() => (isActive ? onClear() : onToggleStatus(status))}
            aria-pressed={isActive}
            className={cn(
              'px-4 py-3.5 text-start transition-colors',
              'hover:bg-surface-inset',
              isActive && 'bg-brand-50 hover:bg-brand-50',
            )}
          >
            {content}
            <span className="sr-only">
              {isActive
                ? ' — filtering by this status. Activate to clear.'
                : ' — filter by this status'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
