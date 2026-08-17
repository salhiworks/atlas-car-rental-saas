import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ErrorState } from '@/components/feedback/ErrorState'
import { Alert, PageHeader, useToast } from '@/components/ui'
import { BusinessSection } from '@/features/reports/components/BusinessSection'
import { FleetSection } from '@/features/reports/components/FleetSection'
import {
  CostsSection,
  CustomersSection,
  RentalsSection,
} from '@/features/reports/components/OperationsSections'
import {
  ComplianceCard,
  FinancingSection,
  TrackingSection,
} from '@/features/reports/components/PositionSections'
import { ReportToolbar } from '@/features/reports/components/ReportToolbar'
import { downloadCsv } from '@/features/reports/csv'
import {
  REPORT_SECTIONS,
  type FleetSort,
  type ReportSection,
  isExpenseDimension,
  isFleetSort,
  isReportSection,
  resolveCurrencyScope,
} from '@/features/reports/domain'
import {
  exportBusinessSummary,
  exportCustomerBalances,
  exportExpenseBreakdown,
  exportFinancingPosition,
  exportFleetPerformance,
} from '@/features/reports/exports'
import {
  MAX_CUSTOM_DAYS,
  type ReportPeriodKey,
  isReportPeriodKey,
  periodBounds,
  previousPeriod,
  resolveReportPeriod,
} from '@/features/reports/period'
import {
  useBusinessSummary,
  useComplianceSummary,
  useCustomerBalances,
  useCustomerCohorts,
  useCustomerRevenue,
  useExpenseBreakdown,
  useFinancingPosition,
  useFleetPerformance,
  useGpsCoverage,
  usePositionSummary,
  useRentalOperations,
  useRentalValues,
  useUtilisationSeries,
} from '@/features/reports/queries'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { toIsoDateInTimeZone } from '@/lib/datetime/timezone'
import { cn } from '@/lib/utils/cn'
import type { ReportExpenseDimension } from '@/types/database'

/**
 * The reporting workspace.
 *
 * ONE PAGE, SEVEN SECTIONS — not seven dashboards that happen to share a
 * sidebar. Period, currency and comparison are set once at the top and every
 * section obeys them, so two figures on the same screen always describe the same
 * window in the same currency.
 *
 * The state that is worth sharing lives in the URL: section, period, custom
 * dates, currency, comparison, ranking. A colleague can be sent a link to
 * exactly what was on screen. What never goes in the URL is anybody's identity —
 * no customer id, no name — because a bookmarked or pasted report address ends
 * up in histories, chat logs and support tickets.
 *
 * Currency is a FILTER, not a conversion. There is no exchange rate anywhere in
 * this product, so selecting EUR shows the euro records; it does not restate
 * dirham records in euros. Every monetary figure on this page belongs to exactly
 * one currency.
 */

export function ReportsPage() {
  const organization = useOrganization()
  const toast = useToast()
  const canSeeCustomers = usePermission('customers.view')
  const [searchParams, setSearchParams] = useSearchParams()

  // Frozen at mount: a period derived from a moving clock would re-resolve on
  // every render and change the query key underneath the request.
  const [now] = useState(() => new Date())
  const timeZone = organization.time_zone
  const locale = organization.locale

  const sectionParam = searchParams.get('section') ?? ''
  const section: ReportSection = isReportSection(sectionParam) ? sectionParam : 'business'

  const periodParam = searchParams.get('period') ?? ''
  const periodKey: ReportPeriodKey = isReportPeriodKey(periodParam) ? periodParam : 'this-month'

  const customFrom = searchParams.get('from') ?? ''
  const customTo = searchParams.get('to') ?? ''
  const requestedCurrency = searchParams.get('currency')
  const compare = searchParams.get('compare') === '1'
  const byParam = searchParams.get('by') ?? ''
  const dimension: ReportExpenseDimension = isExpenseDimension(byParam) ? byParam : 'category'
  const sortParam = searchParams.get('sort') ?? ''
  const fleetSort: FleetSort = isFleetSort(sortParam) ? sortParam : 'contribution'
  const balancePage = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  /*
   * A custom range is resolved from whatever the picker is SHOWING, not only
   * from a complete pair. Editing one box used to leave the other absent, and
   * the report silently fell back to this month while the control kept
   * displaying the date the user had just typed — a report whose own dates
   * disagreed with its figures.
   */
  const period = useMemo(() => {
    if (periodKey !== 'custom') return resolveReportPeriod(periodKey, timeZone, now)

    const base = resolveReportPeriod('this-month', timeZone, now)
    const from = customFrom || toIsoDateInTimeZone(base.from, timeZone)
    const to = customTo || toIsoDateInTimeZone(base.inclusiveEnd, timeZone)
    return resolveReportPeriod('custom', timeZone, now, { from, to })
  }, [periodKey, timeZone, now, customFrom, customTo])

  const window = useMemo(() => periodBounds(period, timeZone), [period, timeZone])
  const comparison = useMemo(() => previousPeriod(period, timeZone), [period, timeZone])
  const comparisonWindow = useMemo(() => periodBounds(comparison, timeZone), [comparison, timeZone])

  const patch = useCallback(
    (values: Record<string, string | null>, options: { resetPage?: boolean } = {}) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          for (const [key, value] of Object.entries(values)) {
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
          }
          if (options.resetPage !== false) next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // --- Data ------------------------------------------------------------------

  const summary = useBusinessSummary(window)
  const previousSummary = useBusinessSummary(comparisonWindow, compare)
  const positions = usePositionSummary()

  /*
   * The currencies on offer are the ones THE SELECTED PERIOD contains.
   *
   * Deliberately not the union of every loaded query: positions and financing
   * are lifetime figures, so a customer still owing euros on a 2024 contract
   * would make a dirham-only August read "2 currencies in this period". And
   * folding in whichever sections happened to be cached made the answer depend
   * on which tab somebody clicked first, so two people opening one link saw
   * different numbers.
   */
  const available = useMemo(() => {
    const codes = new Set<string>()
    for (const row of summary.data ?? []) codes.add(row.currency)
    return [...codes]
  }, [summary.data])

  const scope = useMemo(
    () => resolveCurrencyScope(available, requestedCurrency, organization.default_currency),
    [available, requestedCurrency, organization.default_currency],
  )
  const scopeCurrency = scope.currency

  const fleet = useFleetPerformance(window, section === 'fleet')
  const utilisation = useUtilisationSeries(window, period.granularity, section === 'fleet')
  const compliance = useComplianceSummary(section === 'fleet')
  const rentalOps = useRentalOperations(window, section === 'rentals')
  const rentalValues = useRentalValues(window, section === 'rentals')
  const cohorts = useCustomerCohorts(window, section === 'customers')
  const customerRevenue = useCustomerRevenue(window, section === 'customers')
  // Balances are paginated inside one currency, so they wait for one.
  const balances = useCustomerBalances(
    scopeCurrency,
    balancePage,
    section === 'customers' && scopeCurrency !== null,
  )
  const expenses = useExpenseBreakdown(window, dimension, section === 'costs')
  const financing = useFinancingPosition(section === 'financing')
  const gps = useGpsCoverage(section === 'tracking')

  const currentRow = useMemo(
    () => (summary.data ?? []).find((row) => row.currency === scope.currency) ?? null,
    [summary.data, scope.currency],
  )
  const previousRow = useMemo(
    () => (previousSummary.data ?? []).find((row) => row.currency === scope.currency) ?? null,
    [previousSummary.data, scope.currency],
  )
  const positionRow = useMemo(
    () => (positions.data ?? []).find((row) => row.currency === scope.currency) ?? null,
    [positions.data, scope.currency],
  )

  // --- Export ----------------------------------------------------------------

  const exportContext = useMemo(
    () => ({
      agencyName: organization.name,
      reportName: REPORT_SECTIONS.find((entry) => entry.key === section)?.label ?? 'Report',
      periodLabel: period.label,
      from: window.from,
      to: window.to,
      currency: scope.currency,
      generatedAt: toIsoDateInTimeZone(now, timeZone),
      filters: scope.isMixed ? [`Currency filter: ${scope.currency ?? 'none'}`] : [],
    }),
    [organization.name, section, period.label, window, scope, now, timeZone],
  )

  const onExport = useCallback(() => {
    const scoped = <T extends { currency: string }>(rows: readonly T[]) =>
      scope.currency ? rows.filter((row) => row.currency === scope.currency) : [...rows]

    try {
      let output: { filename: string; contents: string } | null = null

      switch (section) {
        case 'business':
          output = exportBusinessSummary(exportContext, summary.data ?? [], positions.data ?? [])
          break
        case 'fleet':
          output = exportFleetPerformance(exportContext, scoped(fleet.data ?? []))
          break
        case 'costs':
          output = exportExpenseBreakdown(exportContext, scoped(expenses.data ?? []), dimension)
          break
        case 'customers':
          output = exportCustomerBalances(exportContext, balances.data?.rows ?? [], {
            timeZone,
            page: balances.data?.page ?? 1,
            pageCount: balances.data?.pageCount ?? 1,
          })
          break
        case 'financing':
          output = exportFinancingPosition(exportContext, scoped(financing.data ?? []))
          break
        // Rentals and Tracking are read as figures on screen rather than as a
        // table: one is a set of counts and the other is a stamped snapshot,
        // and a spreadsheet of either would invite arithmetic across periods
        // that the data does not support.
        case 'rentals':
        case 'tracking':
          output = null
          break
      }

      if (!output) {
        toast.toast({
          tone: 'info',
          title: 'Nothing to export here',
          description: 'This section is a snapshot rather than a table.',
        })
        return
      }

      downloadCsv(output.filename, output.contents)
      toast.success('Report exported', output.filename)
    } catch {
      toast.error('The export could not be produced', 'Try again, or narrow the period.')
    }
  }, [
    section,
    exportContext,
    summary.data,
    positions.data,
    fleet.data,
    expenses.data,
    balances.data,
    financing.data,
    dimension,
    scope.currency,
    timeZone,
    toast,
  ])

  const exportable =
    section === 'business' ||
    section === 'fleet' ||
    section === 'costs' ||
    section === 'customers' ||
    section === 'financing'

  // --- Render ----------------------------------------------------------------

  const header = (
    <PageHeader
      eyebrow="Finance"
      title="Reports"
      description="What the fleet earned, what it cost to run, and where the money stands."
    />
  )

  const toolbar = (
    <ReportToolbar
      period={period}
      periodKey={periodKey}
      onPeriodChange={(key) => patch({ period: key === 'this-month' ? null : key })}
      customFrom={customFrom || toIsoDateInTimeZone(period.from, timeZone)}
      // The exclusive bound would tell somebody that August ends on
      // 1 September, and accepting that prefill would report a 32-day August.
      customTo={customTo || toIsoDateInTimeZone(period.inclusiveEnd, timeZone)}
      onCustomChange={(next) =>
        // Both keys, always: a half-written range resolves to a window the
        // control is not showing.
        patch({
          period: 'custom',
          from: next.from ?? customFrom ?? toIsoDateInTimeZone(period.from, timeZone),
          to: next.to ?? customTo ?? toIsoDateInTimeZone(period.inclusiveEnd, timeZone),
        })
      }
      currency={scope.currency}
      currencies={scope.available}
      onCurrencyChange={(currency) => patch({ currency })}
      compare={compare}
      onCompareChange={(value) => patch({ compare: value ? '1' : null })}
      comparisonLabel={comparison.label}
      onExport={exportable ? onExport : undefined}
      exportDisabled={summary.isPending}
    />
  )

  const tabs = (
    <nav
      className="border-line -mb-px flex gap-1 overflow-x-auto border-b"
      aria-label="Report sections"
    >
      {REPORT_SECTIONS.map((entry) => (
        <button
          key={entry.key}
          type="button"
          onClick={() => patch({ section: entry.key === 'business' ? null : entry.key })}
          aria-current={section === entry.key ? 'page' : undefined}
          className={cn(
            'shrink-0 border-b-2 px-3 py-2 text-[0.8125rem] font-medium transition-colors',
            section === entry.key
              ? 'border-brand-600 text-ink'
              : 'text-ink-muted hover:text-ink border-transparent',
          )}
        >
          {entry.label}
        </button>
      ))}
    </nav>
  )

  if (summary.isError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Finance" title="Reports" />
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      </div>
    )
  }

  /*
   * A read that failed is not a read that found nothing.
   *
   * Without this, a timed-out financing query rendered "No active financing —
   * loans and leases appear here once an agreement is active" for an agency
   * carrying twelve live agreements, with no retry and nothing to say the
   * figure had not been read. Every section names the queries it depends on, so
   * a failure surfaces as a failure.
   */
  const sectionQueries = {
    business: [summary, positions],
    fleet: [fleet, utilisation, compliance],
    rentals: [rentalOps, rentalValues],
    customers: [cohorts, customerRevenue, balances],
    costs: [expenses],
    financing: [financing],
    tracking: [gps],
  }[section]

  const failed = sectionQueries.find((query) => query.isError)
  if (failed) {
    return (
      <div className="space-y-6">
        {header}
        {toolbar}
        {tabs}
        <ErrorState error={failed.error} onRetry={() => void failed.refetch()} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}
      {toolbar}
      {tabs}

      {period.truncated ? (
        <Alert tone="caution" title="This range was shortened">
          A report can cover at most {MAX_CUSTOM_DAYS} days at once. The figures below end on{' '}
          {toIsoDateInTimeZone(period.inclusiveEnd, timeZone)}.
        </Alert>
      ) : null}

      {scope.isMixed ? (
        <Alert tone="info">
          This period contains {scope.available.length} currencies ({scope.available.join(', ')}).
          Figures are shown in {scope.currency} — records in other currencies are not converted and
          are never added to these totals.
        </Alert>
      ) : null}

      {section === 'business' ? (
        <BusinessSection
          summary={currentRow}
          previous={previousRow}
          positions={positionRow}
          currency={scope.currency}
          currencyCount={scope.available.length}
          locale={locale}
          timeZone={timeZone}
          window={window}
          granularity={period.granularity}
          compare={compare}
          isLoading={summary.isPending}
        />
      ) : null}

      {section === 'fleet' ? (
        <div className="space-y-6">
          <FleetSection
            rows={fleet.data ?? []}
            utilisation={utilisation.data ?? []}
            currency={scope.currency}
            locale={locale}
            timeZone={timeZone}
            granularity={period.granularity}
            sort={fleetSort}
            onSortChange={(next) => patch({ sort: next === 'contribution' ? null : next })}
            isLoading={fleet.isPending}
            utilisationLoading={utilisation.isPending}
          />
          <ComplianceCard
            rows={compliance.data ?? []}
            locale={locale}
            isLoading={compliance.isPending}
          />
        </div>
      ) : null}

      {section === 'rentals' ? (
        <RentalsSection
          operations={rentalOps.data ?? null}
          values={rentalValues.data ?? []}
          currency={scope.currency}
          locale={locale}
          isLoading={rentalOps.isPending}
        />
      ) : null}

      {section === 'customers' ? (
        <CustomersSection
          cohorts={cohorts.data ?? null}
          revenue={customerRevenue.data ?? []}
          balances={balances.data?.rows ?? []}
          balancesPage={balances.data?.page ?? 1}
          balancesPageCount={balances.data?.pageCount ?? 1}
          onBalancesPage={(page) => patch({ page: String(page) }, { resetPage: false })}
          currency={scope.currency}
          locale={locale}
          canOpenCustomers={canSeeCustomers}
          isLoading={cohorts.isPending}
        />
      ) : null}

      {section === 'costs' ? (
        <CostsSection
          rows={expenses.data ?? []}
          dimension={dimension}
          onDimensionChange={(next) => patch({ by: next === 'category' ? null : next })}
          currency={scope.currency}
          locale={locale}
          isLoading={expenses.isPending}
        />
      ) : null}

      {section === 'financing' ? (
        <FinancingSection
          rows={financing.data ?? []}
          currency={scope.currency}
          locale={locale}
          timeZone={timeZone}
          isLoading={financing.isPending}
        />
      ) : null}

      {section === 'tracking' ? (
        <TrackingSection
          coverage={gps.data ?? null}
          locale={locale}
          timeZone={timeZone}
          isLoading={gps.isPending}
        />
      ) : null}
    </div>
  )
}
