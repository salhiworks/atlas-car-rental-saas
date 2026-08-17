import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'

import { CHARGE_KIND_LABELS, formatTaxRate, type Quote } from '../pricing'

export interface QuoteSummaryProps {
  quote: Quote
  locale: string
  depositMinor: number
  taxLabel: string | null
  /** Omitted where the lines are not editable — a signed contract, for one. */
  onRemoveLine?: (index: number) => void
  /** Marks lines the desk cannot remove, such as the hire itself. */
  isRemovable?: (index: number) => boolean
}

/**
 * What the customer is being asked to pay, itemised.
 *
 * The deposit is shown apart from the total and never added to it. It is the
 * customer's money held against damage, not income — and a total that quietly
 * included it would be the single most expensive mistake this screen could make.
 */
export function QuoteSummary({
  quote,
  locale,
  depositMinor,
  taxLabel,
  onRemoveLine,
  isRemovable,
}: QuoteSummaryProps) {
  const cash = (minor: number) => formatMoney(minor, quote.currency, { locale })

  return (
    <div className="space-y-3">
      <ul className="divide-line divide-y">
        {quote.lines.map((line, index) => (
          <li key={`${line.kind}-${index}`} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-ink truncate text-[0.8125rem]">{line.description}</p>
              <p className="text-ink-subtle text-[0.6875rem]">
                {CHARGE_KIND_LABELS[line.kind]}
                {line.quantity !== 1 ? ` · ${line.quantity} × ${cash(line.unitAmountMinor)}` : ''}
                {line.isTaxable ? '' : ' · not taxed'}
              </p>
            </div>
            <span data-numeric="" className="text-ink shrink-0 text-[0.8125rem]">
              {cash(line.amountMinor)}
            </span>
            {onRemoveLine && (isRemovable?.(index) ?? true) ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRemoveLine(index)}
                aria-label={`Remove ${line.description}`}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            ) : null}
          </li>
        ))}
        {quote.lines.length === 0 ? (
          <li className="text-ink-subtle py-4 text-center text-[0.8125rem]">
            Nothing charged yet.
          </li>
        ) : null}
      </ul>

      <dl className="border-line space-y-1 border-t pt-3">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted text-[0.8125rem]">Rental</dt>
          <dd data-numeric="" className="text-ink text-[0.8125rem]">
            {cash(quote.subtotalMinor)}
          </dd>
        </div>
        {quote.extrasMinor > 0 ? (
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted text-[0.8125rem]">Extras</dt>
            <dd data-numeric="" className="text-ink text-[0.8125rem]">
              {cash(quote.extrasMinor)}
            </dd>
          </div>
        ) : null}
        {quote.discountMinor > 0 ? (
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted text-[0.8125rem]">Discount</dt>
            <dd data-numeric="" className="text-ink text-[0.8125rem]">
              −{cash(quote.discountMinor)}
            </dd>
          </div>
        ) : null}
        {quote.taxRateBps > 0 ? (
          <div className="flex justify-between gap-3">
            <dt className="text-ink-muted text-[0.8125rem]">
              {taxLabel || 'Tax'} ({formatTaxRate(quote.taxRateBps)})
            </dt>
            <dd data-numeric="" className="text-ink text-[0.8125rem]">
              {cash(quote.taxMinor)}
            </dd>
          </div>
        ) : null}

        <div className="border-line mt-2 flex justify-between gap-3 border-t pt-2">
          <dt className="text-ink text-[0.9375rem] font-semibold">Total</dt>
          <dd data-numeric="" className="text-ink text-[0.9375rem] font-semibold">
            {cash(quote.totalMinor)}
          </dd>
        </div>

        {depositMinor > 0 ? (
          <div className="flex justify-between gap-3 pt-1">
            <dt className="text-ink-subtle text-[0.75rem]">Refundable deposit, held separately</dt>
            <dd data-numeric="" className="text-ink-subtle text-[0.75rem]">
              {cash(depositMinor)}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}
