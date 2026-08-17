import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'

import { financingDetailPath } from '@/app/routes/paths'
import { Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { FinancingAgreementOverview } from '@/types/database'

import { FREQUENCY_SHORT, urgencyOf } from '../domain'
import { AgreementStatusBadge, MoneyFact } from './FinancingBadges'

export interface AgreementCardListProps {
  agreements: readonly FinancingAgreementOverview[]
  locale: string
  today: string
  isLoading?: boolean
}

/**
 * The same ledger on a phone.
 *
 * A seven-column table does not survive 390 pixels, and a horizontally
 * scrolling one is a table nobody reads. Each agreement becomes a card whose
 * first line is the car and whose last line is the thing that needs doing.
 */
export function AgreementCardList({
  agreements,
  locale,
  today,
  isLoading,
}: AgreementCardListProps) {
  if (isLoading) {
    return (
      <ul className="divide-line divide-y lg:hidden">
        {Array.from({ length: 4 }).map((_, index) => (
          <li key={index} className="px-4 py-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-2 h-3 w-1/2" />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul className="divide-line divide-y lg:hidden">
      {agreements.map((agreement) => {
        const urgency = urgencyOf(agreement, today)

        return (
          <li
            key={agreement.id}
            className={cn('px-4 py-3', urgency === 'overdue' && 'bg-critical-50/30')}
          >
            <Link to={financingDetailPath(agreement.id)} className="block">
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="text-ink block truncate text-[0.875rem] font-medium">
                    {agreement.vehicle_make} {agreement.vehicle_model}
                  </span>
                  <span className="identifier text-ink-subtle block truncate text-[0.6875rem]">
                    {agreement.vehicle_plate} · {agreement.lender_name}
                  </span>
                </span>
                <AgreementStatusBadge status={agreement.agreement_status} />
              </span>

              <span className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-ink-subtle text-[0.6875rem]">
                  Payment{' '}
                  {agreement.installment_amount_minor === null ? (
                    '—'
                  ) : (
                    <span data-numeric="" className="text-ink">
                      {formatMoney(agreement.installment_amount_minor, agreement.currency, {
                        locale,
                      })}{' '}
                      {FREQUENCY_SHORT[agreement.payment_frequency]}
                    </span>
                  )}
                </span>

                <span className="text-ink-subtle text-[0.6875rem]">
                  Principal left{' '}
                  {agreement.agreement_status === 'draft' ? (
                    <span className="text-ink">—</span>
                  ) : (
                    <MoneyFact
                      amountMinor={agreement.remaining_principal_minor}
                      currency={agreement.currency}
                      locale={locale}
                      state={
                        agreement.principal_known
                          ? 'known'
                          : agreement.financed_amount_minor === null
                            ? 'unknown'
                            : 'incomplete'
                      }
                      className="text-[0.75rem]"
                    />
                  )}
                </span>
              </span>

              {agreement.overdue_minor > 0 ? (
                <span className="text-critical-700 mt-2 flex items-center gap-1 text-[0.75rem]">
                  <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                  <span data-numeric="" className="font-medium">
                    {formatMoney(agreement.overdue_minor, agreement.currency, { locale })}
                  </span>{' '}
                  overdue
                </span>
              ) : agreement.next_due_on ? (
                <span className="text-ink-subtle mt-2 block text-[0.75rem]">
                  Next{' '}
                  {formatDate(new Date(`${agreement.next_due_on}T00:00:00Z`), {
                    locale,
                    timeZone: 'UTC',
                  })}
                  {agreement.next_due_minor !== null
                    ? ` · ${formatMoney(agreement.next_due_minor, agreement.currency, { locale })}`
                    : ''}
                </span>
              ) : null}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
