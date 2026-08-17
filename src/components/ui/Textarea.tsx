import { type TextareaHTMLAttributes, forwardRef } from 'react'

import { cn } from '@/lib/utils/cn'

import { controlBaseClasses, controlStateClasses } from './control-styles'
import { useFieldControlProps } from './field-context'

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, id, rows = 4, ...props }, ref) {
  const { hasError, ...aria } = useFieldControlProps(id)

  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        controlBaseClasses,
        controlStateClasses(hasError),
        'resize-y px-3 py-2 leading-6',
        className,
      )}
      {...aria}
      {...props}
    />
  )
})
