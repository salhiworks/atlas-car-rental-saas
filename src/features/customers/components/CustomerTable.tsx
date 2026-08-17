import { Building2, ChevronRight, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Badge, Skeleton } from '@/components/ui'
import type { ComplianceOptions } from '@/lib/compliance/expiry'
import { formatDate } from '@/lib/datetime/format'
import { getCountryName } from '@/lib/i18n/regions'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { CustomerDirectoryEntry } from '@/types/database'

import { ArchivedBadge, DriverLicenceBadge } from './CustomerBadges'

export interface CustomerTableProps {
  customers: readonly CustomerDirectoryEntry[]
  compliance: ComplianceOptions
  locale: string
  isLoading?: boolean
}

/**
 * The customer list as an operational table.
 *
 * Deliberately not a CRM card grid: staff scan this while somebody waits, so
 * name, phone and licence validity sit in fixed columns an eye can run down.
 *
 * No document numbers appear here at all. The list answers "who is this and can
 * they drive" — reading an identifier is something you do on the profile, having
 * opened it on purpose.
 */
export function CustomerTable({ customers, compliance, locale, isLoading }: CustomerTableProps) {
  return (
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full min-w-[900px] border-collapse text-start">
        <thead>
          <tr className="border-line border-b">
            <th scope="col" className="eyebrow px-5 py-2.5 text-start font-semibold">
              Customer
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Contact
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Nationality
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Driving licence
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Rentals
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end font-semibold">
              Outstanding
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
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-8 rounded-full" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-32" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-5 w-24 rounded-full" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-16" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="ms-auto h-4 w-16" />
                  </td>
                  <td />
                </tr>
              ))
            : customers.map((customer) => {
                const isCompany = customer.customer_type === 'company'
                const Icon = isCompany ? Building2 : UserRound

                return (
                  <tr
                    key={customer.customer_id}
                    className={cn(
                      'group hover:bg-surface-muted transition-colors',
                      customer.archived_at && 'opacity-60',
                    )}
                  >
                    <td className="relative px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span
                          aria-hidden="true"
                          className="border-line bg-surface-inset text-ink-subtle flex size-8 shrink-0 items-center justify-center rounded-full border"
                        >
                          <Icon className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <Link
                            to={`${paths.customers}/${customer.customer_id}`}
                            className="text-ink block truncate text-[0.875rem] leading-5 font-medium hover:underline"
                          >
                            {customer.display_name}
                            <span className="absolute inset-0" aria-hidden="true" />
                          </Link>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            {customer.archived_at ? <ArchivedBadge /> : null}
                            {customer.identity_document_count === 0 ? (
                              <span className="text-ink-subtle text-[0.6875rem]">
                                No ID on file
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3">
                      <p className="text-ink truncate text-[0.8125rem]">{customer.phone ?? '—'}</p>
                      {customer.email ? (
                        <p className="text-ink-subtle truncate text-[0.75rem]">{customer.email}</p>
                      ) : null}
                    </td>

                    <td className="text-ink-muted px-3 py-3 text-[0.8125rem]">
                      {customer.nationality_country_code
                        ? getCountryName(customer.nationality_country_code, locale)
                        : '—'}
                    </td>

                    <td className="px-3 py-3">
                      <DriverLicenceBadge customer={customer} compliance={compliance} />
                    </td>

                    <td className="px-3 py-3">
                      {customer.active_rental_id ? (
                        <Badge tone="info" withDot>
                          Renting now
                        </Badge>
                      ) : customer.upcoming_rental_id ? (
                        <Badge tone="caution" withDot>
                          Booked
                        </Badge>
                      ) : (
                        <span data-numeric="" className="text-ink-muted text-[0.8125rem]">
                          {customer.rental_count === 0 ? '—' : customer.rental_count}
                        </span>
                      )}
                      {customer.last_rental_ends_at && !customer.active_rental_id ? (
                        <p className="text-ink-subtle mt-0.5 text-[0.6875rem]">
                          Last{' '}
                          {formatDate(new Date(customer.last_rental_ends_at), {
                            locale,
                            timeZone: compliance.timeZone,
                          })}
                        </p>
                      ) : null}
                    </td>

                    <td data-numeric="" className="px-3 py-3 text-end text-[0.8125rem]">
                      <OutstandingCell customer={customer} locale={locale} />
                    </td>

                    <td className="px-3 py-3">
                      <ChevronRight
                        className="text-ink-subtle group-hover:text-ink size-4 transition-colors"
                        aria-hidden="true"
                      />
                    </td>
                  </tr>
                )
              })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Outstanding balance, or an honest refusal to state one.
 *
 * A customer billed in two currencies has two true numbers and no single true
 * number, and this product holds no exchange rate — so it says so rather than
 * adding EUR to MAD.
 */
export function OutstandingCell({
  customer,
  locale,
}: {
  customer: Pick<
    CustomerDirectoryEntry,
    'outstanding_currency_count' | 'outstanding_minor' | 'outstanding_currency'
  >
  locale: string
}) {
  if (customer.outstanding_currency_count === 0) {
    return <span className="text-ink-subtle">—</span>
  }

  if (customer.outstanding_currency_count > 1) {
    return (
      <span className="text-caution-700 text-[0.75rem]">
        {customer.outstanding_currency_count} currencies
      </span>
    )
  }

  return (
    <span className="text-ink font-medium">
      {formatMoney(customer.outstanding_minor ?? 0, customer.outstanding_currency ?? 'USD', {
        locale,
      })}
    </span>
  )
}
