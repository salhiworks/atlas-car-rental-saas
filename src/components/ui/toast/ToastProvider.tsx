import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { type ComponentType, type ReactNode, useCallback, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils/cn'

import {
  ToastContext,
  type ToastApi,
  type ToastOptions,
  type ToastRecord,
  type ToastTone,
} from './toast-context'

const DEFAULT_DURATION = 5000

const TONE: Record<ToastTone, { accent: string; Icon: ComponentType<{ className?: string }> }> = {
  info: { accent: 'text-info-600', Icon: Info },
  positive: { accent: 'text-positive-600', Icon: CheckCircle2 },
  caution: { accent: 'text-caution-600', Icon: AlertTriangle },
  critical: { accent: 'text-critical-600', Icon: XCircle },
}

let counter = 0

/**
 * Transient confirmations and failures.
 *
 * The viewport is a polite live region so a screen reader announces the message
 * without interrupting; failures are given a longer life because they usually
 * carry an instruction the reader needs time to act on.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const toast = useCallback(
    (options: ToastOptions): string => {
      counter += 1
      const id = `toast-${counter}`
      const tone = options.tone ?? 'info'
      const duration =
        options.duration ?? (tone === 'critical' ? DEFAULT_DURATION * 1.6 : DEFAULT_DURATION)

      setToasts((current) => [
        ...current.slice(-3),
        { id, title: options.title, description: options.description, tone, duration },
      ])

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        )
      }

      return id
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ title, description, tone: 'positive' }),
      error: (title, description) => toast({ title, description, tone: 'critical' }),
    }),
    [toast, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:end-0 sm:items-end"
      >
        {toasts.map((item) => {
          const { accent, Icon } = TONE[item.tone]
          return (
            <div
              key={item.id}
              className={cn(
                'bg-surface border-line pointer-events-auto flex w-full max-w-sm gap-3 rounded-lg border p-3.5 shadow-overlay',
              )}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', accent)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-[0.8125rem] leading-5 font-semibold">{item.title}</p>
                {item.description ? (
                  <p className="text-ink-muted mt-0.5 text-[0.8125rem] leading-5">
                    {item.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="text-ink-subtle hover:text-ink -m-1 shrink-0 self-start rounded p-1 transition-colors"
              >
                <X className="size-3.5" aria-hidden="true" />
                <span className="sr-only">Dismiss</span>
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
