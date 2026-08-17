import { AlertTriangle, ArrowDownLeft, ArrowUpRight, FileSignature, Wallet } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ButtonLink, Card, CardHeader, EmptyState, Skeleton } from '@/components/ui'
import type { RentalDeskView } from '@/features/rentals/api'
import { useRentalSummary } from '@/features/rentals/queries'
import { cn } from '@/lib/utils/cn'
import { addDaysInTimeZone, startOfDayInTimeZone } from '@/lib/datetime/timezone'

export interface TodayOperationsProps {
  locale: string
  timeZone: string
  /** Whether the agency has ever written a contract, so zeros are not shown as news. */
  hasContracts: boolean
  canCreateRentals: boolean
}

interface Item {
  /** The desk view this tile counts, and the one the link opens. */
  readonly key: RentalDeskView
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
  readonly to: string
  readonly count: (summary: {
    collectingToday: number
    returningToday: number
    overdue: number
    outstanding: number
  }) => number
  /** Reads as a problem rather than as a figure once it is above zero. */
  readonly isAlarming?: boolean
}

const ITEMS: readonly Item[] = [
  {
    key: 'collecting',
    label: 'Collecting today',
    icon: ArrowUpRight,
    tone: 'text-info-600',
    to: `${paths.rentals}?view=collecting`,
    count: (summary) => summary.collectingToday,
  },
  {
    key: 'returning',
    label: 'Due back today',
    icon: ArrowDownLeft,
    tone: 'text-brand-600',
    to: `${paths.rentals}?view=returning`,
    count: (summary) => summary.returningToday,
  },
  {
    key: 'overdue',
    label: 'Past return time',
    icon: AlertTriangle,
    tone: 'text-critical-600',
    to: `${paths.rentals}?view=overdue`,
    count: (summary) => summary.overdue,
    isAlarming: true,
  },
  {
    key: 'outstanding',
    label: 'Contracts owing money',
    icon: Wallet,
    tone: 'text-caution-600',
    to: `${paths.rentals}?view=outstanding`,
    count: (summary) => summary.outstanding,
  },
]

/**
 * What the desk has to deal with today.
 *
 * The figures below this on the dashboard say how the month is going; this one
 * says what is happening before closing time, which is the question somebody
 * opening Atlas at nine in the morning actually has. Each number is a link into
 * the rentals board already filtered to the contracts behind it — the same
 * saved queries the board's own summary tiles use, so the two cannot disagree.
 *
 * "Today" is the agency's day in its own time zone. A desk in Casablanca does
 * not want a browser's idea of midnight deciding which returns are today's.
 */
export function TodayOperations({
  locale,
  timeZone,
  hasContracts,
  canCreateRentals,
}: TodayOperationsProps) {
  const now = new Date()
  const dayStart = startOfDayInTimeZone(now, timeZone)
  const summaryQuery = useRentalSummary(
    dayStart.toISOString(),
    addDaysInTimeZone(dayStart, timeZone, 1).toISOString(),
  )

  const summary = summaryQuery.data
  const dateLabel = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(now)

  return (
    <Card>
      <CardHeader
        title="Today"
        description={dateLabel}
        actions={
          hasContracts ? (
            <ButtonLink variant="secondary" size="sm" to={paths.calendar}>
              Open the calendar
            </ButtonLink>
          ) : null
        }
      />

      {!hasContracts ? (
        <EmptyState
          size="sm"
          icon={FileSignature}
          title="Nothing on the desk yet"
          description="Collections, returns and anything past its return time appear here as soon as the first contract is running."
          action={
            canCreateRentals ? (
              <ButtonLink variant="primary" size="sm" to={paths.rentalNew}>
                Write a contract
              </ButtonLink>
            ) : null
          }
        />
      ) : (
        <ul className="divide-line grid grid-cols-1 divide-y lg:grid-cols-4 lg:divide-x lg:divide-y-0">
          {ITEMS.map((item) => {
            const value = summary ? item.count(summary) : null
            const Icon = item.icon

            return (
              <li key={item.key} className="min-w-0">
                <Link
                  to={item.to}
                  className={cn(
                    'hover:bg-surface-muted flex items-center justify-between gap-3 px-5 py-3.5 transition-colors',
                    'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:-outline-offset-2',
                    'lg:block lg:py-4',
                  )}
                >
                  <span className="text-ink-muted flex items-center gap-2 text-[0.8125rem] lg:text-[0.75rem]">
                    <Icon className={cn('size-4 shrink-0', item.tone)} aria-hidden="true" />
                    {item.label}
                  </span>

                  {summaryQuery.isPending || value === null ? (
                    <Skeleton className="h-7 w-8 lg:mt-2" />
                  ) : (
                    <span
                      data-numeric=""
                      className={cn(
                        'text-[1.375rem] leading-7 font-semibold lg:mt-1.5 lg:block',
                        item.isAlarming && value > 0 ? 'text-critical-700' : 'text-ink',
                      )}
                    >
                      {value}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
