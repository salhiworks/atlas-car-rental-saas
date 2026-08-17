import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

import type { RentalSummary as RentalSummaryData } from '../api'

export interface RentalSummaryProps {
  summary: RentalSummaryData | undefined
  isLoading: boolean
  active: 'collecting' | 'returning' | 'overdue' | 'outstanding' | null
  onSelect: (tile: 'collecting' | 'returning' | 'overdue' | 'outstanding') => void
  onClear: () => void
}

interface Tile {
  readonly key: 'collecting' | 'returning' | 'overdue' | 'outstanding'
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
}

const TILES: readonly Tile[] = [
  { key: 'collecting', label: 'Collecting today', icon: ArrowUpRight, tone: 'text-info-600' },
  { key: 'returning', label: 'Due back today', icon: ArrowDownLeft, tone: 'text-brand-600' },
  { key: 'overdue', label: 'Past return time', icon: AlertTriangle, tone: 'text-critical-600' },
  { key: 'outstanding', label: 'Money owed', icon: Wallet, tone: 'text-caution-600' },
]

/**
 * The desk's day, in four numbers that are also filters.
 *
 * "Today" is the agency's day in its own time zone, resolved by the page — a
 * desk in Casablanca closing at 19:00 does not want the browser's idea of
 * midnight deciding which returns are today's.
 */
export function RentalSummary({
  summary,
  isLoading,
  active,
  onSelect,
  onClear,
}: RentalSummaryProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {TILES.map((tile) => {
        const value =
          summary?.[
            tile.key === 'collecting'
              ? 'collectingToday'
              : tile.key === 'returning'
                ? 'returningToday'
                : tile.key === 'overdue'
                  ? 'overdue'
                  : 'outstanding'
          ]
        const isActive = active === tile.key
        const Icon = tile.icon

        return (
          <button
            key={tile.key}
            type="button"
            onClick={() => (isActive ? onClear() : onSelect(tile.key))}
            aria-pressed={isActive}
            className={cn(
              'border-line bg-surface hover:border-line-strong flex items-center gap-3 rounded-lg border px-4 py-3 text-start transition-colors',
              'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2',
              isActive && 'border-brand-400 bg-brand-50/40',
            )}
          >
            <Icon className={cn('size-4 shrink-0', tile.tone)} aria-hidden="true" />
            <div className="min-w-0">
              {isLoading ? (
                <Skeleton className="h-6 w-8" />
              ) : (
                <p data-numeric="" className="text-ink text-[1.375rem] leading-7 font-semibold">
                  {value ?? 0}
                </p>
              )}
              <p className="text-ink-subtle truncate text-[0.75rem]">{tile.label}</p>
            </div>
          </button>
        )
      })}
    </div>
  )
}
