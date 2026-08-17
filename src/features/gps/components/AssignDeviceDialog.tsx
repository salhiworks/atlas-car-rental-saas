import { Search } from 'lucide-react'
import { useState } from 'react'

import { Alert, Button, Dialog, DialogContent, Input, Textarea, useToast } from '@/components/ui'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'
import type { GpsUnitInventoryRow } from '@/types/database'

import { useAssignUnit, useAssignableVehicles } from '../queries'

/**
 * Fitting a device to a vehicle.
 *
 * The list offered here is every vehicle in the fleet, including ones that
 * already have a tracker. Moving a device to a car that has one is a real thing
 * that happens — a unit is swapped out, a car is sold, a tracker is recovered
 * from a write-off — and refusing to offer it would just send somebody to
 * release the old link first and hope nothing happens in between.
 *
 * What the database does when that is confirmed is the important part: one
 * transaction closes the device's previous assignment, closes the vehicle's
 * previous assignment, and opens the new one. Two partial unique indexes make
 * the "one active assignment" rule true even when two administrators press the
 * button at the same instant — one of them gets a conflict rather than a fleet
 * with a device on two cars.
 */

export interface AssignDeviceDialogProps {
  unit: GpsUnitInventoryRow
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AssignDeviceDialog({ unit, open, onOpenChange }: AssignDeviceDialogProps) {
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const vehicles = useAssignableVehicles(search, open)
  const assign = useAssignUnit()

  async function onConfirm() {
    if (!selected) return
    try {
      await assign.mutateAsync({
        vehicleId: selected,
        unitId: unit.id,
        note: note.trim() === '' ? null : note.trim(),
      })
      toast.success(
        'Device assigned',
        'Positions from this tracker are now attributed to that vehicle.',
      )
      onOpenChange(false)
      setSelected(null)
      setNote('')
    } catch (error) {
      toast.error('Could not assign the device', toErrorMessage(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={`Assign ${unit.name}`}
        description="Choose the vehicle this tracker is fitted to. Positions reported by the device will be shown against that vehicle from now on."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void onConfirm()}
              isLoading={assign.isPending}
              disabled={!selected}
            >
              Assign device
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="relative">
            <Search
              className="text-ink-subtle pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input
              aria-label="Search vehicles"
              className="ps-9"
              placeholder="Plate, make or model"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              autoFocus
            />
          </div>

          <div className="border-line max-h-64 overflow-y-auto rounded-md border">
            {vehicles.isError ? (
              <Alert tone="critical" className="m-2">
                {toErrorMessage(vehicles.error)}
              </Alert>
            ) : null}

            <ul className="divide-line divide-y">
              {(vehicles.data ?? []).map((vehicle) => (
                <li key={vehicle.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(vehicle.id)}
                    aria-pressed={selected === vehicle.id}
                    className={cn(
                      'hover:bg-surface-inset w-full px-3 py-2 text-start transition-colors',
                      selected === vehicle.id && 'bg-brand-50 hover:bg-brand-50',
                    )}
                  >
                    <p className="text-[0.8125rem] font-medium">{vehicle.registration_plate}</p>
                    <p className="text-ink-muted text-[0.75rem]">
                      {vehicle.make} {vehicle.model}
                    </p>
                  </button>
                </li>
              ))}
            </ul>

            {(vehicles.data ?? []).length === 0 && !vehicles.isLoading ? (
              <p className="text-ink-muted px-3 py-6 text-center text-[0.8125rem]">
                No vehicle matches that search.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="gps-assignment-note"
              className="text-ink block text-[0.8125rem] font-medium"
            >
              Note
            </label>
            <Textarea
              id="gps-assignment-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Fitted at the depot, behind the dashboard"
              maxLength={280}
            />
            <p className="text-ink-subtle text-[0.75rem]">
              Kept with the assignment history, so somebody can tell later why this device was on
              this car.
            </p>
          </div>

          {assign.isError ? <Alert tone="critical">{toErrorMessage(assign.error)}</Alert> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
