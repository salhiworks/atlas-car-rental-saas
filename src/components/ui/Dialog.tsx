import * as Primitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

/**
 * Modal surface built on Radix.
 *
 * Focus trapping, focus restoration, Escape handling, scroll locking and the
 * aria wiring are delegated — they are the parts of a dialog that are easy to
 * get subtly wrong and hard to notice, and only the appearance is ours.
 */
export const Dialog = Primitive.Root
export const DialogTrigger = Primitive.Trigger
export const DialogClose = Primitive.Close

export interface DialogContentProps {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  /** `lg` suits multi-column forms; `xl` the import preview table. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

const SIZES: Record<NonNullable<DialogContentProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-5xl',
}

export function DialogContent({
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
}: DialogContentProps) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-40 bg-[#16181a]/40 backdrop-blur-[2px]" />
      <Primitive.Content
        className={cn(
          'bg-surface border-line fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)]',
          '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border shadow-overlay',
          'overlay-enter outline-none',
          SIZES[size],
          className,
        )}
        aria-describedby={description ? undefined : undefined}
      >
        <div className="border-line flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0 space-y-1">
            <Primitive.Title className="text-[0.9375rem] leading-5 font-semibold">
              {title}
            </Primitive.Title>
            {description ? (
              <Primitive.Description className="text-ink-muted text-[0.8125rem] leading-5">
                {description}
              </Primitive.Description>
            ) : null}
          </div>
          <Primitive.Close
            className="text-ink-subtle hover:bg-surface-inset hover:text-ink -me-1.5 -mt-1 shrink-0 rounded-md p-1.5 transition-colors"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </Primitive.Close>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="border-line bg-surface-muted flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
            {footer}
          </div>
        ) : null}
      </Primitive.Content>
    </Primitive.Portal>
  )
}
