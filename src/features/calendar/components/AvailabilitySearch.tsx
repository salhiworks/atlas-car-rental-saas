import { CalendarSearch, Plus, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Alert, Badge, Button, Field, Input, Skeleton } from '@/components/ui'
import { evaluateVehicleCompliance, type ComplianceOptions } from '@/lib/compliance/expiry'
import { billableDays } from '@/features/rentals/pricing'
import { formatDateTime } from '@/lib/datetime/format'
import { fromDateTimeLocalValue } from '@/lib/datetime/timezone'
import { formatMoney } from '@/lib/money/money'
import type { VehicleFleetEntry } from '@/types/database'

import { useAvailability } from '../queries'

export interface AvailabilitySearchProps {
  vehicles: readonly VehicleFleetEntry[]
  locale: string
  timeZone: string
  compliance: ComplianceOptions
  canCreate: boolean
  /** Opening the rental flow with this vehicle and period already chosen. */
  onStartRental: (vehicleId: string, startsAt: Date, endsAt: Date) => void
  initialStartsAt: string
  initialEndsAt: string
}

/**
 * "What is free from Friday at ten until Monday at six?"
 *
 * Answered by `vehicles_available_between()` — the same function the booking
 * flow uses and the same one the exclusion constraint backs. There is no second
 * availability algorithm anywhere in this module, because two would eventually
 * disagree and the one on screen would be the one staff believed.
 *
 * Compliance is shown, never enforced. The product treats an expired inspection
 * as a warning rather than a bar elsewhere, and quietly making it a hard block
 * here would change a business rule inside a search panel.
 */
export function AvailabilitySearch({
  vehicles,
  locale,
  timeZone,
  compliance,
  canCreate,
  onStartRental,
  initialStartsAt,
  initialEndsAt,
}: AvailabilitySearchProps) {
  const [startsAtLocal, setStartsAtLocal] = useState(initialStartsAt)
  const [endsAtLocal, setEndsAtLocal] = useState(initialEndsAt)

  const startsAt = useMemo(
    () => fromDateTimeLocalValue(startsAtLocal, timeZone),
    [startsAtLocal, timeZone],
  )
  const endsAt = useMemo(
    () => fromDateTimeLocalValue(endsAtLocal, timeZone),
    [endsAtLocal, timeZone],
  )
  const isValid = Boolean(startsAt && endsAt && endsAt > startsAt)

  const query = useAvailability(
    isValid && startsAt ? startsAt.toISOString() : null,
    isValid && endsAt ? endsAt.toISOString() : null,
  )

  const availableIds = useMemo(() => new Set(query.data ?? []), [query.data])
  const matches = useMemo(
    () => vehicles.filter((vehicle) => availableIds.has(vehicle.vehicle_id)),
    [vehicles, availableIds],
  )

  const days = isValid && startsAt && endsAt ? billableDays(startsAt, endsAt) : 0

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" required>
          <Input
            type="datetime-local"
            value={startsAtLocal}
            onChange={(event) => setStartsAtLocal(event.target.value)}
          />
        </Field>
        <Field
          label="Until"
          required
          {...(isValid ? {} : { error: 'The end must be after the start.' })}
        >
          <Input
            type="datetime-local"
            value={endsAtLocal}
            onChange={(event) => setEndsAtLocal(event.target.value)}
          />
        </Field>
      </div>

      {isValid && startsAt && endsAt ? (
        <p className="text-ink-muted text-[0.75rem]">
          {formatDateTime(startsAt, { locale, timeZone })} to{' '}
          {formatDateTime(endsAt, { locale, timeZone })} · {days} chargeable{' '}
          {days === 1 ? 'day' : 'days'}
        </p>
      ) : null}

      {query.isPending && isValid ? (
        <ul className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <li key={index} className="border-line rounded-md border p-3">
              <Skeleton className="h-4 w-40" />
            </li>
          ))}
        </ul>
      ) : !isValid ? null : matches.length === 0 ? (
        <Alert tone="caution" title="Nothing is free for that period">
          Every vehicle in service is committed over these dates or off the road. Try a different
          period, or free a vehicle up first.
        </Alert>
      ) : (
        <>
          <p className="text-ink-subtle text-[0.75rem]">
            {matches.length} {matches.length === 1 ? 'vehicle' : 'vehicles'} free
          </p>
          <ul className="max-h-72 space-y-2 overflow-y-auto pe-1">
            {matches.map((vehicle) => {
              const state = evaluateVehicleCompliance(vehicle, compliance)

              return (
                <li
                  key={vehicle.vehicle_id}
                  className="border-line flex items-center gap-3 rounded-md border px-3 py-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-ink block truncate text-[0.8125rem] font-medium">
                      {vehicle.make} {vehicle.model}
                      {vehicle.model_year ? ` ${vehicle.model_year}` : ''}
                    </span>
                    <span className="identifier text-ink-subtle block truncate text-[0.6875rem]">
                      {vehicle.registration_plate}
                    </span>
                  </span>

                  {state.needsAttention ? (
                    <Badge
                      tone={state.overall === 'expired' ? 'critical' : 'caution'}
                      className="gap-1"
                    >
                      <TriangleAlert className="size-3" aria-hidden="true" />
                      {state.overall === 'expired' ? 'Expired' : 'Due soon'}
                    </Badge>
                  ) : null}

                  <span data-numeric="" className="text-ink shrink-0 text-[0.8125rem]">
                    {formatMoney(vehicle.daily_rate_minor, vehicle.currency, { locale })}
                    <span className="text-ink-subtle text-[0.625rem]">/day</span>
                  </span>

                  {canCreate && startsAt && endsAt ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      leadingIcon={<Plus />}
                      onClick={() => onStartRental(vehicle.vehicle_id, startsAt, endsAt)}
                    >
                      Book
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {!isValid ? (
        <p className="text-ink-subtle flex items-center gap-2 text-[0.8125rem]">
          <CalendarSearch className="size-4 shrink-0" aria-hidden="true" />
          Choose a period to see what is free.
        </p>
      ) : null}
    </div>
  )
}
