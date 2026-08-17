import { Archive, ArchiveRestore, Pencil, Plus, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'
import type { Lender } from '@/types/database'

import { LENDER_KINDS, LENDER_KIND_LABELS } from '../domain'
import {
  useCreateLender,
  useDuplicateLenders,
  useLenders,
  useSetLenderArchived,
  useUpdateLender,
} from '../queries'
import { emptyLenderForm, lenderSchema, type LenderFormInput } from '../schemas'

export interface LenderManagerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  canManage: boolean
}

/**
 * Who the agency borrows from.
 *
 * A dialog rather than a sidebar entry: a lender exists to be chosen while
 * recording an agreement, and a section of its own would suggest a workspace
 * nobody needs.
 *
 * Two lenders may share a name — two branches, two companies trading alike —
 * so a repeated name produces a warning and never a refusal. A tax identifier
 * genuinely identifies a legal entity, so that one is unique and the database
 * says so. Nothing is ever merged automatically.
 */
export function LenderManager({ open, onOpenChange, canManage }: LenderManagerProps) {
  if (!open) return null
  return <LenderManagerContent open={open} onOpenChange={onOpenChange} canManage={canManage} />
}

function LenderManagerContent({ open, onOpenChange, canManage }: LenderManagerProps) {
  const toast = useToast()
  const lendersQuery = useLenders({ includeArchived: true })
  const create = useCreateLender()
  const update = useUpdateLender()
  const setArchived = useSetLenderArchived()

  const [editing, setEditing] = useState<Lender | null>(null)
  const [values, setValues] = useState<LenderFormInput | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const duplicates = useDuplicateLenders(
    values?.name ?? '',
    values?.taxIdentifier ?? '',
    values !== null,
  )
  const warnings = (duplicates.data ?? []).filter((row) => row.lender_id !== editing?.id)

  const lenders = lendersQuery.data ?? []
  const active = lenders.filter((lender) => lender.archived_at === null)
  const retired = lenders.filter((lender) => lender.archived_at !== null)

  const startNew = () => {
    setEditing(null)
    setValues(emptyLenderForm())
    setErrors({})
  }

  const startEdit = (lender: Lender) => {
    setEditing(lender)
    setErrors({})
    setValues({
      name: lender.name,
      kind: lender.kind,
      email: lender.email ?? '',
      phone: lender.phone ?? '',
      taxIdentifier: lender.tax_identifier ?? '',
      accountReference: lender.account_reference ?? '',
      address: lender.address ?? '',
      notes: lender.notes ?? '',
    })
  }

  const save = async () => {
    if (!values) return
    const parsed = lenderSchema.safeParse(values)

    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form')
        next[key] ??= issue.message
      }
      setErrors(next)
      return
    }

    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, values: parsed.data })
        toast.success('Lender updated')
      } else {
        await create.mutateAsync(parsed.data)
        toast.success('Lender added')
      }
      setValues(null)
      setEditing(null)
    } catch (failure) {
      setErrors({ form: toErrorMessage(failure) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Lenders"
        description="Banks, leasing companies and anyone else the agency borrows from."
        size="lg"
        footer={
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        }
      >
        {values ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-ink text-[0.875rem] font-medium">
                {editing ? `Edit ${editing.name}` : 'Add a lender'}
              </p>
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<X />}
                onClick={() => {
                  setValues(null)
                  setEditing(null)
                }}
              >
                Cancel
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required {...(errors.name ? { error: errors.name } : {})}>
                <Input
                  value={values.name}
                  maxLength={160}
                  onChange={(event) => setValues({ ...values, name: event.target.value })}
                  placeholder="Banque Populaire"
                />
              </Field>

              <Field label="Kind">
                <Select
                  value={values.kind}
                  onChange={(event) =>
                    setValues({ ...values, kind: event.target.value as LenderFormInput['kind'] })
                  }
                  options={LENDER_KINDS.map((kind) => ({
                    value: kind,
                    label: LENDER_KIND_LABELS[kind],
                  }))}
                />
              </Field>

              <Field label="Email" {...(errors.email ? { error: errors.email } : {})}>
                <Input
                  value={values.email ?? ''}
                  onChange={(event) => setValues({ ...values, email: event.target.value })}
                />
              </Field>

              <Field label="Phone" {...(errors.phone ? { error: errors.phone } : {})}>
                <Input
                  value={values.phone ?? ''}
                  onChange={(event) => setValues({ ...values, phone: event.target.value })}
                />
              </Field>

              <Field
                label="Business or tax identifier"
                hint="Identifies the company. Two lenders cannot share one."
                {...(errors.taxIdentifier ? { error: errors.taxIdentifier } : {})}
              >
                <Input
                  value={values.taxIdentifier ?? ''}
                  maxLength={60}
                  onChange={(event) => setValues({ ...values, taxIdentifier: event.target.value })}
                />
              </Field>

              <Field
                label="Account or agreement number"
                hint="What you quote when you call them. Never a password or a card number."
                {...(errors.accountReference ? { error: errors.accountReference } : {})}
              >
                <Input
                  value={values.accountReference ?? ''}
                  maxLength={96}
                  onChange={(event) =>
                    setValues({ ...values, accountReference: event.target.value })
                  }
                />
              </Field>
            </div>

            <Field label="Address" {...(errors.address ? { error: errors.address } : {})}>
              <Textarea
                rows={2}
                maxLength={300}
                value={values.address ?? ''}
                onChange={(event) => setValues({ ...values, address: event.target.value })}
              />
            </Field>

            {warnings.length > 0 ? (
              <Alert
                tone={warnings[0]?.match_strength === 'strong' ? 'caution' : 'info'}
                title={
                  warnings[0]?.match_strength === 'strong'
                    ? 'A lender with this identifier already exists'
                    : 'A lender with this name already exists'
                }
              >
                <ul className="mt-1 space-y-1">
                  {warnings.map((warning) => (
                    <li key={warning.lender_id} className="text-[0.8125rem]">
                      {warning.name} · {warning.match_reason}
                      {warning.archived_at ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ms-2"
                          onClick={() =>
                            void setArchived
                              .mutateAsync({ id: warning.lender_id, archived: false })
                              .then(() => {
                                toast.success('Lender restored', warning.name)
                                setValues(null)
                              })
                          }
                        >
                          Restore instead
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[0.75rem] opacity-90">
                  Two companies can share a trading name. Nothing is blocked and nothing is merged —
                  check, then carry on if this really is a different lender.
                </p>
              </Alert>
            ) : null}

            {errors.form ? (
              <Alert tone="critical" title="The lender was not saved">
                <span className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {errors.form}
                </span>
              </Alert>
            ) : null}

            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => void save()}
                isLoading={create.isPending || update.isPending}
              >
                {editing ? 'Save changes' : 'Add lender'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {canManage ? (
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" leadingIcon={<Plus />} onClick={startNew}>
                  Add a lender
                </Button>
              </div>
            ) : null}

            {lenders.length === 0 ? (
              <p className="text-ink-subtle py-6 text-center text-[0.8125rem]">
                No lenders yet. Add the bank or leasing company before recording an agreement.
              </p>
            ) : (
              <ul className="divide-line divide-y">
                {[...active, ...retired].map((lender) => (
                  <li
                    key={lender.id}
                    className={cn(
                      'flex items-center gap-3 py-2.5',
                      lender.archived_at && 'opacity-60',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block truncate text-[0.8125rem] font-medium">
                        {lender.name}
                        {lender.archived_at ? ' · retired' : ''}
                      </span>
                      <span className="text-ink-subtle block truncate text-[0.6875rem]">
                        {LENDER_KIND_LABELS[lender.kind]}
                        {lender.tax_identifier ? ` · ${lender.tax_identifier}` : ''}
                      </span>
                    </span>

                    {canManage ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${lender.name}`}
                          onClick={() => startEdit(lender)}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={
                            lender.archived_at ? `Restore ${lender.name}` : `Retire ${lender.name}`
                          }
                          onClick={() =>
                            void setArchived.mutateAsync({
                              id: lender.id,
                              archived: lender.archived_at === null,
                            })
                          }
                        >
                          {lender.archived_at ? (
                            <ArchiveRestore className="size-3.5" aria-hidden="true" />
                          ) : (
                            <Archive className="size-3.5" aria-hidden="true" />
                          )}
                        </Button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-ink-subtle text-[0.75rem]">
              Retiring a lender stops it being offered for new agreements. Every agreement already
              with it keeps the relationship.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
