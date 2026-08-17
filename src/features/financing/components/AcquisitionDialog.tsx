import { TriangleAlert } from 'lucide-react'
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
import { minorToDecimalString } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { VehicleAcquisitionMethod } from '@/types/database'

import { ACQUISITION_METHOD_HINTS, ACQUISITION_METHOD_LABELS } from '../domain'
import { useUpdateAcquisition } from '../queries'
import { buildAcquisitionSchema, type AcquisitionFormInput } from '../schemas'

export interface AcquisitionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vehicleId: string
  defaultCurrency: string
  current: {
    acquisitionMethod: VehicleAcquisitionMethod | null
    acquiredOn: string | null
    acquisitionPriceMinor: number | null
    acquisitionCurrency: string | null
    acquisitionSupplier: string | null
    acquisitionNotes: string | null
  }
}

const METHODS: readonly VehicleAcquisitionMethod[] = ['cash', 'financed', 'leased', 'other']

/**
 * How the agency came to have this car.
 *
 * On the vehicle rather than on an agreement, because it is true of a car
 * bought outright as well as one financed, and because a price recorded in two
 * places is a price that will eventually disagree with itself.
 *
 * The currency is stored beside the price, so changing the agency's default
 * currency later cannot silently rewrite what a vehicle cost.
 */
export function AcquisitionDialog({
  open,
  onOpenChange,
  vehicleId,
  defaultCurrency,
  current,
}: AcquisitionDialogProps) {
  const toast = useToast()
  const update = useUpdateAcquisition(vehicleId)

  const [values, setValues] = useState<AcquisitionFormInput>(() => ({
    acquisitionMethod: current.acquisitionMethod ?? '',
    acquiredOn: current.acquiredOn ?? '',
    acquisitionPrice:
      current.acquisitionPriceMinor !== null && current.acquisitionCurrency
        ? minorToDecimalString(current.acquisitionPriceMinor, current.acquisitionCurrency)
        : '',
    acquisitionCurrency: current.acquisitionCurrency ?? defaultCurrency,
    acquisitionSupplier: current.acquisitionSupplier ?? '',
    acquisitionNotes: current.acquisitionNotes ?? '',
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const currency = values.acquisitionCurrency || defaultCurrency

  const save = async () => {
    const schema = buildAcquisitionSchema(currency)
    const parsed = schema.safeParse(values)

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
      await update.mutateAsync(parsed.data)
      toast.success('Acquisition updated')
      onOpenChange(false)
    } catch (failure) {
      setErrors({ form: toErrorMessage(failure) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="How this vehicle was acquired"
        description="What it cost to buy, and how it was paid for."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} isLoading={update.isPending}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Acquired by"
            hint={
              values.acquisitionMethod
                ? ACQUISITION_METHOD_HINTS[values.acquisitionMethod as VehicleAcquisitionMethod]
                : 'Leave blank if nobody has recorded it. Blank is not the same as a cash purchase.'
            }
            {...(errors.acquisitionMethod ? { error: errors.acquisitionMethod } : {})}
          >
            <Select
              value={values.acquisitionMethod ?? ''}
              onChange={(event) => setValues({ ...values, acquisitionMethod: event.target.value })}
              options={[
                { value: '', label: 'Not recorded' },
                ...METHODS.map((method) => ({
                  value: method,
                  label: ACQUISITION_METHOD_LABELS[method],
                })),
              ]}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Date acquired"
              {...(errors.acquiredOn ? { error: errors.acquiredOn } : {})}
            >
              <Input
                type="date"
                value={values.acquiredOn ?? ''}
                onChange={(event) => setValues({ ...values, acquiredOn: event.target.value })}
              />
            </Field>

            <Field
              label="Price"
              {...(errors.acquisitionPrice ? { error: errors.acquisitionPrice } : {})}
            >
              <Input
                value={values.acquisitionPrice ?? ''}
                inputMode="decimal"
                placeholder="0.00"
                onChange={(event) => setValues({ ...values, acquisitionPrice: event.target.value })}
              />
            </Field>

            <Field
              label="Currency"
              {...(errors.acquisitionCurrency ? { error: errors.acquisitionCurrency } : {})}
            >
              <Input
                value={values.acquisitionCurrency ?? ''}
                maxLength={3}
                className="uppercase"
                onChange={(event) =>
                  setValues({ ...values, acquisitionCurrency: event.target.value.toUpperCase() })
                }
              />
            </Field>
          </div>

          <Field
            label="Seller or dealer"
            {...(errors.acquisitionSupplier ? { error: errors.acquisitionSupplier } : {})}
          >
            <Input
              value={values.acquisitionSupplier ?? ''}
              maxLength={160}
              onChange={(event) =>
                setValues({ ...values, acquisitionSupplier: event.target.value })
              }
            />
          </Field>

          <Field label="Notes">
            <Textarea
              rows={2}
              maxLength={2000}
              value={values.acquisitionNotes ?? ''}
              onChange={(event) => setValues({ ...values, acquisitionNotes: event.target.value })}
            />
          </Field>

          <p className="text-ink-subtle text-[0.75rem] leading-5">
            What a vehicle cost to buy is not an operating expense and never reaches the running
            costs or the operating result. It is kept here so a later report can use it — this
            product does not calculate depreciation, and does not pretend to.
          </p>

          {errors.form ? (
            <Alert tone="critical" title="This was not saved">
              <span className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {errors.form}
              </span>
            </Alert>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
