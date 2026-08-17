import { createContext, useContext } from 'react'

export interface FieldContextValue {
  readonly controlId: string
  readonly descriptionId: string | undefined
  readonly errorId: string | undefined
  readonly hasError: boolean
  readonly isRequired: boolean
}

export const FieldContext = createContext<FieldContextValue | null>(null)

/**
 * Wires a control to its label, hint and error message.
 *
 * Consuming controls read this context for their id and `aria-describedby`, so
 * a field cannot end up with a label that points nowhere or an error message
 * that a screen reader never announces.
 */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext)
}

/** Shared aria wiring for every control that lives inside a Field. */
export function useFieldControlProps(explicitId?: string) {
  const context = useFieldContext()
  if (!context) {
    return { id: explicitId, hasError: false }
  }

  const describedBy = [context.descriptionId, context.errorId].filter(Boolean).join(' ')

  return {
    id: explicitId ?? context.controlId,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    'aria-invalid': context.hasError || undefined,
    'aria-required': context.isRequired || undefined,
    hasError: context.hasError,
  }
}
