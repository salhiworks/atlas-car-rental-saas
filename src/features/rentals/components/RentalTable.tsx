import { ChevronRight, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'

import { rentalDetailPath } from '@/app/routes/paths'
import { Skeleton } from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { RentalBoardEntry } from '@/types/database'

import { OverdueBadge, PaymentStatusBadge, RentalStatusBadge } from './RentalBadges'

export interface RentalTableProps {
  rentals: readonly RentalBoardEntry[]
  locale: string
  timeZone: string
  isLoading?: boolean
}

/**
 * The rentals board as a table.
 *
 * A rental desk reads down columns: who, which car, out when, back when, what
 * is owed. Cards would show four contracts per screen and hide the dates, which
 * are the whole job.
 */
export function RentalTable({ rentals, locale, timeZone, isLoading = false }: RentalTableProps) {
  const when = (iso: string) => formatDateTime(new Date(iso), { locale, timeZone })

  return (
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full min-w-[960px] border-collapse text-start">
        <thead>
          <tr className="border-line border-b">
            <th scope="col" className="eyebrow px-5 py-2.5 text-start font-semibold">
              Contract
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Renter
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Vehicle
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Out
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Back
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end font-semibold">
              Total
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end font-semibold">
              Owed
            </th>
            <th scope="col" className="w-10 px-3 py-2.5">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>

        <tbody className="divide-line divide-y">
          {isLoading
            ? Array.from({ length: 6 }).map((_, index) => (
                <tr key={index}>
                  <td className="px-5 py-3">
                    <div className="space-y-1.5">
                      <Skeleton className="h-3.5 w-28" />
                      <Skeleton className="h-5 w-20 rounded-full" />
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-32" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-36" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-28" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-28" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="ms-auto h-4 w-16" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="ms-auto h-4 w-16" />
                  </td>
                  <td />
                </tr>
              ))
            : rentals.map((rental) => (
                <tr
                  key={rental.id}
                  className={cn(
                    'group hover:bg-surface-muted transition-colors',
                    rental.status === 'cancelled' && 'opacity-60',
                  )}
                >
                  {/* `relative` scopes the stretched link to this cell, so the
                      reference is clickable across it without nesting
                      interactive elements. */}
                  <td className="relative px-5 py-3">
                    <Link
                      to={rentalDetailPath(rental.id)}
                      className="identifier text-ink block hover:underline"
                    >
                      {rental.reference}
                      <span className="absolute inset-0" aria-hidden="true" />
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <RentalStatusBadge status={rental.status} />
                      <OverdueBadge isOverdue={rental.is_overdue} />
                    </div>
                  </td>

                  <td className="px-3 py-3">
                    <p className="text-ink truncate text-[0.8125rem]">{rental.customer_name}</p>
                    {rental.renter_is_not_driver ? (
                      <p className="text-ink-subtle mt-0.5 flex items-center gap-1 text-[0.6875rem]">
                        <UserRound className="size-3" aria-hidden="true" />
                        {rental.primary_driver_name} driving
                      </p>
                    ) : rental.driver_count > 1 ? (
                      <p className="text-ink-subtle mt-0.5 text-[0.6875rem]">
                        {rental.driver_count} drivers
                      </p>
                    ) : null}
                  </td>

                  <td className="px-3 py-3">
                    <p className="text-ink truncate text-[0.8125rem]">
                      {rental.vehicle_make} {rental.vehicle_model}
                    </p>
                    <p className="identifier text-ink-subtle mt-0.5 text-[0.6875rem]">
                      {rental.vehicle_plate}
                    </p>
                  </td>

                  <td className="text-ink px-3 py-3 text-[0.8125rem] whitespace-nowrap">
                    {when(rental.starts_at)}
                  </td>

                  <td className="text-ink px-3 py-3 text-[0.8125rem] whitespace-nowrap">
                    {when(rental.ends_at)}
                    {rental.extension_count > 0 ? (
                      <span className="text-ink-subtle ms-1.5 text-[0.6875rem]">extended</span>
                    ) : null}
                  </td>

                  <td data-numeric="" className="text-ink px-3 py-3 text-end text-[0.8125rem]">
                    {formatMoney(rental.total_minor, rental.currency, { locale })}
                  </td>

                  <td className="px-3 py-3 text-end">
                    {rental.balance_due_minor > 0 ? (
                      <span data-numeric="" className="text-ink text-[0.8125rem]">
                        {formatMoney(rental.balance_due_minor, rental.currency, { locale })}
                      </span>
                    ) : (
                      <PaymentStatusBadge status={rental.payment_status} />
                    )}
                    {rental.deposit_held_minor > 0 ? (
                      <p className="text-ink-subtle mt-0.5 text-[0.6875rem]">
                        {formatMoney(rental.deposit_held_minor, rental.currency, { locale })} held
                      </p>
                    ) : null}
                  </td>

                  <td className="px-3 py-3">
                    <ChevronRight
                      className="text-ink-subtle group-hover:text-ink size-4 transition-colors"
                      aria-hidden="true"
                    />
                  </td>
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  )
}
