import { Plus, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'

import { expenseDetailPath, paths } from '@/app/routes/paths'
import { ButtonLink, Card, CardBody, CardHeader, Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'

import { useExpenseList, useRentalExpenseSummary } from '../queries'

export interface RentalCostPanelProps {
  rentalId: string
  locale: string
  canRecord: boolean
}

/**
 * What this hire cost the agency.
 *
 * Deliberately not inside Charges, and deliberately not styled like it. A
 * charge is money the customer owes; a cost is money the agency spent. Putting
 * a valet or a toll into the contract total because it happened during the hire
 * would bill the customer for something nobody agreed to — so this panel adds
 * to nothing on the contract and says as much.
 */
export function RentalCostPanel({ rentalId, locale, canRecord }: RentalCostPanelProps) {
  const summaryQuery = useRentalExpenseSummary(rentalId)
  const listQuery = useExpenseList({ rentalId, status: 'recorded', sort: 'date', pageSize: 20 })

  const summary = summaryQuery.data ?? []
  const expenses = listQuery.data?.rows ?? []

  return (
    <Card className="border-dashed">
      <CardHeader
        title="Agency costs"
        description="Money the agency spent on this hire. Not billed to the customer and not part of the contract total."
        actions={
          canRecord ? (
            <ButtonLink
              variant="ghost"
              size="sm"
              leadingIcon={<Plus />}
              to={`${paths.expenseNew}?rental=${rentalId}`}
            >
              Add a cost
            </ButtonLink>
          ) : null
        }
      />

      <CardBody>
        {summaryQuery.isPending || listQuery.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : expenses.length === 0 ? (
          <p className="text-ink-subtle flex items-center gap-2 text-[0.8125rem]">
            <Wallet className="size-3.5 shrink-0" aria-hidden="true" />
            Nothing recorded against this hire.
          </p>
        ) : (
          <div className="space-y-3">
            <ul className="divide-line divide-y">
              {expenses.map((expense) => (
                <li key={expense.id} className="flex items-center gap-3 py-2">
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
                      {expense.vendor_name ? ` · ${expense.vendor_name}` : ''}
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

            {/* One line per currency: two are never added together. */}
            <dl className="border-line space-y-1 border-t pt-2">
              {summary.map((row) => (
                <div key={row.currency} className="flex items-center justify-between gap-3">
                  <dt className="text-ink-muted text-[0.8125rem]">
                    Cost to the agency{summary.length > 1 ? ` (${row.currency})` : ''}
                  </dt>
                  <dd data-numeric="" className="text-ink text-[0.8125rem] font-semibold">
                    {formatMoney(row.total_minor, row.currency, { locale })}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
