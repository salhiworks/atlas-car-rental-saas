import { useState } from 'react'

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
} from '@/components/ui'
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '@/lib/datetime/timezone'
import { formatMoney, minorToDecimalString, parseMoneyToMinor } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { PaymentMethod, PaymentPurpose } from '@/types/database'

import { useRecordPayment } from '../queries'

export interface PaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rentalId: string
  currency: string
  locale: string
  timeZone: string
  balanceDueMinor: number
  depositHeldMinor: number
  depositAgreedMinor: number
  /** Opens straight into the case the desk asked for. */
  intent: 'charge' | 'deposit' | 'refund-deposit'
}

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
  { value: 'other', label: 'Other' },
]

/**
 * Taking or returning money on a contract.
 *
 * A deposit and a payment for the hire are different kinds of money and are
 * recorded as such: the deposit reduces nothing the customer owes and never
 * counts as revenue, and saying so on this screen is what stops the two being
 * confused at the counter.
 */
export function PaymentDialog({
  open,
  onOpenChange,
  rentalId,
  currency,
  locale,
  timeZone,
  balanceDueMinor,
  depositHeldMinor,
  depositAgreedMinor,
  intent,
}: PaymentDialogProps) {
  const toast = useToast()
  const recordPayment = useRecordPayment(rentalId)

  const isRefund = intent === 'refund-deposit'
  const purpose: PaymentPurpose = intent === 'charge' ? 'rental_charge' : 'deposit'

  const suggested =
    intent === 'charge'
      ? Math.max(balanceDueMinor, 0)
      : intent === 'deposit'
        ? Math.max(depositAgreedMinor - depositHeldMinor, 0)
        : depositHeldMinor

  const [amount, setAmount] = useState(() =>
    suggested > 0 ? minorToDecimalString(suggested, currency) : '',
  )
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [paidAt, setPaidAt] = useState(() => toDateTimeLocalValue(new Date(), timeZone))
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const minor = parseMoneyToMinor(amount, currency)
    if (minor === null || minor <= 0) {
      setError('Enter an amount above zero.')
      return
    }
    if (isRefund && minor > depositHeldMinor) {
      setError(`Only ${formatMoney(depositHeldMinor, currency, { locale })} is being held.`)
      return
    }

    const instant = fromDateTimeLocalValue(paidAt, timeZone)
    if (!instant) {
      setError('Choose a valid date and time.')
      return
    }

    setError(null)

    try {
      await recordPayment.mutateAsync({
        amountMinor: minor,
        direction: isRefund ? 'outbound' : 'inbound',
        purpose,
        method,
        paidAt: instant.toISOString(),
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      })
      toast.success(
        isRefund
          ? 'Deposit returned'
          : purpose === 'deposit'
            ? 'Deposit taken'
            : 'Payment recorded',
        formatMoney(minor, currency, { locale }),
      )
      onOpenChange(false)
    } catch (failure) {
      toast.error('Could not record this', toErrorMessage(failure))
    }
  }

  const title = isRefund
    ? 'Return the deposit'
    : purpose === 'deposit'
      ? 'Take a deposit'
      : 'Record a payment'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={`In ${currency}, the currency this contract was agreed in.`}
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={recordPayment.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              isLoading={recordPayment.isPending}
            >
              {title}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {purpose === 'deposit' && !isRefund ? (
            <Alert tone="info" title="A deposit is not payment for the hire">
              It is held against damage and returned at the end. It will not reduce what the
              customer still owes, and it is never counted as revenue.
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Amount" required {...(error ? { error } : {})}>
              <Input
                value={amount}
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
              />
            </Field>

            <Field label="Method" required>
              <Select
                value={method}
                onChange={(event) => setMethod(event.target.value as PaymentMethod)}
                options={METHODS}
              />
            </Field>
          </div>

          <Field label={isRefund ? 'Returned at' : 'Received at'} required>
            <Input
              type="datetime-local"
              value={paidAt}
              onChange={(event) => setPaidAt(event.target.value)}
            />
          </Field>

          <Field label="Reference" hint="Receipt number, transaction id, anything you file it by.">
            <Input
              value={reference}
              maxLength={80}
              onChange={(event) => setReference(event.target.value)}
            />
          </Field>

          <Field label="Notes">
            <Textarea
              value={notes}
              rows={2}
              maxLength={500}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
