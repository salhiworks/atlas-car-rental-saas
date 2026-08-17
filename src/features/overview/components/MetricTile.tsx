import type { ReactNode } from 'react'

import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

export interface MetricTileProps {
  label: string
  /** Pre-formatted for display — formatting is a currency and locale decision, not this component's. */
  value: ReactNode
  /** One short line of context: what the figure covers, or what it excludes. */
  caption?: ReactNode
  isLoading?: boolean
  emphasis?: 'default' | 'strong'
  className?: string
}

/**
 * A single figure.
 *
 * No sparkline, no percentage-change chip. A change indicator needs a prior
 * period to compare against, and inventing one — or showing "+0%" against no
 * history — is worse than showing the number plainly.
 */
export function MetricTile({
  label,
  value,
  caption,
  isLoading = false,
  emphasis = 'default',
  className,
}: MetricTileProps) {
  return (
    <div className={cn('bg-surface border-line rounded-lg border p-4 shadow-raised', className)}>
      <p className="eyebrow">{label}</p>

      {isLoading ? (
        <Skeleton className="mt-2.5 h-7 w-24" />
      ) : (
        <p
          data-numeric=""
          className={cn(
            'mt-1.5 leading-8 font-semibold tracking-tight',
            emphasis === 'strong' ? 'text-[1.5rem]' : 'text-[1.25rem]',
          )}
        >
          {value}
        </p>
      )}

      {caption ? <p className="text-ink-subtle mt-1 text-[0.75rem] leading-4">{caption}</p> : null}
    </div>
  )
}
