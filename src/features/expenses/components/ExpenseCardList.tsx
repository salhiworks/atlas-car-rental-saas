import { Link } from 'react-router-dom'

import { expenseDetailPath } from '@/app/routes/paths'
import { Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { ExpenseLedgerEntry } from '@/types/database'

import { AllocationCell, AttachmentIndicator, ExpenseStatusBadge } from './ExpenseBadges'

export interface ExpenseCardListProps {
  expenses: readonly ExpenseLedgerEntry[]
  locale: string
  isLoading?: boolean
}

/** The same ledger on a phone, where a six-column table cannot go. */
export function ExpenseCardList({ expenses, locale, isLoading = false }: ExpenseCardListProps) {
  if (isLoading) {
    return (
      <ul className="divide-line divide-y lg:hidden">
        {Array.from({ length: 4 }).map((_, index) => (
          <li key={index} className="space-y-2 px-4 py-3.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3.5 w-28" />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul className="divide-line divide-y lg:hidden">
      {expenses.map((expense) => (
        <li key={expense.id} className={cn(expense.status === 'voided' && 'opacity-60')}>
          <Link
            to={expenseDetailPath(expense.id)}
            className="hover:bg-surface-muted focus-visible:outline-brand-500 block px-4 py-3.5 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-ink truncate text-[0.875rem] font-medium">
                  {expense.description ?? 'Untitled cost'}
                </p>
                <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                  {formatDate(new Date(`${expense.incurred_on}T00:00:00Z`), {
                    locale,
                    timeZone: 'UTC',
                  })}{' '}
                  · {expense.category_name}
                </p>
              </div>
              <span
                data-numeric=""
                className={cn(
                  'text-ink shrink-0 text-[0.875rem] font-semibold',
                  expense.status === 'voided' && 'line-through',
                )}
              >
                {formatMoney(expense.amount_minor, expense.currency, { locale })}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <AllocationCell expense={expense} linked={false} />
              {expense.vendor_name ? (
                <span className="text-ink-subtle truncate text-[0.75rem]">
                  {expense.vendor_name}
                </span>
              ) : null}
              <AttachmentIndicator count={expense.attachment_count} />
              <ExpenseStatusBadge status={expense.status} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
