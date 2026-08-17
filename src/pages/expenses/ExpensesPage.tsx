import { Plus, ReceiptText, SearchX, Settings2, Upload } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ListPagination,
  PageHeader,
} from '@/components/ui'
import { EXPENSE_SORTS, type ExpenseSort, type ExpenseStatusFilter } from '@/features/expenses/api'
import { CategoryBreakdown } from '@/features/expenses/components/CategoryBreakdown'
import { ExpenseCardList } from '@/features/expenses/components/ExpenseCardList'
import { ExpenseSummaryStrip } from '@/features/expenses/components/ExpenseSummary'
import { ExpenseTable } from '@/features/expenses/components/ExpenseTable'
import { ExpenseToolbar, type ExpenseFilters } from '@/features/expenses/components/ExpenseToolbar'
import { ExpenseImportDialog } from '@/features/expenses/components/ExpenseImportDialog'
import { ExpenseSettingsDialog } from '@/features/expenses/components/ExpenseSettingsDialog'
import {
  useCategoryBreakdown,
  useExpenseCategories,
  useExpenseList,
  useExpenseSummary,
  useExpenseVendors,
} from '@/features/expenses/queries'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { cn } from '@/lib/utils/cn'
import {
  addMonthsInTimeZone,
  startOfMonthInTimeZone,
  toIsoDateInTimeZone,
} from '@/lib/datetime/timezone'
import type { ExpenseAllocation } from '@/types/database'

/**
 * The cost ledger.
 *
 * Period first, because almost every question about spend begins with a month.
 * Filters live in the URL so a view can be bookmarked and sent to a colleague —
 * a cost is agency business, and none of these parameters carries a customer's
 * name.
 */

const ALLOCATIONS: readonly string[] = ['overhead', 'vehicle', 'rental']

function isSort(value: string): value is ExpenseSort {
  return value in EXPENSE_SORTS
}

export function ExpensesPage() {
  const organization = useOrganization()
  const canCreate = usePermission('expenses.create')
  const canManageCategories = usePermission('expenseCategories.manage')
  const canManageVendors = usePermission('expenseVendors.manage')
  const [searchParams, setSearchParams] = useSearchParams()
  const [now] = useState(() => new Date())
  const [showSettings, setShowSettings] = useState(false)
  const [showImport, setShowImport] = useState(false)

  const timeZone = organization.time_zone
  const locale = organization.locale

  // The period is a pair of business dates, resolved in the agency's own zone
  // so "this month" means the month the agency is in.
  const period = useMemo(() => {
    const anchorIso = searchParams.get('month')
    const anchor =
      anchorIso && /^\d{4}-\d{2}$/.test(anchorIso)
        ? new Date(`${anchorIso}-01T12:00:00Z`)
        : startOfMonthInTimeZone(now, timeZone)

    const start = startOfMonthInTimeZone(anchor, timeZone)
    const end = addMonthsInTimeZone(start, timeZone, 1)

    return {
      from: toIsoDateInTimeZone(start, timeZone),
      to: toIsoDateInTimeZone(end, timeZone),
      label: new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
        timeZone,
      }).format(start),
      monthParam: toIsoDateInTimeZone(start, timeZone).slice(0, 7),
      start,
    }
  }, [searchParams, now, timeZone, locale])

  const isCurrentMonth =
    period.monthParam ===
    toIsoDateInTimeZone(startOfMonthInTimeZone(now, timeZone), timeZone).slice(0, 7)

  const filters: ExpenseFilters = useMemo(() => {
    const sort = searchParams.get('sort') ?? 'date'
    const allocation = searchParams.get('allocation') ?? 'any'
    const status = searchParams.get('status') ?? 'recorded'

    return {
      search: searchParams.get('q') ?? '',
      sort: isSort(sort) ? sort : 'date',
      categoryId: searchParams.get('category') ?? '',
      allocation: ALLOCATIONS.includes(allocation) ? (allocation as ExpenseAllocation) : 'any',
      vendorId: searchParams.get('vendor') ?? '',
      currency: searchParams.get('currency') ?? '',
      status: ['recorded', 'voided', 'all'].includes(status)
        ? (status as ExpenseStatusFilter)
        : 'recorded',
    }
  }, [searchParams])

  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void, { resetPage = true } = {}) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          mutate(next)
          if (resetPage) next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const changeFilters = useCallback(
    (patch: Partial<ExpenseFilters>) => {
      updateParams((params) => {
        const set = (key: string, value: string, fallback: string) => {
          if (value === fallback) params.delete(key)
          else params.set(key, value)
        }
        if (patch.search !== undefined) set('q', patch.search, '')
        if (patch.sort !== undefined) set('sort', patch.sort, 'date')
        if (patch.categoryId !== undefined) set('category', patch.categoryId, '')
        if (patch.allocation !== undefined) set('allocation', patch.allocation, 'any')
        if (patch.vendorId !== undefined) set('vendor', patch.vendorId, '')
        if (patch.currency !== undefined) set('currency', patch.currency, '')
        if (patch.status !== undefined) set('status', patch.status, 'recorded')
      })
    },
    [updateParams],
  )

  const stepPeriod = (direction: -1 | 1) =>
    updateParams((params) =>
      params.set(
        'month',
        toIsoDateInTimeZone(addMonthsInTimeZone(period.start, timeZone, direction), timeZone).slice(
          0,
          7,
        ),
      ),
    )

  const summaryQuery = useExpenseSummary(period.from, period.to)
  const breakdownQuery = useCategoryBreakdown(period.from, period.to)
  const categoriesQuery = useExpenseCategories()
  const vendorsQuery = useExpenseVendors()

  const listQuery = useExpenseList({
    search: filters.search,
    from: period.from,
    to: period.to,
    ...(filters.categoryId ? { categoryIds: [filters.categoryId] } : {}),
    allocation: filters.allocation,
    ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
    ...(filters.currency ? { currency: filters.currency } : {}),
    status: filters.status,
    sort: filters.sort,
    page,
  })

  const expenses = listQuery.data?.rows ?? []
  const total = listQuery.data?.total ?? 0
  const pageCount = listQuery.data?.pageCount ?? 1
  const summary = useMemo(() => summaryQuery.data ?? [], [summaryQuery.data])

  const currencies = useMemo(
    () => [...new Set(summary.map((row) => row.currency))].sort(),
    [summary],
  )

  const isFiltered =
    filters.search !== '' ||
    filters.categoryId !== '' ||
    filters.allocation !== 'any' ||
    filters.vendorId !== '' ||
    filters.currency !== '' ||
    filters.status !== 'recorded'

  /*
   * A breakdown of nothing is a heading over an empty box. While the period
   * holds no costs and nothing is filtered, the list gets the whole width and
   * the page stops looking like a layout waiting for data.
   */
  const showBreakdown = listQuery.isPending || expenses.length > 0 || isFiltered

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        eyebrow="Finance"
        description={`What ${organization.name} spends, and what each cost belongs to.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canManageCategories || canManageVendors ? (
              <Button
                variant="secondary"
                leadingIcon={<Settings2 />}
                onClick={() => setShowSettings(true)}
              >
                Categories and suppliers
              </Button>
            ) : null}
            {canCreate ? (
              <Button
                variant="secondary"
                leadingIcon={<Upload />}
                onClick={() => setShowImport(true)}
              >
                Import
              </Button>
            ) : null}
            {canCreate ? (
              <ButtonLink variant="primary" leadingIcon={<Plus />} to={paths.expenseNew}>
                Record a cost
              </ButtonLink>
            ) : null}
          </div>
        }
      />

      <ExpenseSummaryStrip
        rows={summary}
        locale={locale}
        isLoading={summaryQuery.isPending}
        active={filters.allocation === 'any' ? null : filters.allocation}
        onSelect={(allocation) => changeFilters({ allocation })}
        onClear={() => changeFilters({ allocation: 'any' })}
      />

      <ExpenseToolbar
        filters={filters}
        onChange={changeFilters}
        onClearAll={() =>
          setSearchParams(
            period.monthParam
              ? new URLSearchParams({ month: period.monthParam })
              : new URLSearchParams(),
            { replace: true },
          )
        }
        categories={categoriesQuery.data ?? []}
        vendors={vendorsQuery.data ?? []}
        currencies={currencies}
        periodLabel={period.label}
        onStepPeriod={stepPeriod}
        onThisMonth={() => updateParams((params) => params.delete('month'))}
        isCurrentMonth={isCurrentMonth}
      />

      {/* The table needs 900px before it starts scrolling inside its own card,
          which a 20rem aside took away on a 1440px screen. Beside it only where
          both genuinely fit; underneath, at full width, everywhere else. */}
      <div className={cn('grid gap-6', showBreakdown && '2xl:grid-cols-[minmax(0,1fr)_20rem]')}>
        <Card className="overflow-hidden">
          {listQuery.isError ? (
            <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
          ) : listQuery.isPending ? (
            <>
              <ExpenseTable expenses={[]} locale={locale} isLoading />
              <ExpenseCardList expenses={[]} locale={locale} isLoading />
            </>
          ) : expenses.length === 0 ? (
            isFiltered ? (
              <EmptyState
                icon={SearchX}
                title="No costs match these filters"
                description="Try a different search, or clear the filters to see everything in this period."
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setSearchParams(new URLSearchParams({ month: period.monthParam }), {
                        replace: true,
                      })
                    }
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ReceiptText}
                title={`Nothing recorded in ${period.label}`}
                description="Record what the agency spends and every vehicle's real running cost follows from it."
                action={
                  canCreate ? (
                    <ButtonLink variant="primary" to={paths.expenseNew}>
                      Record a cost
                    </ButtonLink>
                  ) : (
                    <p className="text-ink-subtle text-[0.8125rem]">
                      Ask a manager or administrator to record costs.
                    </p>
                  )
                }
              />
            )
          ) : (
            <>
              <ExpenseTable expenses={expenses} locale={locale} />
              <ExpenseCardList expenses={expenses} locale={locale} />
            </>
          )}

          <ListPagination
            page={page}
            pageCount={pageCount}
            total={total}
            noun="cost"
            onPageChange={(next) =>
              updateParams((params) => params.set('page', String(next)), { resetPage: false })
            }
          />
        </Card>

        {showBreakdown ? (
          <Card className="h-fit">
            <CardHeader title="Where it went" description={period.label} />
            <CardBody>
              <CategoryBreakdown
                rows={breakdownQuery.data ?? []}
                locale={locale}
                isLoading={breakdownQuery.isPending}
                activeCategoryId={filters.categoryId === '' ? null : filters.categoryId}
                onSelect={(categoryId) =>
                  changeFilters({
                    categoryId: filters.categoryId === categoryId ? '' : categoryId,
                  })
                }
              />
            </CardBody>
          </Card>
        ) : null}
      </div>

      <ExpenseSettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        canManageCategories={canManageCategories}
        canManageVendors={canManageVendors}
      />

      <ExpenseImportDialog open={showImport} onOpenChange={setShowImport} />
    </div>
  )
}
