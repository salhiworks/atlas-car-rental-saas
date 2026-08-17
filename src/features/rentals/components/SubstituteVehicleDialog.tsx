import { useState } from 'react'

import { Alert, Button, Dialog, DialogContent, useToast } from '@/components/ui'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { VehicleFleetEntry } from '@/types/database'

import { useSubstituteVehicle } from '../queries'
import { VehiclePicker } from './VehiclePicker'

export interface SubstituteVehicleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rentalId: string
  currentVehicleLabel: string
  startsAt: string
  endsAt: string
  locale: string
}

/**
 * Putting the customer in a different car.
 *
 * Only offered before collection: once somebody has driven away, the vehicle on
 * the contract is a fact rather than a plan, and swapping it would make the
 * hand-over record describe a car that was never handed over.
 *
 * The replacement's own availability is checked the same way a new booking's
 * is, so a substitution cannot create the double booking a fresh contract could
 * not.
 */
export function SubstituteVehicleDialog({
  open,
  onOpenChange,
  rentalId,
  currentVehicleLabel,
  startsAt,
  endsAt,
  locale,
}: SubstituteVehicleDialogProps) {
  const toast = useToast()
  const substitute = useSubstituteVehicle(rentalId)
  const [chosen, setChosen] = useState<VehicleFleetEntry | null>(null)

  const submit = async () => {
    if (!chosen) return

    try {
      await substitute.mutateAsync(chosen.vehicle_id)
      toast.success(
        'Vehicle changed',
        `${chosen.registration_plate} is now on this contract, and the previous vehicle is free again.`,
      )
      onOpenChange(false)
      setChosen(null)
    } catch (error) {
      toast.error('Could not change the vehicle', toErrorMessage(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Change the vehicle"
        description={`${currentVehicleLabel} is on this contract now.`}
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={substitute.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              isLoading={substitute.isPending}
              disabled={!chosen}
            >
              Move to this vehicle
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Alert tone="info" title="The pricing does not change by itself">
            If the replacement is priced differently, adjust the charges afterwards and reissue the
            contract.
          </Alert>

          <VehiclePicker
            from={startsAt}
            to={endsAt}
            selectedId={chosen?.vehicle_id ?? null}
            onSelect={setChosen}
            locale={locale}
            excludeRentalId={rentalId}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
