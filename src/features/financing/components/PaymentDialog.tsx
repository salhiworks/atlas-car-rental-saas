import { Info, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'

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
import { formatDate } from '@/lib/datetime/format'
import { formatMoney, minorToDecimalString, parseMoneyToMinor } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { FinancingAgreementOverview, FinancingInstallmentStatus } from '@/types/database'

import { PAYMENT_PURPOSE_LABELS } from '../domain'
import { useDuplicatePayments, useRecordPayment } from '../queries'
import {
  PAYMENT_PURPOSE_VALUES,
  buildFinancingPaymentSchema,
  emptyPaymentForm,
  type FinancingPaymentFormInput,
} from '../schemas'

export interface PaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agreement: FinancingAgreementOverview
  installments: readonly FinancingInstallmentStatus[]
  /** Pre-selected when the dialog was opened from a schedule row. */
  installment?: FinancingInstallmentStatus | null
  locale: string
  todayIso: string
}

const METHODS = [
  { value: '', label: 'Not recorded' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
  { value: 'other', label: 'Other' },
]

/**
 * Recording what actually went to the lender.
 *
 * The split is optional, and that is the point. Somebody who only knows that
 * 4,300 left the account can save that in four keystrokes; whatever the
 * components do not explain becomes unallocated, which every total downstream
 * reports honestly rather than counting as interest.
 *
 * Where the schedule knows the split, it is offered as a suggestion and labelled
 * as one. It is what the contract said would happen, not what the lender
 * confirmed happened, and the difference is left to the person who has the
 * statement in front of them.
 */
export function PaymentDialog(props: PaymentDialogProps) {
  if (!props.open) return null
  return <PaymentDialogContent {...props} />
}

function PaymentDialogContent({
  open,
  onOpenChange,
  agreement,
  installments,
  installment,
  locale,
  todayIso,
}: PaymentDialogProps) {
  const toast = useToast()
  const record = useRecordPayment(agreement.id)

  const [values, setValues] = useState<FinancingPaymentFormInput>(() => {
    const base = emptyPaymentForm(todayIso)
    if (!installment) return base
    return {
      ...base,
      installmentId: installment.id,
      amount: minorToDecimalString(installment.outstanding_minor, agreement.currency),
    }
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [splitOpen, setSplitOpen] = useState(false)
  const [suggested, setSuggested] = useState(false)

  const currency = agreement.currency
  const amountMinor = parseMoneyToMinor(values.amount || '0', currency) ?? 0
  const principalMinor = parseMoneyToMinor(values.principal || '0', currency) ?? 0
  const interestMinor = parseMoneyToMinor(values.interest || '0', currency) ?? 0
  const feesMinor = parseMoneyToMinor(values.fees || '0', currency) ?? 0
  const allocated = principalMinor + interestMinor + feesMinor
  const unallocated = amountMinor - allocated

  const selected = installments.find((row) => row.id === values.installmentId) ?? null

  const open_ = installments.filter((row) => row.outstanding_minor > 0)

  const duplicateProbe = useMemo(
    () =>
      amountMinor > 0 && values.paidOn
        ? {
            agreementId: agreement.id,
            paidOn: values.paidOn,
            amountMinor,
            reference: values.reference === '' ? null : (values.reference ?? null),
          }
        : null,
    [agreement.id, values.paidOn, values.reference, amountMinor],
  )
  const duplicates = useDuplicatePayments(duplicateProbe, duplicateProbe !== null)
  const warnings = duplicates.data ?? []

  const applySuggestion = () => {
    if (!selected || selected.expected_principal_minor === null) return
    setSplitOpen(true)
    setSuggested(true)
    setValues((current) => ({
      ...current,
      principal: minorToDecimalString(selected.expected_principal_minor ?? 0, currency),
      interest: minorToDecimalString(selected.expected_interest_minor ?? 0, currency),
    }))
  }

  const submit = async () => {
    const schema = buildFinancingPaymentSchema(currency)
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

    setErrors({})

    try {
      await record.mutateAsync(parsed.data)
      toast.success(
        'Payment recorded',
        unallocated > 0
          ? `${formatMoney(unallocated, currency, { locale })} is unallocated until the split is known.`
          : undefined,
      )
      onOpenChange(false)
    } catch (failure) {
      setErrors({ form: toErrorMessage(failure) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record a lender payment"
        description={`${agreement.lender_name} · ${agreement.vehicle_make} ${agreement.vehicle_model}`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} isLoading={record.isPending}>
              Record payment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date paid" required {...(errors.paidOn ? { error: errors.paidOn } : {})}>
              <Input
                type="date"
                value={values.paidOn}
                onChange={(event) => setValues({ ...values, paidOn: event.target.value })}
              />
            </Field>

            <Field
              label={`Amount (${currency})`}
              required
              hint="What actually left the account."
              {...(errors.amount ? { error: errors.amount } : {})}
            >
              <Input
                value={values.amount}
                inputMode="decimal"
                placeholder="0.00"
                onChange={(event) => setValues({ ...values, amount: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Settles" hint="Leave blank for a payment outside the schedule.">
              <Select
                value={values.installmentId ?? ''}
                onChange={(event) => {
                  const next = installments.find((row) => row.id === event.target.value)
                  setSuggested(false)
                  setValues({
                    ...values,
                    installmentId: event.target.value,
                    amount:
                      next && values.amount === ''
                        ? minorToDecimalString(next.outstanding_minor, currency)
                        : values.amount,
                  })
                }}
                options={[
                  { value: '', label: 'No particular payment' },
                  ...open_.map((row) => ({
                    value: row.id,
                    label: `#${row.sequence} · ${formatDate(new Date(`${row.due_on}T00:00:00Z`), {
                      locale,
                      timeZone: 'UTC',
                    })} · ${formatMoney(row.outstanding_minor, currency, { locale })} left`,
                  })),
                ]}
              />
            </Field>

            <Field label="Purpose">
              <Select
                value={values.purpose}
                onChange={(event) =>
                  setValues({
                    ...values,
                    purpose: event.target.value as FinancingPaymentFormInput['purpose'],
                  })
                }
                options={PAYMENT_PURPOSE_VALUES.map((purpose) => ({
                  value: purpose,
                  label: PAYMENT_PURPOSE_LABELS[purpose],
                }))}
              />
            </Field>
          </div>

          {/* ------------------------------------------------------- the split */}
          <div className="border-line bg-surface-muted rounded-md border p-3">
            {splitOpen ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field
                    label="Principal"
                    {...(errors.principal ? { error: errors.principal } : {})}
                  >
                    <Input
                      value={values.principal ?? ''}
                      inputMode="decimal"
                      placeholder="0.00"
                      onChange={(event) => {
                        setSuggested(false)
                        setValues({ ...values, principal: event.target.value })
                      }}
                    />
                  </Field>
                  <Field label="Interest">
                    <Input
                      value={values.interest ?? ''}
                      inputMode="decimal"
                      placeholder="0.00"
                      onChange={(event) => {
                        setSuggested(false)
                        setValues({ ...values, interest: event.target.value })
                      }}
                    />
                  </Field>
                  <Field label="Fees">
                    <Input
                      value={values.fees ?? ''}
                      inputMode="decimal"
                      placeholder="0.00"
                      onChange={(event) => setValues({ ...values, fees: event.target.value })}
                    />
                  </Field>
                </div>

                {/* The arithmetic, always visible. */}
                <div className={cnReconcile(unallocated)} aria-live="polite">
                  {formatMoney(amountMinor, currency, { locale })} paid ={' '}
                  {formatMoney(principalMinor, currency, { locale })} principal +{' '}
                  {formatMoney(interestMinor, currency, { locale })} interest +{' '}
                  {formatMoney(feesMinor, currency, { locale })} fees
                  {unallocated !== 0 ? (
                    <>
                      {' '}
                      +{' '}
                      <span className="font-semibold">
                        {formatMoney(Math.abs(unallocated), currency, { locale })}
                      </span>{' '}
                      {unallocated > 0 ? 'unallocated' : 'over-allocated'}
                    </>
                  ) : null}
                </div>

                {unallocated > 0 ? (
                  <p className="text-ink-subtle text-[0.75rem]">
                    The unallocated part stays unallocated. It is not counted as interest, and it
                    does not reduce the principal balance.
                  </p>
                ) : null}

                {suggested ? (
                  <Alert tone="info" title="This is the scheduled split, not the lender’s">
                    These figures come from the schedule this agreement generated. If the lender’s
                    statement says something else, type what the statement says.
                  </Alert>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-ink-muted flex items-start gap-2 text-[0.8125rem]">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  Do you know how much of this was interest? If not, leave it — the whole payment is
                  recorded as unallocated, which is the truth.
                </p>
                <div className="flex items-center gap-2">
                  {selected?.expected_principal_minor !== null && selected !== null ? (
                    <Button variant="ghost" size="sm" onClick={applySuggestion}>
                      Use scheduled split
                    </Button>
                  ) : null}
                  <Button variant="secondary" size="sm" onClick={() => setSplitOpen(true)}>
                    Enter the split
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Paid by">
              <Select
                value={values.method ?? ''}
                onChange={(event) => setValues({ ...values, method: event.target.value })}
                options={METHODS}
              />
            </Field>

            <Field label="Lender reference" hint="Their transaction number, if you have it.">
              <Input
                value={values.reference ?? ''}
                maxLength={96}
                onChange={(event) => setValues({ ...values, reference: event.target.value })}
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea
              rows={2}
              maxLength={2000}
              value={values.notes ?? ''}
              onChange={(event) => setValues({ ...values, notes: event.target.value })}
            />
          </Field>

          {warnings.length > 0 ? (
            <Alert
              tone={warnings[0]?.match_strength === 'strong' ? 'caution' : 'info'}
              title={
                warnings[0]?.match_strength === 'strong'
                  ? 'This reference is already recorded'
                  : 'A similar payment is already recorded'
              }
            >
              <ul className="mt-1 space-y-1">
                {warnings.map((warning) => (
                  <li key={warning.payment_id} className="text-[0.8125rem]">
                    {formatMoney(warning.amount_minor, currency, { locale })} on{' '}
                    {formatDate(new Date(`${warning.paid_on}T00:00:00Z`), {
                      locale,
                      timeZone: 'UTC',
                    })}{' '}
                    <span className="opacity-80">({warning.match_reason})</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[0.75rem] opacity-90">
                Nothing is blocked and nothing is merged. A lender really can be paid the same
                amount twice in a day.
              </p>
            </Alert>
          ) : null}

          {errors.form ? (
            <Alert tone="critical" title="The payment was not recorded">
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

function cnReconcile(unallocated: number): string {
  const base = 'rounded border px-2.5 py-2 text-[0.75rem] leading-5'
  if (unallocated < 0) return `${base} border-critical-200 bg-critical-50 text-critical-700`
  if (unallocated > 0) return `${base} border-line bg-surface text-ink-muted`
  return `${base} border-positive-200 bg-positive-50 text-positive-700`
}
