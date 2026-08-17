import type { ReactNode } from 'react'

import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

/**
 * A ranked list with a bar behind each row.
 *
 * Not a pie chart. Comparing angles is measurably harder than comparing
 * lengths, a pie cannot carry more than about five slices before its labels
 * collide, and it makes "which is bigger" — the only question anybody asks of a
 * cost breakdown — the hardest thing on the screen.
 *
 * The bar is a background, not a mark: the label and the figure are ordinary
 * text at ordinary weight, so the row is readable with the bar ignored entirely.
 * One colour, because these are magnitudes of the same thing rather than
 * different categories of thing.
 */

export interface RankedItem {
  readonly id: string
  readonly label: string
  readonly value: number
  /** Right-aligned, pre-formatted. */
  readonly display: string
  readonly caption?: ReactNode
  readonly badge?: ReactNode
  readonly href?: string
}

export interface RankedBarsProps {
  items: readonly RankedItem[]
  /** Denominator for the bars. Defaults to the largest value present. */
  total?: number
  isLoading?: boolean
  emptyLabel?: string
  onSelect?: (id: string) => void
  className?: string
}

export function RankedBars({
  items,
  total,
  isLoading = false,
  emptyLabel = 'Nothing recorded in this period.',
  onSelect,
  className,
}: RankedBarsProps) {
  if (isLoading) {
    return (
      <div className={cn('space-y-2.5 p-4', className)}>
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return <p className="text-ink-muted px-4 py-6 text-center text-[0.8125rem]">{emptyLabel}</p>
  }

  const largest = Math.max(total ?? 0, ...items.map((item) => Math.abs(item.value)), 1)

  return (
    <ul className={cn('divide-line divide-y', className)}>
      {items.map((item) => {
        const share = Math.max(0, Math.min(1, Math.abs(item.value) / largest))
        const body = (
          <>
            {/* Behind the text, never over it. */}
            <span
              aria-hidden="true"
              className="bg-brand-50 absolute inset-y-0 start-0 rounded-e-sm"
              style={{ width: `${share * 100}%` }}
            />
            <span className="relative flex items-baseline gap-3">
              <span className="min-w-0 flex-1">
                {/*
                  `min-w-0` on the inner row too: `truncate` can only shrink a
                  label if every flex ancestor is allowed to go below its
                  min-content width. Without it, a supplier or customer whose
                  name is one long unbroken token — an email, a URL, a pasted
                  formula — sets the card's minimum width and pushes the whole
                  page sideways on a phone.
                */}
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate text-[0.8125rem] font-medium">
                    {item.label}
                  </span>
                  {item.badge}
                </span>
                {item.caption ? (
                  <span className="text-ink-subtle mt-0.5 block text-[0.75rem]">
                    {item.caption}
                  </span>
                ) : null}
              </span>
              <span data-numeric="" className="shrink-0 text-[0.8125rem] tabular-nums">
                {item.display}
              </span>
            </span>
          </>
        )

        return (
          <li key={item.id}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className="hover:bg-surface-inset focus-visible:ring-brand-500 relative block w-full px-4 py-2.5 text-start transition-colors outline-none focus-visible:ring-2"
              >
                {body}
              </button>
            ) : (
              <div className="relative px-4 py-2.5">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
