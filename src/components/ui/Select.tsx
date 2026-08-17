import { ChevronDown } from 'lucide-react'
import { type SelectHTMLAttributes, forwardRef } from 'react'

import { cn } from '@/lib/utils/cn'

import { controlBaseClasses, controlStateClasses } from './control-styles'
import { useFieldControlProps } from './field-context'

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: readonly SelectOption[]
  /** Rendered as a disabled first option — use for "Choose a country", never as a real value. */
  placeholder?: string
}

/**
 * A native `<select>`.
 *
 * Deliberately not a custom listbox: the settings screens pick from lists of
 * several hundred time zones and currencies, and the platform's own control
 * gives free type-ahead, correct touch behaviour and reliable screen reader
 * support that a bespoke widget would have to re-earn.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, id, ...props },
  ref,
) {
  const { hasError, ...aria } = useFieldControlProps(id)

  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          controlBaseClasses,
          controlStateClasses(hasError),
          'h-9 cursor-pointer appearance-none ps-3 pe-9',
          className,
        )}
        {...aria}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="text-ink-subtle pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
    </div>
  )
})
