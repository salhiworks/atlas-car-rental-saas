import { Ban, Coins } from 'lucide-react'

import { Badge, Button, EmptyState, Skeleton } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { FinancingPayment } from '@/types/database'

import { PAYMENT_PURPOSE_LABELS } from '../domain'

export interface PaymentListProps {
  payments: readonly FinancingPayment[]
  locale: string
  isLoading?: boolean
  canVoid: boolean
  onVoid?: (payment: FinancingPayment) => void
}

const METHOD_LABELS: Readonly<Record<string, string>> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  online: 'Online',
  other: 'Other',
}

/**
 * What actually went to the lender.
 *
 * Each row shows how the money was split, and says plainly when it was not.
 * A voided payment stays on the list, struck through and labelled, because the
 * record of a correction is part of the correction.
 */
export function PaymentList({ payments, locale, isLoading, canVoid, onVoid }: PaymentListProps) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-5">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (payments.length === 0) {
    return (
      <EmptyState
        icon={Coins}
        size="sm"
        title="Nothing paid yet"
        description="Record a payment as soon as one leaves the account, and the position below follows from it."
      />
    )
  }

  return (
    <ul className="divide-line divide-y">
      {payments.map((payment) => {
        const voided = payment.status === 'voided'
        const money = (minor: number) => formatMoney(minor, payment.currency, { locale })

        return (
          <li key={payment.id} className={cn('px-5 py-3', voided && 'bg-surface-muted/50')}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span
                    data-numeric=""
                    className={cn(
                      'text-ink text-[0.9375rem] font-semibold',
                      voided && 'text-ink-subtle line-through',
                    )}
                  >
                    {money(payment.amount_minor)}
                  </span>
                  {voided ? <Badge tone="critical">Voided</Badge> : null}
                  {payment.purpose !== 'installment' ? (
                    <Badge tone="neutral">{PAYMENT_PURPOSE_LABELS[payment.purpose]}</Badge>
                  ) : null}
                </p>

                <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                  {formatDate(new Date(`${payment.paid_on}T00:00:00Z`), {
                    locale,
                    timeZone: 'UTC',
                  })}
                  {payment.method ? ` · ${METHOD_LABELS[payment.method] ?? payment.method}` : ''}
                  {payment.reference ? ` · ${payment.reference}` : ''}
                </p>

                {/* How the money was split — or the honest absence of a split. */}
                <p className="text-ink-muted mt-1 text-[0.75rem]">
                  {payment.unallocated_minor === payment.amount_minor ? (
                    <span className="text-ink-subtle">
                      Split not recorded — counted as cash paid, not as interest or principal.
                    </span>
                  ) : (
                    <>
                      {payment.principal_minor > 0
                        ? `${money(payment.principal_minor)} principal`
                        : null}
                      {payment.principal_minor > 0 && payment.interest_minor > 0 ? ' · ' : ''}
                      {payment.interest_minor > 0
                        ? `${money(payment.interest_minor)} interest`
                        : null}
                      {payment.fees_minor > 0
                        ? `${payment.principal_minor > 0 || payment.interest_minor > 0 ? ' · ' : ''}${money(payment.fees_minor)} fees`
                        : null}
                      {payment.unallocated_minor > 0
                        ? ` · ${money(payment.unallocated_minor)} unallocated`
                        : null}
                    </>
                  )}
                </p>

                {payment.notes ? (
                  <p className="text-ink-subtle mt-1 text-[0.75rem] italic">{payment.notes}</p>
                ) : null}

                {voided && payment.void_reason ? (
                  <p className="text-critical-700 mt-1 text-[0.75rem]">
                    Voided: {payment.void_reason}
                  </p>
                ) : null}
              </div>

              {canVoid && !voided ? (
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<Ban />}
                  onClick={() => onVoid?.(payment)}
                >
                  Void
                </Button>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
