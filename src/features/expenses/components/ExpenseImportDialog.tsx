import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Alert, Badge, Button, Dialog, DialogContent, Select, useToast } from '@/components/ui'
import { useOrganization } from '@/features/workspace/workspace-context'
import { formatMoney } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'

import { createExpense } from '../api'
import {
  IMPORT_FIELDS,
  type ColumnMapping,
  type ExpenseImportRow,
  type ImportLookups,
  type ParsedCsv,
  buildImportTemplate,
  expenseDocumentKey,
  guessColumnMapping,
  isImportable,
  normaliseImportedDate,
  parseCsv,
  validateImportRows,
} from '../csv'
import {
  expenseKeys,
  useExpenseCategories,
  useExpenseList,
  useExpenseVendors,
  useRentalOptions,
  useVehicleOptions,
} from '../queries'

type Step = 'choose' | 'map' | 'result'

export interface ExpenseImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ImportOutcome {
  imported: number
  failed: { line: number; label: string; message: string }[]
}

const MAX_ROWS = 500

/** How far back the already-recorded check reaches. */
const DUPLICATE_WINDOW_PAGE_SIZE = 100

/**
 * Bringing a year of costs in from a spreadsheet.
 *
 * Two rules make this safe. The file is validated in the browser against the
 * *same* schema the form uses, so a spreadsheet is never a way around a
 * constraint. And every name in it — a category, a plate, a contract, a
 * supplier — is resolved against records that already exist; nothing is created
 * as a side effect of an import.
 *
 * Partial success is a real outcome. Importing 47 of 50 and naming the three
 * that failed is more use to an agency than refusing all fifty over one date.
 */
export function ExpenseImportDialog(props: ExpenseImportDialogProps) {
  // Mounted only while open: the lookups below are the whole fleet and the
  // whole supplier list, and nobody should pay for them to visit the ledger.
  if (!props.open) return null
  return <ImportDialogContent {...props} />
}

function ImportDialogContent({ open, onOpenChange }: ExpenseImportDialogProps) {
  const organization = useOrganization()
  const toast = useToast()
  const client = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('choose')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<ParsedCsv | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)

  const categoriesQuery = useExpenseCategories(true)
  const vendorsQuery = useExpenseVendors({ includeArchived: false })
  const vehiclesQuery = useVehicleOptions()
  const rentalsQuery = useRentalOptions()

  // The span the file covers, read from the column mapped as the date and
  // through the same reader the import uses. Scanning every cell for anything
  // date-shaped would let an invoice number widen the window.
  const span = useMemo(() => {
    if (!parsed) return null
    const column = mapping.incurredOn
    if (column == null) return null

    const dates = parsed.rows
      .map((row) => normaliseImportedDate((row[column] ?? '').trim()))
      .filter((value): value is string => value !== null)
      .sort()

    const first = dates[0]
    const last = dates[dates.length - 1]
    if (!first || !last) return null

    // Half-open, so the last day in the file is inside the window.
    const end = new Date(`${last}T00:00:00Z`)
    end.setUTCDate(end.getUTCDate() + 1)
    return { from: first, to: end.toISOString().slice(0, 10) }
  }, [parsed, mapping])

  const existingQuery = useExpenseList({
    ...(span ? { from: span.from, to: span.to } : {}),
    status: 'recorded',
    sort: 'date',
    pageSize: DUPLICATE_WINDOW_PAGE_SIZE,
  })

  const lookups: ImportLookups = useMemo(() => {
    const categoriesByName = new Map<string, string>()
    const archivedCategoryNames = new Set<string>()
    for (const category of categoriesQuery.data ?? []) {
      const key = category.name.trim().toUpperCase().replace(/\s+/g, ' ')
      if (category.archived_at) archivedCategoryNames.add(key)
      else categoriesByName.set(key, category.id)
    }

    const vehiclesByPlate = new Map<string, string>()
    for (const vehicle of vehiclesQuery.data ?? []) {
      vehiclesByPlate.set(
        vehicle.registration_plate.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        vehicle.id,
      )
    }

    const rentalsByReference = new Map<string, string>()
    for (const rental of rentalsQuery.data ?? []) {
      rentalsByReference.set(rental.reference.trim().toUpperCase().replace(/\s+/g, ' '), rental.id)
    }

    // Every match kept: two suppliers may legitimately share a name, and the
    // import refuses to choose between them rather than picking one.
    const vendorsByName = new Map<string, string[]>()
    for (const vendor of vendorsQuery.data ?? []) {
      const key = vendor.name.trim().toUpperCase().replace(/\s+/g, ' ')
      const bucket = vendorsByName.get(key)
      if (bucket) bucket.push(vendor.id)
      else vendorsByName.set(key, [vendor.id])
    }

    return {
      categoriesByName,
      archivedCategoryNames,
      vehiclesByPlate,
      rentalsByReference,
      vendorsByName,
    }
  }, [categoriesQuery.data, vehiclesQuery.data, rentalsQuery.data, vendorsQuery.data])

  const existingKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const expense of existingQuery.data?.rows ?? []) {
      const key = expenseDocumentKey(expense.vendor_name, expense.reference, expense.currency)
      if (key) keys.add(key)
    }
    return keys
  }, [existingQuery.data])

  const duplicateCheckIsPartial =
    (existingQuery.data?.total ?? 0) > (existingQuery.data?.rows.length ?? 0)

  const validation = useMemo(() => {
    if (!parsed) return null
    return validateImportRows(parsed, mapping, {
      defaultCurrency: organization.default_currency,
      lookups,
      existingKeys,
    })
  }, [parsed, mapping, organization.default_currency, lookups, existingKeys])

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

    setFileName(file.name)
    setParsed(result)
    setMapping(guessColumnMapping(result.headers))
    setStep('map')
  }

  const runImport = useMutation({
    mutationFn: async (rows: ExpenseImportRow[]): Promise<ImportOutcome> => {
      const result: ImportOutcome = { imported: 0, failed: [] }

      // Sequential on purpose: a parallel burst makes a failure impossible to
      // attribute to a row, which is the only thing that helps afterwards.
      for (const row of rows) {
        if (!row.values) continue
        try {
          await createExpense(organization.id, row.values)
          result.imported += 1
        } catch (cause) {
          result.failed.push({
            line: row.line,
            label: row.identifier,
            message: toErrorMessage(cause),
          })
        }
      }

      return result
    },
    onSuccess: async (result) => {
      setOutcome(result)
      setStep('result')
      await client.invalidateQueries({ queryKey: expenseKeys.all(organization.id) })
      await client.invalidateQueries({ queryKey: ['organization', organization.id, 'overview'] })
      await client.invalidateQueries({ queryKey: ['organization', organization.id, 'reports'] })
      if (result.imported > 0) {
        toast.success(
          `${result.imported} ${result.imported === 1 ? 'cost' : 'costs'} imported`,
          result.failed.length > 0 ? `${result.failed.length} could not be imported.` : undefined,
        )
      }
    },
    onError: (cause: unknown) => setError(toErrorMessage(cause)),
  })

  const downloadTemplate = () => {
    const blob = new Blob([buildImportTemplate(organization.default_currency)], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'expenses-import-template.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const importable = validation?.rows.filter(isImportable) ?? []
  const lookupsLoading =
    categoriesQuery.isPending ||
    vendorsQuery.isPending ||
    vehiclesQuery.isPending ||
    rentalsQuery.isPending

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        title="Import costs"
        description="Bring a period of spending in from a spreadsheet."
        size={step === 'map' ? 'xl' : 'lg'}
        footer={
          step === 'map' ? (
            <>
              <p className="text-ink-subtle me-auto text-[0.75rem]">
                {validation?.validCount ?? 0} ready · {validation?.errorCount ?? 0} with errors ·{' '}
                {validation?.duplicateCount ?? 0} already recorded
              </p>
              <Button variant="ghost" onClick={() => setStep('choose')}>
                Choose another file
              </Button>
              <Button
                variant="primary"
                isLoading={runImport.isPending}
                disabled={importable.length === 0 || lookupsLoading}
                onClick={() => runImport.mutate(importable)}
              >
                Import {importable.length} {importable.length === 1 ? 'cost' : 'costs'}
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
              A date, a description, an amount and a category are required. Categories, suppliers,
              plates and contract references have to already exist — nothing is created by an
              import. The amount is the gross paid, tax included.
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

            {duplicateCheckIsPartial ? (
              <Alert tone="info" title="Duplicate checking is partial">
                This period already holds {existingQuery.data?.total} costs, and the most recent{' '}
                {DUPLICATE_WINDOW_PAGE_SIZE} were checked against your file. Rows past that are
                imported without an already-recorded warning.
              </Alert>
            ) : null}

            <section>
              <p className="eyebrow mb-2">Match your columns</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {IMPORT_FIELDS.map((field) => (
                  <label key={field.key} className="space-y-1.5">
                    <span className="text-ink block text-[0.8125rem] font-medium">
                      {field.label}
                      {field.required ? (
                        <span className="text-critical-600 ms-0.5" aria-hidden="true">
                          *
                        </span>
                      ) : null}
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
                        Cost
                      </th>
                      <th scope="col" className="eyebrow px-3 py-2 text-end">
                        Amount
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
                          ? `Same supplier and invoice number as row ${row.duplicateOfLine}`
                          : row.conflictsWithExisting
                            ? 'This invoice number is already recorded against this supplier'
                            : null)

                      return (
                        <tr key={row.line} className={cn(!ok && 'bg-critical-50/40')}>
                          <td data-numeric="" className="text-ink-subtle px-3 py-1.5">
                            {row.line}
                          </td>
                          <td className="text-ink max-w-[16rem] truncate px-3 py-1.5">
                            {row.identifier}
                            {row.values ? (
                              <span className="text-ink-subtle block text-[0.6875rem]">
                                {row.values.incurredOn}
                              </span>
                            ) : null}
                          </td>
                          <td data-numeric="" className="px-3 py-1.5 text-end">
                            {row.values
                              ? formatMoney(row.values.amount, row.values.currency, {
                                  locale: organization.locale,
                                })
                              : '—'}
                          </td>
                          <td className="px-3 py-1.5">
                            {ok ? (
                              <span className="text-positive-700 inline-flex items-center gap-1">
                                <CheckCircle2 className="size-3" aria-hidden="true" />
                                Ready
                              </span>
                            ) : (
                              <span className="text-critical-700 inline-flex items-start gap-1">
                                <AlertTriangle
                                  className="mt-0.5 size-3 shrink-0"
                                  aria-hidden="true"
                                />
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
                  ? `${outcome.imported} ${outcome.imported === 1 ? 'cost' : 'costs'} imported`
                  : `${outcome.imported} imported, ${outcome.failed.length} could not be`
              }
            >
              {outcome.failed.length === 0
                ? 'They count towards the period from now on, and towards the vehicles they belong to.'
                : 'Everything that could be imported has been. Fix the rows below in your file and import them again.'}
            </Alert>

            {outcome.failed.length > 0 ? (
              <ul className="divide-line border-line divide-y rounded-lg border">
                {outcome.failed.map((failure) => (
                  <li key={failure.line} className="px-4 py-2.5 text-[0.8125rem]">
                    <span className="text-ink-subtle">Row {failure.line}</span> {failure.label}
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
