import { Plus, ReceiptText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { expenseDetailPath, paths } from '@/app/routes/paths'
import {
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Select,
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

import { useExpenseList, useVehicleOperatingSummary } from '../queries'

export interface VehicleCostPanelProps {
  vehicleId: string
  locale: string
  timeZone: string
  canRecord: boolean
}

const RANGES = [
  { value: '12m', label: 'Last 12 months' },
  { value: '3m', label: 'Last 3 months' },
  { value: 'all', label: 'All time' },
] as const

type RangeKey = (typeof RANGES)[number]['value']

/**
 * What one car costs to run, and what it brought in.
 *
 * The figure is an operating contribution, not a profit: agency overhead, the
 * financing on the car and its depreciation are all outside it, and the panel
 * says so rather than leaving an owner to assume otherwise. Two currencies are
 * never added — each gets its own line.
 */
export function VehicleCostPanel({
  vehicleId,
  locale,
  timeZone,
  canRecord,
}: VehicleCostPanelProps) {
  const [range, setRange] = useState<RangeKey>('12m')
  const [now] = useState(() => new Date())

  const period = useMemo(() => {
    // The upper bound is the first day of next month, so the month in progress
    // is included whole.
    const to = toIsoDateInTimeZone(
      addMonthsInTimeZone(startOfMonthInTimeZone(now, timeZone), timeZone, 1),
      timeZone,
    )

    if (range === 'all') return { from: '1970-01-01', to }

    const months = range === '12m' ? 12 : 3
    const from = toIsoDateInTimeZone(
      addMonthsInTimeZone(startOfMonthInTimeZone(now, timeZone), timeZone, -(months - 1)),
      timeZone,
    )
    return { from, to }
  }, [range, now, timeZone])

  const summaryQuery = useVehicleOperatingSummary(vehicleId, period.from, period.to)
  const recentQuery = useExpenseList({
    vehicleId,
    from: period.from,
    to: period.to,
    status: 'recorded',
    sort: 'date',
    pageSize: 5,
  })

  const rows = summaryQuery.data ?? []
  const recent = recentQuery.data?.rows ?? []
  const totalRecorded = recentQuery.data?.total ?? 0

  return (
    <Card>
      <CardHeader
        title="Running costs"
        description="What this vehicle earned and what it cost, side by side."
        actions={
          <div className="w-40">
            <Select
              aria-label="Period"
              value={range}
              onChange={(event) => setRange(event.target.value as RangeKey)}
              options={RANGES.map((option) => ({ value: option.value, label: option.label }))}
            />
          </div>
        }
      />

      <CardBody className="space-y-4">
        {summaryQuery.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            size="sm"
            title="Nothing recorded in this period"
            description="Record what this car costs and its real economics follow from it."
            action={
              canRecord ? (
                <ButtonLink
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Plus />}
                  to={`${paths.expenseNew}?vehicle=${vehicleId}`}
                >
                  Record a cost
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-4">
            {rows.map((row) => (
              <div key={row.currency} className="space-y-2">
                {rows.length > 1 ? <p className="eyebrow">{row.currency}</p> : null}

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                  <Figure
                    label="Rental revenue"
                    value={formatMoney(row.rental_revenue_minor, row.currency, { locale })}
                    caption={`${row.rental_count} ${row.rental_count === 1 ? 'contract' : 'contracts'} paid`}
                  />
                  <Figure
                    label="Direct costs"
                    value={formatMoney(row.direct_expense_minor, row.currency, { locale })}
                    caption={`${row.expense_count} ${row.expense_count === 1 ? 'cost' : 'costs'} recorded`}
                  />
                  <Figure
                    label="Operating contribution"
                    value={formatMoney(row.operating_contribution_minor, row.currency, { locale })}
                    caption="Revenue less direct costs"
                    tone={row.operating_contribution_minor < 0 ? 'negative' : 'default'}
                  />
                </dl>

                {row.direct_expense_minor > 0 ? (
                  <p className="text-ink-subtle text-[0.75rem]">
                    {formatMoney(row.vehicle_expense_minor, row.currency, { locale })} against the
                    car itself · {formatMoney(row.rental_expense_minor, row.currency, { locale })}{' '}
                    caused by individual hires.
                  </p>
                ) : null}
              </div>
            ))}

            <p className="text-ink-subtle border-line border-t pt-3 text-[0.75rem] leading-4">
              A contribution, not a profit. Agency overhead, this car’s financing and its
              depreciation are all outside this figure.
            </p>
          </div>
        )}

        {recent.length > 0 ? (
          <div className="border-line border-t pt-3">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <p className="eyebrow">Recent costs</p>
              <p className="text-ink-subtle text-[0.75rem]">
                {totalRecorded} {totalRecorded === 1 ? 'cost' : 'costs'} in this period
              </p>
            </div>

            <ul className="divide-line divide-y">
              {recent.map((expense) => (
                <li key={expense.id} className="flex items-center gap-3 py-2">
                  {/* flex + min-w-0 so the truncating lines below cannot set a
                      minimum width and push the whole page sideways. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <Link
                      to={expenseDetailPath(expense.id)}
                      className="text-ink block truncate text-[0.8125rem] hover:underline"
                    >
                      {expense.description ?? 'Untitled cost'}
                    </Link>
                    <span className="text-ink-subtle block truncate text-[0.6875rem]">
                      {expense.category_name} ·{' '}
                      {formatDate(new Date(`${expense.incurred_on}T00:00:00Z`), {
                        locale,
                        timeZone: 'UTC',
                      })}
                      {expense.allocation === 'rental' && expense.rental_reference
                        ? ` · via ${expense.rental_reference}`
                        : ''}
                    </span>
                  </span>
                  <span
                    data-numeric=""
                    className="text-ink shrink-0 text-[0.8125rem] whitespace-nowrap"
                  >
                    {formatMoney(expense.amount_minor, expense.currency, { locale })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {canRecord && rows.length > 0 ? (
          <ButtonLink
            variant="secondary"
            size="sm"
            leadingIcon={<Plus />}
            to={`${paths.expenseNew}?vehicle=${vehicleId}`}
          >
            Record a cost for this vehicle
          </ButtonLink>
        ) : null}
      </CardBody>
    </Card>
  )
}

function Figure({
  label,
  value,
  caption,
  tone = 'default',
}: {
  label: string
  value: string
  caption: string
  tone?: 'default' | 'negative'
}) {
  return (
    <div>
      <dt className="text-ink-subtle text-[0.75rem]">{label}</dt>
      <dd
        data-numeric=""
        className={cn(
          'mt-0.5 text-[0.9375rem] font-semibold',
          tone === 'negative' ? 'text-critical-600' : 'text-ink',
        )}
      >
        {value}
      </dd>
      <p className="text-ink-subtle text-[0.6875rem]">{caption}</p>
    </div>
  )
}
