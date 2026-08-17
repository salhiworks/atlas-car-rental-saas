import type { InputHTMLAttributes } from 'react'

import { cn } from '@/lib/utils/cn'

export type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>

/**
 * An on/off preference.
 *
 * A real checkbox underneath, visually hidden: the semantics, the label
 * association and the keyboard behaviour are the platform's, and only the
 * appearance is ours. A `div role="switch"` would have meant reimplementing all
 * three, and getting one of them subtly wrong.
 */
export function Switch({ className, disabled, ...props }: SwitchProps) {
  return (
    <span className={cn('relative inline-flex shrink-0 items-center', className)}>
      <input
        type="checkbox"
        role="switch"
        disabled={disabled}
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(
          'border-line-strong bg-surface-inset h-5 w-9 rounded-full border transition-colors',
          'peer-checked:bg-brand-600 peer-checked:border-brand-700',
          'peer-focus-visible:outline-brand-500 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2',
          'peer-disabled:opacity-50',
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          'bg-surface pointer-events-none absolute start-0.5 size-4 rounded-full shadow-raised',
          'border-line border transition-transform',
          'peer-checked:translate-x-4 peer-checked:border-transparent rtl:peer-checked:-translate-x-4',
          'peer-disabled:opacity-50',
        )}
      />
    </span>
  )
}
