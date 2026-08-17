import { ChevronDown, Landmark } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Badge, Button, EmptyState, Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { FinancingInstallmentStatus } from '@/types/database'

import { InstallmentStateBadge } from './FinancingBadges'

export interface ScheduleTableProps {
  installments: readonly FinancingInstallmentStatus[]
  currency: string
  locale: string
  isLoading?: boolean
  canRecord: boolean
  onRecordPayment?: (installment: FinancingInstallmentStatus) => void
}

/** How many rows to show before asking. A 60-month loan is not a first read. */
const INITIAL_ROWS = 12

/**
 * The expected schedule, with what has actually been paid against each row.
 *
 * The window matters: an agreement can have sixty instalments and nobody opens
 * this page to read all sixty. What opens is the part that is unsettled, plus a
 * little history for context — everything else is one press away.
 *
 * The principal and interest columns are absent entirely in simple mode rather
 * than filled with dashes: a column of nothing is a column that invites somebody
 * to wonder whether it is zero.
 */
export function ScheduleTable({
  installments,
  currency,
  locale,
  isLoading,
  canRecord,
  onRecordPayment,
}: ScheduleTableProps) {
  const [expanded, setExpanded] = useState(false)

  const splitKnown = installments.some((row) => row.expected_principal_minor !== null)

  const { rows, hiddenCount } = useMemo(() => {
    if (expanded || installments.length <= INITIAL_ROWS) {
      return { rows: installments, hiddenCount: 0 }
    }

    // Anchor the window on the first unsettled row, with a couple of settled
    // ones above it so the reader can see where they are.
    const firstOpen = installments.findIndex((row) => row.outstanding_minor > 0)
    const start = firstOpen <= 2 ? 0 : Math.min(firstOpen - 2, installments.length - INITIAL_ROWS)
    return {
      rows: installments.slice(start, start + INITIAL_ROWS),
      hiddenCount: installments.length - INITIAL_ROWS,
    }
  }, [installments, expanded])

  if (isLoading) {
    return (
      <div className="space-y-2 p-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    )
  }

  if (installments.length === 0) {
    return (
      <EmptyState
        icon={Landmark}
        size="sm"
        title="No schedule yet"
        description="Activate this agreement to generate the payments it implies."
      />
    )
  }

  const money = (minor: number) => formatMoney(minor, currency, { locale })

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.8125rem]">
          <thead>
            <tr className="border-line bg-surface-muted border-b">
              <th scope="col" className="eyebrow w-10 px-4 py-2 text-start">
                #
              </th>
              <th scope="col" className="eyebrow px-3 py-2 text-start">
                Due
              </th>
              <th scope="col" className="eyebrow px-3 py-2 text-end">
                Expected
              </th>
              {splitKnown ? (
                <>
                  <th scope="col" className="eyebrow px-3 py-2 text-end">
                    Principal
                  </th>
                  <th scope="col" className="eyebrow px-3 py-2 text-end">
                    Interest
                  </th>
                </>
              ) : null}
              <th scope="col" className="eyebrow px-3 py-2 text-end">
                Paid
              </th>
              <th scope="col" className="eyebrow px-3 py-2 text-end">
                Left
              </th>
              <th scope="col" className="eyebrow px-4 py-2 text-start">
                Status
              </th>
              {canRecord ? <th scope="col" className="w-10 px-2 py-2" /> : null}
            </tr>
          </thead>

          <tbody className="divide-line divide-y">
            {rows.map((installment) => (
              <tr
                key={installment.id}
                className={cn(
                  'transition-colors',
                  installment.is_overdue && 'bg-critical-50/30',
                  installment.state === 'paid' && 'opacity-70',
                )}
              >
                <td data-numeric="" className="text-ink-subtle px-4 py-2">
                  {installment.sequence}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatDate(new Date(`${installment.due_on}T00:00:00Z`), {
                    locale,
                    timeZone: 'UTC',
                  })}
                  {installment.is_balloon ? (
                    <Badge tone="caution" className="ms-2">
                      Balloon
                    </Badge>
                  ) : null}
                </td>
                <td data-numeric="" className="text-ink px-3 py-2 text-end whitespace-nowrap">
                  {money(installment.expected_total_minor)}
                </td>
                {splitKnown ? (
                  <>
                    <td
                      data-numeric=""
                      className="text-ink-muted px-3 py-2 text-end whitespace-nowrap"
                    >
                      {installment.expected_principal_minor === null
                        ? '—'
                        : money(installment.expected_principal_minor)}
                    </td>
                    <td
                      data-numeric=""
                      className="text-ink-muted px-3 py-2 text-end whitespace-nowrap"
                    >
                      {installment.expected_interest_minor === null
                        ? '—'
                        : money(installment.expected_interest_minor)}
                    </td>
                  </>
                ) : null}
                <td data-numeric="" className="text-ink px-3 py-2 text-end whitespace-nowrap">
                  {installment.paid_minor === 0 ? (
                    <span className="text-ink-subtle">—</span>
                  ) : (
                    money(installment.paid_minor)
                  )}
                </td>
                <td
                  data-numeric=""
                  className={cn(
                    'px-3 py-2 text-end whitespace-nowrap',
                    installment.is_overdue ? 'text-critical-700 font-medium' : 'text-ink-muted',
                  )}
                >
                  {installment.outstanding_minor === 0 ? '—' : money(installment.outstanding_minor)}
                </td>
                <td className="px-4 py-2">
                  <InstallmentStateBadge state={installment.state} />
                </td>
                {canRecord ? (
                  <td className="px-2 py-2">
                    {installment.outstanding_minor > 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRecordPayment?.(installment)}
                      >
                        Pay
                      </Button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hiddenCount > 0 ? (
        <div className="border-line border-t px-4 py-2.5 text-center">
          <Button
            variant="ghost"
            size="sm"
            trailingIcon={<ChevronDown />}
            onClick={() => setExpanded(true)}
          >
            Show all {installments.length} payments
          </Button>
        </div>
      ) : null}

      {!splitKnown ? (
        <p className="text-ink-subtle border-line border-t px-4 py-2.5 text-[0.75rem]">
          This agreement records what is paid and when. How much of each payment is interest was
          never recorded, so it is not shown — and not guessed at.
        </p>
      ) : null}
    </div>
  )
}
