import { type InputHTMLAttributes, type ReactNode, forwardRef } from 'react'

import { cn } from '@/lib/utils/cn'

import { controlBaseClasses, controlStateClasses } from './control-styles'
import { useFieldControlProps } from './field-context'

// `prefix` shadows a legacy HTML attribute of the same name; ours is a node
// rendered inside the control, so the attribute is omitted.
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  /** Static text or icon rendered inside the leading edge, e.g. a currency symbol. */
  prefix?: ReactNode
  /** Static text rendered inside the trailing edge, e.g. a unit. */
  suffix?: ReactNode
  /** Sets tabular numerals and right alignment for monetary and numeric entry. */
  numeric?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, prefix, suffix, numeric = false, id, ...props },
  ref,
) {
  const { hasError, ...aria } = useFieldControlProps(id)

  const input = (
    <input
      ref={ref}
      className={cn(
        controlBaseClasses,
        controlStateClasses(hasError),
        'h-9 px-3',
        numeric && 'text-right tabular-nums',
        prefix && 'ps-9',
        suffix && 'pe-12',
        className,
      )}
      {...aria}
      {...props}
    />
  )

  if (!prefix && !suffix) return input

  return (
    <div className="relative">
      {prefix ? (
        <span className="text-ink-subtle pointer-events-none absolute inset-y-0 start-0 flex w-9 items-center justify-center text-[0.8125rem]">
          {prefix}
        </span>
      ) : null}
      {input}
      {suffix ? (
        <span className="text-ink-subtle pointer-events-none absolute inset-y-0 end-0 flex items-center pe-3 text-[0.8125rem]">
          {suffix}
        </span>
      ) : null}
    </div>
  )
})
