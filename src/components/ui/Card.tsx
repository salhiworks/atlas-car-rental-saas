import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('bg-surface border-line rounded-lg border shadow-raised', className)}
      {...props}
    />
  )
}

// `title` and `HTMLAttributes.title` mean different things — the tooltip
// attribute is omitted so the heading can be any renderable node.
export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  /** Right-aligned controls: filters, a period selector, a primary action. */
  actions?: ReactNode
}

export function CardHeader({ title, description, actions, className, ...props }: CardHeaderProps) {
  return (
    <div
      className={cn(
        'border-line flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4',
        className,
      )}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-[0.9375rem] leading-5 font-semibold">{title}</h2>
        {description ? <p className="text-ink-muted text-[0.8125rem]">{description}</p> : null}
      </div>
      {/* Wraps rather than pushing the card sideways. `shrink-0` turned a header
          with a search box and a filter into a horizontally scrolling page on a
          390px screen; wrapping costs a line and fixes it everywhere. */}
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'border-line bg-surface-muted flex items-center justify-end gap-2 rounded-b-lg border-t px-5 py-3',
        className,
      )}
      {...props}
    />
  )
}
