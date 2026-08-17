import { AlertTriangle, ArrowRight, Landmark, Pencil, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { financingDetailPath, paths } from '@/app/routes/paths'
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Skeleton,
} from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import {
  addMonthsInTimeZone,
  startOfMonthInTimeZone,
  toIsoDateInTimeZone,
} from '@/lib/datetime/timezone'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { VehicleAcquisitionMethod } from '@/types/database'

import {
  ACQUISITION_METHOD_LABELS,
  AGREEMENT_TYPE_LABELS,
  FREQUENCY_SHORT,
  cashContribution,
  costExplanation,
} from '../domain'
import { useVehicleOperatingSummary } from '@/features/expenses/queries'

import { useVehicleAgreements, useVehicleFinancingSummary } from '../queries'
import { AcquisitionDialog } from './AcquisitionDialog'
import { AgreementStatusBadge, MoneyFact } from './FinancingBadges'

export interface VehicleFinancingPanelProps {
  vehicleId: string
  defaultCurrency: string
  acquisitionMethod: VehicleAcquisitionMethod | null
  acquiredOn: string | null
  acquisitionPriceMinor: number | null
  acquisitionCurrency: string | null
  acquisitionSupplier: string | null
  acquisitionNotes: string | null
  locale: string
  timeZone: string
  canCreate: boolean
  canEditAcquisition?: boolean
  /** Set when the reader may see operating figures, so a cash view can be offered. */
  canViewOperating?: boolean
}

/**
 * A vehicle's financing, on its own page.
 *
 * Concise on purpose: the vehicle page is about the car, not about the loan.
 * What belongs here is what an owner asks while looking at the car — was it
 * financed, who by, what is left, and is anything late — with a link to the
 * agreement for everything else.
 *
 * The last figure is the interesting one. Operating contribution less what
 * actually went to the lender is a genuinely useful cash view, and it is
 * labelled as cash every single time. It is not profit: principal repayment is
 * inside it, and depreciation, overhead and tax are not.
 */
export function VehicleFinancingPanel({
  vehicleId,
  defaultCurrency,
  acquisitionMethod,
  acquiredOn,
  acquisitionPriceMinor,
  acquisitionCurrency,
  acquisitionSupplier,
  acquisitionNotes,
  locale,
  timeZone,
  canCreate,
  canEditAcquisition = false,
  canViewOperating = false,
}: VehicleFinancingPanelProps) {
  const [now] = useState(() => new Date())
  const [editingAcquisition, setEditingAcquisition] = useState(false)

  // The same twelve-month window the running-costs panel uses, so the two
  // figures on this page are about the same period.
  const period = useMemo(() => {
    const start = startOfMonthInTimeZone(now, timeZone)
    return {
      from: toIsoDateInTimeZone(addMonthsInTimeZone(start, timeZone, -11), timeZone),
      to: toIsoDateInTimeZone(addMonthsInTimeZone(start, timeZone, 1), timeZone),
    }
  }, [now, timeZone])

  const agreementsQuery = useVehicleAgreements(vehicleId)
  const summaryQuery = useVehicleFinancingSummary(vehicleId, period.from, period.to)
  // Same window and same key as the running-costs panel, so TanStack serves one
  // request rather than two for the same question.
  const operatingQuery = useVehicleOperatingSummary(
    canViewOperating ? vehicleId : undefined,
    period.from,
    period.to,
  )

  const agreements = agreementsQuery.data ?? []
  const live = agreements.find((agreement) => agreement.agreement_status === 'active')
  const summary = summaryQuery.data ?? []

  const acquisitionDialog = canEditAcquisition ? (
    <AcquisitionDialog
      key={`${acquisitionMethod}-${acquiredOn}-${acquisitionPriceMinor}`}
      open={editingAcquisition}
      onOpenChange={setEditingAcquisition}
      vehicleId={vehicleId}
      defaultCurrency={defaultCurrency}
      current={{
        acquisitionMethod,
        acquiredOn,
        acquisitionPriceMinor,
        acquisitionCurrency,
        acquisitionSupplier,
        acquisitionNotes,
      }}
    />
  ) : null

  const acquisition =
    acquisitionMethod || acquiredOn || acquisitionPriceMinor !== null ? (
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
        <Fact label="Acquired">
          {acquisitionMethod ? ACQUISITION_METHOD_LABELS[acquisitionMethod] : 'Not recorded'}
        </Fact>
        <Fact label="Date">
          {acquiredOn
            ? formatDate(new Date(`${acquiredOn}T00:00:00Z`), { locale, timeZone: 'UTC' })
            : '—'}
        </Fact>
        <Fact label="Price">
          {acquisitionPriceMinor !== null && acquisitionCurrency
            ? formatMoney(acquisitionPriceMinor, acquisitionCurrency, { locale })
            : '—'}
        </Fact>
      </dl>
    ) : canEditAcquisition ? (
      <p className="text-ink-subtle text-[0.8125rem]">
        How this vehicle was acquired has not been recorded.
      </p>
    ) : null

  if (agreementsQuery.isPending) {
    return (
      <Card>
        <CardHeader title="Financing" />
        <CardBody className="space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </CardBody>
      </Card>
    )
  }

  if (agreements.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Financing"
          description="How this vehicle was paid for."
          actions={
            canEditAcquisition ? (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<Pencil />}
                onClick={() => setEditingAcquisition(true)}
              >
                Acquisition
              </Button>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          {acquisition}
          <EmptyState
            icon={Landmark}
            size="sm"
            title={
              acquisitionMethod === 'cash'
                ? 'Bought outright — nothing financed'
                : 'No financing recorded'
            }
            description={
              acquisitionMethod === 'cash'
                ? 'A vehicle paid for in full needs no agreement here.'
                : 'Record a loan, lease or instalment plan to track what is owed and when it is due.'
            }
            action={
              canCreate ? (
                <ButtonLink
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Plus />}
                  to={`${paths.financingNew}?vehicle=${vehicleId}`}
                >
                  Add financing
                </ButtonLink>
              ) : undefined
            }
          />
          <p className="text-ink-subtle text-[0.75rem] leading-4">
            What a vehicle cost to buy is not an operating expense, and neither is a down payment or
            a loan repayment. None of it reaches this vehicle’s running costs.
          </p>
          {acquisitionDialog}
        </CardBody>
      </Card>
    )
  }

  const financing = live ? summary.find((row) => row.currency === live.currency) : undefined
  const operatingRow = live
    ? operatingQuery.data?.find((row) => row.currency === live.currency)
    : undefined
  const cash = cashContribution(operatingRow ?? null, financing ?? null)

  return (
    <Card>
      <CardHeader
        title="Financing"
        description="How this vehicle was paid for, and what is still owed on it."
        actions={
          <div className="flex items-center gap-2">
            {canEditAcquisition ? (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<Pencil />}
                onClick={() => setEditingAcquisition(true)}
              >
                Acquisition
              </Button>
            ) : null}
            {live ? (
              <Link
                to={financingDetailPath(live.id)}
                className="text-ink-muted hover:text-ink inline-flex items-center gap-1 text-[0.8125rem]"
              >
                View agreement
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        }
      />

      <CardBody className="space-y-4">
        {acquisition}

        {live ? (
          <>
            <div className="border-line rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-ink text-[0.875rem] font-medium">{live.lender_name}</span>
                  <span className="text-ink-subtle text-[0.75rem]">
                    {AGREEMENT_TYPE_LABELS[live.agreement_type]}
                    {live.reference ? ` · ${live.reference}` : ''}
                  </span>
                </span>
                <AgreementStatusBadge status={live.agreement_status} />
              </div>

              <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <Fact label="Payment">
                  {live.installment_amount_minor === null
                    ? '—'
                    : `${formatMoney(live.installment_amount_minor, live.currency, { locale })} ${FREQUENCY_SHORT[live.payment_frequency]}`}
                </Fact>
                <Fact label="Next due">
                  {live.next_due_on
                    ? formatDate(new Date(`${live.next_due_on}T00:00:00Z`), {
                        locale,
                        timeZone: 'UTC',
                      })
                    : 'Nothing scheduled'}
                </Fact>
                <Fact label="Principal still owed">
                  <MoneyFact
                    amountMinor={live.remaining_principal_minor}
                    currency={live.currency}
                    locale={locale}
                    state={
                      live.principal_known
                        ? 'known'
                        : live.financed_amount_minor === null
                          ? 'unknown'
                          : 'incomplete'
                    }
                  />
                </Fact>
              </dl>

              {live.overdue_minor > 0 ? (
                <p className="text-critical-700 mt-3 flex items-center gap-1.5 text-[0.8125rem]">
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                  <span data-numeric="" className="font-medium">
                    {formatMoney(live.overdue_minor, live.currency, { locale })}
                  </span>{' '}
                  overdue
                </p>
              ) : null}
            </div>

            {financing ? (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <Fact label="Paid to the lender">
                  <span data-numeric="">
                    {formatMoney(financing.cash_paid_minor, financing.currency, { locale })}
                  </span>
                  <span className="text-ink-subtle block text-[0.6875rem]">last 12 months</span>
                </Fact>
                <Fact label="Interest and fees">
                  <MoneyFact
                    amountMinor={financing.financing_cost_minor}
                    currency={financing.currency}
                    locale={locale}
                    state={financing.cost_complete ? 'known' : 'incomplete'}
                    reason={costExplanation(financing.cost_complete)}
                  />
                  <span className="text-ink-subtle block text-[0.6875rem]">
                    the cost of borrowing
                  </span>
                </Fact>
                {cash ? (
                  <Fact label="Cash after financing">
                    <span
                      data-numeric=""
                      className={cn(
                        'font-semibold',
                        cash.afterFinancingMinor < 0 ? 'text-critical-600' : 'text-ink',
                      )}
                    >
                      {formatMoney(cash.afterFinancingMinor, financing.currency, { locale })}
                    </span>
                    <span className="text-ink-subtle block text-[0.6875rem]">
                      contribution less lender payments
                    </span>
                  </Fact>
                ) : null}
              </dl>
            ) : null}

            {cash ? (
              <p className="text-ink-subtle border-line border-t pt-3 text-[0.75rem] leading-5">
                Cash after financing is{' '}
                {formatMoney(cash.operatingContributionMinor, financing!.currency, { locale })}{' '}
                contribution less{' '}
                {formatMoney(cash.financingCashMinor, financing!.currency, { locale })} paid to the
                lender. It is a <strong className="font-medium">cash</strong> figure for planning,
                not profit: it has principal repayment in it, and depreciation, overhead and tax out
                of it.
              </p>
            ) : financing && canViewOperating ? (
              /*
               * Financing figures exist but operating ones do not — nothing was
               * earned or spent on this car in the window, or the two are in
               * different currencies. Say which, rather than leaving a gap where
               * a figure was expected.
               */
              <p className="text-ink-subtle border-line border-t pt-3 text-[0.75rem] leading-5">
                {operatingRow
                  ? `This agreement is in ${financing.currency} and this vehicle earns in ${operatingRow.currency}. The two are never combined — there is no exchange rate here, and one figure would be a guess.`
                  : 'A cash-after-financing figure needs rental revenue or running costs over the same period, and none is recorded for this vehicle yet.'}
              </p>
            ) : null}
          </>
        ) : null}

        {agreements.filter((agreement) => agreement.agreement_status !== 'active').length > 0 ? (
          <div className="border-line border-t pt-3">
            <p className="eyebrow mb-1.5">Earlier agreements</p>
            <ul className="divide-line divide-y">
              {agreements
                .filter((agreement) => agreement.agreement_status !== 'active')
                .map((agreement) => (
                  <li key={agreement.id} className="flex items-center gap-3 py-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Link
                        to={financingDetailPath(agreement.id)}
                        className="text-ink block truncate text-[0.8125rem] hover:underline"
                      >
                        {agreement.lender_name}
                      </Link>
                      <span className="text-ink-subtle block truncate text-[0.6875rem]">
                        {AGREEMENT_TYPE_LABELS[agreement.agreement_type]} ·{' '}
                        {formatDate(new Date(`${agreement.starts_on}T00:00:00Z`), {
                          locale,
                          timeZone: 'UTC',
                        })}
                        {agreement.closure_reason ? ` · ${agreement.closure_reason}` : ''}
                      </span>
                    </span>
                    <AgreementStatusBadge status={agreement.agreement_status} />
                  </li>
                ))}
            </ul>
          </div>
        ) : null}

        {canCreate && !live ? (
          <ButtonLink
            variant="secondary"
            size="sm"
            leadingIcon={<Plus />}
            to={`${paths.financingNew}?vehicle=${vehicleId}`}
          >
            Add financing
          </ButtonLink>
        ) : null}

        {acquisitionDialog}
      </CardBody>
    </Card>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-subtle text-[0.75rem]">{label}</dt>
      <dd className="text-ink mt-0.5 text-[0.8125rem]">{children}</dd>
    </div>
  )
}
