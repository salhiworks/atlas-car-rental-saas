import { useQuery } from '@tanstack/react-query'
import { Banknote, CarFront, Plus, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  Select,
  Skeleton,
} from '@/components/ui'
import { FinancingObligationsCard } from '@/features/financing/components/FinancingObligationsCard'
import { fetchFinancialSeries, fetchOverview } from '@/features/overview/api'
import { FleetStrip } from '@/features/overview/components/FleetStrip'
import { MetricTile } from '@/features/overview/components/MetricTile'
import { RevenueExpensesChart } from '@/features/overview/components/RevenueExpensesChart'
import { SetupChecklist } from '@/features/overview/components/SetupChecklist'
import { TodayOperations } from '@/features/overview/components/TodayOperations'
import {
  PERIOD_OPTIONS,
  type PeriodKey,
  isPeriodKey,
  periodToDateRange,
  resolvePeriod,
} from '@/features/overview/period'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatMoney } from '@/lib/money/money'
import { queryKeys } from '@/lib/query/keys'

/**
 * The agency dashboard.
 *
 * Every figure on this page comes from `organization_overview`, which runs under
 * the caller's own privileges. A new agency sees zeros because it has zero — no
 * sample fleet, no illustrative revenue.
 *
 * It is read top to bottom as two questions in order: what has to be dealt with
 * today, and how the period is going. The operational half is first because it
 * is the one with a deadline.
 */
export function OverviewPage() {
  const organization = useOrganization()
  const canEditSettings = usePermission('organization.update')
  const canViewFinancing = usePermission('financing.view')
  const canViewRentals = usePermission('rentals.view')
  const canCreateRentals = usePermission('rentals.create')
  const canCreateVehicles = usePermission('vehicles.create')
  const canCreateCustomers = usePermission('customers.create')
  const canCreateExpenses = usePermission('expenses.create')
  const [periodKey, setPeriodKey] = useState<PeriodKey>('this-month')

  const locale = organization.locale
  const timeZone = organization.time_zone

  const period = useMemo(() => resolvePeriod(periodKey, timeZone), [periodKey, timeZone])
  const dateRange = useMemo(() => periodToDateRange(period, timeZone), [period, timeZone])

  const overviewQuery = useQuery({
    queryKey: queryKeys.overview(
      organization.id,
      period.from.toISOString(),
      period.to.toISOString(),
    ),
    queryFn: () => fetchOverview(organization.id, period.from, period.to),
    staleTime: 30_000,
  })

  const seriesQuery = useQuery({
    queryKey: queryKeys.financialSeries(
      organization.id,
      dateRange.from,
      dateRange.to,
      period.granularity,
    ),
    queryFn: () =>
      fetchFinancialSeries(organization.id, dateRange.from, dateRange.to, period.granularity),
    staleTime: 30_000,
  })

  const overview = overviewQuery.data
  const currency = overview?.currency ?? organization.default_currency
  const money = (amountMinor: number) => formatMoney(amountMinor, currency, { locale })

  const isSetupComplete =
    overview !== undefined && overview.fleet_total > 0 && overview.rentals_total > 0
  const hasFleet = (overview?.fleet_total ?? 0) > 0
  const hasContracts = (overview?.rentals_total ?? 0) > 0

  if (overviewQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Overview" />
        <Card>
          <ErrorState error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} />
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={`How ${organization.name} is running right now.`}
        actions={
          <>
            <div className="w-44">
              <Select
                aria-label="Reporting period"
                options={PERIOD_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                value={periodKey}
                onChange={(event) => {
                  const next = event.target.value
                  if (isPeriodKey(next)) setPeriodKey(next)
                }}
              />
            </div>
            {canCreateRentals ? (
              <ButtonLink variant="primary" leadingIcon={<Plus />} to={paths.rentalNew}>
                New rental
              </ButtonLink>
            ) : null}
          </>
        }
      />

      {overview && overview.excluded_currency_records > 0 ? (
        <Alert tone="caution" title="Some records are in another currency">
          {overview.excluded_currency_records}{' '}
          {overview.excluded_currency_records === 1 ? 'record is' : 'records are'} not in {currency}{' '}
          and {overview.excluded_currency_records === 1 ? 'has' : 'have'} been left out of the
          totals below. Converting them would need an exchange rate this workspace does not hold.
        </Alert>
      ) : null}

      {/* First-run guidance, above everything else while it applies: for an
          agency that has not started trading, finishing setup *is* the thing
          that needs attention today. Retired the moment it is trading. */}
      {overview && !isSetupComplete ? (
        <Card>
          <SetupChecklist
            organization={organization}
            overview={overview}
            canEditSettings={canEditSettings}
          />
        </Card>
      ) : null}

      {/* What needs attention today */}
      {canViewRentals ? (
        <TodayOperations
          locale={locale}
          timeZone={timeZone}
          hasContracts={hasContracts}
          canCreateRentals={canCreateRentals}
        />
      ) : null}

      {/* Money.
       *
       * The third tile is deliberately not called profit. It is rental money
       * received less the costs somebody recorded, which is not the same thing:
       * financing, depreciation, salaries that were never entered and the
       * agency's own tax position are all outside it. Calling that "profit"
       * would be a figure an owner could take a decision on and be wrong. */}
      <section aria-label="Financial summary" className="space-y-2">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Revenue"
            value={money(overview?.revenue_minor ?? 0)}
            caption={`Payments received, ${period.label.toLowerCase()}`}
            isLoading={overviewQuery.isPending}
            emphasis="strong"
          />
          <MetricTile
            label="Expenses"
            value={money(overview?.expenses_minor ?? 0)}
            caption={`Costs recorded, ${period.label.toLowerCase()}`}
            isLoading={overviewQuery.isPending}
            emphasis="strong"
          />
          <MetricTile
            label="Operating result"
            value={money(overview?.profit_minor ?? 0)}
            caption="Revenue less recorded costs"
            isLoading={overviewQuery.isPending}
            emphasis="strong"
          />
          <MetricTile
            label="Outstanding"
            value={money(overview?.outstanding_minor ?? 0)}
            caption="Owed on open contracts"
            isLoading={overviewQuery.isPending}
            emphasis="strong"
          />
        </div>

        <p className="text-ink-subtle text-[0.75rem] leading-4">
          The operating result is what came in from rentals less what was recorded as spent. It is
          not profit: financing, depreciation and anything nobody entered are outside it. Deposits
          are never counted as revenue.
        </p>
      </section>

      {/* Fleet + operations */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="flex flex-col">
          <CardHeader
            title="Fleet status"
            description={
              overviewQuery.isPending
                ? undefined
                : `${overview?.fleet_total ?? 0} ${overview?.fleet_total === 1 ? 'vehicle' : 'vehicles'} in service`
            }
            actions={
              hasFleet ? (
                <ButtonLink variant="secondary" size="sm" to={paths.vehicles}>
                  Open the fleet
                </ButtonLink>
              ) : null
            }
          />
          <CardBody className="flex flex-1 flex-col justify-center py-5">
            {overviewQuery.isPending ? (
              <div className="space-y-3">
                <Skeleton className="h-2.5 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : (
              <FleetStrip
                available={overview?.fleet_available ?? 0}
                rented={overview?.fleet_rented ?? 0}
                reserved={overview?.fleet_reserved ?? 0}
                maintenance={overview?.fleet_maintenance ?? 0}
                unavailable={overview?.fleet_unavailable ?? 0}
                emptyAction={
                  canCreateVehicles ? (
                    <ButtonLink variant="primary" size="sm" to={paths.vehicleNew}>
                      Add a vehicle
                    </ButtonLink>
                  ) : null
                }
              />
            )}
          </CardBody>
        </Card>

        {/* Side by side rather than stacked: two tiles in a column made the
            fleet card twice the height of its own content, and the strip ended
            up floating in the middle of an empty card. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <MetricTile
            label="Active contracts"
            value={overview?.rentals_active ?? 0}
            caption="Vehicles currently with a customer"
            isLoading={overviewQuery.isPending}
          />
          <MetricTile
            label="Upcoming pick-ups"
            value={overview?.rentals_upcoming ?? 0}
            caption="Reserved and not yet collected"
            isLoading={overviewQuery.isPending}
          />
        </div>
      </div>

      {/* Trend */}
      <Card>
        <CardHeader
          title="Revenue and expenses"
          description={`${period.label} · ${period.granularity === 'month' ? 'by month' : 'by day'}`}
          actions={<span className="text-ink-subtle text-[0.75rem]">In {currency}</span>}
        />
        {seriesQuery.isError ? (
          <ErrorState error={seriesQuery.error} onRetry={() => void seriesQuery.refetch()} />
        ) : (
          <RevenueExpensesChart
            series={seriesQuery.data ?? []}
            currency={currency}
            locale={locale}
            timeZone={timeZone}
            granularity={period.granularity}
            isLoading={seriesQuery.isPending}
            emptyAction={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {canCreateRentals ? (
                  <ButtonLink variant="secondary" size="sm" to={paths.rentalNew}>
                    New rental
                  </ButtonLink>
                ) : null}
                {canCreateExpenses ? (
                  <ButtonLink variant="secondary" size="sm" to={paths.expenseNew}>
                    Record a cost
                  </ButtonLink>
                ) : null}
              </div>
            }
          />
        )}
      </Card>

      {/* Financing obligations. Context, not a redefinition: the operating
          result above is unchanged by anything a lender is owed. */}
      <FinancingObligationsCard locale={locale} enabled={canViewFinancing} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Customers"
          value={overview?.customers_total ?? 0}
          caption="On file"
          isLoading={overviewQuery.isPending}
        />
        <MetricTile
          label="Contracts"
          value={overview?.rentals_total ?? 0}
          caption="All time"
          isLoading={overviewQuery.isPending}
        />
        <MetricTile
          label="Completed"
          value={overview?.rentals_completed_in_period ?? 0}
          caption={period.label}
          isLoading={overviewQuery.isPending}
        />
        <MetricTile
          label="Deposits held"
          value={money(overview?.deposits_held_minor ?? 0)}
          caption="On reserved and active contracts"
          isLoading={overviewQuery.isPending}
        />
      </div>

      {/* Shortcuts, last: a dashboard's job is to say what is happening, and
          only then to be a place to start something. Nothing here is a new
          capability — each is the same route the sidebar leads to. */}
      {(canCreateRentals || canCreateVehicles || canCreateCustomers || canCreateExpenses) &&
      isSetupComplete ? (
        <section aria-label="Quick actions" className="flex flex-wrap items-center gap-2">
          <span className="eyebrow me-1">Start something</span>
          {canCreateRentals ? (
            <ButtonLink size="sm" leadingIcon={<Plus />} to={paths.rentalNew}>
              New rental
            </ButtonLink>
          ) : null}
          {canCreateCustomers ? (
            <ButtonLink size="sm" leadingIcon={<UserRound />} to={paths.customerNew}>
              Add a customer
            </ButtonLink>
          ) : null}
          {canCreateVehicles ? (
            <ButtonLink size="sm" leadingIcon={<CarFront />} to={paths.vehicleNew}>
              Add a vehicle
            </ButtonLink>
          ) : null}
          {canCreateExpenses ? (
            <ButtonLink size="sm" leadingIcon={<Banknote />} to={paths.expenseNew}>
              Record a cost
            </ButtonLink>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
