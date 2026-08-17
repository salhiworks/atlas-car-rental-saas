import { Ban, Plus, ShieldCheck, Undo2 } from 'lucide-react'
import { useState } from 'react'

import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  useToast,
} from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'
import type { Payment, PaymentMethod } from '@/types/database'

import { useRentalPayments, useVoidPayment } from '../queries'

export interface PaymentsPanelProps {
  rentalId: string
  currency: string
  locale: string
  timeZone: string
  canRecord: boolean
  canVoid: boolean
  onRecordCharge: () => void
  onTakeDeposit: () => void
  onRefundDeposit: () => void
  depositHeldMinor: number
  depositAgreedMinor: number
  balanceDueMinor: number
}

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  cheque: 'Cheque',
  online: 'Online',
  other: 'Other',
}

/**
 * Money on this contract.
 *
 * Deposits are listed alongside payments but are never mixed into what the
 * customer has paid — a deposit reduces nothing they owe. Nothing is deleted
 * either: a mistaken entry is voided, stays visible with its reason, and stops
 * counting everywhere at once.
 */
export function PaymentsPanel({
  rentalId,
  currency,
  locale,
  timeZone,
  canRecord,
  canVoid,
  onRecordCharge,
  onTakeDeposit,
  onRefundDeposit,
  depositHeldMinor,
  depositAgreedMinor,
  balanceDueMinor,
}: PaymentsPanelProps) {
  const toast = useToast()
  const paymentsQuery = useRentalPayments(rentalId)
  const voidPayment = useVoidPayment()
  const [voiding, setVoiding] = useState<Payment | null>(null)
  const [reason, setReason] = useState('')

  const payments = paymentsQuery.data ?? []

  const confirmVoid = async () => {
    if (!voiding) return
    try {
      await voidPayment.mutateAsync({ paymentId: voiding.id, reason: reason.trim() || null })
      toast.success('Payment voided', 'It stays on the record and counts nowhere.')
      setVoiding(null)
      setReason('')
    } catch (error) {
      toast.error('Could not void this payment', toErrorMessage(error))
    }
  }

  return (
    <Card>
      <CardHeader
        title="Money"
        description="Deposits are held, not earned. They never reduce what is owed."
        actions={
          canRecord ? (
            <div className="flex flex-wrap items-center gap-2">
              {depositHeldMinor > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Undo2 />}
                  onClick={onRefundDeposit}
                >
                  Return deposit
                </Button>
              ) : depositAgreedMinor > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<ShieldCheck />}
                  onClick={onTakeDeposit}
                >
                  Take deposit
                </Button>
              ) : null}
              <Button variant="primary" size="sm" leadingIcon={<Plus />} onClick={onRecordCharge}>
                Record payment
              </Button>
            </div>
          ) : null
        }
      />

      <CardBody className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Still owed"
            value={formatMoney(Math.max(balanceDueMinor, 0), currency, { locale })}
            tone={balanceDueMinor > 0 ? 'text-ink' : 'text-positive-700'}
          />
          <Figure
            label="Deposit held"
            value={formatMoney(depositHeldMinor, currency, { locale })}
            tone="text-ink"
          />
          <Figure
            label="Deposit agreed"
            value={formatMoney(depositAgreedMinor, currency, { locale })}
            tone="text-ink-muted"
          />
        </dl>

        {payments.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="Nothing recorded yet"
            description="Payments and deposits taken against this contract will be listed here."
          />
        ) : (
          <ul className="divide-line divide-y">
            {payments.map((payment) => {
              const isVoided = payment.voided_at !== null
              const isOut = payment.direction === 'outbound'

              return (
                <li
                  key={payment.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 py-2.5',
                    isVoided && 'opacity-60',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-ink flex flex-wrap items-center gap-1.5 text-[0.8125rem]">
                      <span data-numeric="" className={cn(isVoided && 'line-through')}>
                        {isOut ? '−' : ''}
                        {formatMoney(payment.amount_minor, payment.currency, { locale })}
                      </span>
                      {payment.purpose === 'deposit' ? (
                        <Badge tone="info">Deposit</Badge>
                      ) : (
                        <Badge tone="neutral">Rental</Badge>
                      )}
                      {isVoided ? <Badge tone="critical">Voided</Badge> : null}
                    </p>
                    <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                      {METHOD_LABELS[payment.method]} ·{' '}
                      {formatDateTime(new Date(payment.paid_at), { locale, timeZone })}
                      {payment.reference ? ` · ${payment.reference}` : ''}
                    </p>
                    {isVoided && payment.void_reason ? (
                      <p className="text-ink-subtle mt-0.5 text-[0.75rem] italic">
                        {payment.void_reason}
                      </p>
                    ) : null}
                  </div>

                  {canVoid && !isVoided ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<Ban />}
                      onClick={() => setVoiding(payment)}
                    >
                      Void
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </CardBody>

      <ConfirmDialog
        open={voiding !== null}
        onOpenChange={(open) => {
          if (!open) {
            setVoiding(null)
            setReason('')
          }
        }}
        title="Void this payment"
        description="The entry stays on the record, marked as voided, and stops counting towards what has been paid."
        confirmLabel="Void payment"
        isPending={voidPayment.isPending}
        onConfirm={() => void confirmVoid()}
      >
        <Field label="Why" hint="Kept with the entry so the reason survives the correction.">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="Entered twice"
          />
        </Field>
      </ConfirmDialog>
    </Card>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="border-line rounded-md border px-3 py-2">
      <dt className="text-ink-subtle text-[0.75rem]">{label}</dt>
      <dd data-numeric="" className={cn('mt-0.5 text-[0.9375rem] font-semibold', tone)}>
        {value}
      </dd>
    </div>
  )
}
