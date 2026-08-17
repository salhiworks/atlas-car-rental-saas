import { ArrowLeft, Ban, CheckCircle2, CircleHelp, Play, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { paths, vehicleDetailPath } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui'
import { FinancingDocuments } from '@/features/financing/components/FinancingDocuments'
import { FinancingHistory } from '@/features/financing/components/FinancingHistory'
import {
  AgreementStatusBadge,
  ModeBadge,
  MoneyFact,
} from '@/features/financing/components/FinancingBadges'
import { PaymentDialog } from '@/features/financing/components/PaymentDialog'
import { PaymentList } from '@/features/financing/components/PaymentList'
import { ScheduleTable } from '@/features/financing/components/ScheduleTable'
import {
  AGREEMENT_STATUS_HINTS,
  AGREEMENT_TYPE_LABELS,
  FREQUENCY_LABELS,
  costExplanation,
  describeTerm,
  formatRate,
  paymentBlockedReason,
  payoffBlockedReason,
  principalExplanation,
  principalState,
  termsFrozenReason,
} from '@/features/financing/domain'
import {
  useActivateAgreement,
  useAgreement,
  useAgreementPayments,
  useCloseAgreement,
  useDeleteAgreement,
  useFinancingChanges,
  useSchedule,
  useVoidPayment,
} from '@/features/financing/queries'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatDate } from '@/lib/datetime/format'
import { toIsoDateInTimeZone } from '@/lib/datetime/timezone'
import { formatMoney } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { FinancingInstallmentStatus, FinancingPayment } from '@/types/database'

/**
 * One financing agreement, in full.
 *
 * The order is the order the questions arrive: where does this stand, what were
 * the terms, what is owed and when, what has actually been paid, and what
 * paperwork backs it up.
 *
 * Every figure that cannot honestly be stated says so. That is not a limitation
 * of the page — it is the product's position on financing, and it is visible.
 */
export function FinancingDetailPage() {
  const { financingId } = useParams<{ financingId: string }>()
  const organization = useOrganization()
  const navigate = useNavigate()
  const toast = useToast()

  const canManage = usePermission('financing.update')
  const canRecordPayments = usePermission('financingPayments.create')
  const canVoidPayments = usePermission('financingPayments.void')
  const canManageDocuments = usePermission('financingDocuments.create')
  const canDelete = usePermission('financing.delete')

  const agreementQuery = useAgreement(financingId)
  const scheduleQuery = useSchedule(financingId)
  const paymentsQuery = useAgreementPayments(financingId)
  const changesQuery = useFinancingChanges(financingId)

  const activate = useActivateAgreement(financingId ?? '')
  const close = useCloseAgreement(financingId ?? '')
  const voidPayment = useVoidPayment()
  const removeAgreement = useDeleteAgreement()

  const [payFor, setPayFor] = useState<FinancingInstallmentStatus | null | undefined>(undefined)
  const [voidTarget, setVoidTarget] = useState<FinancingPayment | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [closing, setClosing] = useState(false)
  const [closeStatus, setCloseStatus] = useState<'paid_off' | 'closed' | 'cancelled'>('closed')
  const [closeReason, setCloseReason] = useState('')
  const [deleting, setDeleting] = useState(false)

  const locale = organization.locale
  const timeZone = organization.time_zone
  const todayIso = toIsoDateInTimeZone(new Date(), timeZone)

  if (agreementQuery.isError) {
    return (
      <Card>
        <ErrorState
          title="This agreement could not be found"
          error={agreementQuery.error}
          onRetry={() => void agreementQuery.refetch()}
        />
      </Card>
    )
  }

  const agreement = agreementQuery.data

  if (!agreement || !financingId) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardBody>
        </Card>
      </div>
    )
  }

  const money = (minor: number) => formatMoney(minor, agreement.currency, { locale })
  const installments = scheduleQuery.data ?? []
  const payments = paymentsQuery.data ?? []

  const principal = principalState(agreement)
  const frozenReason = termsFrozenReason(agreement)
  const payoffBlocked = payoffBlockedReason(agreement)
  const paymentBlocked = paymentBlockedReason(agreement)

  const isDraft = agreement.agreement_status === 'draft'

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={paths.financing}
          className="text-ink-subtle hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem] transition-colors"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All financing
        </Link>
      </div>

      <PageHeader
        title={`${agreement.vehicle_make} ${agreement.vehicle_model}`}
        eyebrow="Financing"
        description={
          <span className="flex flex-wrap items-center gap-x-2">
            <Link
              to={vehicleDetailPath(agreement.vehicle_id)}
              className="identifier text-ink hover:underline"
            >
              {agreement.vehicle_plate}
            </Link>
            <span>· {agreement.lender_name}</span>
            <span>· {AGREEMENT_TYPE_LABELS[agreement.agreement_type]}</span>
            {agreement.reference ? <span>· {agreement.reference}</span> : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isDraft && canManage ? (
              <Button
                variant="primary"
                leadingIcon={<Play />}
                isLoading={activate.isPending}
                onClick={() =>
                  void activate
                    .mutateAsync()
                    .then(() => toast.success('Agreement activated', 'Its schedule is ready.'))
                    .catch((failure: unknown) =>
                      toast.error('Could not activate this agreement', toErrorMessage(failure)),
                    )
                }
              >
                Activate
              </Button>
            ) : null}

            {canRecordPayments && !paymentBlocked ? (
              <Button variant="secondary" onClick={() => setPayFor(null)}>
                Record a payment
              </Button>
            ) : null}

            {canManage && agreement.agreement_status === 'active' ? (
              <Button variant="ghost" onClick={() => setClosing(true)}>
                End agreement
              </Button>
            ) : null}

            {isDraft && canDelete && agreement.payment_count === 0 ? (
              <Button variant="ghost" leadingIcon={<Trash2 />} onClick={() => setDeleting(true)}>
                Delete draft
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <AgreementStatusBadge status={agreement.agreement_status} />
        <ModeBadge mode={agreement.mode} />
        {agreement.vehicle_archived ? <Badge tone="neutral">Vehicle retired</Badge> : null}
        {agreement.lender_archived ? <Badge tone="neutral">Lender retired</Badge> : null}
        <span className="text-ink-subtle text-[0.75rem]">
          {AGREEMENT_STATUS_HINTS[agreement.agreement_status]}
        </span>
      </div>

      {agreement.overdue_minor > 0 ? (
        <Alert tone="critical" title={`${money(agreement.overdue_minor)} overdue`}>
          {agreement.overdue_count} payment{agreement.overdue_count === 1 ? ' is' : 's are'} past
          due. The vehicle being retired from the fleet would not change that — an obligation
          outlives the car.
        </Alert>
      ) : null}

      {isDraft ? (
        <Alert tone="info" title="This is a draft">
          No schedule exists and no payment can be recorded yet. Terms can be corrected freely until
          it is activated.
        </Alert>
      ) : null}

      {agreement.closure_reason ? (
        <Alert tone="info" title="Why this agreement ended">
          {agreement.closure_reason}
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-5">
          {/* ------------------------------------------------ current position */}
          <Card>
            <CardHeader
              title="Where this stands"
              description="Cash, cost and balance are three different questions."
            />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
                <Position
                  label="Principal still owed"
                  hint={principalExplanation(principal)}
                  value={
                    <MoneyFact
                      amountMinor={agreement.remaining_principal_minor}
                      currency={agreement.currency}
                      locale={locale}
                      state={principal}
                      reason={principalExplanation(principal)}
                      emphasis
                    />
                  }
                />
                <Position
                  label="Paid to the lender"
                  hint="Every payment recorded against this agreement, whatever it was for. Cash out, not a cost."
                  value={
                    <span data-numeric="" className="text-ink text-[0.9375rem] font-semibold">
                      {money(agreement.cash_paid_minor)}
                    </span>
                  }
                />
                <Position
                  label="Financing cost"
                  hint={costExplanation(agreement.cost_complete)}
                  value={
                    <MoneyFact
                      amountMinor={agreement.financing_cost_minor}
                      currency={agreement.currency}
                      locale={locale}
                      state={agreement.cost_complete ? 'known' : 'incomplete'}
                      reason={costExplanation(agreement.cost_complete)}
                      emphasis
                    />
                  }
                />

                <Position
                  label="Principal repaid"
                  value={<span data-numeric="">{money(agreement.principal_paid_minor)}</span>}
                />
                <Position
                  label="Interest paid"
                  value={<span data-numeric="">{money(agreement.interest_paid_minor)}</span>}
                />
                <Position
                  label="Fees paid"
                  value={<span data-numeric="">{money(agreement.fees_paid_minor)}</span>}
                />

                {agreement.unallocated_minor > 0 ? (
                  <Position
                    label="Unallocated"
                    hint="Cash that reached the lender without anybody recording how it was split. It is not interest and it does not reduce the balance."
                    value={
                      <span data-numeric="" className="text-caution-700">
                        {money(agreement.unallocated_minor)}
                      </span>
                    }
                  />
                ) : null}

                <Position
                  label="Still scheduled"
                  hint="What the schedule still expects. An obligation, not money spent."
                  value={<span data-numeric="">{money(agreement.remaining_scheduled_minor)}</span>}
                />

                <Position
                  label="Next payment"
                  value={
                    agreement.next_due_on ? (
                      <>
                        {formatDate(new Date(`${agreement.next_due_on}T00:00:00Z`), {
                          locale,
                          timeZone: 'UTC',
                        })}
                        {agreement.next_due_minor !== null ? (
                          <span data-numeric="" className="text-ink-subtle ms-2">
                            {money(agreement.next_due_minor)}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-ink-subtle">Nothing scheduled</span>
                    )
                  }
                />
              </dl>

              <p className="text-ink-subtle border-line mt-4 border-t pt-3 text-[0.75rem] leading-5">
                None of these figures is profit, and none of them reaches the operating result on
                the dashboard. Repaying principal settles a debt rather than spending money; only
                interest and fees are the price of borrowing.
              </p>
            </CardBody>
          </Card>

          {/* -------------------------------------------------------- schedule */}
          <Card className="overflow-hidden">
            <CardHeader
              title="Payment schedule"
              description={
                agreement.installment_rows > 0
                  ? `${agreement.installment_rows} payments · ${money(agreement.scheduled_total_minor)} in total`
                  : 'Generated when the agreement is activated.'
              }
            />
            <ScheduleTable
              installments={installments}
              currency={agreement.currency}
              locale={locale}
              isLoading={scheduleQuery.isPending}
              canRecord={canRecordPayments && !paymentBlocked}
              onRecordPayment={(installment) => setPayFor(installment)}
            />
          </Card>

          {/* -------------------------------------------------------- payments */}
          <Card className="overflow-hidden">
            <CardHeader
              title="Payments made"
              description="What actually left the account, and how it was split."
            />
            <PaymentList
              payments={payments}
              locale={locale}
              isLoading={paymentsQuery.isPending}
              canVoid={canVoidPayments}
              onVoid={(payment) => {
                setVoidTarget(payment)
                setVoidReason('')
              }}
            />
          </Card>

          <FinancingDocuments
            agreementId={agreement.id}
            canManage={canManageDocuments}
            locale={locale}
            timeZone={timeZone}
          />
        </div>

        {/* ---------------------------------------------------------- sidebar */}
        <aside className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Terms" />
            <CardBody>
              <dl className="space-y-3">
                <Term label="Amount financed">
                  {agreement.financed_amount_minor === null ? (
                    <span className="text-ink-subtle inline-flex items-center gap-1">
                      <CircleHelp className="size-3.5" aria-hidden="true" />
                      Not recorded
                    </span>
                  ) : (
                    money(agreement.financed_amount_minor)
                  )}
                </Term>
                <Term label="Down payment">
                  {agreement.down_payment_amount_minor === null
                    ? '—'
                    : money(agreement.down_payment_amount_minor)}
                </Term>
                <Term label="Rate">
                  {formatRate(agreement.rate_bps) ?? (
                    <span className="text-ink-subtle inline-flex items-center gap-1">
                      <CircleHelp className="size-3.5" aria-hidden="true" />
                      Not recorded
                    </span>
                  )}
                </Term>
                <Term label="Payment">
                  {agreement.installment_amount_minor === null
                    ? '—'
                    : `${money(agreement.installment_amount_minor)} · ${FREQUENCY_LABELS[agreement.payment_frequency].toLowerCase()}`}
                </Term>
                <Term label="Term">
                  {describeTerm(agreement.installments_count, agreement.payment_frequency) ?? '—'}
                </Term>
                {agreement.balloon_minor !== null ? (
                  <Term label="Final payment">{money(agreement.balloon_minor)}</Term>
                ) : null}
                <Term label="Starts">
                  {formatDate(new Date(`${agreement.starts_on}T00:00:00Z`), {
                    locale,
                    timeZone: 'UTC',
                  })}
                </Term>
                <Term label="Ends">
                  {agreement.ends_on
                    ? formatDate(new Date(`${agreement.ends_on}T00:00:00Z`), {
                        locale,
                        timeZone: 'UTC',
                      })
                    : '—'}
                </Term>
                {agreement.payoff_on ? (
                  <Term label="Paid off">
                    {formatDate(new Date(`${agreement.payoff_on}T00:00:00Z`), {
                      locale,
                      timeZone: 'UTC',
                    })}
                  </Term>
                ) : null}
              </dl>

              {frozenReason ? (
                <p className="text-ink-subtle border-line mt-4 border-t pt-3 text-[0.75rem] leading-5">
                  {frozenReason}
                </p>
              ) : null}

              {agreement.notes ? (
                <div className="border-line mt-4 border-t pt-3">
                  <p className="text-ink-subtle text-[0.75rem]">Notes</p>
                  <p className="text-ink mt-1 text-[0.8125rem] whitespace-pre-wrap">
                    {agreement.notes}
                  </p>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="History" description="What has been corrected, and by whom." />
            <CardBody>
              <FinancingHistory
                events={changesQuery.data ?? []}
                currency={agreement.currency}
                locale={locale}
                timeZone={timeZone}
              />
            </CardBody>
          </Card>
        </aside>
      </div>

      {/* ---------------------------------------------------------- dialogs */}
      {payFor !== undefined ? (
        <PaymentDialog
          open
          onOpenChange={(open) => (open ? undefined : setPayFor(undefined))}
          agreement={agreement}
          installments={installments}
          installment={payFor}
          locale={locale}
          todayIso={todayIso}
        />
      ) : null}

      <ConfirmDialog
        open={voidTarget !== null}
        onOpenChange={(open) => (open ? undefined : setVoidTarget(null))}
        title="Void this payment"
        description="It stops counting towards cash paid, principal repaid and financing cost, and the instalment it settled reopens. Nothing is deleted."
        confirmLabel="Void payment"
        isPending={voidPayment.isPending}
        onConfirm={() => {
          if (!voidTarget) return
          void voidPayment
            .mutateAsync({ paymentId: voidTarget.id, reason: voidReason.trim() || null })
            .then(() => {
              toast.success('Payment voided', 'It no longer counts towards any total.')
              setVoidTarget(null)
            })
            .catch((failure: unknown) => {
              toast.error('Could not void this payment', toErrorMessage(failure))
            })
        }}
      >
        <Field label="Why" hint="Kept with the record so the correction explains itself.">
          <Input
            value={voidReason}
            maxLength={500}
            onChange={(event) => setVoidReason(event.target.value)}
            placeholder="Posted twice"
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={closing}
        onOpenChange={(open) => {
          setClosing(open)
          if (!open) setCloseReason('')
        }}
        title="End this agreement"
        confirmLabel="End agreement"
        tone={closeStatus === 'paid_off' ? 'primary' : 'danger'}
        isPending={close.isPending}
        onConfirm={() => {
          void close
            .mutateAsync({
              status: closeStatus,
              reason: closeReason.trim() || null,
              payoffOn: closeStatus === 'paid_off' ? todayIso : null,
            })
            .then(() => {
              toast.success('Agreement ended')
              setClosing(false)
              setCloseReason('')
            })
            .catch((failure: unknown) => {
              toast.error('Could not end this agreement', toErrorMessage(failure))
            })
        }}
      >
        <div className="space-y-3">
          <Field label="How it ended">
            <Select
              value={closeStatus}
              onChange={(event) =>
                setCloseStatus(event.target.value as 'paid_off' | 'closed' | 'cancelled')
              }
              options={[
                { value: 'paid_off', label: 'Paid off — every obligation was met' },
                { value: 'closed', label: 'Closed — ended for another reason' },
                { value: 'cancelled', label: 'Cancelled — never came into effect' },
              ]}
            />
          </Field>

          {closeStatus === 'paid_off' && payoffBlocked ? (
            <Alert tone="caution" title="This cannot be marked paid off yet">
              <span className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {payoffBlocked} Record the remaining payments, or close it with a reason instead.
              </span>
            </Alert>
          ) : null}

          {closeStatus === 'paid_off' && !payoffBlocked ? (
            <Alert tone="positive" title="Everything scheduled has been settled">
              <span className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                This agreement can honestly be recorded as paid off.
              </span>
            </Alert>
          ) : null}

          {closeStatus !== 'paid_off' ? (
            <Field label="Why" hint="Kept on the record. Required.">
              <Input
                value={closeReason}
                maxLength={500}
                onChange={(event) => setCloseReason(event.target.value)}
                placeholder="Refinanced with another bank"
              />
            </Field>
          ) : null}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this draft"
        description="It has no payments against it, so nothing financial is lost. An agreement with any history is closed instead."
        confirmLabel="Delete draft"
        isPending={removeAgreement.isPending}
        onConfirm={() => {
          void removeAgreement
            .mutateAsync(agreement.id)
            .then(() => {
              toast.success('Draft deleted')
              void navigate(paths.financing, { replace: true })
            })
            .catch((failure: unknown) => {
              setDeleting(false)
              toast.error('Could not delete this draft', toErrorMessage(failure))
            })
        }}
      />

      {paymentBlocked && canRecordPayments ? (
        <p className="text-ink-subtle flex items-center gap-1.5 text-[0.75rem]">
          <Ban className="size-3.5 shrink-0" aria-hidden="true" />
          {paymentBlocked}
        </p>
      ) : null}
    </div>
  )
}

function Position({
  label,
  hint,
  value,
}: {
  label: string
  hint?: string
  value: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-ink-subtle text-[0.75rem]" title={hint}>
        {label}
      </dt>
      <dd className="mt-0.5">{value}</dd>
      {hint ? <p className="text-ink-subtle mt-0.5 text-[0.6875rem] leading-4">{hint}</p> : null}
    </div>
  )
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-subtle shrink-0 text-[0.75rem]">{label}</dt>
      <dd data-numeric="" className="text-ink text-end text-[0.8125rem]">
        {children}
      </dd>
    </div>
  )
}
