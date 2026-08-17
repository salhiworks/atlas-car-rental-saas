import { AlertTriangle, CarFront } from 'lucide-react'
import { Link } from 'react-router-dom'

import { financingDetailPath, vehicleDetailPath } from '@/app/routes/paths'
import { Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { FinancingAgreementOverview } from '@/types/database'

import { AGREEMENT_TYPE_LABELS, FREQUENCY_SHORT, urgencyOf } from '../domain'
import { AgreementStatusBadge, MoneyFact } from './FinancingBadges'

export interface AgreementTableProps {
  agreements: readonly FinancingAgreementOverview[]
  locale: string
  today: string
  isLoading?: boolean
}

/**
 * The financing ledger, at a desk.
 *
 * The column order is the order a manager reads: which car, who lent, what is
 * still owed, what is due next, and whether anything is late. Overdue is the
 * only thing given colour, because it is the only thing that needs an action
 * today.
 *
 * Principal outstanding shows "Not known" rather than a zero wherever the
 * agreement cannot support a figure — the same rule everywhere in this module.
 */
export function AgreementTable({ agreements, locale, today, isLoading }: AgreementTableProps) {
  if (isLoading) {
    return (
      <div className="hidden lg:block">
        <div className="space-y-2 p-5">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full border-collapse text-[0.8125rem]">
        <thead>
          <tr className="border-line bg-surface-muted border-b">
            <th scope="col" className="eyebrow px-5 py-2.5 text-start">
              Vehicle
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start">
              Lender
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end">
              Payment
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end">
              Principal left
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-start">
              Next due
            </th>
            <th scope="col" className="eyebrow px-3 py-2.5 text-end">
              Overdue
            </th>
            <th scope="col" className="eyebrow px-5 py-2.5 text-start">
              Status
            </th>
          </tr>
        </thead>

        <tbody className="divide-line divide-y">
          {agreements.map((agreement) => {
            const urgency = urgencyOf(agreement, today)

            return (
              <tr
                key={agreement.id}
                className={cn(
                  'hover:bg-surface-muted/60 transition-colors',
                  urgency === 'overdue' && 'bg-critical-50/30',
                )}
              >
                <td className="px-5 py-2.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <CarFront className="text-ink-subtle size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">
                      <Link
                        to={financingDetailPath(agreement.id)}
                        className="text-ink block truncate font-medium hover:underline"
                      >
                        {agreement.vehicle_make} {agreement.vehicle_model}
                      </Link>
                      <Link
                        to={vehicleDetailPath(agreement.vehicle_id)}
                        className="identifier text-ink-subtle block truncate text-[0.6875rem] hover:underline"
                      >
                        {agreement.vehicle_plate}
                        {agreement.vehicle_archived ? ' · retired' : ''}
                      </Link>
                    </span>
                  </span>
                </td>

                <td className="px-3 py-2.5">
                  <span className="text-ink block truncate">{agreement.lender_name}</span>
                  <span className="text-ink-subtle block truncate text-[0.6875rem]">
                    {AGREEMENT_TYPE_LABELS[agreement.agreement_type]}
                    {agreement.reference ? ` · ${agreement.reference}` : ''}
                  </span>
                </td>

                <td className="px-3 py-2.5 text-end">
                  {agreement.installment_amount_minor === null ? (
                    <span className="text-ink-subtle text-[0.75rem]">—</span>
                  ) : (
                    <>
                      <span data-numeric="" className="text-ink block whitespace-nowrap">
                        {formatMoney(agreement.installment_amount_minor, agreement.currency, {
                          locale,
                        })}
                      </span>
                      <span className="text-ink-subtle block text-[0.6875rem]">
                        {FREQUENCY_SHORT[agreement.payment_frequency]}
                      </span>
                    </>
                  )}
                </td>

                <td className="px-3 py-2.5 text-end">
                  {agreement.agreement_status === 'draft' ? (
                    /* Nothing is outstanding on an agreement that has not
                       started. Showing the whole amount financed here would
                       overstate what the agency owes today. */
                    <span className="text-ink-subtle text-[0.75rem]">—</span>
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
                      reason={
                        agreement.financed_amount_minor === null
                          ? 'The amount financed was never recorded, so there is no balance to derive.'
                          : 'Some payments have not been split.'
                      }
                    />
                  )}
                </td>

                <td className="px-3 py-2.5">
                  {agreement.next_due_on ? (
                    <>
                      <span className="text-ink block whitespace-nowrap">
                        {formatDate(new Date(`${agreement.next_due_on}T00:00:00Z`), {
                          locale,
                          timeZone: 'UTC',
                        })}
                      </span>
                      {agreement.next_due_minor !== null ? (
                        <span
                          data-numeric=""
                          className="text-ink-subtle block text-[0.6875rem] whitespace-nowrap"
                        >
                          {formatMoney(agreement.next_due_minor, agreement.currency, { locale })}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-ink-subtle text-[0.75rem]">Nothing scheduled</span>
                  )}
                </td>

                <td className="px-3 py-2.5 text-end">
                  {agreement.overdue_minor > 0 ? (
                    <span className="text-critical-700 inline-flex items-center gap-1 whitespace-nowrap">
                      <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                      <span data-numeric="" className="font-medium">
                        {formatMoney(agreement.overdue_minor, agreement.currency, { locale })}
                      </span>
                    </span>
                  ) : (
                    <span className="text-ink-subtle text-[0.75rem]">—</span>
                  )}
                </td>

                <td className="px-5 py-2.5">
                  <AgreementStatusBadge status={agreement.agreement_status} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
