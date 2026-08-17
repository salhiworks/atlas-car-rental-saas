import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/utils/cn'

export type BadgeTone = 'neutral' | 'brand' | 'positive' | 'info' | 'caution' | 'critical'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-badge-50 text-neutral-badge-600 border-neutral-badge-200',
  brand: 'bg-brand-50 text-brand-700 border-brand-200',
  positive: 'bg-positive-50 text-positive-700 border-positive-200',
  info: 'bg-info-50 text-info-700 border-info-200',
  caution: 'bg-caution-50 text-caution-700 border-caution-200',
  critical: 'bg-critical-50 text-critical-700 border-critical-200',
}

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-badge-600',
  brand: 'bg-brand-500',
  positive: 'bg-positive-600',
  info: 'bg-info-600',
  caution: 'bg-caution-600',
  critical: 'bg-critical-600',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  /** Adds a status dot. Use for lifecycle states, not for counts or labels. */
  withDot?: boolean
}

/**
 * Status badges are tinted, never filled. Twenty rows of solid colour turn a
 * table into a chart; a tint keeps the row readable and still separates states
 * at a glance.
 */
export function Badge({
  tone = 'neutral',
  withDot = false,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
        'text-2xs leading-4 font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {withDot ? (
        <span
          className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASSES[tone])}
          aria-hidden="true"
        />
      ) : null}
      {children}
    </span>
  )
}
