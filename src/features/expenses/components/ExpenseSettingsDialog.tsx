import { ArchiveRestore, Archive, Pencil, Plus, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import {
  Alert,
  Badge,
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
import type { ExpenseCategoryRecord, ExpenseVendor } from '@/types/database'

import { ALLOCATION_LABELS } from '../allocation'
import {
  useCreateCategory,
  useCreateVendor,
  useDuplicateVendors,
  useExpenseCategories,
  useExpenseVendors,
  useSetCategoryArchived,
  useSetVendorArchived,
  useUpdateCategory,
  useUpdateVendor,
} from '../queries'
import {
  categorySchema,
  emptyVendorForm,
  vendorSchema,
  type CategoryFormInput,
  type VendorFormInput,
} from '../schemas'

export interface ExpenseSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  canManageCategories: boolean
  canManageVendors: boolean
}

/**
 * Categories and suppliers, kept inside the Expenses workspace.
 *
 * Neither earns a place in the sidebar: they are things an agency configures
 * occasionally, from the screen where they are used.
 *
 * Nothing here deletes. A category or a supplier with history behind it has to
 * keep existing or every cost that used it would read "Unknown" — so the action
 * is to retire it, which removes it from the pickers and leaves the past alone.
 */
export function ExpenseSettingsDialog({
  open,
  onOpenChange,
  canManageCategories,
  canManageVendors,
}: ExpenseSettingsDialogProps) {
  const [tab, setTab] = useState<'categories' | 'vendors'>(
    canManageCategories ? 'categories' : 'vendors',
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Categories and suppliers"
        description="Retired entries stay on the costs that already use them."
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        }
      >
        <div className="space-y-4">
          <div
            className="border-line-strong bg-surface inline-flex rounded-md border p-0.5"
            role="tablist"
            aria-label="What to manage"
          >
            {(
              [
                ['categories', 'Categories', canManageCategories],
                ['vendors', 'Suppliers', canManageVendors],
              ] as const
            ).map(([value, label, allowed]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                disabled={!allowed}
                onClick={() => setTab(value)}
                className={cn(
                  'rounded px-3 py-1 text-[0.8125rem] font-medium transition-colors',
                  'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-1',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  tab === value
                    ? 'bg-brand-700 text-ink-inverse'
                    : 'text-ink-muted hover:bg-surface-inset hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'categories' ? (
            <CategoryManager canManage={canManageCategories} />
          ) : (
            <VendorManager canManage={canManageVendors} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// -----------------------------------------------------------------------------

function CategoryManager({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const categoriesQuery = useExpenseCategories(true)
  const createCategory = useCreateCategory()
  const updateCategory = useUpdateCategory()
  const setArchived = useSetCategoryArchived()

  const [editing, setEditing] = useState<ExpenseCategoryRecord | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [form, setForm] = useState<CategoryFormInput>({
    name: '',
    description: '',
    defaultAllocation: '',
  })
  const [error, setError] = useState<string | null>(null)

  const categories = categoriesQuery.data ?? []

  const startEdit = (category: ExpenseCategoryRecord) => {
    setEditing(category)
    setIsAdding(false)
    setError(null)
    setForm({
      name: category.name,
      description: category.description ?? '',
      defaultAllocation: category.default_allocation ?? '',
    })
  }

  const submit = async () => {
    const parsed = categorySchema.safeParse(form)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details.')
      return
    }

    try {
      if (editing) {
        await updateCategory.mutateAsync({ id: editing.id, values: parsed.data })
        toast.success('Category updated', parsed.data.name)
      } else {
        await createCategory.mutateAsync(parsed.data)
        toast.success('Category added', parsed.data.name)
      }
      setEditing(null)
      setIsAdding(false)
      setError(null)
    } catch (failure) {
      setError(toErrorMessage(failure))
    }
  }

  return (
    <div className="space-y-3">
      {canManage ? (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Plus />}
            onClick={() => {
              setIsAdding(true)
              setEditing(null)
              setError(null)
              setForm({ name: '', description: '', defaultAllocation: '' })
            }}
          >
            Add a category
          </Button>
        </div>
      ) : null}

      {isAdding || editing ? (
        <div className="border-line bg-surface-muted space-y-3 rounded-md border p-3">
          <Field label="Name" required {...(error ? { error } : {})}>
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              maxLength={60}
              autoFocus
            />
          </Field>

          <Field
            label="Usually belongs to"
            hint="Offered when this category is chosen; the desk may still say otherwise."
          >
            <Select
              value={form.defaultAllocation ?? ''}
              onChange={(event) => setForm({ ...form, defaultAllocation: event.target.value })}
              options={[
                { value: '', label: 'No suggestion' },
                { value: 'overhead', label: ALLOCATION_LABELS.overhead },
                { value: 'vehicle', label: ALLOCATION_LABELS.vehicle },
                { value: 'rental', label: ALLOCATION_LABELS.rental },
              ]}
            />
          </Field>

          <Field label="Description">
            <Textarea
              value={form.description ?? ''}
              rows={2}
              maxLength={300}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(null)
                setIsAdding(false)
                setError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              isLoading={createCategory.isPending || updateCategory.isPending}
            >
              {editing ? 'Save changes' : 'Add category'}
            </Button>
          </div>
        </div>
      ) : null}

      <ul className="divide-line max-h-80 divide-y overflow-y-auto">
        {categories.map((category) => (
          <li key={category.id} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'text-ink block truncate text-[0.8125rem] font-medium',
                  category.archived_at && 'opacity-60',
                )}
              >
                {category.name}
              </span>
              <span className="text-ink-subtle block truncate text-[0.6875rem]">
                {category.default_allocation
                  ? ALLOCATION_LABELS[category.default_allocation]
                  : 'No default'}
                {category.description ? ` · ${category.description}` : ''}
              </span>
            </span>

            {category.archived_at ? <Badge tone="neutral">Retired</Badge> : null}

            {canManage ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${category.name}`}
                  onClick={() => startEdit(category)}
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={
                    category.archived_at ? `Restore ${category.name}` : `Retire ${category.name}`
                  }
                  isLoading={setArchived.isPending}
                  onClick={() =>
                    void setArchived
                      .mutateAsync({ id: category.id, archived: category.archived_at === null })
                      .catch((failure: unknown) =>
                        toast.error('Could not change that', toErrorMessage(failure)),
                      )
                  }
                >
                  {category.archived_at ? (
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
    </div>
  )
}

// -----------------------------------------------------------------------------

function VendorManager({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const vendorsQuery = useExpenseVendors({ includeArchived: true })
  const createVendor = useCreateVendor()
  const updateVendor = useUpdateVendor()
  const setArchived = useSetVendorArchived()

  const [editing, setEditing] = useState<ExpenseVendor | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [form, setForm] = useState<VendorFormInput>(emptyVendorForm)
  const [error, setError] = useState<string | null>(null)

  const vendors = vendorsQuery.data ?? []

  /**
   * Suppliers that resemble the one being typed.
   *
   * The commonest way an agency ends up with two "Garage Atlas" rows is
   * somebody re-creating one that was retired, so retired matches are surfaced
   * with a restore rather than hidden.
   */
  const duplicatesQuery = useDuplicateVendors(
    form.name,
    form.taxIdentifier ?? '',
    (isAdding || editing !== null) && form.name.trim().length >= 2,
  )
  const duplicates = (duplicatesQuery.data ?? []).filter(
    (candidate) => candidate.vendor_id !== editing?.id,
  )

  const submit = async () => {
    const parsed = vendorSchema.safeParse(form)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the details.')
      return
    }

    try {
      if (editing) {
        await updateVendor.mutateAsync({ id: editing.id, values: parsed.data })
        toast.success('Supplier updated', parsed.data.name)
      } else {
        await createVendor.mutateAsync(parsed.data)
        toast.success('Supplier added', parsed.data.name)
      }
      setEditing(null)
      setIsAdding(false)
      setForm(emptyVendorForm())
      setError(null)
    } catch (failure) {
      setError(toErrorMessage(failure))
    }
  }

  return (
    <div className="space-y-3">
      {canManage ? (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Plus />}
            onClick={() => {
              setIsAdding(true)
              setEditing(null)
              setError(null)
              setForm(emptyVendorForm())
            }}
          >
            Add a supplier
          </Button>
        </div>
      ) : null}

      {isAdding || editing ? (
        <div className="border-line bg-surface-muted space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required {...(error ? { error } : {})}>
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                maxLength={120}
                autoFocus
              />
            </Field>
            <Field label="Tax or business ID" hint="Two suppliers cannot share one.">
              <Input
                value={form.taxIdentifier ?? ''}
                onChange={(event) => setForm({ ...form, taxIdentifier: event.target.value })}
                maxLength={60}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email">
              <Input
                type="email"
                value={form.email ?? ''}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </Field>
            <Field label="Phone">
              <Input
                value={form.phone ?? ''}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
              />
            </Field>
          </div>

          {duplicates.length > 0 ? (
            <Alert
              tone={duplicates[0]?.match_strength === 'strong' ? 'caution' : 'info'}
              title={
                duplicates[0]?.match_strength === 'strong'
                  ? 'That tax ID is already on file'
                  : 'A supplier with this name already exists'
              }
            >
              <ul className="mt-1 space-y-1">
                {duplicates.map((candidate) => (
                  <li
                    key={candidate.vendor_id}
                    className="flex items-center gap-2 text-[0.8125rem]"
                  >
                    <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
                    <span className="flex-1">
                      {candidate.name}{' '}
                      <span className="opacity-80">({candidate.match_reason})</span>
                    </span>
                    {candidate.archived_at ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void setArchived
                            .mutateAsync({ id: candidate.vendor_id, archived: false })
                            .then(() => {
                              toast.success('Supplier restored', candidate.name)
                              setIsAdding(false)
                              setEditing(null)
                            })
                        }
                      >
                        Restore
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[0.75rem] opacity-90">
                Branches of the same chain are genuinely separate suppliers, so nothing is blocked
                by a shared name.
              </p>
            </Alert>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(null)
                setIsAdding(false)
                setError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              isLoading={createVendor.isPending || updateVendor.isPending}
            >
              {editing ? 'Save changes' : 'Add supplier'}
            </Button>
          </div>
        </div>
      ) : null}

      <ul className="divide-line max-h-80 divide-y overflow-y-auto">
        {vendors.map((vendor) => (
          <li key={vendor.id} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'text-ink block truncate text-[0.8125rem] font-medium',
                  vendor.archived_at && 'opacity-60',
                )}
              >
                {vendor.name}
              </span>
              <span className="text-ink-subtle block truncate text-[0.6875rem]">
                {[vendor.tax_identifier, vendor.email, vendor.phone].filter(Boolean).join(' · ') ||
                  'No contact details'}
              </span>
            </span>

            {vendor.archived_at ? <Badge tone="neutral">Retired</Badge> : null}

            {canManage ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${vendor.name}`}
                  onClick={() => {
                    setEditing(vendor)
                    setIsAdding(false)
                    setError(null)
                    setForm({
                      name: vendor.name,
                      email: vendor.email ?? '',
                      phone: vendor.phone ?? '',
                      taxIdentifier: vendor.tax_identifier ?? '',
                      address: vendor.address ?? '',
                      notes: vendor.notes ?? '',
                    })
                  }}
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={
                    vendor.archived_at ? `Restore ${vendor.name}` : `Retire ${vendor.name}`
                  }
                  isLoading={setArchived.isPending}
                  onClick={() =>
                    void setArchived
                      .mutateAsync({ id: vendor.id, archived: vendor.archived_at === null })
                      .catch((failure: unknown) =>
                        toast.error('Could not change that', toErrorMessage(failure)),
                      )
                  }
                >
                  {vendor.archived_at ? (
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
    </div>
  )
}
