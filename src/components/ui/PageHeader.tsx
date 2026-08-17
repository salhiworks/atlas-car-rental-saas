import type { ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

export interface PageHeaderProps {
  title: string
  description?: ReactNode
  /** Short contextual label above the title, e.g. the section this page belongs to. */
  eyebrow?: string
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="min-w-0 space-y-1">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="text-xl leading-7 font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-ink-muted max-w-2xl text-[0.8125rem] leading-5">{description}</p>
        ) : null}
      </div>
      {/* Wraps rather than pushing the page sideways. A header with three
          actions is 495px wide on a phone, and `shrink-0` turned that into a
          horizontally scrolling page instead of a second line of buttons. */}
      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </header>
  )
}
