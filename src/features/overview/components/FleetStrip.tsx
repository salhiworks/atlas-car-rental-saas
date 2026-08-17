import { CarFront } from 'lucide-react'
import type { ReactNode } from 'react'

import { EmptyState } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { VehicleStatus } from '@/types/database'

interface FleetSegment {
  readonly status: VehicleStatus
  readonly label: string
  readonly count: number
  readonly bar: string
  readonly dot: string
}

export interface FleetStripProps {
  available: number
  rented: number
  reserved: number
  maintenance: number
  unavailable: number
  emptyAction?: ReactNode
}

/**
 * The dispatch strip: the whole fleet's composition in one line.
 *
 * This is the question a rental manager asks first every morning — how much of
 * the fleet is earning, how much is idle, how much is off the road — and it is
 * answerable at a glance from proportion alone, before reading a single number.
 *
 * Segments use the reserved status palette, which is exactly what they are, and
 * each carries its own count and name so identity never rests on colour.
 */
export function FleetStrip({
  available,
  rented,
  reserved,
  maintenance,
  unavailable,
  emptyAction,
}: FleetStripProps) {
  const segments: FleetSegment[] = [
    {
      status: 'available',
      label: 'Available',
      count: available,
      bar: 'bg-positive-600',
      dot: 'bg-positive-600',
    },
    { status: 'rented', label: 'Rented', count: rented, bar: 'bg-info-600', dot: 'bg-info-600' },
    {
      status: 'reserved',
      label: 'Reserved',
      count: reserved,
      bar: 'bg-caution-600',
      dot: 'bg-caution-600',
    },
    {
      status: 'maintenance',
      label: 'Maintenance',
      count: maintenance,
      bar: 'bg-critical-600',
      dot: 'bg-critical-600',
    },
    {
      status: 'unavailable',
      label: 'Unavailable',
      count: unavailable,
      bar: 'bg-neutral-badge-600',
      dot: 'bg-neutral-badge-600',
    },
  ]

  const total = segments.reduce((sum, segment) => sum + segment.count, 0)

  if (total === 0) {
    return (
      <EmptyState
        size="sm"
        icon={CarFront}
        title="No vehicles yet"
        description="Add your first vehicle and this strip will show what is on the lot, what is out, and what is off the road."
        action={emptyAction}
      />
    )
  }

  const present = segments.filter((segment) => segment.count > 0)

  return (
    <div className="space-y-3.5">
      {/* 2px surface gaps keep adjacent fills from reading as one block. */}
      <div className="flex h-2.5 gap-0.5 overflow-hidden" role="presentation">
        {present.map((segment) => (
          <div
            key={segment.status}
            className={cn('h-full rounded-[2px]', segment.bar)}
            style={{ width: `${((segment.count / total) * 100).toFixed(3)}%` }}
          />
        ))}
      </div>

      {/* Two columns on a phone, one row of five where there is width for it.
          The old single wrapping row left a ragged second line of two, and the
          counts never lined up under each other. */}
      <dl className="border-line grid grid-cols-2 gap-x-5 gap-y-2 border-t pt-3.5 sm:grid-cols-3 lg:grid-cols-5">
        {segments.map((segment) => (
          <div key={segment.status} className="flex items-baseline gap-2">
            <span
              className={cn('size-1.5 shrink-0 translate-y-[-2px] rounded-full', segment.dot)}
              aria-hidden="true"
            />
            <dt className="text-ink-muted min-w-0 flex-1 truncate text-[0.8125rem]">
              {segment.label}
            </dt>
            <dd data-numeric="" className="text-ink text-[0.8125rem] font-semibold">
              {segment.count}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
