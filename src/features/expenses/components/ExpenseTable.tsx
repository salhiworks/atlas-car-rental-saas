import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'

import { expenseDetailPath } from '@/app/routes/paths'
import { Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { ExpenseLedgerEntry } from '@/types/database'

import { PAYMENT_METHOD_LABELS } from '../schemas'
import { AllocationCell, AttachmentIndicator, ExpenseStatusBadge } from './ExpenseBadges'

export interface ExpenseTableProps {
  expenses: readonly ExpenseLedgerEntry[]
  locale: string
  isLoading?: boolean
}

/**
 * The ledger as a table.
 *
 * Money is right-aligned and tabular so a column of amounts can be scanned down
 * the decimal, and each row states its own currency — there is no single
 * currency for the page to assume, and a figure without one is a figure nobody
 * can act on.
 *
 * The date is rendered in UTC on purpose. `incurred_on` is a calendar date, not
 * an instant: a cost incurred on 31 July is 31 July whether the reader is in
 * Casablanca or Auckland, and putting it through a zone is exactly how it would
 * come out as the 30th.
 */
export function ExpenseTable({ expenses, locale, isLoading = false }: ExpenseTableProps) {
  return (
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full min-w-[980px] border-collapse text-start">
        <thead>
          <tr className="border-line border-b">
            <th scope="col" className="eyebrow px-5 py-2.5 text-start font-semibold">
              Date
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Description
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Category
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Belongs to
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start font-semibold">
              Supplier
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end font-semibold">
              Amount
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
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-48" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-32" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="h-4 w-28" />
                  </td>
                  <td className="px-3 py-3">
                    <Skeleton className="ms-auto h-4 w-20" />
                  </td>
                  <td />
                </tr>
              ))
            : expenses.map((expense) => (
                <tr
                  key={expense.id}
                  className={cn(
                    'group hover:bg-surface-muted transition-colors',
                    expense.status === 'voided' && 'opacity-60',
                  )}
                >
                  <td
                    data-numeric=""
                    className="text-ink px-5 py-3 text-[0.8125rem] whitespace-nowrap"
                  >
                    {formatDate(new Date(`${expense.incurred_on}T00:00:00Z`), {
                      locale,
                      timeZone: 'UTC',
                    })}
                  </td>

                  {/* `relative` scopes the stretched link to this cell, so the
                      description is clickable across it without nesting
                      interactive elements. */}
                  <td className="relative px-3 py-3">
                    <Link
                      to={expenseDetailPath(expense.id)}
                      className="text-ink block max-w-[22rem] truncate text-[0.875rem] leading-5 font-medium hover:underline"
                    >
                      {expense.description ?? 'Untitled cost'}
                      <span className="absolute inset-0" aria-hidden="true" />
                    </Link>
                    <span className="mt-0.5 flex items-center gap-2">
                      {expense.reference ? (
                        <span className="identifier text-ink-subtle text-[0.6875rem]">
                          {expense.reference}
                        </span>
                      ) : null}
                      <AttachmentIndicator count={expense.attachment_count} />
                      <ExpenseStatusBadge status={expense.status} />
                    </span>
                  </td>

                  <td className="px-3 py-3">
                    <span className="text-ink-muted text-[0.8125rem]">{expense.category_name}</span>
                  </td>

                  <td className="px-3 py-3">
                    <AllocationCell expense={expense} />
                  </td>

                  <td className="px-3 py-3">
                    <span className="text-ink-muted block max-w-[10rem] truncate text-[0.8125rem]">
                      {expense.vendor_name ?? '—'}
                    </span>
                    {expense.payment_method ? (
                      <span className="text-ink-subtle text-[0.6875rem]">
                        {PAYMENT_METHOD_LABELS[expense.payment_method]}
                      </span>
                    ) : null}
                  </td>

                  <td className="px-3 py-3 text-end">
                    <span
                      data-numeric=""
                      className={cn(
                        'text-ink text-[0.8125rem] font-medium',
                        expense.status === 'voided' && 'line-through',
                      )}
                    >
                      {formatMoney(expense.amount_minor, expense.currency, { locale })}
                    </span>
                    {expense.tax_amount_minor > 0 ? (
                      <span className="text-ink-subtle block text-[0.6875rem]">
                        incl. {formatMoney(expense.tax_amount_minor, expense.currency, { locale })}{' '}
                        {expense.tax_label ?? 'tax'}
                      </span>
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
