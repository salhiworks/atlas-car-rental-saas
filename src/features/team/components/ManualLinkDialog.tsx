import { Check, Copy, KeyRound } from 'lucide-react'
import { useState } from 'react'

import { Alert, Button, Dialog, DialogContent } from '@/components/ui'

/**
 * The one-time invitation link, when no email carried it.
 *
 * This is the only place in the product that displays a raw invitation token, and
 * it exists because the alternative is worse: an invitation that was created,
 * could not be emailed, and leaves the administrator with no way to deliver it.
 *
 * Shown once. It lives in component state for as long as the dialog is open and
 * is written nowhere else — not to storage, not to a toast, not to a query cache,
 * not to a log. Issuing another link rotates this one out of existence, which the
 * copy says, because an administrator who keeps an old link in a chat thread and
 * wonders why it stopped working has been failed by the interface, not by the
 * rotation.
 */

export interface ManualLinkDialogProps {
  /** Null closes the dialog. */
  link: string | null
  roleLabel: string
  email: string | null
  detail: string | null
  onClose: () => void
}

export function ManualLinkDialog({
  link,
  roleLabel,
  email,
  detail,
  onClose,
}: ManualLinkDialogProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      // Clipboard access can be refused. The link is on screen and selectable.
      setCopied(false)
    }
  }

  return (
    <Dialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false)
          onClose()
        }
      }}
    >
      <DialogContent
        title="Send this link yourself"
        description="The invitation is valid. No email was sent."
        size="md"
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="space-y-4">
          <Alert tone="caution" title="Treat this link like a password">
            Anyone who opens it joins this agency as {roleLabel}
            {email ? ` under ${email}` : ''}. Send it to that person directly and nowhere else. It
            is shown once — closing this dialog is the last you will see of it, and issuing another
            link replaces this one.
          </Alert>

          {detail ? <p className="text-ink-muted text-[0.8125rem] leading-5">{detail}</p> : null}

          <div className="border-line bg-surface-inset flex items-start gap-2 rounded-md border p-3">
            <KeyRound className="text-ink-subtle mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <code className="min-w-0 flex-1 text-[0.75rem] leading-5 break-all">{link}</code>
          </div>

          <Button variant="secondary" onClick={() => void copy()} fullWidth>
            {copied ? (
              <>
                <Check className="size-4" aria-hidden="true" /> Copied
              </>
            ) : (
              <>
                <Copy className="size-4" aria-hidden="true" /> Copy link
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
