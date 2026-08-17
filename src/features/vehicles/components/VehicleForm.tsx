import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'

import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui'
import { useDistanceUnit } from '@/features/workspace/useOrganizationSettings'
import { getCurrencySymbol, minorToDecimalString } from '@/lib/money/money'

import {
  FUEL_TYPE_OPTIONS,
  TRANSMISSION_OPTIONS,
  VEHICLE_STATUS_OPTIONS,
  buildVehicleSchema,
  emptyVehicleForm,
  type VehicleFormInput,
  type VehicleFormValues,
} from '../schemas'

export interface VehicleFormProps {
  currency: string
  defaultValues?: VehicleFormInput
  submitLabel: string
  isSubmitting?: boolean
  onSubmit: (values: VehicleFormValues) => void
  onCancel: () => void
}

/**
 * The one vehicle form, used to add and to edit.
 *
 * Grouped the way an agency thinks about a car — what it is, how it is hired
 * out, and what paperwork it carries — rather than in database column order.
 * Compliance dates sit last because they are the fields most often filled in
 * later, and nothing in that section is required to save a vehicle.
 */
export function VehicleForm({
  currency,
  defaultValues,
  submitLabel,
  isSubmitting = false,
  onSubmit,
  onCancel,
}: VehicleFormProps) {
  const distanceUnit = useDistanceUnit()
  const [formError, setFormError] = useState<string | null>(null)
  const schema = useMemo(() => buildVehicleSchema(currency), [currency])

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<VehicleFormInput, unknown, VehicleFormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultValues ?? emptyVehicleForm(currency),
  })

  const submit = handleSubmit(
    (values) => {
      setFormError(null)
      onSubmit(values)
    },
    () => {
      setFormError('Some fields need attention. Check the highlighted entries below.')
    },
  )

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-6" noValidate>
      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      <Card>
        <CardHeader
          title="Identity"
          description="How this vehicle is identified on contracts and at the counter."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Make" error={errors.make?.message} required>
              <Input autoFocus placeholder="Renault" {...register('make')} />
            </Field>

            <Field label="Model" error={errors.model?.message} required>
              <Input placeholder="Clio" {...register('model')} />
            </Field>

            <Field label="Model year" error={errors.modelYear?.message}>
              <Input inputMode="numeric" placeholder="2023" numeric {...register('modelYear')} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              label="Registration plate"
              error={errors.registrationPlate?.message}
              hint="Stored as typed, matched without spacing or case."
              required
            >
              <Input
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="identifier"
                {...register('registrationPlate')}
              />
            </Field>

            <Field
              label="VIN or chassis number"
              error={errors.vin?.message}
              hint="Optional. 17 characters on most modern vehicles."
            >
              <Input
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="identifier"
                {...register('vin')}
              />
            </Field>

            <Field label="Colour" error={errors.color?.message}>
              <Input placeholder="White" {...register('color')} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Category" error={errors.category?.message} hint="Economy, SUV, Van…">
              <Input {...register('category')} />
            </Field>

            <Field label="Fuel" error={errors.fuelType?.message}>
              <Select
                options={[{ value: '', label: 'Not recorded' }, ...FUEL_TYPE_OPTIONS]}
                {...register('fuelType', { setValueAs: (value: string) => value || null })}
              />
            </Field>

            <Field label="Transmission" error={errors.transmission?.message}>
              <Select
                options={[{ value: '', label: 'Not recorded' }, ...TRANSMISSION_OPTIONS]}
                {...register('transmission', { setValueAs: (value: string) => value || null })}
              />
            </Field>

            <Field label="Seats" error={errors.seats?.message}>
              <Input inputMode="numeric" numeric {...register('seats')} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Hire and condition" description="What it costs and where it stands." />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Daily rate"
              error={errors.dailyRate?.message}
              hint={`In ${currency}.`}
              required
            >
              <Input
                inputMode="decimal"
                numeric
                prefix={getCurrencySymbol(currency)}
                placeholder="0"
                {...register('dailyRate')}
              />
            </Field>

            <Field label="Odometer" error={errors.odometer?.message} required>
              <Input inputMode="numeric" numeric suffix={distanceUnit} {...register('odometer')} />
            </Field>

            <Field
              label="Status"
              error={errors.status?.message}
              hint="Rented and reserved are set by contracts."
              required
            >
              <Select options={VEHICLE_STATUS_OPTIONS} {...register('status')} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Compliance"
          description="Renewal dates. Leave anything you do not track blank — you will be warned as each one approaches."
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Insurance expires" error={errors.insuranceExpiresOn?.message}>
              <Input type="date" {...register('insuranceExpiresOn')} />
            </Field>

            <Field label="Inspection expires" error={errors.inspectionExpiresOn?.message}>
              <Input type="date" {...register('inspectionExpiresOn')} />
            </Field>

            <Field label="Registration expires" error={errors.registrationExpiresOn?.message}>
              <Input type="date" {...register('registrationExpiresOn')} />
            </Field>

            <Field label="Next service due" error={errors.nextServiceOn?.message}>
              <Input type="date" {...register('nextServiceOn')} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Notes" description="Internal only. Never shown to customers." />
        <CardBody>
          <Field label="Notes" hideLabel error={errors.notes?.message}>
            <Textarea
              rows={3}
              placeholder="Winter tyres fitted, small dent on the rear bumper…"
              {...register('notes')}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" isLoading={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

/**
 * Turns a fleet row back into form values.
 *
 * Takes `operational_status`, not `effective_status`: the form edits what the
 * agency decides about the vehicle, and occupancy is not editable.
 */
export function vehicleToFormInput(vehicle: {
  make: string
  model: string
  model_year: number | null
  registration_plate: string
  vin: string | null
  color: string | null
  category: string | null
  fuel_type: VehicleFormInput['fuelType']
  transmission: VehicleFormInput['transmission']
  seats: number | null
  odometer: number
  daily_rate_minor: number
  currency: string
  operational_status: VehicleFormInput['status']
  insurance_expires_on: string | null
  inspection_expires_on: string | null
  registration_expires_on: string | null
  next_service_on: string | null
  notes: string | null
}): VehicleFormInput {
  return {
    make: vehicle.make,
    model: vehicle.model,
    modelYear: vehicle.model_year === null ? '' : String(vehicle.model_year),
    registrationPlate: vehicle.registration_plate,
    vin: vehicle.vin ?? '',
    color: vehicle.color ?? '',
    category: vehicle.category ?? '',
    fuelType: vehicle.fuel_type,
    transmission: vehicle.transmission,
    seats: vehicle.seats === null ? '' : String(vehicle.seats),
    odometer: String(vehicle.odometer),
    // Editing shows the amount the way it is stored, not a re-formatted string,
    // so saving without touching the field cannot round it.
    dailyRate: minorToDecimalString(vehicle.daily_rate_minor, vehicle.currency),
    currency: vehicle.currency,
    status: vehicle.operational_status,
    insuranceExpiresOn: vehicle.insurance_expires_on ?? '',
    inspectionExpiresOn: vehicle.inspection_expires_on ?? '',
    registrationExpiresOn: vehicle.registration_expires_on ?? '',
    nextServiceOn: vehicle.next_service_on ?? '',
    notes: vehicle.notes ?? '',
  }
}
