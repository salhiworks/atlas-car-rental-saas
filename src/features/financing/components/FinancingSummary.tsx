import { AlertTriangle, CalendarClock, Coins, Landmark } from 'lucide-react'

import { Alert, Skeleton } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { OrganizationFinancingSummaryRow } from '@/types/database'

export interface FinancingSummaryStripProps {
  rows: readonly OrganizationFinancingSummaryRow[]
  locale: string
  periodLabel: string
  isLoading: boolean
}

/**
 * The agency's financing position at a glance.
 *
 * Four figures, not ten. Each answers a question a manager actually asks:
 * what do we still owe, what did we send the lenders this period, what is
 * coming, and what is late.
 *
 * Two currencies are never added. With one currency this is four tiles; with
 * several it is an honest per-currency list, because the alternative is
 * inventing an exchange rate.
 *
 * A principal balance that cannot be derived is not shown as zero — it is
 * excluded from the total and the number of agreements it came from is stated,
 * so the figure is readable as "at least this, across the ones we can compute".
 */
export function FinancingSummaryStrip({
  rows,
  locale,
  periodLabel,
  isLoading,
}: FinancingSummaryStripProps) {
  if (isLoading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="border-line bg-surface rounded-lg border px-4 py-3">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
    )
  }

  const present = rows.filter(
    (row) =>
      row.agreement_count > 0 ||
      row.cash_paid_minor > 0 ||
      row.overdue_minor > 0 ||
      row.due_soon_minor > 0,
  )

  if (present.length === 0) {
    return (
      <div className="border-line bg-surface rounded-lg border px-4 py-6 text-center">
        <p className="text-ink-muted text-[0.875rem]">No financing recorded yet.</p>
      </div>
    )
  }

  if (present.length > 1) {
    return (
      <div className="space-y-2">
        <Alert tone="info" title="Financing in more than one currency">
          These figures are not added together — this product holds no exchange rate, and a combined
          number would be a guess. Each currency is shown on its own.
        </Alert>

        <div className="border-line bg-surface divide-line divide-y rounded-lg border">
          {present.map((row) => (
            <div
              key={row.currency}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3"
            >
              <span className="text-ink w-14 shrink-0 text-[0.8125rem] font-semibold">
                {row.currency}
              </span>
              <span className="text-ink-subtle text-[0.75rem]">
                {row.active_agreement_count} active ·{' '}
                {row.remaining_principal_minor === null
                  ? 'principal not known'
                  : `${formatMoney(row.remaining_principal_minor, row.currency, { locale })} principal`}{' '}
                · {formatMoney(row.cash_paid_minor, row.currency, { locale })} paid ·{' '}
                {formatMoney(row.overdue_minor, row.currency, { locale })} overdue
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const only = present[0]!
  const money = (minor: number) => formatMoney(minor, only.currency, { locale })

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        icon={<Landmark className="text-brand-600 size-4 shrink-0" aria-hidden="true" />}
        value={
          only.remaining_principal_minor === null
            ? 'Not known'
            : money(only.remaining_principal_minor)
        }
        label={
          only.unknown_principal_count > 0
            ? `Principal outstanding · ${only.unknown_principal_count} not derivable`
            : 'Principal outstanding'
        }
        muted={only.remaining_principal_minor === null}
      />
      <Tile
        icon={<Coins className="text-ink-subtle size-4 shrink-0" aria-hidden="true" />}
        value={money(only.cash_paid_minor)}
        label={`Paid to lenders · ${periodLabel.toLowerCase()}`}
      />
      <Tile
        icon={<CalendarClock className="text-ink-subtle size-4 shrink-0" aria-hidden="true" />}
        value={money(only.due_soon_minor)}
        label={`Due in 30 days · ${only.due_soon_count} payment${only.due_soon_count === 1 ? '' : 's'}`}
      />
      <Tile
        icon={
          <AlertTriangle
            className={cn(
              'size-4 shrink-0',
              only.overdue_minor > 0 ? 'text-critical-600' : 'text-ink-subtle',
            )}
            aria-hidden="true"
          />
        }
        value={money(only.overdue_minor)}
        label={`Overdue · ${only.overdue_count} payment${only.overdue_count === 1 ? '' : 's'}`}
        critical={only.overdue_minor > 0}
      />
    </div>
  )
}

function Tile({
  icon,
  value,
  label,
  muted = false,
  critical = false,
}: {
  icon: React.ReactNode
  value: string
  label: string
  muted?: boolean
  critical?: boolean
}) {
  return (
    <div
      className={cn(
        'border-line bg-surface flex items-center gap-3 rounded-lg border px-4 py-3',
        critical && 'border-critical-200 bg-critical-50/40',
      )}
    >
      {icon}
      <span className="min-w-0">
        <span
          data-numeric=""
          className={cn(
            'block text-[1.25rem] leading-7 font-semibold',
            muted ? 'text-ink-subtle text-[1rem]' : critical ? 'text-critical-700' : 'text-ink',
          )}
        >
          {value}
        </span>
        <span className="text-ink-subtle block truncate text-[0.6875rem]">{label}</span>
      </span>
    </div>
  )
}
