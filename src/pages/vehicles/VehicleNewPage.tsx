import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { paths, vehicleDetailPath } from '@/app/routes/paths'
import { Alert, PageHeader, useToast } from '@/components/ui'
import { VehicleForm } from '@/features/vehicles/components/VehicleForm'
import { useCreateVehicle } from '@/features/vehicles/queries'
import type { VehicleFormValues } from '@/features/vehicles/schemas'
import { useOrganization } from '@/features/workspace/workspace-context'
import { toErrorMessage } from '@/lib/supabase/errors'

export function VehicleNewPage() {
  const organization = useOrganization()
  const navigate = useNavigate()
  const toast = useToast()
  const create = useCreateVehicle()
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (values: VehicleFormValues) => {
    setError(null)
    create.mutate(values, {
      onSuccess: (vehicle) => {
        toast.success('Vehicle added', `${vehicle.make} ${vehicle.model} is now in your fleet.`)
        // Straight to the new vehicle, where photos and documents are added.
        void navigate(vehicleDetailPath(vehicle.id), { replace: true })
      },
      onError: (cause) => setError(toErrorMessage(cause)),
    })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          to={paths.vehicles}
          className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem]"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Fleet
        </Link>
      </div>

      <PageHeader
        title="Add a vehicle"
        eyebrow="Fleet"
        description="Only the make, model, plate, rate and odometer are needed to start. Everything else can follow."
      />

      {error ? <Alert tone="critical">{error}</Alert> : null}

      <VehicleForm
        currency={organization.default_currency}
        submitLabel="Add vehicle"
        isSubmitting={create.isPending}
        onSubmit={handleSubmit}
        onCancel={() => void navigate(paths.vehicles)}
      />
    </div>
  )
}
