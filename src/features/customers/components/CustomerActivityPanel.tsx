import { CalendarClock, ReceiptText } from 'lucide-react'
import { Link } from 'react-router-dom'

import { rentalDetailPath } from '@/app/routes/paths'
import { CardBody, CardHeader, EmptyState, Skeleton } from '@/components/ui'
import type { ComplianceOptions } from '@/lib/compliance/expiry'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import type { CustomerDirectoryEntry } from '@/types/database'

import { useCustomerFinancialSummary } from '../queries'

export interface CustomerActivityPanelProps {
  customer: CustomerDirectoryEntry
  compliance: ComplianceOptions
  locale: string
}

/**
 * Rental history and money, read from the contracts that exist.
 *
 * Nothing here is invented: a customer with no rentals gets an empty state
 * rather than a row of zeroes dressed up as history. References are shown as
 * text rather than links because the Rentals module has no detail route yet, and
 * a link to a page that does not exist is worse than no link.
 */
export function CustomerActivityPanel({
  customer,
  compliance,
  locale,
}: CustomerActivityPanelProps) {
  const financeQuery = useCustomerFinancialSummary(customer.customer_id)
  const finance = financeQuery.data ?? []

  const hasHistory = customer.rental_count > 0

  return (
    <>
      <CardHeader title="Rental activity" description="Contracts and balances for this customer." />

      <CardBody className="p-0">
        {!hasHistory ? (
          <EmptyState
            size="sm"
            icon={CalendarClock}
            title="No rentals yet"
            description="Contracts involving this customer will appear here once the first one is created."
          />
        ) : (
          <>
            <dl className="divide-line grid grid-cols-2 divide-y sm:grid-cols-4 sm:divide-y-0 sm:divide-x">
              <Figure label="Rentals" value={String(customer.rental_count)} />
              <Figure
                label="First rental"
                value={
                  customer.first_rental_at
                    ? formatDate(new Date(customer.first_rental_at), {
                        locale,
                        timeZone: compliance.timeZone,
                      })
                    : '—'
                }
              />
              <Figure
                label="Last returned"
                value={
                  customer.last_rental_ends_at
                    ? formatDate(new Date(customer.last_rental_ends_at), {
                        locale,
                        timeZone: compliance.timeZone,
                      })
                    : '—'
                }
              />
              <Figure
                label="Currently"
                value={
                  customer.active_rental_reference
                    ? 'Renting'
                    : customer.upcoming_rental_reference
                      ? 'Booked'
                      : 'Idle'
                }
              />
            </dl>

            {customer.active_rental_reference || customer.upcoming_rental_reference ? (
              <div className="border-line space-y-2 border-t px-5 py-4">
                {customer.active_rental_reference && customer.active_rental_ends_at ? (
                  <p className="text-[0.8125rem]">
                    <span className="text-ink-subtle">Out on </span>
                    {customer.active_rental_id ? (
                      <Link
                        to={rentalDetailPath(customer.active_rental_id)}
                        className="identifier hover:underline"
                      >
                        {customer.active_rental_reference}
                      </Link>
                    ) : (
                      <span className="identifier">{customer.active_rental_reference}</span>
                    )}
                    <span className="text-ink-muted">
                      {' '}
                      · due back{' '}
                      {formatDate(new Date(customer.active_rental_ends_at), {
                        locale,
                        timeZone: compliance.timeZone,
                      })}
                    </span>
                  </p>
                ) : null}

                {customer.upcoming_rental_reference && customer.upcoming_rental_starts_at ? (
                  <p className="text-[0.8125rem]">
                    <span className="text-ink-subtle">Next booking </span>
                    {customer.upcoming_rental_id ? (
                      <Link
                        to={rentalDetailPath(customer.upcoming_rental_id)}
                        className="identifier hover:underline"
                      >
                        {customer.upcoming_rental_reference}
                      </Link>
                    ) : (
                      <span className="identifier">{customer.upcoming_rental_reference}</span>
                    )}
                    <span className="text-ink-muted">
                      {' '}
                      · from{' '}
                      {formatDate(new Date(customer.upcoming_rental_starts_at), {
                        locale,
                        timeZone: compliance.timeZone,
                      })}
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CardBody>

      <CardHeader
        title="Financial summary"
        description={
          finance.length > 1
            ? 'Reported per currency — figures in different currencies are never added together.'
            : 'Across this customer’s contracts.'
        }
        className="border-t"
      />

      <CardBody className="p-0">
        {financeQuery.isPending ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : finance.length === 0 ? (
          <EmptyState
            size="sm"
            icon={ReceiptText}
            title="Nothing billed yet"
            description="Charges, payments and balances appear once this customer has a contract."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-[0.8125rem]">
              <thead>
                <tr className="border-line border-b">
                  <th scope="col" className="eyebrow px-5 py-2 text-start font-semibold">
                    Currency
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-end font-semibold">
                    Charged
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-end font-semibold">
                    Paid
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-end font-semibold">
                    Outstanding
                  </th>
                  <th scope="col" className="eyebrow px-5 py-2 text-end font-semibold">
                    Deposits held
                  </th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {finance.map((row) => (
                  <tr key={row.currency}>
                    <td className="identifier px-5 py-2.5">{row.currency}</td>
                    <td data-numeric="" className="px-3 py-2.5 text-end">
                      {formatMoney(row.charged_minor, row.currency, { locale })}
                    </td>
                    <td data-numeric="" className="px-3 py-2.5 text-end">
                      {formatMoney(row.paid_minor, row.currency, { locale })}
                    </td>
                    <td
                      data-numeric=""
                      className={`px-3 py-2.5 text-end ${row.outstanding_minor > 0 ? 'text-critical-700 font-medium' : ''}`}
                    >
                      {formatMoney(row.outstanding_minor, row.currency, { locale })}
                    </td>
                    <td data-numeric="" className="px-5 py-2.5 text-end">
                      {formatMoney(row.deposits_held_minor, row.currency, { locale })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-5 py-3">
      <dt className="eyebrow">{label}</dt>
      <dd data-numeric="" className="text-ink mt-1 text-[0.8125rem] font-medium">
        {value}
      </dd>
    </div>
  )
}
