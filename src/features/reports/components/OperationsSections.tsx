import { Banknote, FileSignature, Users } from 'lucide-react'
import { Link } from 'react-router-dom'

import { customerDetailPath } from '@/app/routes/paths'
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Select } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import type {
  ReportCustomerBalanceRow,
  ReportCustomerCohortRow,
  ReportCustomerRevenueRow,
  ReportExpenseDimension,
  ReportExpenseRow,
  ReportRentalOperationsRow,
  ReportRentalValueRow,
} from '@/types/database'

import { formatBps, formatCount, formatDays, formatShare, shareOfTotal } from '../domain'

import { RankedBars } from './RankedBars'
import { ReportMetric } from './ReportMetric'

// =============================================================================
// Rentals
// =============================================================================

/**
 * Rental operations.
 *
 * Every count here is filtered by ITS OWN date, and the captions say which,
 * because these numbers look comparable and are not. "Bookings created" is data
 * entry; "hires started" is operations; "completed" is settlement. A report that
 * filtered all three by `created_at` would produce three plausible figures that
 * answer the same question badly.
 */
export function RentalsSection({
  operations,
  values,
  currency,
  locale,
  isLoading,
}: {
  operations: ReportRentalOperationsRow | null
  values: readonly ReportRentalValueRow[]
  currency: string | null
  locale: string
  isLoading: boolean
}) {
  const scoped = currency ? values.find((row) => row.currency === currency) : undefined

  if (!isLoading && !operations) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={FileSignature}
            title="No rental activity in this period"
            description="Contracts, cancellations and durations appear here once hires fall inside the selected dates."
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="Hires started"
          value={formatCount(operations?.started, locale)}
          caption="Contracts whose hire period begins inside the window."
          isLoading={isLoading}
          emphasis="strong"
        />
        <ReportMetric
          label="Hires completed"
          value={formatCount(operations?.completed, locale)}
          caption="Closed inside the window."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Average hire length"
          value={
            operations?.avg_billable_days === null || operations?.avg_billable_days === undefined
              ? '—'
              : `${formatDays(Number(operations.avg_billable_days), locale)} days`
          }
          caption="Billable days across hires completed in the window."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Average hire value"
          value={
            // A truthiness test would print an unknown for a courtesy hire that
            // was genuinely worth nothing.
            scoped?.avg_completed_value_minor != null && currency
              ? formatMoney(scoped.avg_completed_value_minor, currency, { locale })
              : '—'
          }
          caption="Contracted total of completed hires. Deposits are not part of it."
          isLoading={isLoading}
        />
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title="Lifecycle"
            description="Each figure is counted on its own business date."
          />
          <CardBody>
            <dl className="divide-line divide-y">
              <Line
                label="Bookings created"
                value={formatCount(operations?.created, locale)}
                hint="By the date the record was entered."
              />
              <Line
                label="Bookings confirmed"
                value={formatCount(operations?.confirmed, locale)}
                hint="By the date the reservation was confirmed."
              />
              <Line
                label="Vehicles collected"
                value={formatCount(operations?.picked_up, locale)}
                hint="By the recorded pick-up time."
              />
              <Line
                label="Vehicles returned"
                value={formatCount(operations?.returned, locale)}
                hint="By the recorded return time."
              />
              <Line
                label="Returned late"
                value={formatCount(operations?.returned_late, locale)}
                hint="Returned after the agreed end. Measured from the stored timestamps."
              />
              <Line
                label="Cancellations"
                value={formatCount(operations?.cancelled, locale)}
                hint="By the date the booking was cancelled."
              />
              <Line
                label="Cancellation rate"
                value={formatBps(operations?.cancellation_bps, locale)}
                hint="Cancelled against confirmed plus cancelled. Abandoned drafts are not bookings and are excluded."
              />
              <Line
                label="Extensions recorded"
                value={formatCount(operations?.extensions, locale)}
                hint="Counted on hires starting in the window. A reschedule does not increment it."
              />
            </dl>
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader title="Right now" description="Current state, not a period figure." />
          <CardBody>
            <dl className="divide-line divide-y">
              <Line
                label="Out with customers"
                value={formatCount(operations?.active_now, locale)}
                hint="Contracts currently active."
              />
              <Line
                label="Reserved"
                value={formatCount(operations?.reserved_now, locale)}
                hint="Committed but not yet collected."
              />
              <Line
                label="Average time out"
                value={
                  operations?.avg_actual_hours === null ||
                  operations?.avg_actual_hours === undefined
                    ? '—'
                    : `${formatDays(Number(operations.avg_actual_hours) / 24, locale)} days`
                }
                hint="Measured from collection to return, where both were recorded. Different from billable length."
              />
              <Line
                label="Contracted value completed"
                value={
                  scoped && currency
                    ? formatMoney(scoped.completed_total_minor, currency, { locale })
                    : '—'
                }
                hint="What customers were charged, which is not the same as what they paid."
              />
              <Line
                label="Rental cash received"
                value={
                  scoped && currency ? formatMoney(scoped.revenue_minor, currency, { locale }) : '—'
                }
                hint="Net of refunds, in the period."
              />
            </dl>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

// =============================================================================
// Customers
// =============================================================================

/**
 * Who rents, and who owes.
 *
 * A "first-time renter" is somebody whose first hire that actually happened
 * falls inside the window — not somebody whose customer record was created in
 * it. A record entered last March and first hired today is a new renter today,
 * and the two questions have different answers on any real dataset.
 *
 * Nothing here is called lifetime value. What is shown is rental cash received
 * in the selected period, in one currency, which is what was measured.
 */
export function CustomersSection({
  cohorts,
  revenue,
  balances,
  balancesPage,
  balancesPageCount,
  onBalancesPage,
  currency,
  locale,
  canOpenCustomers,
  isLoading,
}: {
  cohorts: ReportCustomerCohortRow | null
  revenue: readonly ReportCustomerRevenueRow[]
  balances: readonly ReportCustomerBalanceRow[]
  balancesPage: number
  balancesPageCount: number
  onBalancesPage: (page: number) => void
  currency: string | null
  locale: string
  canOpenCustomers: boolean
  isLoading: boolean
}) {
  const scopedRevenue = currency ? revenue.filter((row) => row.currency === currency) : revenue
  const scopedBalances = currency ? balances.filter((row) => row.currency === currency) : balances

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="Customers who rented"
          value={formatCount(cohorts?.renters_in_period, locale)}
          caption="Distinct customers whose hire began in the window."
          isLoading={isLoading}
          emphasis="strong"
        />
        <ReportMetric
          label="First-time renters"
          value={formatCount(cohorts?.first_time_renters, locale)}
          caption="Their first hire ever, not their record's creation date."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Returning renters"
          value={formatCount(cohorts?.returning_renters, locale)}
          caption="Had hired before this window."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Repeat rate"
          value={formatBps(cohorts?.repeat_rate_bps, locale)}
          caption="Returning renters as a share of renters in the window."
          isLoading={isLoading}
        />
      </div>

      {cohorts && cohorts.renters_in_period > 0 && cohorts.returning_renters === 0 ? (
        <Alert tone="info">
          Nobody who hired in this period had hired before. With a short history that is expected —
          a repeat rate becomes meaningful once the agency has more than one period behind it.
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title="Rental cash by customer"
            description={
              currency
                ? `Received in the period, in ${currency}. Not a lifetime figure.`
                : 'Received in the period.'
            }
          />
          <CardBody className="p-0">
            <RankedBars
              isLoading={isLoading}
              emptyLabel="No rental payments in this period."
              items={scopedRevenue.map((row) => ({
                id: row.customer_id,
                label: row.display_name,
                value: row.revenue_minor,
                display: formatMoney(row.revenue_minor, row.currency, { locale }),
                caption: `${row.rental_count} hire${row.rental_count === 1 ? '' : 's'}`,
                badge:
                  row.customer_type === 'company' ? (
                    <Badge tone="neutral">Company</Badge>
                  ) : undefined,
              }))}
            />
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title="Outstanding balances"
            description="Money owed as at now — not filtered by the period above."
          />
          <CardBody className="p-0">
            {scopedBalances.length === 0 ? (
              <EmptyState
                icon={Users}
                size="sm"
                title="Nothing outstanding"
                description="Every contract with a balance has been settled."
              />
            ) : (
              <ul className="divide-line divide-y">
                {scopedBalances.map((row) => (
                  <li
                    key={`${row.customer_id}-${row.currency}`}
                    className="flex items-baseline justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      {canOpenCustomers ? (
                        <Link
                          to={customerDetailPath(row.customer_id)}
                          // `block`, because `truncate`'s overflow:hidden does
                          // not apply to an inline box — an anchor holding one
                          // long unbroken name would otherwise set the card's
                          // minimum width and push the page sideways.
                          className="text-brand-700 block truncate text-[0.8125rem] font-medium hover:underline"
                        >
                          {row.display_name}
                        </Link>
                      ) : (
                        <span className="truncate text-[0.8125rem] font-medium">
                          {row.display_name}
                        </span>
                      )}
                      <p className="text-ink-subtle truncate text-[0.75rem]">
                        {row.rental_count} contract{row.rental_count === 1 ? '' : 's'}
                        {row.deposits_held_minor > 0
                          ? ` · ${formatMoney(row.deposits_held_minor, row.currency, { locale })} deposit held`
                          : ''}
                      </p>
                    </div>
                    <span data-numeric="" className="shrink-0 text-[0.8125rem] font-medium">
                      {formatMoney(row.outstanding_minor, row.currency, { locale })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
          {balancesPageCount > 1 ? (
            <div className="border-line text-ink-muted flex items-center justify-between border-t px-4 py-2 text-[0.75rem]">
              <span>
                Page {balancesPage} of {balancesPageCount}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="hover:text-ink disabled:opacity-40"
                  disabled={balancesPage <= 1}
                  onClick={() => onBalancesPage(balancesPage - 1)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="hover:text-ink disabled:opacity-40"
                  disabled={balancesPage >= balancesPageCount}
                  onClick={() => onBalancesPage(balancesPage + 1)}
                >
                  Next
                </button>
              </span>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  )
}

// =============================================================================
// Costs
// =============================================================================

const DIMENSIONS: readonly { value: ReportExpenseDimension; label: string }[] = [
  { value: 'category', label: 'By category' },
  { value: 'vendor', label: 'By supplier' },
  { value: 'allocation', label: 'By allocation' },
]

/**
 * Where the money goes.
 *
 * Grouped by identity rather than by label, so a supplier renamed last week and
 * two suppliers that happen to share a name both behave correctly. Archived
 * categories and suppliers stay in: the money they account for was really spent,
 * and archiving only removes them from the pickers.
 *
 * Voided costs appear nowhere, and rows the Financing module owns are excluded —
 * counting a loan instalment as an operating cost would count the same money
 * twice against the same fleet.
 */
export function CostsSection({
  rows,
  dimension,
  onDimensionChange,
  currency,
  locale,
  isLoading,
}: {
  rows: readonly ReportExpenseRow[]
  dimension: ReportExpenseDimension
  onDimensionChange: (dimension: ReportExpenseDimension) => void
  currency: string | null
  locale: string
  isLoading: boolean
}) {
  const scoped = currency ? rows.filter((row) => row.currency === currency) : rows
  const total = scoped.reduce((sum, row) => sum + Number(row.gross_minor), 0)
  const count = scoped.reduce((sum, row) => sum + Number(row.expense_count), 0)
  const tax = scoped.reduce((sum, row) => sum + Number(row.tax_minor), 0)

  if (!isLoading && rows.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={Banknote}
            title="No costs recorded in this period"
            description="Fuel, servicing, insurance and everything else the agency spends appear here once they are logged."
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="Total recorded"
          value={currency ? formatMoney(total, currency, { locale }) : '—'}
          caption="Gross, tax included. Voided costs count nowhere."
          isLoading={isLoading}
          emphasis="strong"
        />
        <ReportMetric
          label="Tax within it"
          value={currency ? formatMoney(tax, currency, { locale }) : '—'}
          caption="Part of the gross above, never added to it."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Costs recorded"
          value={formatCount(count, locale)}
          caption="Individual entries in the period."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Average cost"
          value={
            count > 0 && currency
              ? formatMoney(Math.round(total / count), currency, { locale })
              : '—'
          }
          caption="Gross total divided by entries."
          isLoading={isLoading}
        />
      </div>

      <Card>
        <CardHeader
          title="Spending breakdown"
          description="Financing instalments are reported separately and are not operating cost."
          actions={
            <Select
              aria-label="Group costs by"
              className="h-8 w-44 text-[0.8125rem]"
              value={dimension}
              onChange={(event) => onDimensionChange(event.target.value as ReportExpenseDimension)}
              options={DIMENSIONS.map((option) => ({ ...option }))}
            />
          }
        />
        <CardBody className="p-0">
          <RankedBars
            isLoading={isLoading}
            total={total}
            emptyLabel="No costs recorded in this period."
            items={[...scoped]
              .sort((a, b) => Number(b.gross_minor) - Number(a.gross_minor))
              .map((row) => ({
                id: `${row.dimension_id ?? row.dimension_key ?? row.dimension_label}-${row.currency}`,
                label: row.dimension_label,
                value: Number(row.gross_minor),
                display: formatMoney(row.gross_minor, row.currency, { locale }),
                caption: `${row.expense_count} cost${row.expense_count === 1 ? '' : 's'} · ${formatShare(
                  shareOfTotal(Number(row.gross_minor), total),
                  locale,
                )} of spend`,
                badge: row.dimension_archived ? (
                  <Badge tone="neutral" title="Archived, but its historical spend is kept.">
                    Archived
                  </Badge>
                ) : undefined,
              }))}
          />
        </CardBody>
      </Card>
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
