import { Landmark, Plus, SearchX, Users } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import { Button, ButtonLink, Card, EmptyState, ListPagination, PageHeader } from '@/components/ui'
import {
  AGREEMENT_SORTS,
  type AgreementSort,
  type AgreementStatusFilter,
} from '@/features/financing/api'
import { AgreementCardList } from '@/features/financing/components/AgreementCardList'
import { AgreementTable } from '@/features/financing/components/AgreementTable'
import { FinancingSummaryStrip } from '@/features/financing/components/FinancingSummary'
import {
  FinancingToolbar,
  type FinancingFilters,
} from '@/features/financing/components/FinancingToolbar'
import { LenderManager } from '@/features/financing/components/LenderManager'
import { useAgreementList, useFinancingSummary, useLenders } from '@/features/financing/queries'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import {
  addMonthsInTimeZone,
  startOfMonthInTimeZone,
  toIsoDateInTimeZone,
} from '@/lib/datetime/timezone'
import type { FinancingAgreementType } from '@/types/database'

/**
 * The financing workspace.
 *
 * Live agreements first, because an agreement that has ended is history and
 * history is not what a Monday morning is about. Filters live in the URL so a
 * view can be bookmarked and sent to a colleague; none of them carries anything
 * about a customer, because financing is between the agency and its lender.
 */

const STATUSES: readonly string[] = [
  'live',
  'draft',
  'active',
  'paid_off',
  'closed',
  'cancelled',
  'all',
]

function isSort(value: string): value is AgreementSort {
  return value in AGREEMENT_SORTS
}

export function FinancingPage() {
  const organization = useOrganization()
  const canCreate = usePermission('financing.create')
  const canManageLenders = usePermission('lenders.manage')
  const [searchParams, setSearchParams] = useSearchParams()
  const [now] = useState(() => new Date())
  const [showLenders, setShowLenders] = useState(false)

  const timeZone = organization.time_zone
  const locale = organization.locale
  const today = toIsoDateInTimeZone(now, timeZone)

  // Cash paid is reported for a period; everything else is a position.
  const period = useMemo(() => {
    const start = startOfMonthInTimeZone(now, timeZone)
    const end = addMonthsInTimeZone(start, timeZone, 1)
    return {
      from: toIsoDateInTimeZone(start, timeZone),
      to: toIsoDateInTimeZone(end, timeZone),
      label: new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
        timeZone,
      }).format(start),
    }
  }, [now, timeZone, locale])

  const filters: FinancingFilters = useMemo(() => {
    const sort = searchParams.get('sort') ?? 'next_due'
    const status = searchParams.get('status') ?? 'live'
    const type = searchParams.get('type') ?? 'any'
    const due = searchParams.get('due') ?? 'any'

    return {
      search: searchParams.get('q') ?? '',
      sort: isSort(sort) ? sort : 'next_due',
      status: STATUSES.includes(status) ? (status as AgreementStatusFilter) : 'live',
      lenderId: searchParams.get('lender') ?? '',
      agreementType: ['loan', 'lease', 'installment_plan', 'other'].includes(type)
        ? (type as FinancingAgreementType)
        : 'any',
      dueState: ['overdue', 'due_soon'].includes(due)
        ? (due as FinancingFilters['dueState'])
        : 'any',
      currency: searchParams.get('currency') ?? '',
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
    (patch: Partial<FinancingFilters>) => {
      updateParams((params) => {
        const set = (key: string, value: string, fallback: string) => {
          if (value === fallback) params.delete(key)
          else params.set(key, value)
        }
        if (patch.search !== undefined) set('q', patch.search, '')
        if (patch.sort !== undefined) set('sort', patch.sort, 'next_due')
        if (patch.status !== undefined) set('status', patch.status, 'live')
        if (patch.lenderId !== undefined) set('lender', patch.lenderId, '')
        if (patch.agreementType !== undefined) set('type', patch.agreementType, 'any')
        if (patch.dueState !== undefined) set('due', patch.dueState, 'any')
        if (patch.currency !== undefined) set('currency', patch.currency, '')
      })
    },
    [updateParams],
  )

  const summaryQuery = useFinancingSummary(period.from, period.to)
  const lendersQuery = useLenders()

  const listQuery = useAgreementList({
    search: filters.search,
    status: filters.status,
    ...(filters.lenderId ? { lenderId: filters.lenderId } : {}),
    agreementType: filters.agreementType,
    dueState: filters.dueState,
    ...(filters.currency ? { currency: filters.currency } : {}),
    sort: filters.sort,
    page,
  })

  const agreements = listQuery.data?.rows ?? []
  const total = listQuery.data?.total ?? 0
  const pageCount = listQuery.data?.pageCount ?? 1
  const summary = useMemo(() => summaryQuery.data ?? [], [summaryQuery.data])

  const currencies = useMemo(
    () => [...new Set(summary.map((row) => row.currency))].sort(),
    [summary],
  )

  const hasAgreements =
    listQuery.isPending || total > 0 || summary.some((row) => row.agreement_count > 0)

  const isFiltered =
    filters.search !== '' ||
    filters.status !== 'live' ||
    filters.lenderId !== '' ||
    filters.agreementType !== 'any' ||
    filters.dueState !== 'any' ||
    filters.currency !== ''

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financing"
        eyebrow="Finance"
        description="What the agency owes on its fleet, and what it has actually paid."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              leadingIcon={<Users />}
              onClick={() => setShowLenders(true)}
            >
              Lenders
            </Button>
            {canCreate ? (
              <ButtonLink variant="primary" leadingIcon={<Plus />} to={paths.financingNew}>
                Add financing
              </ButtonLink>
            ) : null}
          </div>
        }
      />

      {/* Neither the position nor the filters mean anything before there is a
          first agreement, and three stacked ways of saying "nothing here" is
          what made this page feel unfinished. */}
      {hasAgreements ? (
        <>
          <FinancingSummaryStrip
            rows={summary}
            locale={locale}
            periodLabel={period.label}
            isLoading={summaryQuery.isPending}
          />

          <FinancingToolbar
            filters={filters}
            onChange={changeFilters}
            onClearAll={() => setSearchParams(new URLSearchParams(), { replace: true })}
            lenders={lendersQuery.data ?? []}
            currencies={currencies}
          />
        </>
      ) : null}

      <Card className="overflow-hidden">
        {listQuery.isError ? (
          <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
        ) : listQuery.isPending ? (
          <>
            <AgreementTable agreements={[]} locale={locale} today={today} isLoading />
            <AgreementCardList agreements={[]} locale={locale} today={today} isLoading />
          </>
        ) : agreements.length === 0 ? (
          isFiltered ? (
            <EmptyState
              icon={SearchX}
              title="No agreements match these filters"
              description="Try a different search, or clear the filters to see everything."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Landmark}
              title="No vehicle financing recorded"
              description="Record a loan, a lease or an instalment plan and this workspace shows what is owed, what is due and what has been paid. A vehicle bought outright needs nothing here."
              action={
                canCreate ? (
                  <ButtonLink variant="primary" to={paths.financingNew}>
                    Add financing
                  </ButtonLink>
                ) : (
                  <p className="text-ink-subtle text-[0.8125rem]">
                    Ask an administrator to record financing.
                  </p>
                )
              }
            />
          )
        ) : (
          <>
            <AgreementTable agreements={agreements} locale={locale} today={today} />
            <AgreementCardList agreements={agreements} locale={locale} today={today} />
          </>
        )}

        <ListPagination
          page={page}
          pageCount={pageCount}
          total={total}
          noun="agreement"
          onPageChange={(next) =>
            updateParams((params) => params.set('page', String(next)), { resetPage: false })
          }
        />
      </Card>

      {hasAgreements ? (
        <p className="text-ink-subtle text-[0.75rem] leading-4">
          Money paid to a lender is not an operating cost. Repaying principal settles a debt; only
          interest and fees are the price of borrowing, and only those appear as a financing cost.
          None of it touches the operating result on the dashboard.
        </p>
      ) : null}

      <LenderManager
        open={showLenders}
        onOpenChange={setShowLenders}
        canManage={canManageLenders}
      />
    </div>
  )
}
