import { getAppName } from '@/lib/config/env'
import { cn } from '@/lib/utils/cn'

export interface WordmarkProps {
  /** `inverse` is for the deep brand panel; `default` for light surfaces. */
  tone?: 'default' | 'inverse'
  /** `lg` is for surfaces where the identity should read as slightly more prominent, e.g. a public header. Defaults to the size used everywhere else in the product. */
  size?: 'default' | 'lg'
  className?: string
}

/**
 * The product mark: a key-fob square beside the name.
 *
 * The glyph is a stylised key head — the object every rental transaction ends
 * with — drawn as two concentric forms so it stays legible at 28px.
 */
export function Wordmark({ tone = 'default', size = 'default', className }: WordmarkProps) {
  const isInverse = tone === 'inverse'
  const isLarge = size === 'lg'

  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex items-center justify-center rounded-md',
          isLarge ? 'size-8' : 'size-7',
          isInverse ? 'bg-ink-inverse/10 ring-ink-inverse/20 ring-1' : 'bg-brand-700',
        )}
      >
        <svg
          viewBox="0 0 20 20"
          className={isLarge ? 'size-[1.1rem]' : 'size-4'}
          fill="none"
          aria-hidden="true"
        >
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
          'font-semibold tracking-tight',
          isLarge ? 'text-base' : 'text-[0.9375rem]',
          isInverse ? 'text-ink-inverse' : 'text-ink',
        )}
      >
        {getAppName()}
      </span>
    </span>
  )
}
