import { Building2, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Badge, Skeleton } from '@/components/ui'
import type { ComplianceOptions } from '@/lib/compliance/expiry'
import { cn } from '@/lib/utils/cn'
import type { CustomerDirectoryEntry } from '@/types/database'

import { ArchivedBadge, DriverLicenceBadge } from './CustomerBadges'
import { OutstandingCell } from './CustomerTable'

export interface CustomerCardListProps {
  customers: readonly CustomerDirectoryEntry[]
  compliance: ComplianceOptions
  locale: string
  isLoading?: boolean
}

/**
 * The customer list below the table breakpoint.
 *
 * A compact list row rather than the table squeezed into a phone: the same
 * facts, ordered for a narrow screen, with name and phone leading because those
 * are what somebody at the counter is matching against.
 */
export function CustomerCardList({
  customers,
  compliance,
  locale,
  isLoading,
}: CustomerCardListProps) {
  if (isLoading) {
    return (
      <ul className="divide-line divide-y lg:hidden">
        {Array.from({ length: 5 }).map((_, index) => (
          <li key={index} className="flex gap-3 px-4 py-3.5">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul className="divide-line divide-y lg:hidden">
      {customers.map((customer) => {
        const Icon = customer.customer_type === 'company' ? Building2 : UserRound

        return (
          <li key={customer.customer_id}>
            <Link
              to={`${paths.customers}/${customer.customer_id}`}
              className={cn(
                'hover:bg-surface-muted flex gap-3 px-4 py-3.5 transition-colors',
                customer.archived_at && 'opacity-60',
              )}
            >
              <span
                aria-hidden="true"
                className="border-line bg-surface-inset text-ink-subtle flex size-9 shrink-0 items-center justify-center rounded-full border"
              >
                <Icon className="size-4" />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-ink truncate text-[0.8125rem] font-medium">
                    {customer.display_name}
                  </p>
                  <span data-numeric="" className="shrink-0 text-[0.8125rem]">
                    <OutstandingCell customer={customer} locale={locale} />
                  </span>
                </div>

                <p className="text-ink-muted mt-0.5 truncate text-[0.75rem]">
                  {customer.phone ?? customer.email ?? 'No contact details'}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <DriverLicenceBadge customer={customer} compliance={compliance} />
                  {customer.active_rental_id ? (
                    <Badge tone="info" withDot>
                      Renting now
                    </Badge>
                  ) : null}
                  {customer.archived_at ? <ArchivedBadge /> : null}
                </div>
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
