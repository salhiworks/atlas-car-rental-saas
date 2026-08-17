import type { ComponentType, ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

export interface EmptyStateProps {
  icon?: ComponentType<{ className?: string }>
  title: string
  /** One sentence saying what would appear here and how to make it appear. */
  description?: ReactNode
  action?: ReactNode
  /**
   * Supporting detail below the action — what the section will do once it has
   * data, or what the integration does and does not do. Separated by a hairline
   * so it reads as a note rather than as part of the invitation.
   */
  footer?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

/**
 * An empty screen is an instruction, not an apology. Every use of this
 * component should name the next action rather than describing the absence.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  footer,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        // Roomy, but no longer cavernous: py-14 left a card that was mostly air
        // on pages where the empty state is the whole page.
        size === 'md' ? 'gap-3 px-6 py-11' : 'gap-2 px-4 py-8',
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            'border-line bg-surface-inset text-ink-subtle flex items-center justify-center rounded-lg border',
            size === 'md' ? 'size-11' : 'size-9',
          )}
        >
          <Icon className={size === 'md' ? 'size-5' : 'size-4'} />
        </div>
      ) : null}

      <div className="max-w-sm space-y-1">
        <p className={cn('font-semibold', size === 'md' ? 'text-[0.9375rem]' : 'text-sm')}>
          {title}
        </p>
        {description ? (
          <p className="text-ink-muted text-[0.8125rem] leading-5">{description}</p>
        ) : null}
      </div>

      {action ? <div className="pt-1">{action}</div> : null}

      {footer ? (
        <div className="border-line text-ink-muted mt-3 w-full max-w-xl border-t pt-4 text-start text-[0.75rem] leading-5">
          {footer}
        </div>
      ) : null}
    </div>
  )
}
