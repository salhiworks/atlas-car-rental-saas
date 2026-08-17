import { AlertTriangle, CalendarClock, Landmark } from 'lucide-react'
import { Link } from 'react-router-dom'

import { financingDetailPath, paths } from '@/app/routes/paths'
import { Card, CardBody, CardHeader, Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'

import { useDueObligations } from '../queries'

export interface FinancingObligationsCardProps {
  locale: string
  enabled: boolean
}

/** Nothing beyond this is worth the dashboard's attention. */
const MAX_ROWS = 4

/**
 * What the lenders are about to ask for.
 *
 * The Overview is an operations dashboard, not a treasury screen, so this is
 * deliberately one small card: what is late, and what is coming in the next
 * fortnight. It changes none of the figures above it — the operating result is
 * revenue less recorded operating costs and financing does not touch it.
 *
 * It disappears entirely when there is nothing due, because an empty card on a
 * dashboard is a line of noise every single day.
 */
export function FinancingObligationsCard({ locale, enabled }: FinancingObligationsCardProps) {
  const dueQuery = useDueObligations(14, enabled)

  if (!enabled) return null

  if (dueQuery.isPending) {
    return (
      <Card>
        <CardHeader title="Financing due" />
        <CardBody className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </CardBody>
      </Card>
    )
  }

  const obligations = dueQuery.data ?? []
  if (obligations.length === 0) return null

  const overdue = obligations.filter((row) => row.is_overdue)
  const visible = obligations.slice(0, MAX_ROWS)

  return (
    <Card>
      <CardHeader
        title="Financing due"
        description={
          overdue.length > 0
            ? `${overdue.length} payment${overdue.length === 1 ? '' : 's'} overdue`
            : 'In the next fortnight'
        }
        actions={
          <Link to={paths.financing} className="text-ink-muted hover:text-ink text-[0.8125rem]">
            All financing
          </Link>
        }
      />
      <CardBody className="p-0">
        <ul className="divide-line divide-y">
          {visible.map((obligation) => (
            <li key={obligation.installment_id} className="px-5 py-2.5">
              <Link
                to={financingDetailPath(obligation.agreement_id)}
                className="flex items-center gap-3"
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded',
                    obligation.is_overdue
                      ? 'bg-critical-50 text-critical-600'
                      : 'bg-surface-inset text-ink-subtle',
                  )}
                  aria-hidden="true"
                >
                  {obligation.is_overdue ? (
                    <AlertTriangle className="size-3.5" />
                  ) : (
                    <CalendarClock className="size-3.5" />
                  )}
                </span>

                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-ink block truncate text-[0.8125rem]">
                    {obligation.vehicle_make} {obligation.vehicle_model} · {obligation.lender_name}
                  </span>
                  <span className="text-ink-subtle block truncate text-[0.6875rem]">
                    {obligation.is_overdue
                      ? `Overdue since ${formatDate(new Date(`${obligation.due_on}T00:00:00Z`), { locale, timeZone: 'UTC' })}`
                      : formatDate(new Date(`${obligation.due_on}T00:00:00Z`), {
                          locale,
                          timeZone: 'UTC',
                        })}
                    {obligation.is_balloon ? ' · balloon' : ''}
                  </span>
                </span>

                <span
                  data-numeric=""
                  className={cn(
                    'shrink-0 text-[0.8125rem] whitespace-nowrap',
                    obligation.is_overdue ? 'text-critical-700 font-medium' : 'text-ink',
                  )}
                >
                  {formatMoney(obligation.outstanding_minor, obligation.currency, { locale })}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="text-ink-subtle border-line border-t px-5 py-2.5 text-[0.75rem] leading-4">
          <Landmark className="me-1 inline size-3" aria-hidden="true" />
          Money owed to lenders. It is not an operating cost and does not change the operating
          result above.
          {obligations.length > MAX_ROWS
            ? ` ${obligations.length - MAX_ROWS} more due in this window.`
            : ''}
        </p>
      </CardBody>
    </Card>
  )
}
