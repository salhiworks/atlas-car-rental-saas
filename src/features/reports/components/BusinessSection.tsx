import { Wallet } from 'lucide-react'

import { Alert, Card, CardBody, CardHeader, EmptyState } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import type { ReportBusinessSummaryRow, ReportPositionSummaryRow } from '@/types/database'

import { COST_INCOMPLETE_NOTE, formatCount } from '../domain'
import { type Change, type ReportGranularity, compareValues } from '../period'
import { useFinancialSeries } from '../queries'

import { PerformanceChart } from './PerformanceChart'
import { ReportMetric } from './ReportMetric'

/**
 * The business position, in one screen.
 *
 * Two things are deliberately kept apart and labelled as such.
 *
 * PERIOD FLOWS — revenue, cost, the operating result, financing cash — are what
 * moved during the selected window.
 *
 * POSITIONS — receivables, deposits held, remaining principal — are balances as
 * at now. They are NOT filtered by the date picker, because "money customers owe
 * us" is not a monthly quantity, and a date-filtered receivable is a figure that
 * cannot be reconciled to anything.
 *
 * Nothing here is called profit. The operating result is rental revenue less
 * recorded operating cost, before financing and before depreciation — which this
 * product does not model at all.
 */

export interface BusinessSectionProps {
  summary: ReportBusinessSummaryRow | null
  previous: ReportBusinessSummaryRow | null
  positions: ReportPositionSummaryRow | null
  currency: string | null
  currencyCount: number
  locale: string
  timeZone: string
  window: { from: string; to: string }
  granularity: ReportGranularity
  compare: boolean
  isLoading: boolean
}

export function BusinessSection({
  summary,
  previous,
  positions,
  currency,
  currencyCount,
  locale,
  timeZone,
  window,
  granularity,
  compare,
  isLoading,
}: BusinessSectionProps) {
  const series = useFinancialSeries(window, granularity, currency)

  if (!isLoading && currency === null) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={Wallet}
            title="Nothing was recorded in this period"
            description="No payments, costs or financing activity fall inside the selected dates. Choose a wider period, or record the first contract."
          />
        </CardBody>
      </Card>
    )
  }

  /*
   * A period flow that the database looked for and did not find is ZERO, not
   * unknown. The em dash is this product's glyph for "nobody knows", and using
   * it here told an agency on the first of the month that its revenue was
   * unknowable when the true answer was nothing yet.
   *
   * The distinction is real: `summary` is null when the period contains no
   * payments, costs or financing at all, while `currency` is still resolved
   * because the agency has a currency. Once loading has finished and a currency
   * exists, every column of that row is a non-null figure — so zero is right.
   */
  const settled = !isLoading && currency !== null
  const money = (minor: number | null | undefined) => {
    if (!currency) return '—'
    if (minor === null || minor === undefined) {
      return settled ? formatMoney(0, currency, { locale }) : '—'
    }
    return formatMoney(minor, currency, { locale })
  }

  const change = (read: (row: ReportBusinessSummaryRow) => number): Change | null => {
    if (!compare || !summary || !previous) return null
    return compareValues(read(summary), read(previous))
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="Rental revenue"
          value={money(summary?.rental_revenue_minor)}
          caption="Rental-charge payments received, net of refunds."
          change={change((row) => row.rental_revenue_minor)}
          isLoading={isLoading}
          emphasis="strong"
        />
        <ReportMetric
          label="Operating cost"
          value={money(summary?.operating_expense_minor)}
          caption="Recorded costs dated inside the period."
          change={change((row) => row.operating_expense_minor)}
          invertChange
          isLoading={isLoading}
        />
        <ReportMetric
          label="Operating result"
          value={money(summary?.operating_result_minor)}
          caption="Revenue less operating cost. Before financing and depreciation."
          change={change((row) => row.operating_result_minor)}
          isLoading={isLoading}
          emphasis="strong"
        />
        <ReportMetric
          label="Financing cash paid"
          value={money(summary?.financing_cash_paid_minor)}
          caption={
            summary && !summary.financing_cost_complete
              ? 'Includes payments whose split was not stated.'
              : 'Principal, interest and fees paid to lenders.'
          }
          change={change((row) => row.financing_cash_paid_minor)}
          invertChange
          isLoading={isLoading}
        />
      </div>

      {summary && !summary.financing_cost_complete ? (
        <Alert tone="caution" title="Financing cost breakdown incomplete">
          {COST_INCOMPLETE_NOTE} Known interest and fees so far:{' '}
          {money(summary.financing_cost_minor)} of {money(summary.financing_cash_paid_minor)} paid.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Revenue and cost over the period"
          description={
            currencyCount > 1
              ? `Drawn in ${currency}. Records in other currencies are shown by selecting them above; nothing is converted.`
              : 'Revenue is money received for hires; cost is what was recorded as spent.'
          }
        />
        <CardBody className="p-0">
          {currency ? (
            <PerformanceChart
              series={series.data ?? []}
              currency={currency}
              locale={locale}
              timeZone={timeZone}
              granularity={granularity}
              isLoading={series.isPending}
            />
          ) : null}
        </CardBody>
      </Card>

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Money in and out" description="What happened during the period." />
          <CardBody>
            <dl className="divide-line divide-y">
              <Line
                label="Charges received"
                value={money(summary?.rental_charges_in_minor)}
                hint="Inbound payments for the hire itself."
              />
              <Line
                label="Refunds paid"
                value={money(summary?.rental_refunds_out_minor)}
                hint="Outbound rental-charge payments, already netted from revenue."
              />
              <Line
                label="Deposits taken"
                value={money(summary?.deposit_in_minor)}
                hint="The customer's money, never revenue."
              />
              <Line
                label="Deposits returned"
                value={money(summary?.deposit_out_minor)}
                hint="Refunded to customers."
              />
              <Line
                label="Financing interest and fees"
                value={
                  summary && !summary.financing_cost_complete
                    ? `At least ${money(summary.financing_cost_minor)}`
                    : money(summary?.financing_cost_minor)
                }
                hint="The cost of borrowing. Principal repayment is not a cost."
              />
              <Line
                label="Financing principal repaid"
                value={money(summary?.financing_principal_minor)}
                hint="Reduces what is owed. Never an operating expense."
              />
            </dl>
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title="Where things stand"
            description="Balances as at now — not filtered by the period above."
          />
          <CardBody>
            <dl className="divide-line divide-y">
              <Line
                label="Owed by customers"
                value={
                  positions && currency
                    ? formatMoney(positions.outstanding_minor, currency, { locale })
                    : '—'
                }
                hint={
                  positions
                    ? `${formatCount(positions.outstanding_rental_count, locale)} contracts with a balance.`
                    : undefined
                }
              />
              <Line
                label="Deposits held"
                value={
                  positions && currency
                    ? formatMoney(positions.deposits_held_minor, currency, { locale })
                    : '—'
                }
                hint="Refundable. Not revenue, and not part of the operating result."
              />
              <Line
                label="Remaining principal"
                value={
                  positions === null
                    ? '—'
                    : positions.remaining_principal_minor === null
                      ? 'Not derivable'
                      : currency
                        ? formatMoney(positions.remaining_principal_minor, currency, { locale })
                        : '—'
                }
                hint={
                  positions && positions.principal_unknown_count > 0
                    ? `${formatCount(positions.principal_unknown_count, locale)} agreement(s) have no derivable balance and are excluded.`
                    : 'Across active agreements where the arithmetic supports a figure.'
                }
              />
              <Line
                label="Overdue to lenders"
                value={
                  positions && currency
                    ? formatMoney(positions.financing_overdue_minor, currency, { locale })
                    : '—'
                }
                hint={
                  positions
                    ? `${formatCount(positions.financing_overdue_count, locale)} instalment(s) past their due date.`
                    : undefined
                }
              />
            </dl>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function Line({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <dt className="text-[0.8125rem]">{label}</dt>
        {hint ? <p className="text-ink-subtle text-[0.75rem] leading-4">{hint}</p> : null}
      </div>
      <dd data-numeric="" className="shrink-0 text-[0.8125rem] font-medium tabular-nums">
        {value}
      </dd>
    </div>
  )
}
