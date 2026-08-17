import { Building2, CarFront, Coins, FileSignature } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Alert, Skeleton } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { ExpenseAllocation, ExpenseSummaryRow } from '@/types/database'

import { presentCurrencies, shareOfTotal } from '../money'

export interface ExpenseSummaryStripProps {
  rows: readonly ExpenseSummaryRow[]
  locale: string
  isLoading: boolean
  active: ExpenseAllocation | null
  onSelect: (allocation: ExpenseAllocation) => void
  onClear: () => void
}

const TILES: ReadonlyArray<{
  readonly key: ExpenseAllocation
  readonly label: string
  readonly icon: LucideIcon
  readonly field: keyof Pick<ExpenseSummaryRow, 'overhead_minor' | 'vehicle_minor' | 'rental_minor'>
}> = [
  { key: 'overhead', label: 'Agency overhead', icon: Building2, field: 'overhead_minor' },
  { key: 'vehicle', label: 'Vehicle costs', icon: CarFront, field: 'vehicle_minor' },
  { key: 'rental', label: 'Rental costs', icon: FileSignature, field: 'rental_minor' },
]

/**
 * What the period cost, split by who owns it.
 *
 * When the agency spent in one currency this is four figures. When it spent in
 * several it is a breakdown, because adding them would require an exchange rate
 * this product does not have and will not invent. The interface says so rather
 * than quietly showing the largest currency and hoping.
 */
export function ExpenseSummaryStrip({
  rows,
  locale,
  isLoading,
  active,
  onSelect,
  onClear,
}: ExpenseSummaryStripProps) {
  const presentation = presentCurrencies(rows)
  const money = (minor: number, currency: string) => formatMoney(minor, currency, { locale })

  if (isLoading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="border-line bg-surface rounded-lg border px-4 py-3">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
    )
  }

  /*
   * Nothing to summarise, so nothing is shown. The list below already says the
   * period is empty, and a bordered box repeating it made an empty month read
   * as two failures instead of one plain fact.
   */
  if (presentation.rows.length === 0) return null

  if (presentation.isMixed) {
    return (
      <div className="space-y-2">
        <Alert tone="info" title="Spending in more than one currency">
          These costs are not added together — this product holds no exchange rate, and a combined
          figure would be a guess. Each currency is shown on its own.
        </Alert>

        <div className="border-line bg-surface divide-line divide-y rounded-lg border">
          {presentation.rows.map((row) => (
            <div
              key={row.currency}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3"
            >
              <span className="text-ink w-14 shrink-0 text-[0.8125rem] font-semibold">
                {row.currency}
              </span>
              <span data-numeric="" className="text-ink text-[1.0625rem] font-semibold">
                {money(row.total_minor, row.currency)}
              </span>
              <span className="text-ink-subtle text-[0.75rem]">
                {TILES.map(
                  (tile) => `${tile.label.toLowerCase()} ${money(row[tile.field], row.currency)}`,
                ).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const only = presentation.headline!

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <div className="border-line bg-surface flex items-center gap-3 rounded-lg border px-4 py-3">
        <Coins className="text-brand-600 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          <span data-numeric="" className="text-ink block text-[1.25rem] leading-7 font-semibold">
            {money(only.total_minor, only.currency)}
          </span>
          <span className="text-ink-subtle block truncate text-[0.6875rem]">
            Total spent · {only.expense_count} {only.expense_count === 1 ? 'cost' : 'costs'}
          </span>
        </span>
      </div>

      {TILES.map((tile) => {
        const value = only[tile.field]
        const share = shareOfTotal(value, only.total_minor)
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
            <Icon className="text-ink-subtle size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              <span
                data-numeric=""
                className="text-ink block text-[1.25rem] leading-7 font-semibold"
              >
                {money(value, only.currency)}
              </span>
              <span className="text-ink-subtle block truncate text-[0.6875rem]">
                {tile.label}
                {share !== null ? ` · ${share.toFixed(0)}%` : ''}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
