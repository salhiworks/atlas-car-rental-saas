import { type ReactNode, useId } from 'react'

import { cn } from '@/lib/utils/cn'

import { FieldContext } from './field-context'

export interface FieldProps {
  label: ReactNode
  /** Guidance shown beneath the control. Always visible — not a tooltip. */
  hint?: ReactNode
  error?: string | undefined
  required?: boolean
  /** Renders the label visually hidden while keeping it available to assistive tech. */
  hideLabel?: boolean
  /**
   * `row` puts the label and its hint beside the control rather than above it.
   * Used where a screen is a list of individual preferences — Settings — so that
   * every row reads as one decision and the controls line up down the page.
   */
  layout?: 'stacked' | 'row'
  className?: string
  children: ReactNode
}

/**
 * Label, control, hint and error as one accessible unit.
 *
 * The ids are generated here and handed to the control through context, which
 * is what guarantees `htmlFor`, `aria-describedby` and `aria-invalid` all line
 * up — those are easy to get subtly wrong when each form wires them by hand.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  hideLabel = false,
  layout = 'stacked',
  className,
  children,
}: FieldProps) {
  const id = useId()
  const controlId = `${id}-control`
  const descriptionId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined

  const labelNode = (
    <label
      htmlFor={controlId}
      className={cn(
        'text-ink block text-[0.8125rem] leading-5 font-medium',
        hideLabel && 'sr-only',
      )}
    >
      {label}
      {required ? (
        <span className="text-critical-600 ml-0.5" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  )

  const hintNode =
    hint && !error ? (
      <p id={descriptionId} className="text-ink-subtle text-[0.75rem] leading-4">
        {hint}
      </p>
    ) : null

  const errorNode = error ? (
    <p id={errorId} className="text-critical-600 text-[0.75rem] leading-4 font-medium">
      {error}
    </p>
  ) : null

  return (
    <FieldContext.Provider
      value={{ controlId, descriptionId, errorId, hasError: Boolean(error), isRequired: required }}
    >
      {layout === 'row' ? (
        <div
          className={cn(
            'grid items-start gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]',
            className,
          )}
        >
          <div className="min-w-0 space-y-1">
            {labelNode}
            {hintNode}
          </div>
          <div className="min-w-0 space-y-1.5">
            {children}
            {errorNode}
          </div>
        </div>
      ) : (
        <div className={cn('space-y-1.5', className)}>
          {labelNode}
          {children}
          {hintNode}
          {errorNode}
        </div>
      )}
    </FieldContext.Provider>
  )
}
