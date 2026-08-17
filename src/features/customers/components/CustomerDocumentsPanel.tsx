import { zodResolver } from '@hookform/resolvers/zod'
import { Download, FileText, IdCard, Paperclip, Plus, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'

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
  type ComplianceOptions,
  describeCompliance,
  evaluateCompliance,
} from '@/lib/compliance/expiry'
import { formatDate, parseIsoDate } from '@/lib/datetime/format'
import { getCountryName, listCountries } from '@/lib/i18n/regions'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { CustomerDocument } from '@/types/database'

import { DOCUMENT_TYPE_LABELS, DOCUMENT_TYPE_OPTIONS } from '../identity'
import { DOCUMENT_MIME_TYPES, signDocumentUrl } from '../documents'
import {
  useCreateCustomerDocument,
  useCustomerDocuments,
  useDeleteCustomerDocument,
  useUploadDocumentFile,
} from '../queries'
import {
  customerDocumentSchema,
  emptyDocumentForm,
  type CustomerDocumentFormInput,
  type CustomerDocumentFormValues,
} from '../schemas'
import { DocumentStateBadge } from './CustomerBadges'
import { SensitiveValue } from './SensitiveValue'

export interface CustomerDocumentsPanelProps {
  organizationId: string
  customerId: string
  compliance: ComplianceOptions
  locale: string
  canEdit: boolean
  canDelete: boolean
}

/**
 * Identification held for a customer.
 *
 * Passports, national IDs, residence permits and driving licences share one list
 * because they answer the same questions — who issued it, when does it expire,
 * where is the scan. What differs is only which of them a given country expects,
 * and that is a labelling question, not a schema one.
 *
 * Numbers are masked by default and revealed on request; see SensitiveValue.
 */
export function CustomerDocumentsPanel({
  organizationId,
  customerId,
  compliance,
  locale,
  canEdit,
  canDelete,
}: CustomerDocumentsPanelProps) {
  const toast = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isAdding, setIsAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<CustomerDocument | null>(null)
  const [attachTo, setAttachTo] = useState<CustomerDocument | null>(null)
  const [error, setError] = useState<string | null>(null)

  const documentsQuery = useCustomerDocuments(customerId)
  const documents = documentsQuery.data ?? []

  const create = useCreateCustomerDocument(customerId)
  const upload = useUploadDocumentFile(customerId)
  const remove = useDeleteCustomerDocument()

  const openFile = async (document: CustomerDocument) => {
    if (!document.file_path) return
    try {
      // Signed at the moment of asking and short-lived, so a forwarded link dies
      // quickly and no identification document ever has a durable URL.
      const url = await signDocumentUrl(document.file_path)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setError(toErrorMessage(cause))
    }
  }

  const licences = documents.filter((entry) => entry.document_type === 'driver_license')
  const identity = documents.filter((entry) => entry.document_type !== 'driver_license')

  return (
    <>
      <CardHeader
        title="Identification"
        description="Passports, national IDs, residence permits and driving licences."
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
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full" />
            ))}
          </div>
        ) : documents.length === 0 ? (
          <EmptyState
            size="sm"
            icon={IdCard}
            title="No identification recorded"
            description={
              canEdit
                ? 'Record a passport, national ID or driving licence. A scan can be attached now or later.'
                : 'No identification has been recorded for this customer.'
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
          <div className="divide-line divide-y">
            {[
              { label: 'Driving licence', entries: licences },
              { label: 'Identity documents', entries: identity },
            ]
              .filter((group) => group.entries.length > 0)
              .map((group) => (
                <section key={group.label}>
                  <p className="eyebrow bg-surface-muted px-5 py-2">{group.label}</p>
                  <ul className="divide-line divide-y">
                    {group.entries.map((document) => {
                      const status = evaluateCompliance(document.expires_on, compliance)
                      const expiry = document.expires_on
                        ? parseIsoDate(document.expires_on, compliance.timeZone)
                        : null

                      return (
                        <li key={document.id} className="px-5 py-3.5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 space-y-1">
                              <p className="text-ink text-[0.8125rem] font-medium">
                                {DOCUMENT_TYPE_LABELS[document.document_type]}
                                {document.issuing_country ? (
                                  <span className="text-ink-muted ms-2 font-normal">
                                    {getCountryName(document.issuing_country, locale)}
                                  </span>
                                ) : null}
                              </p>

                              <SensitiveValue
                                value={document.document_number}
                                label={`${DOCUMENT_TYPE_LABELS[document.document_type].toLowerCase()} number`}
                              />

                              <p className="text-ink-subtle text-[0.75rem]">
                                {expiry
                                  ? `${describeCompliance(status)} · ${formatDate(expiry, { locale, timeZone: compliance.timeZone })}`
                                  : 'No expiry recorded'}
                                {document.license_classes?.length
                                  ? ` · Classes ${document.license_classes.join(', ')}`
                                  : ''}
                              </p>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                              <DocumentStateBadge state={status.state} />

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
                                  isLoading={upload.isPending && attachTo?.id === document.id}
                                  onClick={() => {
                                    setAttachTo(document)
                                    fileInputRef.current?.click()
                                  }}
                                >
                                  Attach scan
                                </Button>
                              ) : null}

                              {canEdit && document.file_path ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  leadingIcon={<Upload />}
                                  onClick={() => {
                                    setAttachTo(document)
                                    fileInputRef.current?.click()
                                  }}
                                >
                                  Replace
                                </Button>
                              ) : null}

                              {canDelete ? (
                                <button
                                  type="button"
                                  onClick={() => setPendingDelete(document)}
                                  className="text-ink-subtle hover:bg-critical-50 hover:text-critical-600 rounded-md p-1.5 transition-colors"
                                  aria-label={`Delete this ${DOCUMENT_TYPE_LABELS[document.document_type].toLowerCase()}`}
                                >
                                  <Trash2 className="size-3.5" aria-hidden="true" />
                                </button>
                              ) : null}
                            </div>
                          </div>

                          {document.file_name ? (
                            <p className="text-ink-subtle mt-1.5 flex items-center gap-1.5 text-[0.6875rem]">
                              <FileText className="size-3" aria-hidden="true" />
                              {document.file_name}
                              {document.uploaded_at
                                ? ` · added ${formatDate(new Date(document.uploaded_at), { locale, timeZone: compliance.timeZone })}`
                                : ''}
                            </p>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={DOCUMENT_MIME_TYPES.join(',')}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file && attachTo) {
              setError(null)
              upload.mutate(
                { document: attachTo, file },
                {
                  onSuccess: () => toast.success('Scan attached'),
                  onError: (cause) => setError(toErrorMessage(cause)),
                },
              )
            }
            event.target.value = ''
          }}
        />
      </CardBody>

      <AddDocumentDialog
        open={isAdding}
        onOpenChange={setIsAdding}
        organizationId={organizationId}
        isPending={create.isPending}
        onSubmit={(values) =>
          create.mutate(values, {
            onSuccess: () => {
              setIsAdding(false)
              toast.success('Document recorded')
            },
            onError: (cause) => setError(toErrorMessage(cause)),
          })
        }
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this document?"
        description="The record and any attached scan are removed. This cannot be undone."
        confirmLabel="Delete document"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!pendingDelete) return
          remove.mutate(pendingDelete, {
            onSuccess: () => {
              setPendingDelete(null)
              toast.success('Document deleted')
            },
            onError: (cause) => {
              setPendingDelete(null)
              setError(toErrorMessage(cause))
            },
          })
        }}
      />
    </>
  )
}

interface AddDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationId: string
  isPending: boolean
  onSubmit: (values: CustomerDocumentFormValues) => void
}

function AddDocumentDialog({ open, onOpenChange, isPending, onSubmit }: AddDocumentDialogProps) {
  const countries = listCountries()

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CustomerDocumentFormInput, unknown, CustomerDocumentFormValues>({
    resolver: zodResolver(customerDocumentSchema),
    defaultValues: emptyDocumentForm(),
  })

  const documentType = useWatch({ control, name: 'documentType' })
  const isLicence = documentType === 'driver_license'

  const submit = handleSubmit((values) => onSubmit(values))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset(emptyDocumentForm())
      }}
    >
      <DialogContent
        title="Record identification"
        description="The number is stored as presented and shown masked. A scan can be attached afterwards."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} isLoading={isPending}>
              Add document
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Document type" required>
              <Select options={DOCUMENT_TYPE_OPTIONS} {...register('documentType')} />
            </Field>

            <Field label="Issuing country" error={errors.issuingCountry?.message}>
              <Select
                options={[{ value: '', label: 'Not recorded' }, ...countries]}
                {...register('issuingCountry')}
              />
            </Field>
          </div>

          <Field label="Document number" error={errors.documentNumber?.message} required>
            <Input
              autoComplete="off"
              spellCheck={false}
              className="identifier"
              {...register('documentNumber')}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Issued on" error={errors.issuedOn?.message}>
              <Input type="date" {...register('issuedOn')} />
            </Field>

            <Field label="Expires on" error={errors.expiresOn?.message}>
              <Input type="date" {...register('expiresOn')} />
            </Field>
          </div>

          {isLicence ? (
            <Field
              label="Vehicle classes"
              error={errors.licenseClasses?.message}
              hint="Comma separated, as printed on the licence — B, C1, D."
            >
              <Input placeholder="B, C1" {...register('licenseClasses')} />
            </Field>
          ) : null}

          <Field label="Notes" error={errors.notes?.message}>
            <Textarea rows={2} {...register('notes')} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
