import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, Paperclip, Plus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  Alert,
  Button,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui'
import {
  COMPLIANCE_LABELS,
  describeCompliance,
  evaluateCompliance,
  type ComplianceOptions,
} from '@/lib/compliance/expiry'
import { formatDate, parseIsoDate } from '@/lib/datetime/format'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { VehicleDocument, VehicleDocumentType } from '@/types/database'

import { createVehicleDocument } from '../api'
import {
  DOCUMENT_BUCKET,
  removeVehicleDocument,
  signMediaUrl,
  uploadVehicleDocumentFile,
} from '../media'
import { useVehicleDocuments, vehicleKeys } from '../queries'
import { ComplianceBadge } from './VehicleStatusBadge'

const DOCUMENT_TYPES: { value: VehicleDocumentType; label: string }[] = [
  { value: 'insurance', label: 'Insurance' },
  { value: 'registration', label: 'Registration' },
  { value: 'technical_inspection', label: 'Technical inspection' },
  { value: 'road_tax', label: 'Road tax' },
  { value: 'permit', label: 'Permit' },
  { value: 'purchase_invoice', label: 'Purchase invoice' },
  { value: 'lease_agreement', label: 'Lease agreement' },
  { value: 'other', label: 'Other' },
]

const TYPE_LABELS = Object.fromEntries(
  DOCUMENT_TYPES.map((type) => [type.value, type.label]),
) as Record<VehicleDocumentType, string>

export interface VehicleDocumentsProps {
  organizationId: string
  vehicleId: string
  canEdit: boolean
  compliance: ComplianceOptions
  locale: string
}

/**
 * Paperwork attached to a vehicle.
 *
 * Expiry is evaluated with the same shared rule the compliance panel uses, so a
 * document marked "Expiring soon" here and there means the identical thing.
 * Files are optional: agencies commonly record a renewal date long before the
 * certificate itself is scanned.
 */
export function VehicleDocuments({
  organizationId,
  vehicleId,
  canEdit,
  compliance,
  locale,
}: VehicleDocumentsProps) {
  const toast = useToast()
  const client = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isAdding, setIsAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<VehicleDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attachTo, setAttachTo] = useState<VehicleDocument | null>(null)

  const documentsQuery = useVehicleDocuments(vehicleId)
  const documents = documentsQuery.data ?? []

  const invalidate = () =>
    client.invalidateQueries({ queryKey: vehicleKeys.documents(organizationId, vehicleId) })

  const create = useMutation({
    mutationFn: (input: {
      documentType: VehicleDocumentType
      documentNumber: string
      issuer: string
      issuedOn: string
      expiresOn: string
      notes: string
    }) =>
      createVehicleDocument({
        organization_id: organizationId,
        vehicle_id: vehicleId,
        document_type: input.documentType,
        document_number: input.documentNumber.trim() || null,
        issuer: input.issuer.trim() || null,
        issued_on: input.issuedOn || null,
        expires_on: input.expiresOn || null,
        notes: input.notes.trim() || null,
      }),
    onSuccess: async () => {
      await invalidate()
      setIsAdding(false)
      toast.success('Document added')
    },
    onError: (cause: unknown) => setError(toErrorMessage(cause)),
  })

  const attach = useMutation({
    mutationFn: ({ document, file }: { document: VehicleDocument; file: File }) =>
      uploadVehicleDocumentFile({
        organizationId,
        vehicleId,
        documentId: document.id,
        file,
      }),
    onSuccess: async () => {
      await invalidate()
      toast.success('File attached')
    },
    onError: (cause: unknown) => setError(toErrorMessage(cause)),
  })

  const remove = useMutation({
    mutationFn: (document: VehicleDocument) =>
      removeVehicleDocument(document.id, document.file_path),
    onSuccess: async () => {
      await invalidate()
      setPendingDelete(null)
      toast.success('Document deleted')
    },
    onError: (cause: unknown) => {
      setPendingDelete(null)
      setError(toErrorMessage(cause))
    },
  })

  const openFile = async (document: VehicleDocument) => {
    if (!document.file_path) return
    try {
      // Signed on demand and opened directly — the file is never given a
      // permanent URL that could be forwarded or indexed.
      const url = await signMediaUrl(DOCUMENT_BUCKET, document.file_path, 120)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setError(toErrorMessage(cause))
    }
  }

  return (
    <>
      <CardHeader
        title="Documents"
        description="Insurance, registration, inspection and anything else this vehicle carries."
        actions={
          canEdit ? (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Plus />}
              onClick={() => setIsAdding(true)}
            >
              Add document
            </Button>
          ) : null
        }
      />

      <CardBody className="p-0">
        {error ? (
          <Alert tone="critical" className="m-5 mb-0">
            {error}
          </Alert>
        ) : null}

        {documentsQuery.isPending ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : documents.length === 0 ? (
          <EmptyState
            size="sm"
            icon={FileText}
            title="No documents recorded"
            description={
              canEdit
                ? 'Record a renewal date now and attach the certificate whenever you have it.'
                : 'No documents have been recorded for this vehicle.'
            }
            action={
              canEdit ? (
                <Button size="sm" variant="secondary" onClick={() => setIsAdding(true)}>
                  Add document
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-line divide-y">
            {documents.map((document) => {
              const status = evaluateCompliance(document.expires_on, compliance)
              const expiry = document.expires_on
                ? parseIsoDate(document.expires_on, compliance.timeZone)
                : null

              return (
                <li key={document.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-ink text-[0.8125rem] font-medium">
                      {TYPE_LABELS[document.document_type]}
                      {document.document_number ? (
                        <span className="identifier text-ink-muted ms-2">
                          {document.document_number}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                      {expiry
                        ? `${describeCompliance(status)} · ${formatDate(expiry, { locale, timeZone: compliance.timeZone })}`
                        : COMPLIANCE_LABELS.unrecorded}
                      {document.issuer ? ` · ${document.issuer}` : ''}
                    </p>
                  </div>

                  <ComplianceBadge state={status.state} />

                  <div className="flex items-center gap-1">
                    {document.file_path ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        leadingIcon={<Download />}
                        onClick={() => void openFile(document)}
                      >
                        Open
                      </Button>
                    ) : canEdit ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        leadingIcon={<Paperclip />}
                        isLoading={attach.isPending && attachTo?.id === document.id}
                        onClick={() => {
                          setAttachTo(document)
                          fileInputRef.current?.click()
                        }}
                      >
                        Attach
                      </Button>
                    ) : null}

                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => setPendingDelete(document)}
                        className="text-ink-subtle hover:bg-critical-50 hover:text-critical-600 rounded-md p-1.5 transition-colors"
                        aria-label={`Delete ${TYPE_LABELS[document.document_type]} document`}
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file && attachTo) attach.mutate({ document: attachTo, file })
            event.target.value = ''
          }}
        />
      </CardBody>

      <AddDocumentDialog
        open={isAdding}
        onOpenChange={setIsAdding}
        isPending={create.isPending}
        onSubmit={(values) => create.mutate(values)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this document?"
        description="The record and any attached file are removed. This cannot be undone."
        confirmLabel="Delete document"
        isPending={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
      />
    </>
  )
}

interface AddDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isPending: boolean
  onSubmit: (values: {
    documentType: VehicleDocumentType
    documentNumber: string
    issuer: string
    issuedOn: string
    expiresOn: string
    notes: string
  }) => void
}

function AddDocumentDialog({ open, onOpenChange, isPending, onSubmit }: AddDocumentDialogProps) {
  const [documentType, setDocumentType] = useState<VehicleDocumentType>('insurance')
  const [documentNumber, setDocumentNumber] = useState('')
  const [issuer, setIssuer] = useState('')
  const [issuedOn, setIssuedOn] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [notes, setNotes] = useState('')
  const [dateError, setDateError] = useState<string | undefined>(undefined)

  const submit = () => {
    if (issuedOn && expiresOn && expiresOn < issuedOn) {
      setDateError('The expiry date must be on or after the issue date.')
      return
    }
    setDateError(undefined)
    onSubmit({ documentType, documentNumber, issuer, issuedOn, expiresOn, notes })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add a document"
        description="Record the renewal date now; the file can be attached later."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} isLoading={isPending}>
              Add document
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Type" required>
            <Select
              options={DOCUMENT_TYPES}
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value as VehicleDocumentType)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reference or policy number">
              <Input
                value={documentNumber}
                onChange={(event) => setDocumentNumber(event.target.value)}
                className="identifier"
              />
            </Field>

            <Field label="Issued by">
              <Input value={issuer} onChange={(event) => setIssuer(event.target.value)} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Issued on">
              <Input
                type="date"
                value={issuedOn}
                onChange={(event) => setIssuedOn(event.target.value)}
              />
            </Field>

            <Field label="Expires on" error={dateError}>
              <Input
                type="date"
                value={expiresOn}
                onChange={(event) => setExpiresOn(event.target.value)}
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
