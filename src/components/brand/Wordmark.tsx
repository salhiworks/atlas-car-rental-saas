import { getAppName } from '@/lib/config/env'
import { cn } from '@/lib/utils/cn'

export interface WordmarkProps {
  /** `inverse` is for the deep brand panel; `default` for light surfaces. */
  tone?: 'default' | 'inverse'
  className?: string
}

/**
 * The product mark: a key-fob square beside the name.
 *
 * The glyph is a stylised key head — the object every rental transaction ends
 * with — drawn as two concentric forms so it stays legible at 28px.
 */
export function Wordmark({ tone = 'default', className }: WordmarkProps) {
  const isInverse = tone === 'inverse'

  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex size-7 items-center justify-center rounded-md',
          isInverse ? 'bg-ink-inverse/10 ring-ink-inverse/20 ring-1' : 'bg-brand-700',
        )}
      >
        <svg viewBox="0 0 20 20" className="size-4" fill="none" aria-hidden="true">
          <circle
            cx="7.5"
            cy="7.5"
            r="3.75"
            stroke={isInverse ? '#ffffff' : '#ffffff'}
            strokeWidth="1.75"
          />
          <path
            d="M10.2 10.2 16 16M13.4 12.6l-1.6 1.6M16 16l-1.4 1.4"
            stroke="#ffffff"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span
        className={cn(
          'text-[0.9375rem] font-semibold tracking-tight',
          isInverse ? 'text-ink-inverse' : 'text-ink',
        )}
      >
        {getAppName()}
      </span>
    </span>
  )
}
