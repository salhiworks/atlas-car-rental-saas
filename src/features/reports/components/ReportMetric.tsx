import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { ReactNode } from 'react'

import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

import type { Change } from '../period'

/**
 * One figure, and — only when there is something to compare against — how it
 * moved.
 *
 * The change chip is the part that is usually wrong. A previous period of zero
 * has no percentage: the honest answers are "New activity" and "None this
 * period", and both appear here as words rather than as `+∞%` or a confident
 * `+100%`. A sign change has no percentage either — going from a loss of 200 to
 * a gain of 100 is not "+150%" of anything a person can act on.
 *
 * Direction is never carried by colour alone: the arrow points, and the label
 * says what happened.
 */

export interface ReportMetricProps {
  label: string
  /** Pre-formatted. Formatting is a currency and locale decision, not this one's. */
  value: ReactNode
  caption?: ReactNode
  change?: Change | null
  /** True when a rise is bad news — costs, arrears, cancellations. */
  invertChange?: boolean
  isLoading?: boolean
  emphasis?: 'default' | 'strong'
  className?: string
}

export function ReportMetric({
  label,
  value,
  caption,
  change,
  invertChange = false,
  isLoading = false,
  emphasis = 'default',
  className,
}: ReportMetricProps) {
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

      {change && !isLoading ? (
        <ChangeChip change={change} invert={invertChange} className="mt-1.5" />
      ) : null}

      {caption ? <p className="text-ink-subtle mt-1 text-[0.75rem] leading-4">{caption}</p> : null}
    </div>
  )
}

export function ChangeChip({
  change,
  invert = false,
  className,
}: {
  change: Change
  invert?: boolean
  className?: string
}) {
  const good = change.state === 'up' ? !invert : change.state === 'down' ? invert : null

  const Icon =
    change.state === 'up' ? ArrowUpRight : change.state === 'down' ? ArrowDownRight : Minus

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[0.75rem] leading-4 font-medium',
        good === true
          ? 'text-positive-700'
          : good === false
            ? 'text-critical-700'
            : 'text-ink-subtle',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {change.label}
    </span>
  )
}
