import { Plus } from 'lucide-react'
import { useState } from 'react'

import { Button, Field, Input, Select } from '@/components/ui'
import { parseMoneyToMinor } from '@/lib/money/money'
import type { RentalChargeKind } from '@/types/database'

import { ADDABLE_CHARGE_KINDS, CHARGE_KIND_LABELS, type QuoteLine } from '../pricing'

export interface AddChargeFormProps {
  currency: string
  onAdd: (line: QuoteLine) => void
  isPending?: boolean
}

/**
 * Adding one charge to a contract.
 *
 * A discount is entered as a normal positive amount and stored negative, so
 * nobody has to know that the column is signed. "Charge tax on this" is asked
 * rather than assumed: what is taxable differs by country, and a fixed rule
 * would be wrong somewhere.
 */
export function AddChargeForm({ currency, onAdd, isPending = false }: AddChargeFormProps) {
  const [kind, setKind] = useState<RentalChargeKind | 'discount'>('other')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [isTaxable, setIsTaxable] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const trimmed = description.trim()
    if (trimmed === '') {
      setError('Say what this charge is for.')
      return
    }

    const minor = parseMoneyToMinor(amount, currency)
    if (minor === null || minor <= 0) {
      setError('Enter an amount above zero.')
      return
    }

    setError(null)
    onAdd({
      kind,
      description: trimmed,
      quantity: 1,
      unitAmountMinor: minor,
      amountMinor: kind === 'discount' ? -minor : minor,
      isTaxable,
    })

    setDescription('')
    setAmount('')
  }

  return (
    <div className="border-line bg-surface-muted space-y-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_8rem]">
        <Field label="Type">
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value as RentalChargeKind)}
            options={[
              ...ADDABLE_CHARGE_KINDS.map((value) => ({
                value,
                label: CHARGE_KIND_LABELS[value],
              })),
              { value: 'discount', label: CHARGE_KIND_LABELS.discount },
            ]}
          />
        </Field>

        <Field label="Description">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={kind === 'discount' ? 'Returning customer' : 'Child seat'}
            maxLength={200}
          />
        </Field>

        <Field label="Amount">
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="text-ink flex items-center gap-2 text-[0.8125rem]">
          <input
            type="checkbox"
            checked={isTaxable}
            onChange={(event) => setIsTaxable(event.target.checked)}
            className="accent-brand-600 size-4 rounded"
          />
          Include in the tax base
        </label>

        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<Plus />}
          onClick={submit}
          isLoading={isPending}
        >
          Add charge
        </Button>
      </div>

      {error ? <p className="text-critical-600 text-[0.75rem]">{error}</p> : null}
    </div>
  )
}
