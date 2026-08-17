import type { ReactNode } from 'react'

import { Button } from './Button'
import { Dialog, DialogContent } from './Dialog'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** What will happen, in plain terms — not a rhetorical "are you sure?". */
  description?: string
  children?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'primary' | 'danger'
  isPending?: boolean
  onConfirm: () => void
}

/**
 * Confirmation for an action that is hard to undo.
 *
 * The confirm button repeats the verb of the action ("Archive vehicle") rather
 * than saying "Confirm", so the last thing read before committing is what is
 * about to happen.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  isPending = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        {...(description ? { description } : {})}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              {cancelLabel}
            </Button>
            <Button variant={tone} onClick={onConfirm} isLoading={isPending}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}
