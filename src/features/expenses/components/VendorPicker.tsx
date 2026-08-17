import { Plus } from 'lucide-react'
import { useState } from 'react'

import {
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
import type { ExpenseVendor } from '@/types/database'

import { useCreateVendor, useExpenseVendors } from '../queries'
import { emptyVendorForm, vendorSchema, type VendorFormInput } from '../schemas'

export interface VendorPickerProps {
  value: string
  onChange: (vendorId: string) => void
  canCreate: boolean
  /** Kept visible even when archived, so an old cost still names its supplier. */
  currentVendor?: ExpenseVendor | null
  error?: string | undefined
}

/**
 * Choosing a supplier, or adding one without leaving the form.
 *
 * A manager recording a repair at a garage they used for the first time should
 * not have to abandon a half-filled expense to go and create a vendor record.
 * The quick-create is the same insert the vendor manager performs, under the
 * same policy — there is no lighter path that skips validation.
 */
export function VendorPicker({
  value,
  onChange,
  canCreate,
  currentVendor,
  error,
}: VendorPickerProps) {
  const toast = useToast()
  const vendorsQuery = useExpenseVendors()
  const createVendor = useCreateVendor()

  const [isCreating, setIsCreating] = useState(false)
  const [form, setForm] = useState<VendorFormInput>(emptyVendorForm)
  const [formError, setFormError] = useState<string | null>(null)

  const vendors = vendorsQuery.data ?? []
  // An archived supplier stays selectable on the cost that already names it.
  const options = [
    { value: '', label: 'No supplier' },
    ...vendors.map((vendor) => ({ value: vendor.id, label: vendor.name })),
    ...(currentVendor && !vendors.some((vendor) => vendor.id === currentVendor.id)
      ? [{ value: currentVendor.id, label: `${currentVendor.name} (retired)` }]
      : []),
  ]

  const submit = async () => {
    const parsed = vendorSchema.safeParse(form)
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Check the details and try again.')
      return
    }

    try {
      const vendor = await createVendor.mutateAsync(parsed.data)
      onChange(vendor.id)
      toast.success('Supplier added', vendor.name)
      setIsCreating(false)
      setForm(emptyVendorForm())
      setFormError(null)
    } catch (failure) {
      setFormError(toErrorMessage(failure))
    }
  }

  return (
    <>
      <div className="flex items-end gap-2">
        <Field label="Supplier" className="flex-1" {...(error ? { error } : {})}>
          <Select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            options={options}
          />
        </Field>

        {canCreate ? (
          <Button
            variant="secondary"
            leadingIcon={<Plus />}
            onClick={() => setIsCreating(true)}
            aria-label="Add a supplier"
          >
            New
          </Button>
        ) : null}
      </div>

      <Dialog open={isCreating} onOpenChange={setIsCreating}>
        <DialogContent
          title="Add a supplier"
          description="Enough to answer who you pay the most. Nothing more is required."
          size="md"
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setIsCreating(false)}
                disabled={createVendor.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void submit()}
                isLoading={createVendor.isPending}
              >
                Add supplier
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <Field label="Name" required {...(formError ? { error: formError } : {})}>
              <Input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                maxLength={120}
                placeholder="Garage Atlas"
                autoFocus
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
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

            <Field label="Tax or business ID">
              <Input
                value={form.taxIdentifier ?? ''}
                onChange={(event) => setForm({ ...form, taxIdentifier: event.target.value })}
                maxLength={60}
              />
            </Field>

            <Field label="Notes">
              <Textarea
                value={form.notes ?? ''}
                rows={2}
                maxLength={2000}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </Field>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
