import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

export type AlertTone = 'info' | 'positive' | 'caution' | 'critical'

const TONE: Record<
  AlertTone,
  { container: string; icon: string; Icon: ComponentType<{ className?: string }> }
> = {
  info: {
    container: 'bg-info-50 border-info-200 text-info-700',
    icon: 'text-info-600',
    Icon: Info,
  },
  positive: {
    container: 'bg-positive-50 border-positive-200 text-positive-700',
    icon: 'text-positive-600',
    Icon: CheckCircle2,
  },
  caution: {
    container: 'bg-caution-50 border-caution-200 text-caution-700',
    icon: 'text-caution-600',
    Icon: AlertTriangle,
  },
  critical: {
    container: 'bg-critical-50 border-critical-200 text-critical-700',
    icon: 'text-critical-600',
    Icon: XCircle,
  },
}

export interface AlertProps {
  tone?: AlertTone
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}

export function Alert({ tone = 'info', title, children, actions, className }: AlertProps) {
  const { container, icon, Icon } = TONE[tone]

  return (
    <div
      // Errors interrupt; everything else is announced politely when convenient.
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3', container, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="text-[0.8125rem] leading-5 font-semibold">{title}</p> : null}
        {children ? <div className="text-[0.8125rem] leading-5">{children}</div> : null}
        {actions ? <div className="flex flex-wrap gap-2 pt-1">{actions}</div> : null}
      </div>
    </div>
  )
}
