import { ArrowRight } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Alert, Button, Dialog, DialogContent, Field, Input, useToast } from '@/components/ui'
import { billableDays } from '@/features/rentals/pricing'
import { formatDateTime } from '@/lib/datetime/format'
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '@/lib/datetime/timezone'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { RentalScheduleEntry, VehicleFleetEntry } from '@/types/database'

import { useRescheduleRental } from '../queries'

export interface RescheduleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rental: RentalScheduleEntry
  /** Where a drag proposed putting it, or null when opened from a menu. */
  proposedStartsAt: Date
  proposedEndsAt: Date
  targetVehicle: VehicleFleetEntry | null
  locale: string
  timeZone: string
}

/**
 * Confirming a move.
 *
 * Dragging a block produces a proposal, never a write. This dialog is where the
 * proposal becomes a request: it states the old period and the new one, the
 * vehicle change if there is one, what happens to the day count, and — when a
 * contract has been issued — that a new version will be produced. Only then
 * does anything reach the database.
 *
 * It is also the keyboard path. Every move available by dragging is available
 * here, opened from the booking's own menu, because a scheduler that can only
 * be operated with a mouse is a scheduler half the staff cannot use.
 */
export function RescheduleDialog({
  open,
  onOpenChange,
  rental,
  proposedStartsAt,
  proposedEndsAt,
  targetVehicle,
  locale,
  timeZone,
}: RescheduleDialogProps) {
  const toast = useToast()
  const reschedule = useRescheduleRental()

  const [startsAtLocal, setStartsAtLocal] = useState(() =>
    toDateTimeLocalValue(proposedStartsAt, timeZone),
  )
  const [endsAtLocal, setEndsAtLocal] = useState(() =>
    toDateTimeLocalValue(proposedEndsAt, timeZone),
  )
  const [amendContract, setAmendContract] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startsAt = useMemo(
    () => fromDateTimeLocalValue(startsAtLocal, timeZone),
    [startsAtLocal, timeZone],
  )
  const endsAt = useMemo(
    () => fromDateTimeLocalValue(endsAtLocal, timeZone),
    [endsAtLocal, timeZone],
  )

  const isValid = Boolean(startsAt && endsAt && endsAt > startsAt)
  const vehicleChanged = targetVehicle !== null && targetVehicle.vehicle_id !== rental.vehicle_id

  const previousDays = billableDays(new Date(rental.starts_at), new Date(rental.ends_at))
  const nextDays = isValid && startsAt && endsAt ? billableDays(startsAt, endsAt) : previousDays
  const daysChanged = nextDays !== previousDays

  const when = (instant: Date) => formatDateTime(instant, { locale, timeZone })

  const submit = async () => {
    if (!startsAt || !endsAt || !isValid) {
      setError('The return must be after the collection.')
      return
    }
    if (rental.has_live_contract && !amendContract) {
      setError('Confirm that a new contract version may be issued.')
      return
    }

    setError(null)

    try {
      await reschedule.mutateAsync({
        rentalId: rental.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        vehicleId: vehicleChanged ? targetVehicle.vehicle_id : null,
        amendContract,
      })

      toast.success(
        'Booking moved',
        vehicleChanged
          ? `${rental.reference} is now on ${targetVehicle.registration_plate}.`
          : `${rental.reference} now runs ${when(startsAt)} to ${when(endsAt)}.`,
      )
      onOpenChange(false)
    } catch (failure) {
      // The board refetches on failure, so what stays on screen is what the
      // database actually holds — never the move that was refused.
      setError(toErrorMessage(failure))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Move this booking"
        description={`${rental.reference} · ${rental.customer_name}`}
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={reschedule.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              isLoading={reschedule.isPending}
              disabled={!isValid}
            >
              Move booking
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <dl className="border-line bg-surface-muted space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <dt className="text-ink-subtle w-16 shrink-0 text-[0.75rem]">Now</dt>
              <dd className="text-ink-muted text-[0.8125rem]">
                {when(new Date(rental.starts_at))} → {when(new Date(rental.ends_at))}
              </dd>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <dt className="text-ink-subtle w-16 shrink-0 text-[0.75rem]">After</dt>
              <dd className="text-ink flex items-center gap-1.5 text-[0.8125rem] font-medium">
                {startsAt && endsAt ? (
                  <>
                    {when(startsAt)}
                    <ArrowRight className="size-3" aria-hidden="true" />
                    {when(endsAt)}
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            {vehicleChanged ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <dt className="text-ink-subtle w-16 shrink-0 text-[0.75rem]">Vehicle</dt>
                <dd className="text-ink text-[0.8125rem]">
                  {rental.vehicle_plate} → {targetVehicle.registration_plate} ({targetVehicle.make}{' '}
                  {targetVehicle.model})
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Collection" required>
              <Input
                type="datetime-local"
                value={startsAtLocal}
                onChange={(event) => setStartsAtLocal(event.target.value)}
              />
            </Field>
            <Field
              label="Return"
              required
              {...(isValid ? {} : { error: 'The return must be after the collection.' })}
            >
              <Input
                type="datetime-local"
                value={endsAtLocal}
                onChange={(event) => setEndsAtLocal(event.target.value)}
              />
            </Field>
          </div>

          {daysChanged ? (
            <Alert tone="caution" title="The chargeable days change">
              This hire goes from {previousDays} to {nextDays} {nextDays === 1 ? 'day' : 'days'}.
              The day count follows the new period; the charges on the contract do not, so review
              the pricing afterwards.
            </Alert>
          ) : null}

          {rental.has_live_contract ? (
            <div className="border-caution-200 bg-caution-50 space-y-2 rounded-md border p-3">
              <p className="text-caution-700 text-[0.8125rem] font-medium">
                A contract has already been issued for this booking
              </p>
              <p className="text-caution-700 text-[0.75rem]">
                Moving it makes the issued document wrong. A new version will be issued and the
                current one marked superseded — the original is kept exactly as it was.
              </p>
              <label className="text-caution-700 flex items-center gap-2 text-[0.8125rem]">
                <input
                  type="checkbox"
                  checked={amendContract}
                  onChange={(event) => setAmendContract(event.target.checked)}
                  className="accent-caution-600 size-4 rounded"
                />
                Issue a new contract version
              </label>
            </div>
          ) : null}

          {error ? (
            <Alert tone="critical" title="The move was not applied">
              {error}
            </Alert>
          ) : null}

          <p className="text-ink-subtle text-[0.75rem]">
            The database decides. If another booking takes this slot first, nothing here changes.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
