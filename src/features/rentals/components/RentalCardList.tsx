import { ArrowRight, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'

import { rentalDetailPath } from '@/app/routes/paths'
import { Skeleton } from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { RentalBoardEntry } from '@/types/database'

import { OverdueBadge, PaymentStatusBadge, RentalStatusBadge } from './RentalBadges'

export interface RentalCardListProps {
  rentals: readonly RentalBoardEntry[]
  locale: string
  timeZone: string
  isLoading?: boolean
}

/** The same board on a phone, where a seven-column table cannot go. */
export function RentalCardList({
  rentals,
  locale,
  timeZone,
  isLoading = false,
}: RentalCardListProps) {
  const when = (iso: string) => formatDateTime(new Date(iso), { locale, timeZone })

  if (isLoading) {
    return (
      <ul className="divide-line divide-y lg:hidden">
        {Array.from({ length: 4 }).map((_, index) => (
          <li key={index} className="space-y-2 px-4 py-3.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-52" />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul className="divide-line divide-y lg:hidden">
      {rentals.map((rental) => (
        <li key={rental.id} className={cn(rental.status === 'cancelled' && 'opacity-60')}>
          <Link
            to={rentalDetailPath(rental.id)}
            className="hover:bg-surface-muted focus-visible:outline-brand-500 block px-4 py-3.5 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="identifier text-ink">{rental.reference}</p>
                <p className="text-ink mt-1 truncate text-[0.875rem] font-medium">
                  {rental.customer_name}
                </p>
                <p className="text-ink-subtle mt-0.5 truncate text-[0.75rem]">
                  {rental.vehicle_make} {rental.vehicle_model} · {rental.vehicle_plate}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <RentalStatusBadge status={rental.status} />
                <OverdueBadge isOverdue={rental.is_overdue} />
              </div>
            </div>

            {rental.renter_is_not_driver ? (
              <p className="text-ink-subtle mt-2 flex items-center gap-1 text-[0.75rem]">
                <UserRound className="size-3" aria-hidden="true" />
                {rental.primary_driver_name} is driving
              </p>
            ) : null}

            <div className="text-ink-muted mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem]">
              <span>{when(rental.starts_at)}</span>
              <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
              <span>{when(rental.ends_at)}</span>
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-3">
              <span data-numeric="" className="text-ink text-[0.8125rem] font-medium">
                {formatMoney(rental.total_minor, rental.currency, { locale })}
              </span>
              {rental.balance_due_minor > 0 ? (
                <span data-numeric="" className="text-ink-muted text-[0.75rem]">
                  {formatMoney(rental.balance_due_minor, rental.currency, { locale })} owed
                </span>
              ) : (
                <PaymentStatusBadge status={rental.payment_status} />
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
