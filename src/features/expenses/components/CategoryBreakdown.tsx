import { Skeleton } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import type { ExpenseCategoryBreakdownRow } from '@/types/database'

import { shareOfTotal } from '../money'

export interface CategoryBreakdownProps {
  rows: readonly ExpenseCategoryBreakdownRow[]
  locale: string
  isLoading: boolean
  onSelect: (categoryId: string) => void
  activeCategoryId: string | null
}

/**
 * Where the money went, by category.
 *
 * Grouped by currency first, because a share is only meaningful inside one: a
 * category holding 40% of the euros and 5% of the dirhams has no single
 * percentage, and averaging them would be arithmetic nobody asked for.
 *
 * The bar is a proportion of the largest row rather than of the total, which is
 * what makes the difference between the top few readable at a glance.
 */
export function CategoryBreakdown({
  rows,
  locale,
  isLoading,
  onSelect,
  activeCategoryId,
}: CategoryBreakdownProps) {
  if (isLoading) {
    return (
      <ul className="space-y-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <li key={index} className="flex items-center gap-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-2 flex-1" />
            <Skeleton className="h-3 w-16" />
          </li>
        ))}
      </ul>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="text-ink-subtle py-6 text-center text-[0.8125rem]">
        No costs recorded in this period.
      </p>
    )
  }

  const currencies = [...new Set(rows.map((row) => row.currency))]

  return (
    <div className="space-y-5">
      {currencies.map((currency) => {
        const inCurrency = rows
          .filter((row) => row.currency === currency)
          .sort((a, b) => b.total_minor - a.total_minor)
        const total = inCurrency.reduce((sum, row) => sum + row.total_minor, 0)
        const largest = inCurrency[0]?.total_minor ?? 0

        return (
          <section key={currency} className="space-y-2">
            {currencies.length > 1 ? <h3 className="eyebrow">{currency}</h3> : null}

            <ul className="space-y-1.5">
              {inCurrency.slice(0, 8).map((row) => {
                const share = shareOfTotal(row.total_minor, total)
                const width = largest > 0 ? (row.total_minor / largest) * 100 : 0
                const isActive = activeCategoryId === row.category_id

                return (
                  <li key={`${row.category_id}-${currency}`}>
                    <button
                      type="button"
                      onClick={() => onSelect(row.category_id)}
                      aria-pressed={isActive}
                      className="group focus-visible:outline-brand-500 flex w-full items-center gap-3 rounded px-1 py-1 text-start focus-visible:outline-2"
                    >
                      <span className="text-ink w-32 shrink-0 truncate text-[0.8125rem]">
                        {row.category_name}
                      </span>

                      <span className="bg-surface-inset relative h-1.5 flex-1 overflow-hidden rounded-full">
                        <span
                          className={
                            isActive
                              ? 'bg-brand-600 absolute inset-y-0 start-0 rounded-full'
                              : 'bg-brand-400 group-hover:bg-brand-500 absolute inset-y-0 start-0 rounded-full transition-colors'
                          }
                          style={{ width: `${Math.max(width, 2)}%` }}
                        />
                      </span>

                      <span
                        data-numeric=""
                        className="text-ink w-24 shrink-0 text-end text-[0.8125rem]"
                      >
                        {formatMoney(row.total_minor, currency, { locale })}
                      </span>
                      <span
                        data-numeric=""
                        className="text-ink-subtle w-10 shrink-0 text-end text-[0.6875rem]"
                      >
                        {share === null ? '' : `${share.toFixed(0)}%`}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>

            {inCurrency.length > 8 ? (
              <p className="text-ink-subtle ps-1 text-[0.6875rem]">
                and {inCurrency.length - 8} more
              </p>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
