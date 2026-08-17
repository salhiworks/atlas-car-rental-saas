import { TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { expenseDetailPath } from '@/app/routes/paths'
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney, parseMoneyToMinor } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { ExpenseCategoryRecord, ExpenseVendor } from '@/types/database'

import { ALLOCATION_HINTS, ALLOCATION_LABELS, EXPENSE_ALLOCATIONS } from '../allocation'
import { formatTaxRate, parseTaxRatePercent, taxFromGross } from '../money'
import { useDuplicateExpenses, useRentalOptions, useVehicleOptions } from '../queries'
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES, type ExpenseFormInput } from '../schemas'
import { VendorPicker } from './VendorPicker'

export interface ExpenseFormProps {
  values: ExpenseFormInput
  onChange: (patch: Partial<ExpenseFormInput>) => void
  errors: Record<string, string>
  categories: readonly ExpenseCategoryRecord[]
  currentVendor?: ExpenseVendor | null
  canManageVendors: boolean
  locale: string
  /** Excluded from the duplicate check when editing, so it cannot match itself. */
  editingExpenseId?: string
  /** Locks the relation when the form was opened from a vehicle or a rental. */
  lockedRelation?: 'vehicle' | 'rental' | null
}

/**
 * Recording what the agency spent.
 *
 * Four groups, in the order a person reads a receipt: what it cost, what kind
 * of cost it is, who was paid, and the paperwork. Only the selector the chosen
 * allocation actually needs is shown — asking which vehicle an office rent
 * belongs to is a question with no answer.
 *
 * Nothing optional is required. A legitimate cost can be recorded with a date,
 * a description, an amount and a category; the tax, the supplier, the reference
 * and the receipt are all things an agency may or may not have.
 */
export function ExpenseForm({
  values,
  onChange,
  errors,
  categories,
  currentVendor,
  canManageVendors,
  locale,
  editingExpenseId,
  lockedRelation,
}: ExpenseFormProps) {
  const [showTax, setShowTax] = useState(() => values.taxAmount !== '' && values.taxAmount !== '0')

  const currency = values.currency || 'EUR'
  const amountMinor = parseMoneyToMinor(values.amount || '0', currency) ?? 0
  const taxMinor = parseMoneyToMinor(values.taxAmount || '0', currency) ?? 0
  const netMinor = Math.max(0, amountMinor - taxMinor)

  const selectedCategory = categories.find((category) => category.id === values.categoryId)

  // Only the relation the allocation needs is fetched, and only once the
  // allocation asks for it. Both read the whole set rather than a page: a
  // hundred-and-fiftieth car missing from the selector is a car whose costs
  // cannot be recorded at all.
  const vehiclesQuery = useVehicleOptions(values.allocation === 'vehicle')
  const rentalsQuery = useRentalOptions(values.allocation === 'rental')

  /**
   * A cost that looks like one already recorded.
   *
   * Asked only when there is something real to match on — a supplier plus
   * either a document number or an amount and a date. It warns; the desk
   * decides. Agencies buy the same thing twice.
   */
  const duplicateProbe = useMemo(
    () => ({
      vendorId: values.vendorId === '' ? null : (values.vendorId ?? null),
      reference: values.reference === '' ? null : (values.reference ?? null),
      amountMinor: amountMinor > 0 ? amountMinor : null,
      currency,
      incurredOn: values.incurredOn || null,
      ...(editingExpenseId ? { excludeExpenseId: editingExpenseId } : {}),
    }),
    [values.vendorId, values.reference, values.incurredOn, amountMinor, currency, editingExpenseId],
  )

  const duplicatesQuery = useDuplicateExpenses(
    duplicateProbe,
    Boolean(duplicateProbe.vendorId) &&
      (Boolean(duplicateProbe.reference) ||
        (duplicateProbe.amountMinor !== null && Boolean(duplicateProbe.incurredOn))),
  )
  const duplicates = duplicatesQuery.data ?? []

  const applyRate = (input: string) => {
    const bps = parseTaxRatePercent(input)
    onChange({ taxRateBps: bps })
    if (bps !== null && bps > 0 && amountMinor > 0) {
      // Gross includes the tax, so the tax inside it is gross × r / (1 + r).
      const implied = taxFromGross(amountMinor, bps)
      onChange({
        taxRateBps: bps,
        taxAmount: (implied / 10 ** (currency === 'JPY' ? 0 : 2)).toFixed(
          currency === 'JPY' ? 0 : 2,
        ),
      })
    }
  }

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------- cost */}
      <Card>
        <CardHeader
          title="The cost"
          description="What was spent, and when it was actually incurred."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <Field
              label="Date incurred"
              required
              hint="Not the day you are typing it in."
              {...(errors.incurredOn ? { error: errors.incurredOn } : {})}
            >
              <Input
                type="date"
                value={values.incurredOn}
                onChange={(event) => onChange({ incurredOn: event.target.value })}
              />
            </Field>

            <Field
              label="What was it for"
              required
              {...(errors.description ? { error: errors.description } : {})}
            >
              <Input
                value={values.description}
                onChange={(event) => onChange({ description: event.target.value })}
                maxLength={500}
                placeholder="Front brake pads and labour"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field
              label="Amount paid"
              required
              hint="The total that left the agency, tax included."
              {...(errors.amount ? { error: errors.amount } : {})}
            >
              <Input
                value={values.amount}
                inputMode="decimal"
                onChange={(event) => onChange({ amount: event.target.value })}
                placeholder="0.00"
              />
            </Field>

            <Field
              label="Currency"
              required
              {...(errors.currency ? { error: errors.currency } : {})}
            >
              <Input
                value={values.currency}
                onChange={(event) => onChange({ currency: event.target.value.toUpperCase() })}
                maxLength={3}
                className="uppercase"
              />
            </Field>
          </div>

          {showTax ? (
            <div className="border-line bg-surface-muted space-y-3 rounded-md border p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Rate" hint="Optional — fills the amount below.">
                  <Input
                    value={values.taxRateBps === null ? '' : String(values.taxRateBps / 100)}
                    inputMode="decimal"
                    placeholder="20"
                    onChange={(event) => applyRate(event.target.value)}
                  />
                </Field>

                <Field
                  label="Tax included"
                  {...(errors.taxAmount ? { error: errors.taxAmount } : {})}
                >
                  <Input
                    value={values.taxAmount}
                    inputMode="decimal"
                    onChange={(event) => onChange({ taxAmount: event.target.value })}
                    placeholder="0.00"
                  />
                </Field>

                <Field label="Called" hint="VAT, TVA, IVA…">
                  <Input
                    value={values.taxLabel ?? ''}
                    onChange={(event) => onChange({ taxLabel: event.target.value })}
                    maxLength={40}
                  />
                </Field>
              </div>

              <p className="text-ink-muted text-[0.75rem]">
                {formatMoney(amountMinor, currency, { locale })} paid ·{' '}
                {formatMoney(netMinor, currency, { locale })} before {values.taxLabel || 'tax'} ·{' '}
                {formatMoney(taxMinor, currency, { locale })} tax
                {values.taxRateBps ? ` at ${formatTaxRate(values.taxRateBps)}` : ''}. Totals
                everywhere use the amount paid.
              </p>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setShowTax(true)}>
              Record the tax on this
            </Button>
          )}
        </CardBody>
      </Card>

      {/* --------------------------------------------------- classification */}
      <Card>
        <CardHeader
          title="What it belongs to"
          description="This is what makes a vehicle's costs mean something."
        />
        <CardBody className="space-y-4">
          <Field
            label="Category"
            required
            {...(errors.categoryId ? { error: errors.categoryId } : {})}
          >
            <Select
              value={values.categoryId}
              placeholder="Choose a category"
              onChange={(event) => {
                const next = categories.find((category) => category.id === event.target.value)
                onChange({
                  categoryId: event.target.value,
                  // The category suggests where this kind of cost usually goes;
                  // the desk may still say otherwise.
                  ...(next?.default_allocation && !lockedRelation
                    ? { allocation: next.default_allocation }
                    : {}),
                })
              }}
              options={categories.map((category) => ({
                value: category.id,
                label: category.name,
              }))}
            />
          </Field>

          <fieldset disabled={Boolean(lockedRelation)}>
            <legend className="text-ink mb-1.5 block text-[0.8125rem] leading-5 font-medium">
              Belongs to
              <span className="text-critical-600 ml-0.5" aria-hidden="true">
                *
              </span>
            </legend>

            <div className="grid gap-2 sm:grid-cols-3">
              {EXPENSE_ALLOCATIONS.map((allocation) => {
                const isActive = values.allocation === allocation
                return (
                  <button
                    key={allocation}
                    type="button"
                    onClick={() => onChange({ allocation })}
                    aria-pressed={isActive}
                    disabled={Boolean(lockedRelation)}
                    className={cn(
                      'border-line rounded-md border px-3 py-2.5 text-start transition-colors',
                      'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-1',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                      isActive
                        ? 'border-brand-400 bg-brand-50/60'
                        : 'hover:border-line-strong bg-surface',
                    )}
                  >
                    <span
                      className={cn(
                        'block text-[0.8125rem] font-medium',
                        isActive ? 'text-brand-700' : 'text-ink',
                      )}
                    >
                      {ALLOCATION_LABELS[allocation]}
                    </span>
                    <span className="text-ink-subtle mt-0.5 block text-[0.6875rem]">
                      {ALLOCATION_HINTS[allocation]}
                    </span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          {lockedRelation ? (
            <p className="text-ink-subtle text-[0.75rem]">
              Opened from {lockedRelation === 'vehicle' ? 'a vehicle' : 'a rental'}, so this cost is
              attached to it.
            </p>
          ) : null}

          {/* Only the selector the allocation actually needs. */}
          {values.allocation === 'vehicle' ? (
            <Field
              label="Vehicle"
              required
              {...(errors.vehicleId ? { error: errors.vehicleId } : {})}
            >
              <Select
                value={values.vehicleId ?? ''}
                placeholder="Choose a vehicle"
                disabled={lockedRelation === 'vehicle'}
                onChange={(event) => onChange({ vehicleId: event.target.value })}
                options={(vehiclesQuery.data ?? []).map((vehicle) => ({
                  value: vehicle.id,
                  label: `${vehicle.make} ${vehicle.model} · ${vehicle.registration_plate}${
                    vehicle.archived_at ? ' (retired)' : ''
                  }`,
                }))}
              />
            </Field>
          ) : null}

          {values.allocation === 'rental' ? (
            <Field
              label="Rental"
              required
              hint="The vehicle follows from the contract."
              {...(errors.rentalId ? { error: errors.rentalId } : {})}
            >
              <Select
                value={values.rentalId ?? ''}
                placeholder="Choose a rental"
                disabled={lockedRelation === 'rental'}
                onChange={(event) => onChange({ rentalId: event.target.value })}
                options={(rentalsQuery.data ?? []).map((rental) => ({
                  value: rental.id,
                  label: `${rental.reference} · ${formatDate(new Date(rental.starts_at), {
                    locale,
                    timeZone: 'UTC',
                  })}`,
                }))}
              />
            </Field>
          ) : null}

          {selectedCategory?.default_allocation &&
          selectedCategory.default_allocation !== values.allocation ? (
            <p className="text-ink-subtle text-[0.75rem]">
              {selectedCategory.name} usually belongs to{' '}
              {ALLOCATION_LABELS[selectedCategory.default_allocation].toLowerCase()} — this one is
              recorded as {ALLOCATION_LABELS[values.allocation].toLowerCase()}.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------------------------- vendor / payment */}
      <Card>
        <CardHeader title="Who was paid" description="All optional." />
        <CardBody className="space-y-4">
          <VendorPicker
            value={values.vendorId ?? ''}
            onChange={(vendorId) => onChange({ vendorId })}
            canCreate={canManageVendors}
            currentVendor={currentVendor ?? null}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Paid by">
              <Select
                value={values.paymentMethod ?? ''}
                onChange={(event) => onChange({ paymentMethod: event.target.value })}
                options={[
                  { value: '', label: 'Not recorded' },
                  ...PAYMENT_METHOD_VALUES.map((method) => ({
                    value: method,
                    label: PAYMENT_METHOD_LABELS[method],
                  })),
                ]}
              />
            </Field>

            <Field label="Invoice or receipt number">
              <Input
                value={values.reference ?? ''}
                onChange={(event) => onChange({ reference: event.target.value })}
                maxLength={96}
                placeholder="INV-2026-0184"
              />
            </Field>
          </div>

          {duplicates.length > 0 ? (
            <Alert
              tone={duplicates[0]?.match_strength === 'strong' ? 'caution' : 'info'}
              title={
                duplicates[0]?.match_strength === 'strong'
                  ? 'This may already have been recorded'
                  : 'Something similar is already on file'
              }
            >
              <ul className="mt-1 space-y-1">
                {duplicates.slice(0, 3).map((duplicate) => (
                  <li key={duplicate.expense_id} className="text-[0.8125rem]">
                    <Link
                      to={expenseDetailPath(duplicate.expense_id)}
                      className="underline underline-offset-2"
                    >
                      {duplicate.description ?? 'Untitled cost'}
                    </Link>{' '}
                    · {formatMoney(duplicate.amount_minor, duplicate.currency, { locale })} ·{' '}
                    {formatDate(new Date(`${duplicate.incurred_on}T00:00:00Z`), {
                      locale,
                      timeZone: 'UTC',
                    })}{' '}
                    <span className="opacity-80">({duplicate.match_reason})</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[0.75rem] opacity-90">
                Agencies do buy the same thing twice. Nothing is blocked — check, then carry on if
                it is genuinely a second cost.
              </p>
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      {/* ------------------------------------------------------ paperwork */}
      <Card>
        <CardHeader
          title="Notes"
          description="Receipts are attached once the cost has been saved."
        />
        <CardBody className="space-y-4">
          <Field label="Notes">
            <Textarea
              value={values.notes ?? ''}
              rows={3}
              maxLength={2000}
              onChange={(event) => onChange({ notes: event.target.value })}
            />
          </Field>

          {values.allocation === 'vehicle' ? (
            <Field
              label="Odometer at the time"
              hint="Useful on fuel and servicing. Optional."
              {...(errors.odometer ? { error: errors.odometer } : {})}
            >
              <Input
                value={values.odometer ?? ''}
                inputMode="numeric"
                onChange={(event) => onChange({ odometer: event.target.value })}
              />
            </Field>
          ) : null}
        </CardBody>
      </Card>

      {errors.form ? (
        <Alert tone="critical" title="The cost was not saved">
          <span className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {errors.form}
          </span>
        </Alert>
      ) : null}
    </div>
  )
}
