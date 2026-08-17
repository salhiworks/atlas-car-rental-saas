import { Download, FileText, ImageIcon, Paperclip, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Select,
  useToast,
} from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { ExpenseAttachment, ExpenseDocumentKind } from '@/types/database'

import { useDeleteAttachment, useExpenseAttachments, useUploadReceipt } from '../queries'
import { signReceiptUrl } from '../storage'

export interface ReceiptPanelProps {
  expenseId: string
  canManage: boolean
  locale: string
  timeZone: string
}

const KIND_LABELS: Readonly<Record<ExpenseDocumentKind, string>> = {
  receipt: 'Receipt',
  invoice: 'Invoice',
  supporting: 'Supporting document',
  other: 'Other',
}

/**
 * The paperwork behind a cost.
 *
 * The bucket is private and no URL is minted until somebody actually opens a
 * document — a list of signed URLs for every row would hand out access nobody
 * asked for and expire while the page was still open.
 *
 * Deleting is offered because a receipt attached to the wrong cost is a filing
 * mistake rather than a financial one. The cost itself is corrected by editing
 * or voiding, never by removing its evidence.
 */
export function ReceiptPanel({ expenseId, canManage, locale, timeZone }: ReceiptPanelProps) {
  const toast = useToast()
  const attachmentsQuery = useExpenseAttachments(expenseId)
  const upload = useUploadReceipt(expenseId)
  const remove = useDeleteAttachment()

  const inputRef = useRef<HTMLInputElement | null>(null)
  const [kind, setKind] = useState<ExpenseDocumentKind>('receipt')
  const [opening, setOpening] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ExpenseAttachment | null>(null)

  const attachments = attachmentsQuery.data ?? []

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return

    for (const file of Array.from(files)) {
      try {
        await upload.mutateAsync({ file, kind })
      } catch (error) {
        toast.error('Could not attach that file', toErrorMessage(error))
        break
      }
    }

    if (inputRef.current) inputRef.current.value = ''
  }

  /** A short-lived link, requested at the moment it is needed and not before. */
  const open = async (attachment: ExpenseAttachment) => {
    setOpening(attachment.id)
    try {
      const url = await signReceiptUrl(attachment.storage_path)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      toast.error('Could not open that document', toErrorMessage(error))
    } finally {
      setOpening(null)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Receipts and invoices"
        description="Private. Opened through a short-lived link, never a public address."
        actions={
          canManage ? (
            <div className="flex items-center gap-2">
              <div className="w-40">
                <Select
                  aria-label="Document type"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as ExpenseDocumentKind)}
                  options={(Object.keys(KIND_LABELS) as ExpenseDocumentKind[]).map((value) => ({
                    value,
                    label: KIND_LABELS[value],
                  }))}
                />
              </div>
              <Button
                variant="secondary"
                leadingIcon={<Upload />}
                onClick={() => inputRef.current?.click()}
                isLoading={upload.isPending}
              >
                Attach
              </Button>
            </div>
          ) : null
        }
      />

      <CardBody>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          multiple
          className="sr-only"
          onChange={(event) => void onFiles(event.target.files)}
        />

        {attachments.length === 0 ? (
          <EmptyState
            icon={Paperclip}
            size="sm"
            title="No documents attached"
            description={
              canManage
                ? 'Attach the receipt or invoice as a PDF or a photograph.'
                : 'Nothing has been attached to this cost.'
            }
          />
        ) : (
          <ul className="divide-line divide-y">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="flex items-center gap-3 py-2.5">
                <span
                  className="bg-surface-inset text-ink-subtle flex size-8 shrink-0 items-center justify-center rounded"
                  aria-hidden="true"
                >
                  {attachment.content_type === 'application/pdf' ? (
                    <FileText className="size-4" />
                  ) : (
                    <ImageIcon className="size-4" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="text-ink block truncate text-[0.8125rem] font-medium">
                    {attachment.file_name}
                  </span>
                  <span className="text-ink-subtle block truncate text-[0.6875rem]">
                    {KIND_LABELS[attachment.kind]} ·{' '}
                    {Math.max(1, Math.round(attachment.byte_size / 1024))} kB ·{' '}
                    {formatDateTime(new Date(attachment.uploaded_at), { locale, timeZone })}
                  </span>
                </span>

                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Download />}
                  onClick={() => void open(attachment)}
                  isLoading={opening === attachment.id}
                >
                  Open
                </Button>

                {canManage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${attachment.file_name}`}
                    onClick={() => setPendingDelete(attachment)}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}
        title="Remove this document"
        description="The cost itself is unaffected. To correct the cost, edit or void it instead."
        confirmLabel="Remove document"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          void remove
            .mutateAsync(pendingDelete)
            .then(() => {
              toast.success('Document removed', pendingDelete.file_name)
              setPendingDelete(null)
            })
            .catch((error: unknown) => {
              toast.error('Could not remove that document', toErrorMessage(error))
            })
        }}
      />
    </Card>
  )
}
