import { useMemo, useState } from 'react'

import { Alert, Button, Dialog, DialogContent, Field, Input, useToast } from '@/components/ui'
import { formatDateTime } from '@/lib/datetime/format'
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '@/lib/datetime/timezone'
import { formatMoney, minorToDecimalString, parseMoneyToMinor } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'

import { billableDays } from '../pricing'
import { useExtendRental, usePeriodConflicts } from '../queries'

export interface ExtendDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rentalId: string
  vehicleId: string
  currentEndsAt: string
  startsAt: string
  dailyRateMinor: number
  currency: string
  locale: string
  timeZone: string
}

/**
 * Keeping a vehicle out longer.
 *
 * The extra days and their charge are one action, because they are one event.
 * Recording the new return date without the money, or the money without the
 * date, is how a contract ends up saying two different things.
 *
 * The suggested charge is the daily rate times the extra days — a starting
 * point the desk can overwrite, not a rule.
 */
export function ExtendDialog({
  open,
  onOpenChange,
  rentalId,
  vehicleId,
  currentEndsAt,
  startsAt,
  dailyRateMinor,
  currency,
  locale,
  timeZone,
}: ExtendDialogProps) {
  const toast = useToast()
  const extend = useExtendRental(rentalId)

  const [newEndsAtLocal, setNewEndsAtLocal] = useState(() =>
    toDateTimeLocalValue(new Date(Date.parse(currentEndsAt) + 24 * 60 * 60 * 1000), timeZone),
  )
  const [charge, setCharge] = useState('')
  const [hasTouchedCharge, setHasTouchedCharge] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const newEndsAt = useMemo(
    () => fromDateTimeLocalValue(newEndsAtLocal, timeZone),
    [newEndsAtLocal, timeZone],
  )

  const isLater = Boolean(newEndsAt && newEndsAt.getTime() > Date.parse(currentEndsAt))

  // Extra days are the difference between the whole hire before and after, so a
  // contract extended twice never gains or loses a day to rounding.
  const additionalDays = useMemo(() => {
    if (!newEndsAt || !isLater) return 0
    const before = billableDays(new Date(startsAt), new Date(currentEndsAt))
    const after = billableDays(new Date(startsAt), newEndsAt)
    return Math.max(0, after - before)
  }, [newEndsAt, isLater, startsAt, currentEndsAt])

  const suggested = additionalDays * dailyRateMinor
  if (!hasTouchedCharge && suggested > 0 && charge !== minorToDecimalString(suggested, currency)) {
    setCharge(minorToDecimalString(suggested, currency))
  }

  const conflictsQuery = usePeriodConflicts(
    open ? vehicleId : null,
    currentEndsAt,
    isLater && newEndsAt ? newEndsAt.toISOString() : null,
    rentalId,
  )
  const conflicts = conflictsQuery.data ?? []

  const submit = async () => {
    if (!newEndsAt || !isLater) {
      setError('The new return has to be later than the current one.')
      return
    }

    const chargeMinor = parseMoneyToMinor(charge || '0', currency)
    if (chargeMinor === null || chargeMinor < 0) {
      setError('Enter the extension charge as a number.')
      return
    }

    setError(null)

    try {
      await extend.mutateAsync({
        newEndsAt: newEndsAt.toISOString(),
        chargeMinor,
        description:
          additionalDays > 0
            ? `Extension — ${additionalDays} ${additionalDays === 1 ? 'day' : 'days'}`
            : 'Extension',
        additionalDays: Math.max(additionalDays, 1),
      })
      toast.success(
        'Rental extended',
        `Now due back ${formatDateTime(newEndsAt, { locale, timeZone })}.`,
      )
      onOpenChange(false)
    } catch (failure) {
      toast.error('Could not extend this rental', toErrorMessage(failure))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Extend this rental"
        description={`Currently due back ${formatDateTime(new Date(currentEndsAt), { locale, timeZone })}.`}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={extend.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              isLoading={extend.isPending}
              disabled={conflicts.length > 0}
            >
              Extend
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="New return" required {...(error ? { error } : {})}>
            <Input
              type="datetime-local"
              value={newEndsAtLocal}
              onChange={(event) => setNewEndsAtLocal(event.target.value)}
            />
          </Field>

          <Field
            label="Extra charge"
            hint={
              suggested > 0
                ? `${additionalDays} more ${additionalDays === 1 ? 'day' : 'days'} at ${formatMoney(dailyRateMinor, currency, { locale })} suggests ${formatMoney(suggested, currency, { locale })}.`
                : 'Leave at zero to extend without charging.'
            }
          >
            <Input
              value={charge}
              inputMode="decimal"
              onChange={(event) => {
                setHasTouchedCharge(true)
                setCharge(event.target.value)
              }}
            />
          </Field>

          {conflicts.length > 0 ? (
            <Alert tone="critical" title="Another contract needs this vehicle">
              {conflicts.map((conflict) => (
                <p key={conflict.rental_id}>
                  {conflict.reference} holds it from{' '}
                  {formatDateTime(new Date(conflict.starts_at), { locale, timeZone })}. Move that
                  booking or offer this customer a different vehicle.
                </p>
              ))}
            </Alert>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
