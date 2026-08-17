import { CircleHelp } from 'lucide-react'

import { Badge, type BadgeTone } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type {
  FinancingAgreementStatus,
  FinancingInstallmentState,
  FinancingMode,
} from '@/types/database'

import {
  AGREEMENT_STATUS_LABELS,
  INSTALLMENT_STATE_LABELS,
  MODE_LABELS,
  type KnownState,
} from '../domain'

/**
 * The small pieces that say where an agreement stands.
 *
 * The one that matters most is `MoneyFact`. A financing screen is full of
 * figures the agency may or may not know, and the difference between "no
 * interest" and "nobody recorded the interest" is the difference between a
 * useful record and a misleading one. Rendering an unknown as a dash with a
 * reason attached — rather than as 0.00 — is the whole discipline of this
 * module expressed in one component.
 */

const STATUS_TONE: Readonly<Record<FinancingAgreementStatus, BadgeTone>> = {
  draft: 'neutral',
  active: 'brand',
  paid_off: 'positive',
  closed: 'neutral',
  cancelled: 'neutral',
}

export function AgreementStatusBadge({ status }: { status: FinancingAgreementStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} withDot={status === 'active'}>
      {AGREEMENT_STATUS_LABELS[status]}
    </Badge>
  )
}

export function ModeBadge({ mode }: { mode: FinancingMode }) {
  return <Badge tone="neutral">{MODE_LABELS[mode]}</Badge>
}

const INSTALLMENT_TONE: Readonly<Record<FinancingInstallmentState, BadgeTone>> = {
  upcoming: 'neutral',
  due_today: 'info',
  partially_paid: 'caution',
  paid: 'positive',
  overdue: 'critical',
  closed: 'neutral',
}

export function InstallmentStateBadge({ state }: { state: FinancingInstallmentState }) {
  return <Badge tone={INSTALLMENT_TONE[state]}>{INSTALLMENT_STATE_LABELS[state]}</Badge>
}

export interface MoneyFactProps {
  amountMinor: number | null
  currency: string
  locale: string
  /**
   * `known` prints the figure. `incomplete` prints it as a floor, because some
   * of the underlying payments have not been split. `unknown` prints nothing at
   * all, because there is nothing to print.
   */
  state?: KnownState
  /** Shown next to an unknown or incomplete figure, on hover and to a reader. */
  reason?: string
  className?: string
  emphasis?: boolean
}

export function MoneyFact({
  amountMinor,
  currency,
  locale,
  state = 'known',
  reason,
  className,
  emphasis = false,
}: MoneyFactProps) {
  if (state === 'unknown' || amountMinor === null) {
    return (
      <span
        className={cn('text-ink-subtle inline-flex items-center gap-1 text-[0.8125rem]', className)}
        title={reason}
      >
        <CircleHelp className="size-3.5 shrink-0" aria-hidden="true" />
        Not known
        {reason ? <span className="sr-only">. {reason}</span> : null}
      </span>
    )
  }

  const formatted = formatMoney(amountMinor, currency, { locale })

  if (state === 'incomplete') {
    return (
      <span
        className={cn('inline-flex items-baseline gap-1', className)}
        title={
          reason ?? 'Some payments have not been split, so this is a floor rather than a figure.'
        }
      >
        <span className="text-ink-subtle text-[0.75rem]" aria-hidden="true">
          at least
        </span>
        <span
          data-numeric=""
          className={cn(
            'text-ink',
            emphasis ? 'text-[0.9375rem] font-semibold' : 'text-[0.8125rem]',
          )}
        >
          {formatted}
        </span>
        <span className="sr-only">
          at least {formatted}. {reason ?? 'Some payments have not been split.'}
        </span>
      </span>
    )
  }

  return (
    <span
      data-numeric=""
      className={cn(
        'text-ink',
        emphasis ? 'text-[0.9375rem] font-semibold' : 'text-[0.8125rem]',
        className,
      )}
    >
      {formatted}
    </span>
  )
}

/** A dash that means "nobody has said", never "zero". */
export function UnknownValue({ reason }: { reason?: string }) {
  return (
    <span
      className="text-ink-subtle inline-flex items-center gap-1 text-[0.8125rem]"
      title={reason}
    >
      <CircleHelp className="size-3.5 shrink-0" aria-hidden="true" />
      Not known
    </span>
  )
}
