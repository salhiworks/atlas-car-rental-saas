import { ArrowLeft, ArrowRight, Check, CircleHelp, Plus, TriangleAlert, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { financingDetailPath, paths } from '@/app/routes/paths'
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { projectSchedule, scheduleTotals } from '@/features/financing/amortization'
import { LenderManager } from '@/features/financing/components/LenderManager'
import {
  AGREEMENT_TYPES,
  AGREEMENT_TYPE_LABELS,
  FREQUENCIES,
  FREQUENCY_LABELS,
  MODE_HINTS,
  MODE_LABELS,
  formatRate,
  parseRatePercent,
} from '@/features/financing/domain'
import { useActivateAgreement, useCreateAgreement, useLenders } from '@/features/financing/queries'
import {
  buildAgreementSchema,
  emptyAgreementForm,
  type AgreementFormInput,
} from '@/features/financing/schemas'
import { useVehicleOptions } from '@/features/expenses/queries'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatDate } from '@/lib/datetime/format'
import { toIsoDateInTimeZone } from '@/lib/datetime/timezone'
import { formatMoney, parseMoneyToMinor } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'
import type { FinancingProjectedInstallment } from '@/types/database'

/**
 * Adding financing.
 *
 * Four steps rather than one long form, because the third of them is a real
 * question — how much of this contract do you actually know? — and asking it
 * in the middle of thirty fields would get the wrong answer.
 *
 * Nobody is asked for an APR they do not have. Choosing the payment plan means
 * the agency knows what it pays and when, and the application will not pretend
 * to know the rest; choosing the loan means the contract's arithmetic is known
 * well enough to split every payment. The review step says, in words, exactly
 * which figures will and will not be derivable afterwards.
 */

type Step = 'vehicle' | 'lender' | 'terms' | 'review'

const STEPS: readonly { key: Step; label: string }[] = [
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'lender', label: 'Lender' },
  { key: 'terms', label: 'What you know' },
  { key: 'review', label: 'Review' },
]

export function FinancingNewPage() {
  const organization = useOrganization()
  const navigate = useNavigate()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const canManageLenders = usePermission('lenders.manage')

  const todayIso = toIsoDateInTimeZone(new Date(), organization.time_zone)

  const [step, setStep] = useState<Step>('vehicle')
  const [showLenders, setShowLenders] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [rateInput, setRateInput] = useState('')

  const vehiclesQuery = useVehicleOptions()
  const lendersQuery = useLenders()
  const create = useCreateAgreement()

  const [values, setValues] = useState<AgreementFormInput>(() => {
    const base = emptyAgreementForm(organization.default_currency, todayIso)
    const vehicle = searchParams.get('vehicle')
    return vehicle ? { ...base, vehicleId: vehicle } : base
  })

  const [createdId, setCreatedId] = useState<string | null>(null)
  const activate = useActivateAgreement(createdId ?? '')

  const patch = (next: Partial<AgreementFormInput>) =>
    setValues((current) => ({ ...current, ...next }))

  const currency = values.currency || organization.default_currency
  const toMinor = (input: string | null | undefined) =>
    input && input.trim() !== '' ? parseMoneyToMinor(input, currency) : null

  /** Drawn locally so it keeps up with typing; the database agrees row for row. */
  const projection = useMemo(
    () =>
      projectSchedule({
        mode: values.mode,
        financedMinor: toMinor(values.financedAmount),
        rateBps: values.rateBps,
        installments:
          values.installmentsCount && String(values.installmentsCount).trim() !== ''
            ? Number(values.installmentsCount)
            : null,
        installmentMinor: toMinor(values.installmentAmount),
        firstPaymentOn: values.firstPaymentOn || null,
        frequency: values.paymentFrequency,
        balloonMinor: toMinor(values.balloon),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      values.mode,
      values.financedAmount,
      values.rateBps,
      values.installmentsCount,
      values.installmentAmount,
      values.firstPaymentOn,
      values.paymentFrequency,
      values.balloon,
      currency,
    ],
  )

  const totals = scheduleTotals(projection.rows)
  const vehicles = vehiclesQuery.data ?? []
  const lenders = lendersQuery.data ?? []
  const vehicle = vehicles.find((row) => row.id === values.vehicleId)
  const lender = lenders.find((row) => row.id === values.lenderId)

  const stepIndex = STEPS.findIndex((entry) => entry.key === step)

  const canLeaveVehicle = values.vehicleId !== ''
  const canLeaveLender = values.lenderId !== ''
  const canLeaveTerms = projection.problem === null

  const submit = async (activateNow: boolean) => {
    const schema = buildAgreementSchema(currency)
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
      const agreement = await create.mutateAsync(parsed.data)
      setCreatedId(agreement.id)

      if (activateNow) {
        // Activation writes the schedule and flips the status in one
        // transaction, so an agreement is never live without its obligations.
        await activate.mutateAsync()
        toast.success('Financing recorded', 'The payment schedule is ready.')
      } else {
        toast.success('Saved as a draft', 'Terms can still be corrected freely.')
      }

      void navigate(financingDetailPath(agreement.id))
    } catch (failure) {
      setErrors({ form: toErrorMessage(failure) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Add financing"
        eyebrow="Finance"
        description="A loan, a lease or an instalment plan against one vehicle."
        actions={
          <ButtonLink variant="ghost" leadingIcon={<X />} to={paths.financing}>
            Cancel
          </ButtonLink>
        }
      />

      {/* Progress. Numbered because these steps genuinely are a sequence. */}
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {STEPS.map((entry, index) => (
          <li key={entry.key} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => index <= stepIndex && setStep(entry.key)}
              disabled={index > stepIndex}
              className={cn(
                'flex items-center gap-1.5 rounded px-2 py-1 text-[0.8125rem] transition-colors',
                'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-1',
                index === stepIndex
                  ? 'bg-brand-50 text-brand-700 font-medium'
                  : index < stepIndex
                    ? 'text-ink-muted hover:text-ink'
                    : 'text-ink-subtle cursor-not-allowed',
              )}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem]',
                  index < stepIndex
                    ? 'bg-positive-100 text-positive-700'
                    : index === stepIndex
                      ? 'bg-brand-600 text-white'
                      : 'bg-surface-inset text-ink-subtle',
                )}
              >
                {index < stepIndex ? <Check className="size-3" aria-hidden="true" /> : index + 1}
              </span>
              {entry.label}
            </button>
            {index < STEPS.length - 1 ? (
              <span className="text-ink-subtle" aria-hidden="true">
                ›
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="max-w-3xl space-y-4">
        {/* ------------------------------------------------------- 1. vehicle */}
        {step === 'vehicle' ? (
          <Card>
            <CardHeader
              title="Which vehicle"
              description="Financing in this product belongs to one car."
            />
            <CardBody className="space-y-4">
              <Field
                label="Vehicle"
                required
                {...(errors.vehicleId ? { error: errors.vehicleId } : {})}
              >
                <Select
                  value={values.vehicleId}
                  placeholder="Choose a vehicle"
                  onChange={(event) => patch({ vehicleId: event.target.value })}
                  options={vehicles.map((row) => ({
                    value: row.id,
                    label: `${row.make} ${row.model} · ${row.registration_plate}${
                      row.archived_at ? ' (retired)' : ''
                    }`,
                  }))}
                />
              </Field>

              <p className="text-ink-subtle text-[0.75rem] leading-5">
                What the vehicle cost to buy is recorded on the vehicle itself, not here — a car
                bought outright needs no agreement at all. This is only for money borrowed against
                it.
              </p>
            </CardBody>
          </Card>
        ) : null}

        {/* -------------------------------------------------------- 2. lender */}
        {step === 'lender' ? (
          <Card>
            <CardHeader
              title="Who lent the money"
              description="And what kind of agreement it is."
            />
            <CardBody className="space-y-4">
              <Field
                label="Lender"
                required
                {...(errors.lenderId ? { error: errors.lenderId } : {})}
              >
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Select
                      value={values.lenderId}
                      placeholder="Choose a lender"
                      onChange={(event) => patch({ lenderId: event.target.value })}
                      options={lenders.map((row) => ({ value: row.id, label: row.name }))}
                    />
                  </div>
                  {canManageLenders ? (
                    <Button
                      variant="secondary"
                      leadingIcon={<Plus />}
                      onClick={() => setShowLenders(true)}
                    >
                      New
                    </Button>
                  ) : null}
                </div>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Kind of agreement" required>
                  <Select
                    value={values.agreementType}
                    onChange={(event) =>
                      patch({
                        agreementType: event.target.value as AgreementFormInput['agreementType'],
                      })
                    }
                    options={AGREEMENT_TYPES.map((type) => ({
                      value: type,
                      label: AGREEMENT_TYPE_LABELS[type],
                    }))}
                  />
                </Field>

                <Field label="Agreement number" hint="Optional — the lender’s own reference.">
                  <Input
                    value={values.reference ?? ''}
                    maxLength={96}
                    onChange={(event) => patch({ reference: event.target.value })}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Currency"
                  required
                  hint="The currency the lender is paid in."
                  {...(errors.currency ? { error: errors.currency } : {})}
                >
                  <Input
                    value={values.currency}
                    maxLength={3}
                    className="uppercase"
                    onChange={(event) => patch({ currency: event.target.value.toUpperCase() })}
                  />
                </Field>

                <Field
                  label="Agreement starts"
                  required
                  {...(errors.startsOn ? { error: errors.startsOn } : {})}
                >
                  <Input
                    type="date"
                    value={values.startsOn}
                    onChange={(event) => patch({ startsOn: event.target.value })}
                  />
                </Field>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {/* --------------------------------------------------------- 3. terms */}
        {step === 'terms' ? (
          <>
            <Card>
              <CardHeader
                title="What do you know about this agreement?"
                description="Answer honestly — the application works from what you have, and does not invent the rest."
              />
              <CardBody className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  {(['simple', 'amortizing'] as const).map((mode) => {
                    const isActive = values.mode === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => patch({ mode })}
                        className={cn(
                          'border-line rounded-md border px-3 py-3 text-start transition-colors',
                          'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-1',
                          isActive
                            ? 'border-brand-400 bg-brand-50/60'
                            : 'hover:border-line-strong bg-surface',
                        )}
                      >
                        <span
                          className={cn(
                            'block text-[0.875rem] font-medium',
                            isActive ? 'text-brand-700' : 'text-ink',
                          )}
                        >
                          {MODE_LABELS[mode]}
                        </span>
                        <span className="text-ink-subtle mt-1 block text-[0.75rem] leading-5">
                          {MODE_HINTS[mode]}
                        </span>
                      </button>
                    )
                  })}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="First payment due"
                    required
                    hint="The day of the month this falls on anchors the whole schedule."
                    {...(errors.firstPaymentOn ? { error: errors.firstPaymentOn } : {})}
                  >
                    <Input
                      type="date"
                      value={values.firstPaymentOn}
                      onChange={(event) => patch({ firstPaymentOn: event.target.value })}
                    />
                  </Field>

                  <Field label="How often" required>
                    <Select
                      value={values.paymentFrequency}
                      onChange={(event) =>
                        patch({
                          paymentFrequency: event.target
                            .value as AgreementFormInput['paymentFrequency'],
                        })
                      }
                      options={FREQUENCIES.map((frequency) => ({
                        value: frequency,
                        label: FREQUENCY_LABELS[frequency],
                      }))}
                    />
                  </Field>
                </div>

                {values.mode === 'simple' ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label={`Each payment (${currency})`}
                      required
                      {...(errors.installmentAmount ? { error: errors.installmentAmount } : {})}
                    >
                      <Input
                        value={values.installmentAmount ?? ''}
                        inputMode="decimal"
                        placeholder="4300.00"
                        onChange={(event) => patch({ installmentAmount: event.target.value })}
                      />
                    </Field>

                    <Field
                      label="Number of payments"
                      required
                      {...(errors.installmentsCount ? { error: errors.installmentsCount } : {})}
                    >
                      <Input
                        value={values.installmentsCount ?? ''}
                        inputMode="numeric"
                        placeholder="48"
                        onChange={(event) => patch({ installmentsCount: event.target.value })}
                      />
                    </Field>
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field
                      label={`Amount financed (${currency})`}
                      required
                      {...(errors.financedAmount ? { error: errors.financedAmount } : {})}
                    >
                      <Input
                        value={values.financedAmount ?? ''}
                        inputMode="decimal"
                        placeholder="150000.00"
                        onChange={(event) => patch({ financedAmount: event.target.value })}
                      />
                    </Field>

                    <Field
                      label="Annual rate"
                      required
                      hint="As written on the contract."
                      {...(errors.rateBps ? { error: errors.rateBps } : {})}
                    >
                      <Input
                        value={rateInput}
                        inputMode="decimal"
                        placeholder="7.25"
                        suffix="%"
                        onChange={(event) => {
                          setRateInput(event.target.value)
                          patch({ rateBps: parseRatePercent(event.target.value) })
                        }}
                      />
                    </Field>

                    <Field
                      label="Number of payments"
                      required
                      {...(errors.installmentsCount ? { error: errors.installmentsCount } : {})}
                    >
                      <Input
                        value={values.installmentsCount ?? ''}
                        inputMode="numeric"
                        placeholder="48"
                        onChange={(event) => patch({ installmentsCount: event.target.value })}
                      />
                    </Field>
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-3">
                  {values.mode === 'amortizing' ? (
                    <Field
                      label={`Contract payment (${currency})`}
                      hint="Optional. If the contract states one, it wins over our arithmetic."
                    >
                      <Input
                        value={values.installmentAmount ?? ''}
                        inputMode="decimal"
                        placeholder={
                          projection.computedPaymentMinor !== null
                            ? formatMoney(projection.computedPaymentMinor, currency, {
                                locale: organization.locale,
                              })
                            : '0.00'
                        }
                        onChange={(event) => patch({ installmentAmount: event.target.value })}
                      />
                    </Field>
                  ) : (
                    <Field
                      label={`Amount financed (${currency})`}
                      hint="Optional. Without it there is no principal balance to derive."
                    >
                      <Input
                        value={values.financedAmount ?? ''}
                        inputMode="decimal"
                        onChange={(event) => patch({ financedAmount: event.target.value })}
                      />
                    </Field>
                  )}

                  <Field
                    label={`Down payment (${currency})`}
                    hint="Optional. Paid to the seller, not to the lender."
                  >
                    <Input
                      value={values.downPayment ?? ''}
                      inputMode="decimal"
                      onChange={(event) => patch({ downPayment: event.target.value })}
                    />
                  </Field>

                  <Field
                    label={`Final / balloon payment (${currency})`}
                    hint="Optional. Shown as its own obligation, never hidden in the last payment."
                    {...(errors.balloon ? { error: errors.balloon } : {})}
                  >
                    <Input
                      value={values.balloon ?? ''}
                      inputMode="decimal"
                      onChange={(event) => patch({ balloon: event.target.value })}
                    />
                  </Field>
                </div>

                {projection.contractDiffersBy !== null && projection.contractDiffersBy !== 0 ? (
                  <Alert tone="info" title="The contract’s payment differs from the calculation">
                    Our arithmetic gives{' '}
                    {formatMoney(projection.computedPaymentMinor ?? 0, currency, {
                      locale: organization.locale,
                    })}
                    ; the contract says{' '}
                    {formatMoney(toMinor(values.installmentAmount) ?? 0, currency, {
                      locale: organization.locale,
                    })}
                    . That happens for entirely ordinary reasons — the lender’s rounding, a fee
                    folded in, an irregular first period. The contract is what you pay, so the
                    schedule below uses it and the final payment absorbs the difference.
                  </Alert>
                ) : null}

                {projection.problem === 'payment-below-interest' ? (
                  <Alert tone="critical" title="These terms do not repay the loan">
                    A payment of{' '}
                    {formatMoney(toMinor(values.installmentAmount) ?? 0, currency, {
                      locale: organization.locale,
                    })}{' '}
                    does not cover the interest at this rate, so the balance would never fall. Check
                    the rate, the term or the payment.
                  </Alert>
                ) : null}

                {projection.problem === 'balloon-too-large' ? (
                  <Alert tone="critical" title="The final payment is too large">
                    A balloon cannot be as large as the amount financed.
                  </Alert>
                ) : null}
              </CardBody>
            </Card>

            {projection.rows.length > 0 ? (
              <SchedulePreview
                rows={projection.rows}
                currency={currency}
                locale={organization.locale}
                totals={totals}
              />
            ) : null}
          </>
        ) : null}

        {/* -------------------------------------------------------- 4. review */}
        {step === 'review' ? (
          <>
            <Card>
              <CardHeader title="Check this over" />
              <CardBody>
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Fact label="Vehicle">
                    {vehicle
                      ? `${vehicle.make} ${vehicle.model} · ${vehicle.registration_plate}`
                      : '—'}
                  </Fact>
                  <Fact label="Lender">{lender?.name ?? '—'}</Fact>
                  <Fact label="Agreement">
                    {AGREEMENT_TYPE_LABELS[values.agreementType]}
                    {values.reference ? ` · ${values.reference}` : ''}
                  </Fact>
                  <Fact label="Recorded as">{MODE_LABELS[values.mode]}</Fact>
                  <Fact label="Payments">
                    {totals.installmentCount} · {FREQUENCY_LABELS[values.paymentFrequency]}
                  </Fact>
                  <Fact label="Total scheduled">
                    {formatMoney(totals.totalMinor, currency, { locale: organization.locale })}
                  </Fact>
                  {values.mode === 'amortizing' ? (
                    <>
                      <Fact label="Amount financed">
                        {formatMoney(toMinor(values.financedAmount) ?? 0, currency, {
                          locale: organization.locale,
                        })}
                      </Fact>
                      <Fact label="Rate">{formatRate(values.rateBps) ?? 'Not recorded'}</Fact>
                    </>
                  ) : null}
                </dl>
              </CardBody>
            </Card>

            {/* The honesty statement. This is the most important thing on the
                page: what the product will be able to tell them afterwards. */}
            <Card>
              <CardHeader title="What this will and will not be able to tell you" />
              <CardBody>
                <ul className="space-y-2.5">
                  <Knowable known label="What is due, and when">
                    Every payment above becomes an obligation with a date, so overdue and due-soon
                    are answerable from the moment you save.
                  </Knowable>
                  <Knowable known label="What you have actually paid">
                    Recorded payment by payment, and reversible by voiding rather than deleting.
                  </Knowable>
                  <Knowable
                    known={values.mode === 'amortizing' || Boolean(values.financedAmount)}
                    label="Principal still owed"
                  >
                    {values.mode === 'amortizing' || values.financedAmount
                      ? 'The amount financed is known, so the balance falls as principal is repaid.'
                      : 'The amount financed was not recorded, so there is no balance to derive. Add it above if you know it.'}
                  </Knowable>
                  <Knowable
                    known={values.mode === 'amortizing'}
                    label="Interest, and what it costs"
                  >
                    {values.mode === 'amortizing'
                      ? 'The schedule splits every payment, and a recorded split makes the financing cost exact.'
                      : 'Nothing here says how much of each payment is interest. Payments will be recorded as unallocated until somebody enters the split, and the financing cost will read as not fully known rather than as zero.'}
                  </Knowable>
                </ul>
              </CardBody>
            </Card>

            {errors.form ? (
              <Alert tone="critical" title="This was not saved">
                <span className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {errors.form}
                </span>
              </Alert>
            ) : null}
          </>
        ) : null}

        {/* ---------------------------------------------------------- footer */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            leadingIcon={<ArrowLeft />}
            disabled={stepIndex === 0}
            onClick={() => setStep(STEPS[stepIndex - 1]!.key)}
          >
            Back
          </Button>

          {step === 'review' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => void submit(false)}
                isLoading={create.isPending && !activate.isPending}
              >
                Save as draft
              </Button>
              <Button
                variant="primary"
                leadingIcon={<Check />}
                onClick={() => void submit(true)}
                isLoading={create.isPending || activate.isPending}
              >
                Save and activate
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              trailingIcon={<ArrowRight />}
              disabled={
                (step === 'vehicle' && !canLeaveVehicle) ||
                (step === 'lender' && !canLeaveLender) ||
                (step === 'terms' && !canLeaveTerms)
              }
              onClick={() => setStep(STEPS[stepIndex + 1]!.key)}
            >
              Continue
            </Button>
          )}
        </div>

        <Field label="Notes" hint="Anything worth remembering about this agreement.">
          <Textarea
            rows={2}
            maxLength={2000}
            value={values.notes ?? ''}
            onChange={(event) => patch({ notes: event.target.value })}
          />
        </Field>
      </div>

      <LenderManager
        open={showLenders}
        onOpenChange={setShowLenders}
        canManage={canManageLenders}
      />
    </div>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-subtle text-[0.75rem]">{label}</dt>
      <dd className="text-ink mt-0.5 text-[0.8125rem]">{children}</dd>
    </div>
  )
}

function Knowable({
  known,
  label,
  children,
}: {
  known: boolean
  label: string
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
          known ? 'bg-positive-100 text-positive-700' : 'bg-surface-inset text-ink-subtle',
        )}
        aria-hidden="true"
      >
        {known ? <Check className="size-2.5" /> : <CircleHelp className="size-2.5" />}
      </span>
      <span className="min-w-0">
        <span className="text-ink block text-[0.8125rem] font-medium">{label}</span>
        <span className="text-ink-muted block text-[0.75rem] leading-5">{children}</span>
      </span>
    </li>
  )
}

function SchedulePreview({
  rows,
  currency,
  locale,
  totals,
}: {
  rows: readonly FinancingProjectedInstallment[]
  currency: string
  locale: string
  totals: ReturnType<typeof scheduleTotals>
}) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? rows : rows.slice(0, 6)
  const splitKnown = totals.principalMinor !== null

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="The payments this creates"
        description={`${totals.installmentCount} payments · ${formatMoney(totals.totalMinor, currency, { locale })} in total`}
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.8125rem]">
          <thead>
            <tr className="border-line bg-surface-muted border-b">
              <th scope="col" className="eyebrow w-10 px-4 py-2 text-start">
                #
              </th>
              <th scope="col" className="eyebrow px-3 py-2 text-start">
                Due
              </th>
              <th scope="col" className="eyebrow px-3 py-2 text-end">
                Payment
              </th>
              {splitKnown ? (
                <>
                  <th scope="col" className="eyebrow px-3 py-2 text-end">
                    Principal
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-end">
                    Interest
                  </th>
                  <th scope="col" className="eyebrow px-4 py-2 text-end">
                    Balance after
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {visible.map((row) => (
              <tr key={row.sequence}>
                <td data-numeric="" className="text-ink-subtle px-4 py-1.5">
                  {row.sequence}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {formatDate(new Date(`${row.due_on}T00:00:00Z`), { locale, timeZone: 'UTC' })}
                  {row.is_balloon ? (
                    <span className="text-caution-700 ms-2 text-[0.6875rem]">balloon</span>
                  ) : null}
                </td>
                <td data-numeric="" className="text-ink px-3 py-1.5 text-end whitespace-nowrap">
                  {formatMoney(row.expected_total_minor, currency, { locale })}
                </td>
                {splitKnown ? (
                  <>
                    <td
                      data-numeric=""
                      className="text-ink-muted px-3 py-1.5 text-end whitespace-nowrap"
                    >
                      {formatMoney(row.expected_principal_minor ?? 0, currency, { locale })}
                    </td>
                    <td
                      data-numeric=""
                      className="text-ink-muted px-3 py-1.5 text-end whitespace-nowrap"
                    >
                      {formatMoney(row.expected_interest_minor ?? 0, currency, { locale })}
                    </td>
                    <td
                      data-numeric=""
                      className="text-ink-muted px-4 py-1.5 text-end whitespace-nowrap"
                    >
                      {formatMoney(row.remaining_principal_minor ?? 0, currency, { locale })}
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > visible.length ? (
        <div className="border-line border-t px-4 py-2 text-center">
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            Show all {rows.length} payments
          </Button>
        </div>
      ) : null}

      <div className="border-line text-ink-subtle border-t px-4 py-2.5 text-[0.75rem] leading-5">
        {splitKnown ? (
          <>
            Interest over the whole agreement:{' '}
            {formatMoney(totals.interestMinor ?? 0, currency, { locale })}. That is the cost of
            borrowing; the principal is money returned, not money spent.
          </>
        ) : (
          <>
            These are cash obligations. How much of each is interest is not recorded, so it is not
            shown — and not guessed at.
          </>
        )}
      </div>
    </Card>
  )
}
