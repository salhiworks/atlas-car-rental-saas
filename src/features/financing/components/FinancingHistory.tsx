import { Ban, History } from 'lucide-react'

import { Badge, EmptyState } from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import type { FinancingChangeEvent } from '@/types/database'

import { AGREEMENT_STATUS_LABELS, FREQUENCY_LABELS, MODE_LABELS, formatRate } from '../domain'

export interface FinancingHistoryProps {
  events: readonly FinancingChangeEvent[]
  currency: string
  locale: string
  timeZone: string
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  financed_amount_minor: 'Amount financed',
  rate_bps: 'Rate',
  installment_amount_minor: 'Payment',
  installments_count: 'Term',
  payment_frequency: 'Frequency',
  first_payment_on: 'First payment',
  balloon_minor: 'Final payment',
  down_payment_amount_minor: 'Down payment',
  currency: 'Currency',
  lender_id: 'Lender',
  mode: 'Kind of agreement',
  agreement_status: 'Status',
  amount_minor: 'Amount',
  status: 'Status',
}

const MONEY_FIELDS = new Set([
  'financed_amount_minor',
  'installment_amount_minor',
  'balloon_minor',
  'down_payment_amount_minor',
  'amount_minor',
])

/**
 * Renders one changed value.
 *
 * Nothing means nothing: a rate that was never recorded reads as "not recorded"
 * rather than as 0%, which is the same distinction the rest of the module makes.
 */
function describe(field: string, value: unknown, currency: string, locale: string): string {
  if (value === null || value === undefined) return 'not recorded'

  if (MONEY_FIELDS.has(field)) return formatMoney(Number(value), currency, { locale })
  if (field === 'rate_bps') return formatRate(Number(value)) ?? 'not recorded'
  if (field.endsWith('_id')) return 'another record'

  if (typeof value === 'string') {
    if (field === 'agreement_status' || field === 'status') {
      return AGREEMENT_STATUS_LABELS[value as keyof typeof AGREEMENT_STATUS_LABELS] ?? value
    }
    if (field === 'payment_frequency') {
      return FREQUENCY_LABELS[value as keyof typeof FREQUENCY_LABELS] ?? value
    }
    if (field === 'mode') return MODE_LABELS[value as keyof typeof MODE_LABELS] ?? value
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return 'a value we cannot show'
}

/**
 * What has been corrected on this agreement.
 *
 * Present because `updated_at` alone says only that something changed. A rate
 * edited from 7.25% to 2.25% has to leave a trace of the 7.25%, or the
 * correction is indistinguishable from the original entry.
 */
export function FinancingHistory({ events, currency, locale, timeZone }: FinancingHistoryProps) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={History}
        size="sm"
        title="Never corrected"
        description="This agreement is exactly as it was first recorded."
      />
    )
  }

  return (
    <ol className="divide-line divide-y">
      {events.map((event) => (
        <li key={event.id} className="py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {event.kind === 'void' ? (
              <Badge tone="critical" className="gap-1">
                <Ban className="size-3" aria-hidden="true" />
                Payment voided
              </Badge>
            ) : event.kind === 'status' ? (
              <Badge tone="info">Status changed</Badge>
            ) : (
              <Badge tone="neutral">Corrected</Badge>
            )}
            <span className="text-ink-subtle text-[0.75rem]">
              {formatDateTime(new Date(event.changed_at), { locale, timeZone })}
            </span>
          </div>

          {event.reason ? (
            <p className="text-ink-muted mt-1 text-[0.8125rem] italic">{event.reason}</p>
          ) : null}

          <ul className="mt-1 space-y-0.5">
            {Object.entries(event.changes).map(([field, change]) => (
              <li key={field} className="text-ink text-[0.8125rem]">
                <span className="text-ink-subtle">{FIELD_LABELS[field] ?? field}:</span>{' '}
                <span className="line-through opacity-70">
                  {describe(field, change.from, currency, locale)}
                </span>{' '}
                <span aria-hidden="true">→</span>{' '}
                <span className="font-medium">{describe(field, change.to, currency, locale)}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  )
}
