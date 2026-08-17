import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils/cn'

import { maskDocumentNumber } from '../identity'

export interface SensitiveValueProps {
  value: string | null | undefined
  /** Whether the person may reveal the full value at all. */
  canReveal?: boolean
  className?: string
  label?: string
}

/**
 * A document number, masked by default.
 *
 * The reasoning is operational rather than ceremonial. A passport number is
 * evidence checked once at the counter, not a display field; leaving it visible
 * on every profile puts it in screenshots, over shoulders and in support
 * tickets for no gain. So the tail is shown — enough to match the document in
 * someone's hand — and the whole value is a deliberate action.
 *
 * Revealing hides itself again after a short while, because the common case is
 * a glance during a handover, not sustained reading.
 */
export function SensitiveValue({
  value,
  canReveal = true,
  className,
  label = 'document number',
}: SensitiveValueProps) {
  const [isRevealed, setIsRevealed] = useState(false)
  const [justCopied, setJustCopied] = useState(false)

  // Never leave a full identifier on screen indefinitely.
  useEffect(() => {
    if (!isRevealed) return
    const timer = setTimeout(() => setIsRevealed(false), 20_000)
    return () => clearTimeout(timer)
  }, [isRevealed])

  useEffect(() => {
    if (!justCopied) return
    const timer = setTimeout(() => setJustCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [justCopied])

  if (!value) {
    return <span className={cn('text-ink-subtle', className)}>—</span>
  }

  const copy = () => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setJustCopied(true))
      .catch(() => setJustCopied(false))
  }

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="identifier text-ink" data-revealed={isRevealed || undefined}>
        {isRevealed ? value : maskDocumentNumber(value)}
      </span>

      {canReveal ? (
        <>
          <button
            type="button"
            onClick={() => setIsRevealed((current) => !current)}
            className="text-ink-subtle hover:bg-surface-inset hover:text-ink rounded p-1 transition-colors"
            aria-label={isRevealed ? `Hide the full ${label}` : `Show the full ${label}`}
          >
            {isRevealed ? (
              <EyeOff className="size-3.5" aria-hidden="true" />
            ) : (
              <Eye className="size-3.5" aria-hidden="true" />
            )}
          </button>

          <button
            type="button"
            onClick={copy}
            className="text-ink-subtle hover:bg-surface-inset hover:text-ink rounded p-1 transition-colors"
            aria-label={`Copy the ${label}`}
          >
            {justCopied ? (
              <Check className="text-positive-600 size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
          </button>

          {/* Announced without putting the value itself into a live region. */}
          <span role="status" className="sr-only">
            {justCopied ? `${label} copied` : ''}
          </span>
        </>
      ) : null}
    </span>
  )
}
