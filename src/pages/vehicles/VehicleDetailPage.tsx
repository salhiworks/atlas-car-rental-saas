import {
  ArchiveRestore,
  ArrowLeft,
  Archive as ArchiveIcon,
  Gauge,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { paths, rentalDetailPath } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui'
import { VehicleCostPanel } from '@/features/expenses/components/VehicleCostPanel'
import { VehicleFinancingPanel } from '@/features/financing/components/VehicleFinancingPanel'
import { VehicleGpsPanel } from '@/features/gps/components/VehicleGpsPanel'
import { VehicleCompliancePanel } from '@/features/vehicles/components/VehicleCompliancePanel'
import { VehicleDocuments } from '@/features/vehicles/components/VehicleDocuments'
import { VehicleForm, vehicleToFormInput } from '@/features/vehicles/components/VehicleForm'
import { VehiclePhotos } from '@/features/vehicles/components/VehiclePhotos'
import {
  VehicleStatusBadge,
  vehicleStatusHint,
} from '@/features/vehicles/components/VehicleStatusBadge'
import { VehicleThumbnail } from '@/features/vehicles/components/VehicleThumbnail'
import {
  useArchiveVehicle,
  useDeleteVehicle,
  useRestoreVehicle,
  useSetVehicleStatus,
  useUpdateOdometer,
  useUpdateVehicle,
  useVehicle,
  useVehicleImages,
  useVehiclePhotoUrls,
  useVehicleUsage,
} from '@/features/vehicles/queries'
import { VEHICLE_STATUS_OPTIONS, type VehicleFormValues } from '@/features/vehicles/schemas'
import { useComplianceOptions, useDistanceUnit } from '@/features/workspace/useOrganizationSettings'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatDate, formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { VehicleOperationalStatus } from '@/types/database'

/**
 * Everything about one vehicle.
 *
 * Ordered by how often it is needed: what state the car is in and what it is
 * doing sit at the top, then its facts, then paperwork. Editing happens in a
 * dialog rather than on a separate page so the surrounding context does not
 * disappear while a plate is corrected.
 */
export function VehicleDetailPage() {
  const { vehicleId } = useParams<{ vehicleId: string }>()
  const organization = useOrganization()
  const compliance = useComplianceOptions()
  const distanceUnit = useDistanceUnit()
  const navigate = useNavigate()
  const toast = useToast()

  const canEdit = usePermission('vehicles.update')
  const canDelete = usePermission('vehicles.delete')
  const canViewExpenses = usePermission('expenses.view')
  const canRecordExpense = usePermission('expenses.create')
  const canViewFinancing = usePermission('financing.view')
  const canCreateFinancing = usePermission('financing.create')

  const [isEditing, setIsEditing] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isOdometerOpen, setIsOdometerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const vehicleQuery = useVehicle(vehicleId)
  const usageQuery = useVehicleUsage(vehicleId)
  const imagesQuery = useVehicleImages(vehicleId)
  const photoUrls = useVehiclePhotoUrls(imagesQuery.data ?? [])

  const update = useUpdateVehicle(vehicleId ?? '')
  const setStatus = useSetVehicleStatus(vehicleId ?? '')
  const setOdometer = useUpdateOdometer(vehicleId ?? '')
  const archive = useArchiveVehicle(vehicleId ?? '')
  const restore = useRestoreVehicle(vehicleId ?? '')
  const remove = useDeleteVehicle(vehicleId ?? '')

  if (vehicleQuery.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (vehicleQuery.isError || !vehicleQuery.data) {
    // An id from another agency and an id that never existed land here
    // identically — the interface must not confirm that a record exists
    // somewhere it cannot be seen.
    return (
      <div className="space-y-6">
        <BackLink />
        <Card className="mx-auto max-w-lg">
          <ErrorState
            title="This vehicle could not be found"
            error={vehicleQuery.error ?? new Error('Not found')}
          />
          <div className="flex justify-center pb-6">
            <Button variant="secondary" onClick={() => void navigate(paths.vehicles)}>
              Back to the fleet
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const vehicle = vehicleQuery.data
  const usage = usageQuery.data
  const isArchived = vehicle.archived_at !== null
  const primaryPhoto = (imagesQuery.data ?? []).find((image) => image.is_primary)
  const primaryUrl = primaryPhoto ? photoUrls.get(primaryPhoto.id) : undefined

  const handleUpdate = (values: VehicleFormValues) => {
    setError(null)
    update.mutate(values, {
      onSuccess: () => {
        setIsEditing(false)
        toast.success('Vehicle updated')
      },
      onError: (cause) => setError(toErrorMessage(cause)),
    })
  }

  return (
    <div className="space-y-6">
      <BackLink />

      {error ? <Alert tone="critical">{error}</Alert> : null}

      {isArchived ? (
        <Alert
          tone="info"
          title="This vehicle is retired"
          actions={
            canEdit ? (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<ArchiveRestore />}
                isLoading={restore.isPending}
                onClick={() =>
                  restore.mutate(undefined, {
                    onSuccess: () => toast.success('Vehicle returned to the fleet'),
                    onError: (cause) => setError(toErrorMessage(cause)),
                  })
                }
              >
                Return to fleet
              </Button>
            ) : null
          }
        >
          It is kept for its contract and expense history but cannot be booked. Retired{' '}
          {formatDate(new Date(vehicle.archived_at!), {
            locale: organization.locale,
            timeZone: compliance.timeZone,
          })}
          .
        </Alert>
      ) : null}

      <PageHeader
        eyebrow="Fleet"
        title={`${vehicle.make} ${vehicle.model}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="identifier text-ink">{vehicle.registration_plate}</span>
            {vehicle.model_year ? <span>· {vehicle.model_year}</span> : null}
            {vehicle.color ? <span>· {vehicle.color}</span> : null}
          </span>
        }
        actions={
          canEdit ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                leadingIcon={<Pencil />}
                onClick={() => setIsEditing(true)}
              >
                Edit
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger
                  className="border-line-strong bg-surface text-ink-muted hover:bg-surface-muted hover:text-ink flex size-9 items-center justify-center rounded-md border shadow-raised transition-colors"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </DropdownMenuTrigger>

                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setIsOdometerOpen(true)}>
                    <Gauge aria-hidden="true" />
                    Record odometer
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {!isArchived ? (
                    <DropdownMenuItem onSelect={() => setIsArchiving(true)}>
                      <ArchiveIcon aria-hidden="true" />
                      Retire from fleet
                    </DropdownMenuItem>
                  ) : null}
                  {canDelete && usage?.can_delete ? (
                    <DropdownMenuItem tone="critical" onSelect={() => setIsDeleting(true)}>
                      <Trash2 aria-hidden="true" />
                      Delete permanently
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null
        }
      />

      {/* min-w-0 on both columns: a grid item defaults to min-width:auto, so a
          single wide descendant stretches the track past the viewport. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          {/* Header: photo, state, and what it is doing now */}
          <Card>
            <div className="flex flex-col gap-5 p-5 sm:flex-row">
              <div className="sm:w-64">
                <div className="border-line bg-surface-inset aspect-[4/3] overflow-hidden rounded-md border">
                  <VehicleThumbnail
                    url={primaryUrl}
                    make={vehicle.make}
                    model={vehicle.model}
                    size="lg"
                  />
                </div>
              </div>

              <div className="min-w-0 flex-1 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <VehicleStatusBadge status={vehicle.effective_status} />
                  {vehicle.is_available_now ? <Badge tone="neutral">Bookable now</Badge> : null}
                </div>

                <p className="text-ink-muted text-[0.8125rem] leading-5">
                  {vehicleStatusHint(vehicle.effective_status)}
                </p>

                <RentalContext
                  vehicle={vehicle}
                  locale={organization.locale}
                  timeZone={compliance.timeZone}
                />

                {canEdit && !isArchived ? (
                  <div className="border-line max-w-xs border-t pt-4">
                    <Field
                      label="Operational status"
                      hint="Rented and reserved come from contracts and cannot be set here."
                    >
                      <Select
                        options={VEHICLE_STATUS_OPTIONS}
                        value={vehicle.operational_status}
                        disabled={setStatus.isPending}
                        onChange={(event) =>
                          setStatus.mutate(event.target.value as VehicleOperationalStatus, {
                            onSuccess: () => toast.success('Status updated'),
                            onError: (cause) => setError(toErrorMessage(cause)),
                          })
                        }
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Details" />
            <CardBody className="p-0">
              <dl className="divide-line grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-x">
                <DetailRow label="Odometer">
                  {new Intl.NumberFormat(organization.locale).format(vehicle.odometer)}{' '}
                  {distanceUnit}
                </DetailRow>
                <DetailRow label="Daily rate">
                  {formatMoney(vehicle.daily_rate_minor, vehicle.currency, {
                    locale: organization.locale,
                  })}
                </DetailRow>
                <DetailRow label="VIN / chassis">
                  {vehicle.vin ? <span className="identifier">{vehicle.vin}</span> : '—'}
                </DetailRow>
                <DetailRow label="Category">{vehicle.category ?? '—'}</DetailRow>
                <DetailRow label="Fuel">{formatEnum(vehicle.fuel_type)}</DetailRow>
                <DetailRow label="Transmission">{formatEnum(vehicle.transmission)}</DetailRow>
                <DetailRow label="Seats">{vehicle.seats ?? '—'}</DetailRow>
                <DetailRow label="Added">
                  {formatDate(new Date(vehicle.created_at), {
                    locale: organization.locale,
                    timeZone: compliance.timeZone,
                  })}
                </DetailRow>
              </dl>

              {vehicle.notes ? (
                <div className="border-line border-t px-5 py-4">
                  <p className="eyebrow mb-1.5">Notes</p>
                  <p className="text-ink-muted text-[0.8125rem] leading-6 whitespace-pre-line">
                    {vehicle.notes}
                  </p>
                </div>
              ) : null}
            </CardBody>
          </Card>

          {/* Where it is now, if a tracker is fitted. Directly beneath the
              recorded facts because the two odometers sit next to each other on
              purpose: one is what the device reports, the other is what a person
              wrote down, and tracking never overwrites the second. */}
          <VehicleGpsPanel
            vehicleId={vehicle.vehicle_id}
            locale={organization.locale}
            timeZone={compliance.timeZone}
          />

          {/* Economics. Placed under the facts rather than beside the photo:
              it is the question an owner asks second, not first. */}
          {canViewExpenses ? (
            <VehicleCostPanel
              vehicleId={vehicle.vehicle_id}
              locale={organization.locale}
              timeZone={compliance.timeZone}
              canRecord={canRecordExpense && !isArchived}
            />
          ) : null}

          {/* Financing sits below the running costs on purpose: what the car
              earns and costs to run is the operating question, and what is owed
              on it is a separate one. Merging them would produce a number that
              is neither. */}
          {canViewFinancing ? (
            <VehicleFinancingPanel
              vehicleId={vehicle.vehicle_id}
              defaultCurrency={vehicle.currency}
              acquisitionMethod={vehicle.acquisition_method}
              acquiredOn={vehicle.acquired_on}
              acquisitionPriceMinor={vehicle.acquisition_price_minor}
              acquisitionCurrency={vehicle.acquisition_currency}
              acquisitionSupplier={vehicle.acquisition_supplier}
              acquisitionNotes={vehicle.acquisition_notes}
              locale={organization.locale}
              timeZone={compliance.timeZone}
              canCreate={canCreateFinancing && !isArchived}
              canEditAcquisition={canEdit}
              canViewOperating={canViewExpenses}
            />
          ) : null}

          <Card>
            <VehiclePhotos vehicleId={vehicle.vehicle_id} canEdit={canEdit && !isArchived} />
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <Card>
            <VehicleCompliancePanel
              vehicle={vehicle}
              compliance={compliance}
              locale={organization.locale}
            />
          </Card>

          <Card>
            <VehicleDocuments
              organizationId={organization.id}
              vehicleId={vehicle.vehicle_id}
              canEdit={canEdit && !isArchived}
              compliance={compliance}
              locale={organization.locale}
            />
          </Card>

          {usage ? (
            <Card>
              <CardHeader title="History" description="What this vehicle is referenced by." />
              <CardBody className="p-0">
                <dl className="divide-line divide-y">
                  <UsageRow label="Contracts" value={usage.rentals_count} />
                  <UsageRow label="Expenses" value={usage.expenses_count} />
                  <UsageRow label="Financing plans" value={usage.financing_count} />
                </dl>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Edit */}
      <Dialog open={isEditing} onOpenChange={setIsEditing}>
        <DialogContent
          title="Edit vehicle"
          description="Changes apply to the fleet immediately. Past contracts keep the figures they were signed with."
          size="xl"
        >
          <VehicleForm
            currency={vehicle.currency}
            defaultValues={vehicleToFormInput(vehicle)}
            submitLabel="Save changes"
            isSubmitting={update.isPending}
            onSubmit={handleUpdate}
            onCancel={() => setIsEditing(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Odometer */}
      <OdometerDialog
        open={isOdometerOpen}
        onOpenChange={setIsOdometerOpen}
        current={vehicle.odometer}
        unit={distanceUnit}
        isPending={setOdometer.isPending}
        onSubmit={(value) =>
          setOdometer.mutate(value, {
            onSuccess: () => {
              setIsOdometerOpen(false)
              toast.success('Odometer updated')
            },
            onError: (cause) => setError(toErrorMessage(cause)),
          })
        }
      />

      {/* Archive */}
      <ConfirmDialog
        open={isArchiving}
        onOpenChange={setIsArchiving}
        title="Retire this vehicle from the fleet?"
        confirmLabel="Retire vehicle"
        isPending={archive.isPending}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              setIsArchiving(false)
              toast.success('Vehicle retired')
            },
            onError: (cause) => {
              setIsArchiving(false)
              setError(toErrorMessage(cause))
            },
          })
        }
      >
        <p className="text-ink-muted text-[0.8125rem] leading-6">
          It stops appearing in the fleet and cannot be booked, but every contract, payment and
          expense that references it stays exactly as it is. You can bring it back at any time.
        </p>
      </ConfirmDialog>

      {/* Permanent delete — only offered when nothing financial refers to it */}
      <ConfirmDialog
        open={isDeleting}
        onOpenChange={setIsDeleting}
        title="Delete this vehicle permanently?"
        confirmLabel="Delete permanently"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              toast.success('Vehicle deleted')
              void navigate(paths.vehicles, { replace: true })
            },
            onError: (cause) => {
              setIsDeleting(false)
              setError(toErrorMessage(cause))
            },
          })
        }
      >
        <p className="text-ink-muted text-[0.8125rem] leading-6">
          This vehicle has no contracts, expenses or financing against it, so nothing financial is
          lost. Its photos and documents are deleted with it. This cannot be undone — retire it
          instead if you might want the record later.
        </p>
      </ConfirmDialog>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to={paths.vehicles}
      className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem]"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Fleet
    </Link>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-3">
      <dt className="eyebrow">{label}</dt>
      <dd data-numeric="" className="text-ink mt-1 text-[0.8125rem]">
        {children}
      </dd>
    </div>
  )
}

function UsageRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <dt className="text-ink-muted text-[0.8125rem]">{label}</dt>
      <dd data-numeric="" className="text-ink text-[0.8125rem] font-medium">
        {value}
      </dd>
    </div>
  )
}

function formatEnum(value: string | null): string {
  if (!value) return '—'
  return value.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())
}

/** Contract context, built only from contracts that exist. */
function RentalContext({
  vehicle,
  locale,
  timeZone,
}: {
  vehicle: {
    current_rental_id: string | null
    current_rental_reference: string | null
    current_rental_ends_at: string | null
    next_rental_id: string | null
    next_rental_reference: string | null
    next_rental_starts_at: string | null
  }
  locale: string
  timeZone: string
}) {
  if (!vehicle.current_rental_reference && !vehicle.next_rental_reference) {
    return (
      <p className="text-ink-subtle text-[0.8125rem]">No contracts booked against this vehicle.</p>
    )
  }

  return (
    <dl className="border-line space-y-2 rounded-md border p-3">
      {vehicle.current_rental_reference && vehicle.current_rental_ends_at ? (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-ink-subtle text-[0.75rem]">Out on</dt>
          <dd className="text-[0.75rem]">
            {vehicle.current_rental_id ? (
              <Link
                to={rentalDetailPath(vehicle.current_rental_id)}
                className="identifier text-ink hover:underline"
              >
                {vehicle.current_rental_reference}
              </Link>
            ) : (
              <span className="identifier text-ink">{vehicle.current_rental_reference}</span>
            )}
          </dd>
          <dd className="text-ink-muted text-[0.75rem]">
            due back{' '}
            {formatDateTime(new Date(vehicle.current_rental_ends_at), { locale, timeZone })}
          </dd>
        </div>
      ) : null}

      {vehicle.next_rental_reference && vehicle.next_rental_starts_at ? (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-ink-subtle text-[0.75rem]">Next booking</dt>
          <dd className="text-[0.75rem]">
            {vehicle.next_rental_id ? (
              <Link
                to={rentalDetailPath(vehicle.next_rental_id)}
                className="identifier text-ink hover:underline"
              >
                {vehicle.next_rental_reference}
              </Link>
            ) : (
              <span className="identifier text-ink">{vehicle.next_rental_reference}</span>
            )}
          </dd>
          <dd className="text-ink-muted text-[0.75rem]">
            from {formatDateTime(new Date(vehicle.next_rental_starts_at), { locale, timeZone })}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

interface OdometerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: number
  unit: 'km' | 'mi'
  isPending: boolean
  onSubmit: (value: number) => void
}

function OdometerDialog({
  open,
  onOpenChange,
  current,
  unit,
  isPending,
  onSubmit,
}: OdometerDialogProps) {
  const [value, setValue] = useState(String(current))
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = () => {
    if (!/^\d+$/.test(value.trim())) {
      setError('Enter the reading as a whole number.')
      return
    }
    const next = Number(value)
    if (next < current) {
      setError(`An odometer does not go backwards. The last reading was ${current} ${unit}.`)
      return
    }
    setError(undefined)
    onSubmit(next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record odometer reading"
        description="Taken at handover or return, whichever is most recent."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} isLoading={isPending}>
              Save reading
            </Button>
          </>
        }
      >
        <Field label="Odometer" error={error} required>
          <Input
            inputMode="numeric"
            numeric
            suffix={unit}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
      </DialogContent>
    </Dialog>
  )
}
