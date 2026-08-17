import { useState } from 'react'

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Textarea,
  useToast,
} from '@/components/ui'
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '@/lib/datetime/timezone'
import { toErrorMessage } from '@/lib/supabase/errors'

import { useCheckInRental, useCheckOutRental } from '../queries'
import { handoverSchema } from '../schemas'

export interface HandoverDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rentalId: string
  phase: 'pickup' | 'return'
  timeZone: string
  distanceUnit: 'km' | 'mi'
  /** The last known reading, so the desk can see what it is starting from. */
  currentOdometer: number | null
}

/**
 * Recording a hand-over or a return.
 *
 * The same three facts are captured either way — when, how far, how much fuel —
 * so this is one dialog with two labels rather than two nearly identical ones
 * that drift apart.
 *
 * The odometer is required. It is what every distance, fuel and damage question
 * is later answered from, and "we will fill it in afterwards" never happens.
 */
export function HandoverDialog({
  open,
  onOpenChange,
  rentalId,
  phase,
  timeZone,
  distanceUnit,
  currentOdometer,
}: HandoverDialogProps) {
  const toast = useToast()
  const checkOut = useCheckOutRental(rentalId)
  const checkIn = useCheckInRental(rentalId)
  const mutation = phase === 'pickup' ? checkOut : checkIn

  const [odometer, setOdometer] = useState(currentOdometer === null ? '' : String(currentOdometer))
  const [fuelPercent, setFuelPercent] = useState('')
  const [notes, setNotes] = useState('')
  const [at, setAt] = useState(() => toDateTimeLocalValue(new Date(), timeZone))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const submit = async () => {
    const parsed = handoverSchema.safeParse({ odometer, fuelPercent, notes, at })

    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'odometer')
        next[key] ??= issue.message
      }
      setErrors(next)
      return
    }

    const instant = fromDateTimeLocalValue(parsed.data.at, timeZone)
    if (!instant) {
      setErrors({ at: 'Choose a valid date and time.' })
      return
    }

    try {
      await mutation.mutateAsync({
        odometer: parsed.data.odometer,
        fuelPercent: parsed.data.fuelPercent,
        notes: parsed.data.notes,
        at: instant.toISOString(),
      })
      toast.success(
        phase === 'pickup' ? 'Vehicle handed over' : 'Return recorded',
        phase === 'pickup'
          ? 'The contract is now out with the customer.'
          : 'Add any final charges, then complete the rental.',
      )
      onOpenChange(false)
    } catch (error) {
      toast.error('Could not save this', toErrorMessage(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={phase === 'pickup' ? 'Check the vehicle out' : 'Record the return'}
        description={
          phase === 'pickup'
            ? 'What you record here is what the customer is measured against when they bring it back.'
            : 'Compare this against the condition at hand-over before you close the contract.'
        }
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} isLoading={mutation.isPending}>
              {phase === 'pickup' ? 'Hand over' : 'Record return'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label={phase === 'pickup' ? 'Handed over at' : 'Returned at'}
            required
            {...(errors.at ? { error: errors.at } : {})}
          >
            <Input
              type="datetime-local"
              value={at}
              onChange={(event) => setAt(event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={`Odometer (${distanceUnit})`}
              required
              {...(errors.odometer ? { error: errors.odometer } : {})}
              {...(currentOdometer !== null
                ? { hint: `Last recorded: ${currentOdometer.toLocaleString()} ${distanceUnit}` }
                : {})}
            >
              <Input
                value={odometer}
                inputMode="numeric"
                onChange={(event) => setOdometer(event.target.value)}
              />
            </Field>

            <Field label="Fuel (%)" {...(errors.fuelPercent ? { error: errors.fuelPercent } : {})}>
              <Input
                value={fuelPercent}
                inputMode="numeric"
                placeholder="100"
                onChange={(event) => setFuelPercent(event.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Condition"
            hint="Marks, damage, anything the customer should be shown now rather than argued about later."
          >
            <Textarea
              value={notes}
              rows={4}
              maxLength={4000}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>

          {phase === 'pickup' ? (
            <Alert tone="info" title="The vehicle's mileage moves with this">
              Saving updates the vehicle's own odometer, so the fleet stays accurate without a
              second step.
            </Alert>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
