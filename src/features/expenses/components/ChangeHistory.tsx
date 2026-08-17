import { History, Ban } from 'lucide-react'

import { Badge, EmptyState } from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import type { ExpenseAllocation, ExpenseChangeEvent } from '@/types/database'

import { ALLOCATION_LABELS } from '../allocation'

export interface ChangeHistoryProps {
  events: readonly ExpenseChangeEvent[]
  currency: string
  locale: string
  timeZone: string
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  amount_minor: 'Amount',
  tax_amount_minor: 'Tax',
  currency: 'Currency',
  incurred_on: 'Date incurred',
  allocation: 'Belongs to',
  vehicle_id: 'Vehicle',
  rental_id: 'Rental',
  category_id: 'Category',
  vendor_id: 'Supplier',
  status: 'Status',
}

/**
 * Renders one changed value.
 *
 * Money is formatted, an allocation is named, and an id is reported as changed
 * rather than as a uuid — a raw identifier tells a manager nothing, and
 * resolving every historical id would mean a query per row for names that may
 * themselves since have changed.
 */
function describe(field: string, value: unknown, currency: string, locale: string): string {
  if (value === null || value === undefined) return 'nothing'
  if (field === 'amount_minor' || field === 'tax_amount_minor') {
    return formatMoney(Number(value), currency, { locale })
  }
  if (field.endsWith('_id')) return 'another record'

  // Everything the trigger records is a scalar. Anything else would be a
  // change to the trigger, so it reads as unknown rather than as
  // "[object Object]" on a manager's screen.
  if (typeof value === 'string') {
    return field === 'allocation' ? (ALLOCATION_LABELS[value as ExpenseAllocation] ?? value) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return 'a value we cannot show'
}

/**
 * What has been corrected on this cost.
 *
 * Present because `updated_at` alone says only that something changed. A figure
 * edited from 1,200 to 12,000 has to leave a trace of the 1,200, or the edit is
 * indistinguishable from the original entry.
 */
export function ChangeHistory({ events, currency, locale, timeZone }: ChangeHistoryProps) {
  if (events.length === 0) {
    return (
      <EmptyState
        icon={History}
        size="sm"
        title="Never corrected"
        description="This cost is exactly as it was first recorded."
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
                Voided
              </Badge>
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

          {event.kind === 'correction' ? (
            <ul className="mt-1 space-y-0.5">
              {Object.entries(event.changes).map(([field, change]) => (
                <li key={field} className="text-ink text-[0.8125rem]">
                  <span className="text-ink-subtle">{FIELD_LABELS[field] ?? field}:</span>{' '}
                  <span className="line-through opacity-70">
                    {describe(field, change.from, currency, locale)}
                  </span>{' '}
                  <span aria-hidden="true">→</span>{' '}
                  <span className="font-medium">
                    {describe(field, change.to, currency, locale)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  )
}
