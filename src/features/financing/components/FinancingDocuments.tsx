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
import type { FinancingDocument, FinancingDocumentKind } from '@/types/database'

import { DOCUMENT_KIND_LABELS } from '../domain'
import {
  useDeleteFinancingDocument,
  useFinancingDocuments,
  useUploadFinancingDocument,
} from '../queries'
import { signFinancingDocumentUrl } from '../storage'

export interface FinancingDocumentsProps {
  agreementId: string
  canManage: boolean
  locale: string
  timeZone: string
}

const KINDS: readonly FinancingDocumentKind[] = [
  'agreement',
  'statement',
  'payoff_letter',
  'receipt',
  'other',
]

/**
 * The paperwork behind an agreement.
 *
 * The bucket is private and no URL is minted until somebody actually opens a
 * document — a list of signed URLs for every row would hand out access nobody
 * asked for and expire while the page was still open.
 */
export function FinancingDocuments({
  agreementId,
  canManage,
  locale,
  timeZone,
}: FinancingDocumentsProps) {
  const toast = useToast()
  const documentsQuery = useFinancingDocuments(agreementId)
  const upload = useUploadFinancingDocument(agreementId)
  const remove = useDeleteFinancingDocument()

  const inputRef = useRef<HTMLInputElement | null>(null)
  const [kind, setKind] = useState<FinancingDocumentKind>('agreement')
  const [opening, setOpening] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FinancingDocument | null>(null)

  const documents = documentsQuery.data ?? []

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
  const open = async (document: FinancingDocument) => {
    setOpening(document.id)
    try {
      const url = await signFinancingDocumentUrl(document.storage_path)
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
        title="Documents"
        description="Private. Opened through a short-lived link, never a public address."
        actions={
          canManage ? (
            <div className="flex items-center gap-2">
              <div className="w-44">
                <Select
                  aria-label="Document type"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as FinancingDocumentKind)}
                  options={KINDS.map((value) => ({
                    value,
                    label: DOCUMENT_KIND_LABELS[value],
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

        {documents.length === 0 ? (
          <EmptyState
            icon={Paperclip}
            size="sm"
            title="No documents attached"
            description={
              canManage
                ? 'Attach the signed agreement, a lender statement or a payoff letter.'
                : 'Nothing has been attached to this agreement.'
            }
          />
        ) : (
          <ul className="divide-line divide-y">
            {documents.map((document) => (
              <li key={document.id} className="flex items-center gap-3 py-2.5">
                <span
                  className="bg-surface-inset text-ink-subtle flex size-8 shrink-0 items-center justify-center rounded"
                  aria-hidden="true"
                >
                  {document.content_type === 'application/pdf' ? (
                    <FileText className="size-4" />
                  ) : (
                    <ImageIcon className="size-4" />
                  )}
                </span>

                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-ink block truncate text-[0.8125rem] font-medium">
                    {document.file_name}
                  </span>
                  <span className="text-ink-subtle block truncate text-[0.6875rem]">
                    {DOCUMENT_KIND_LABELS[document.kind]} ·{' '}
                    {Math.max(1, Math.round(document.byte_size / 1024))} kB ·{' '}
                    {formatDateTime(new Date(document.uploaded_at), { locale, timeZone })}
                  </span>
                </span>

                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Download />}
                  onClick={() => void open(document)}
                  isLoading={opening === document.id}
                >
                  Open
                </Button>

                {canManage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${document.file_name}`}
                    onClick={() => setPendingDelete(document)}
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
        description="The agreement and its payments are unaffected. Only the file goes."
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
