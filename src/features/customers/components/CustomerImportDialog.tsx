import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Alert, Badge, Button, Dialog, DialogContent, Select, useToast } from '@/components/ui'
import { useOrganization } from '@/features/workspace/workspace-context'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'

import { createCustomer, createCustomerDocument, fetchCustomers } from '../api'
import {
  CUSTOMER_IMPORT_FIELDS,
  type ColumnMapping,
  type CustomerImportFieldKey,
  type CustomerImportRow,
  type ParsedCsv,
  buildCustomerImportTemplate,
  guessCustomerColumnMapping,
  isImportable,
  parseCsv,
  validateCustomerImport,
} from '../csv'
import { documentNumberKey } from '../identity'
import { customerDocumentSchema } from '../schemas'
import { customerKeys } from '../queries'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useQueryClient } from '@tanstack/react-query'

type Step = 'choose' | 'map' | 'result'

export interface CustomerImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ImportOutcome {
  imported: number
  failed: { line: number; name: string; message: string }[]
}

const MAX_ROWS = 500

/**
 * Bulk customer import from a spreadsheet.
 *
 * Built on the same import core as Vehicles. Every row goes through the customer
 * schema the form uses, and every identifier through the same normalisation, so
 * a CSV cannot introduce a customer the form would have refused or a passport
 * that collides with one already on file.
 *
 * Partial success is a real outcome: importing 47 of 50 and naming the three
 * that failed by line number is more useful than refusing all fifty over one bad
 * date.
 */
export function CustomerImportDialog(props: CustomerImportDialogProps) {
  // Mounted only while open, so the existing-identifier lookup does not run on
  // every visit to the customers page for a dialog nobody opened.
  if (!props.open) return null
  return <ImportDialogContent {...props} />
}

function ImportDialogContent({ open, onOpenChange }: CustomerImportDialogProps) {
  const organization = useOrganization()
  const toast = useToast()
  const client = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('choose')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping<CustomerImportFieldKey>>({})
  const [existingKeys, setExistingKeys] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)

  const validation = useMemo(() => {
    if (!parsed) return null
    return validateCustomerImport(parsed, mapping, { existingDocumentKeys: existingKeys })
  }, [parsed, mapping, existingKeys])

  const reset = () => {
    setStep('choose')
    setParsed(null)
    setMapping({})
    setFileName('')
    setError(null)
    setOutcome(null)
  }

  const handleClose = (next: boolean) => {
    onOpenChange(next)
    if (!next) setTimeout(reset, 200)
  }

  /**
   * Reads the identifiers already on file so the preview can flag a collision
   * before the database refuses it. Only the normalised numbers are fetched.
   */
  const loadExistingKeys = async (): Promise<ReadonlySet<string>> => {
    const { data, error: loadError } = await getSupabaseClient()
      .from('customer_documents')
      .select('document_type, issuing_country, document_number_normalized')
      .eq('organization_id', organization.id)
      .limit(5000)

    if (loadError) throw loadError

    return new Set(
      (data ?? []).map(
        (row) =>
          `${row.document_type}:${row.issuing_country ?? '~~'}:${row.document_number_normalized}`,
      ),
    )
  }

  const handleFile = async (file: File) => {
    setError(null)

    if (file.size > 5 * 1024 * 1024) {
      setError('That file is larger than 5 MB. Split it and import each part in turn.')
      return
    }

    const text = await file.text()
    const result = parseCsv(text)

    if (result.headers.length === 0 || result.rows.length === 0) {
      setError('That file has no data rows. Check it was exported as CSV.')
      return
    }
    if (result.rows.length > MAX_ROWS) {
      setError(
        `That file has ${result.rows.length} rows. Import up to ${MAX_ROWS} at a time so a failure part-way through stays easy to unpick.`,
      )
      return
    }

    try {
      setExistingKeys(await loadExistingKeys())
    } catch (cause) {
      setError(toErrorMessage(cause))
      return
    }

    setFileName(file.name)
    setParsed(result)
    setMapping(guessCustomerColumnMapping(result.headers))
    setStep('map')
  }

  const runImport = useMutation({
    mutationFn: async (rows: CustomerImportRow[]): Promise<ImportOutcome> => {
      const result: ImportOutcome = { imported: 0, failed: [] }

      // Sequential on purpose: a parallel burst would race the identifier
      // uniqueness index against itself and make failures harder to attribute.
      for (const row of rows) {
        if (!row.values) continue

        try {
          const customer = await createCustomer(organization.id, row.values.customer)

          // Documents go through the same schema as one typed into the form,
          // so an imported passport is validated and normalised identically.
          for (const document of [
            row.values.identityDocument
              ? {
                  documentType: row.values.identityDocument.documentType,
                  documentNumber: row.values.identityDocument.documentNumber,
                  issuingCountry: row.values.identityDocument.issuingCountry ?? '',
                  issuedOn: '',
                  expiresOn: row.values.identityDocument.expiresOn ?? '',
                  licenseClasses: '',
                  notes: '',
                }
              : null,
            row.values.driverLicense
              ? {
                  documentType: 'driver_license' as const,
                  documentNumber: row.values.driverLicense.documentNumber,
                  issuingCountry: row.values.driverLicense.issuingCountry ?? '',
                  issuedOn: '',
                  expiresOn: row.values.driverLicense.expiresOn ?? '',
                  licenseClasses: '',
                  notes: '',
                }
              : null,
          ]) {
            if (!document) continue
            const parsed = customerDocumentSchema.safeParse(document)
            if (parsed.success) {
              await createCustomerDocument(organization.id, customer.id, parsed.data)
            }
          }

          result.imported += 1
        } catch (cause) {
          result.failed.push({
            line: row.line,
            name: row.identifier,
            message: toErrorMessage(cause),
          })
        }
      }

      return result
    },
    onSuccess: async (result) => {
      setOutcome(result)
      setStep('result')
      await client.invalidateQueries({ queryKey: customerKeys.all(organization.id) })
      if (result.imported > 0) {
        toast.success(
          `${result.imported} ${result.imported === 1 ? 'customer' : 'customers'} imported`,
          result.failed.length > 0 ? `${result.failed.length} could not be imported.` : undefined,
        )
      }
    },
    onError: (cause: unknown) => setError(toErrorMessage(cause)),
  })

  const downloadTemplate = () => {
    const blob = new Blob([buildCustomerImportTemplate()], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'customer-import-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const importable = validation?.rows.filter(isImportable) ?? []

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        title="Import customers"
        description="Bring an existing customer list in from a spreadsheet."
        size={step === 'map' ? 'xl' : 'lg'}
        footer={
          step === 'map' ? (
            <>
              <p className="text-ink-subtle me-auto text-[0.75rem]">
                {validation?.validCount ?? 0} ready · {validation?.errorCount ?? 0} with errors ·{' '}
                {validation?.duplicateCount ?? 0} duplicates
              </p>
              <Button variant="ghost" onClick={() => setStep('choose')}>
                Choose another file
              </Button>
              <Button
                variant="primary"
                isLoading={runImport.isPending}
                disabled={importable.length === 0}
                onClick={() => runImport.mutate(importable)}
              >
                Import {importable.length} {importable.length === 1 ? 'customer' : 'customers'}
              </Button>
            </>
          ) : step === 'result' ? (
            <Button variant="primary" onClick={() => handleClose(false)}>
              Done
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => handleClose(false)}>
              Cancel
            </Button>
          )
        }
      >
        {error ? (
          <Alert tone="critical" className="mb-4">
            {error}
          </Alert>
        ) : null}

        {step === 'choose' ? (
          <div className="space-y-4">
            <div className="border-line-strong rounded-lg border border-dashed p-8 text-center">
              <FileSpreadsheet className="text-ink-subtle mx-auto size-8" aria-hidden="true" />
              <p className="text-ink mt-3 text-[0.875rem] font-medium">Choose a CSV file</p>
              <p className="text-ink-muted mx-auto mt-1 max-w-sm text-[0.8125rem] leading-5">
                Column names do not have to match ours — you will line them up in the next step.
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void handleFile(file)
                  event.target.value = ''
                }}
              />

              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="primary"
                  leadingIcon={<Upload />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Select file
                </Button>
                <Button variant="secondary" leadingIcon={<Download />} onClick={downloadTemplate}>
                  Download template
                </Button>
              </div>
            </div>

            <p className="text-ink-subtle text-[0.75rem] leading-5">
              A name is required. Identity and licence numbers are optional, and are checked against
              the customers you already have — a repeated passport is reported rather than imported
              twice. Scans cannot be imported from a spreadsheet; attach them on each profile.
            </p>
          </div>
        ) : null}

        {step === 'map' && parsed && validation ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{fileName}</Badge>
              <span className="text-ink-subtle text-[0.75rem]">
                {parsed.rows.length} {parsed.rows.length === 1 ? 'row' : 'rows'}
              </span>
            </div>

            <section>
              <p className="eyebrow mb-2">Match your columns</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {CUSTOMER_IMPORT_FIELDS.map((field) => (
                  <label key={field.key} className="space-y-1.5">
                    <span className="text-ink block text-[0.8125rem] font-medium">
                      {field.label}
                    </span>
                    <Select
                      value={mapping[field.key] == null ? '' : String(mapping[field.key])}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [field.key]:
                            event.target.value === '' ? null : Number(event.target.value),
                        }))
                      }
                      options={[
                        { value: '', label: 'Not imported' },
                        ...parsed.headers.map((header, index) => ({
                          value: String(index),
                          label: header || `Column ${index + 1}`,
                        })),
                      ]}
                    />
                  </label>
                ))}
              </div>
            </section>

            <section>
              <p className="eyebrow mb-2">Preview</p>
              <div className="border-line max-h-72 overflow-auto rounded-lg border">
                <table className="w-full border-collapse text-[0.75rem]">
                  <thead className="bg-surface-muted sticky top-0">
                    <tr className="border-line border-b">
                      <th scope="col" className="eyebrow w-12 px-3 py-2 text-start">
                        Row
                      </th>
                      <th scope="col" className="eyebrow px-3 py-2 text-start">
                        Customer
                      </th>
                      <th scope="col" className="eyebrow px-3 py-2 text-start">
                        Identification
                      </th>
                      <th scope="col" className="eyebrow px-3 py-2 text-start">
                        Result
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-line divide-y">
                    {validation.rows.map((row) => {
                      const ok = isImportable(row)
                      const reason =
                        row.issues[0]?.message ??
                        (row.duplicateOfLine !== null
                          ? `Same document as row ${row.duplicateOfLine}`
                          : row.conflictsWithExisting
                            ? 'A customer with this document already exists'
                            : null)

                      // Masked even in the preview: the tail is enough to match
                      // a row against the file the person is holding.
                      const identification = row.values?.identityDocument
                        ? `•••• ${documentNumberKey(row.values.identityDocument.documentNumber).slice(-4)}`
                        : row.values?.driverLicense
                          ? `•••• ${documentNumberKey(row.values.driverLicense.documentNumber).slice(-4)}`
                          : '—'

                      return (
                        <tr key={row.line} className={cn(!ok && 'bg-critical-50/40')}>
                          <td data-numeric="" className="text-ink-subtle px-3 py-1.5">
                            {row.line}
                          </td>
                          <td className="text-ink px-3 py-1.5">{row.identifier}</td>
                          <td className="identifier px-3 py-1.5">{identification}</td>
                          <td className="px-3 py-1.5">
                            {ok ? (
                              <span className="text-positive-700 inline-flex items-center gap-1">
                                <CheckCircle2 className="size-3" aria-hidden="true" />
                                Ready
                              </span>
                            ) : (
                              <span className="text-critical-700 inline-flex items-center gap-1">
                                <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                                {reason}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : null}

        {step === 'result' && outcome ? (
          <div className="space-y-4">
            <Alert
              tone={outcome.failed.length === 0 ? 'positive' : 'caution'}
              title={
                outcome.failed.length === 0
                  ? `${outcome.imported} ${outcome.imported === 1 ? 'customer' : 'customers'} imported`
                  : `${outcome.imported} imported, ${outcome.failed.length} could not be`
              }
            >
              {outcome.failed.length === 0
                ? 'They are on file now and ready to put on a contract.'
                : 'Everything that could be imported has been. Fix the rows below and import them again.'}
            </Alert>

            {outcome.failed.length > 0 ? (
              <ul className="divide-line border-line divide-y rounded-lg border">
                {outcome.failed.map((failure) => (
                  <li key={failure.line} className="px-4 py-2.5 text-[0.8125rem]">
                    <span className="text-ink-subtle">Row {failure.line}</span> {failure.name}
                    <p className="text-critical-700 mt-0.5 text-[0.75rem]">{failure.message}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export { fetchCustomers }
