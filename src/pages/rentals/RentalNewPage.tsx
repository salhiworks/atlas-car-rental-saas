import { ArrowLeft, ArrowRight, Check, TriangleAlert, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { paths, rentalDetailPath } from '@/app/routes/paths'
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  PageHeader,
  Textarea,
  useToast,
} from '@/components/ui'
import { DriverLicenceBadge } from '@/features/customers/components/CustomerBadges'
import { AddChargeForm } from '@/features/rentals/components/AddChargeForm'
import { CustomerPicker } from '@/features/rentals/components/CustomerPicker'
import { QuoteSummary } from '@/features/rentals/components/QuoteSummary'
import { VehiclePicker } from '@/features/rentals/components/VehiclePicker'
import {
  baseRentalLine,
  billableDays,
  describeDayRounding,
  formatTaxRate,
  parseTaxRatePercent,
  quoteFromLines,
  type QuoteLine,
} from '@/features/rentals/pricing'
import {
  useAvailableVehicles,
  useCreateRental,
  usePeriodConflicts,
} from '@/features/rentals/queries'
import { useVehicle } from '@/features/vehicles/queries'
import { useOrganizationSettings } from '@/features/workspace/useOrganizationSettings'
import { useComplianceOptions } from '@/features/workspace/useOrganizationSettings'
import { useOrganization } from '@/features/workspace/workspace-context'
import { formatDateTime } from '@/lib/datetime/format'
import {
  addDaysInTimeZone,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from '@/lib/datetime/timezone'
import { formatMoney, minorToDecimalString, parseMoneyToMinor } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'
import { cn } from '@/lib/utils/cn'
import type { CustomerDirectoryEntry, VehicleFleetEntry } from '@/types/database'

/**
 * Writing a new rental.
 *
 * The order of the steps is the order the facts actually depend on each other:
 * the period decides which vehicles are free, the vehicle sets the rate, the
 * people decide who may drive, and only then is there something to price. A
 * single long form would let somebody pick a car before saying when they want
 * it, and then quietly take it away again.
 */

type Step = 'period' | 'vehicle' | 'people' | 'pricing' | 'review'

interface Prefill {
  readonly vehicleId: string | null
  readonly startsAt: Date | null
  readonly endsAt: Date | null
}

/**
 * Context handed over from the Calendar.
 *
 * Only a vehicle id and two timestamps travel — nothing about a customer — and
 * every one of them is treated as a suggestion. The period is re-validated
 * here, the vehicle has to survive the same availability check any other choice
 * would, and if it does not the flow says so rather than booking something the
 * database would refuse.
 */
function readPrefill(params: URLSearchParams): Prefill {
  const parse = (value: string | null): Date | null => {
    if (!value) return null
    const instant = new Date(value)
    return Number.isNaN(instant.getTime()) ? null : instant
  }

  const startsAt = parse(params.get('from'))
  const endsAt = parse(params.get('to'))
  const isValidPeriod = startsAt !== null && endsAt !== null && endsAt > startsAt

  return {
    vehicleId: params.get('vehicle'),
    startsAt: isValidPeriod ? startsAt : null,
    endsAt: isValidPeriod ? endsAt : null,
  }
}

const STEPS: ReadonlyArray<{ key: Step; label: string; hint: string }> = [
  { key: 'period', label: 'Period', hint: 'When the vehicle goes out and comes back' },
  { key: 'vehicle', label: 'Vehicle', hint: 'What is free for those dates' },
  { key: 'people', label: 'People', hint: 'Who is renting and who is driving' },
  { key: 'pricing', label: 'Pricing', hint: 'What the customer is charged' },
  { key: 'review', label: 'Review', hint: 'Check it, then book it' },
]

export function RentalNewPage() {
  const organization = useOrganization()
  const compliance = useComplianceOptions()
  const settingsQuery = useOrganizationSettings()
  const navigate = useNavigate()
  const toast = useToast()
  const createRental = useCreateRental()

  const zone = organization.time_zone
  const locale = organization.locale
  const currency = organization.default_currency

  const [searchParams] = useSearchParams()
  const [prefill] = useState<Prefill>(() => readPrefill(searchParams))

  // Arriving from the board with a slot chosen, the period is already answered,
  // so the flow opens on the vehicle — where its availability is re-checked.
  const [step, setStep] = useState<Step>(prefill.startsAt ? 'vehicle' : 'period')

  // Sensible opening dates: tomorrow morning, back three days later. Typed in
  // the agency's own zone, which is the only zone the desk thinks in.
  const [startsAtLocal, setStartsAtLocal] = useState(() =>
    prefill.startsAt
      ? toDateTimeLocalValue(prefill.startsAt, zone)
      : toDateTimeLocalValue(addDaysInTimeZone(new Date(), zone, 1), zone)
          .slice(0, 11)
          .concat('09:00'),
  )
  const [endsAtLocal, setEndsAtLocal] = useState(() =>
    prefill.endsAt
      ? toDateTimeLocalValue(prefill.endsAt, zone)
      : toDateTimeLocalValue(addDaysInTimeZone(new Date(), zone, 4), zone)
          .slice(0, 11)
          .concat('09:00'),
  )
  const [pickupLocation, setPickupLocation] = useState('')
  const [returnLocation, setReturnLocation] = useState('')

  const [vehicle, setVehicle] = useState<VehicleFleetEntry | null>(null)
  const [renter, setRenter] = useState<CustomerDirectoryEntry | null>(null)
  const [primaryDriver, setPrimaryDriver] = useState<CustomerDirectoryEntry | null>(null)
  const [additionalDrivers, setAdditionalDrivers] = useState<CustomerDirectoryEntry[]>([])

  const [dailyRate, setDailyRate] = useState('')
  const [deposit, setDeposit] = useState('')
  const [taxPercent, setTaxPercent] = useState('')
  const [taxLabel, setTaxLabel] = useState('')
  const [extraLines, setExtraLines] = useState<QuoteLine[]>([])
  const [notes, setNotes] = useState('')
  const [hasTouchedRate, setHasTouchedRate] = useState(false)
  const [hasTouchedDeposit, setHasTouchedDeposit] = useState(false)
  const [hasTouchedTax, setHasTouchedTax] = useState(false)
  const [prefillResolved, setPrefillResolved] = useState(prefill.vehicleId === null)

  const startsAt = useMemo(() => fromDateTimeLocalValue(startsAtLocal, zone), [startsAtLocal, zone])
  const endsAt = useMemo(() => fromDateTimeLocalValue(endsAtLocal, zone), [endsAtLocal, zone])
  const periodIsValid = Boolean(startsAt && endsAt && endsAt > startsAt)

  const settings = settingsQuery.data

  // Agency defaults fill the fields until somebody types over them. Following
  // the source afterwards would overwrite a deliberate figure.
  if (settings && !hasTouchedDeposit && deposit === '' && settings.default_deposit_minor > 0) {
    setDeposit(minorToDecimalString(settings.default_deposit_minor, currency))
  }
  if (settings && !hasTouchedTax && taxPercent === '' && settings.tax_rate_bps > 0) {
    setTaxPercent(String(settings.tax_rate_bps / 100))
    if (settings.tax_label) setTaxLabel(settings.tax_label)
  }
  if (vehicle && !hasTouchedRate && dailyRate === '') {
    setDailyRate(minorToDecimalString(vehicle.daily_rate_minor, currency))
  }

  const days = periodIsValid && startsAt && endsAt ? billableDays(startsAt, endsAt) : 0
  const dailyRateMinor = parseMoneyToMinor(dailyRate || '0', currency) ?? 0
  const depositMinor = parseMoneyToMinor(deposit || '0', currency) ?? 0
  const taxRateBps = parseTaxRatePercent(taxPercent) ?? 0

  const lines = useMemo<QuoteLine[]>(
    () =>
      days > 0 && dailyRateMinor > 0
        ? [baseRentalLine(days, dailyRateMinor), ...extraLines]
        : [...extraLines],
    [days, dailyRateMinor, extraLines],
  )

  const quote = useMemo(
    () => quoteFromLines(lines, currency, taxRateBps),
    [lines, currency, taxRateBps],
  )

  /**
   * Resolving a vehicle handed over by the Calendar.
   *
   * The id is checked against `vehicles_available_between()` for the period
   * actually in the form — not the one that was in the link — so a car taken by
   * somebody else in the meantime is not silently pre-selected. Applied once;
   * afterwards the desk's own choice stands.
   */
  const prefillAvailability = useAvailableVehicles(
    prefill.vehicleId && periodIsValid && startsAt ? startsAt.toISOString() : null,
    prefill.vehicleId && periodIsValid && endsAt ? endsAt.toISOString() : null,
  )
  // Fetched by id rather than looked for in a page of the fleet: an agency with
  // more than a hundred vehicles would otherwise be told a perfectly free car
  // was no longer available, purely because it was not on the first page.
  const prefillVehicle = useVehicle(prefill.vehicleId ?? undefined)

  if (
    !prefillResolved &&
    prefill.vehicleId &&
    prefillAvailability.data !== undefined &&
    (prefillVehicle.data !== undefined || prefillVehicle.isError)
  ) {
    setPrefillResolved(true)
    if (prefillAvailability.data.includes(prefill.vehicleId) && prefillVehicle.data) {
      setVehicle(prefillVehicle.data)
    }
  }

  const prefillVehicleLost =
    prefillResolved && prefill.vehicleId !== null && vehicle === null && step === 'vehicle'

  const conflictsQuery = usePeriodConflicts(
    vehicle?.vehicle_id ?? null,
    startsAt?.toISOString() ?? null,
    endsAt?.toISOString() ?? null,
  )
  const conflicts = conflictsQuery.data ?? []

  const canLeavePeriod = periodIsValid
  const canLeaveVehicle = vehicle !== null
  const canLeavePeople = renter !== null && primaryDriver !== null
  const canLeavePricing = quote.totalMinor >= 0 && days > 0

  const stepIndex = STEPS.findIndex((entry) => entry.key === step)

  const goNext = () => {
    const next = STEPS[stepIndex + 1]
    if (next) setStep(next.key)
  }
  const goBack = () => {
    const previous = STEPS[stepIndex - 1]
    if (previous) setStep(previous.key)
  }

  const submit = async (confirm: boolean) => {
    if (!startsAt || !endsAt || !vehicle || !renter || !primaryDriver) return

    try {
      const rental = await createRental.mutateAsync({
        vehicleId: vehicle.vehicle_id,
        customerId: renter.customer_id,
        primaryDriverId: primaryDriver.customer_id,
        additionalDriverIds: additionalDrivers.map((driver) => driver.customer_id),
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        pickupLocation: pickupLocation.trim() || null,
        returnLocation: returnLocation.trim() || null,
        currency,
        dailyRateMinor,
        billableDays: days,
        depositMinor,
        taxRateBps,
        taxLabel: taxLabel.trim() || null,
        notes: notes.trim() || null,
        lines,
        confirm,
      })

      toast.success(
        confirm ? 'Reservation confirmed' : 'Draft saved',
        confirm
          ? `${vehicle.registration_plate} is held for ${renter.display_name}.`
          : 'The vehicle is not held until you confirm this contract.',
      )
      void navigate(rentalDetailPath(rental.id))
    } catch (error) {
      toast.error('Could not book this', toErrorMessage(error))
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New rental"
        eyebrow="Operations"
        description="Pick the dates first — everything else follows from what is free."
        actions={
          <ButtonLink variant="ghost" leadingIcon={<X />} to={paths.rentals}>
            Cancel
          </ButtonLink>
        }
      />

      <ol className="flex flex-wrap gap-1.5">
        {STEPS.map((entry, index) => {
          const isCurrent = entry.key === step
          const isDone = index < stepIndex

          return (
            <li key={entry.key}>
              <button
                type="button"
                onClick={() => (index <= stepIndex ? setStep(entry.key) : undefined)}
                disabled={index > stepIndex}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.75rem] transition-colors',
                  isCurrent
                    ? 'border-brand-400 bg-brand-50 text-brand-700 font-medium'
                    : isDone
                      ? 'border-line text-ink-muted hover:border-line-strong'
                      : 'border-line text-ink-subtle cursor-not-allowed',
                )}
              >
                {isDone ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : (
                  <span data-numeric="">{index + 1}</span>
                )}
                {entry.label}
              </button>
            </li>
          )
        })}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {step === 'period' ? (
            <Card>
              <CardHeader title="Period" description="Times are in the agency's own time zone." />
              <CardBody className="space-y-4">
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
                    {...(periodIsValid
                      ? {}
                      : { error: 'The return must be after the collection.' })}
                  >
                    <Input
                      type="datetime-local"
                      value={endsAtLocal}
                      onChange={(event) => setEndsAtLocal(event.target.value)}
                    />
                  </Field>
                </div>

                {periodIsValid && startsAt && endsAt ? (
                  <p className="text-ink-muted text-[0.8125rem]">
                    {describeDayRounding(startsAt, endsAt)}
                  </p>
                ) : null}

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Collected from" hint="Leave blank for your usual desk.">
                    <Input
                      value={pickupLocation}
                      onChange={(event) => setPickupLocation(event.target.value)}
                      maxLength={160}
                      placeholder="Airport terminal 1"
                    />
                  </Field>
                  <Field label="Returned to">
                    <Input
                      value={returnLocation}
                      onChange={(event) => setReturnLocation(event.target.value)}
                      maxLength={160}
                      placeholder="Same as collection"
                    />
                  </Field>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {step === 'vehicle' ? (
            <Card>
              <CardHeader
                title="Vehicle"
                description="Only vehicles with nothing else booked over this period."
              />
              <CardBody className="space-y-3">
                {prefillVehicleLost ? (
                  <Alert tone="caution" title="That vehicle is no longer free">
                    Somebody has booked it for this period since the board was drawn. Choose another
                    vehicle, or change the dates.
                  </Alert>
                ) : null}

                <VehiclePicker
                  from={startsAt?.toISOString() ?? null}
                  to={endsAt?.toISOString() ?? null}
                  selectedId={vehicle?.vehicle_id ?? null}
                  onSelect={setVehicle}
                  locale={locale}
                />
              </CardBody>
            </Card>
          ) : null}

          {step === 'people' ? (
            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Renter"
                  description="The person or company the contract is with, and who pays."
                />
                <CardBody className="space-y-3">
                  {renter ? (
                    <SelectedPerson
                      customer={renter}
                      onClear={() => setRenter(null)}
                      compliance={compliance}
                    />
                  ) : (
                    <CustomerPicker
                      selectedIds={[]}
                      compliance={compliance}
                      onSelect={(customer) => {
                        setRenter(customer)
                        // Most of the time the renter drives. Offering that as
                        // the default saves a search and stays overridable.
                        if (!primaryDriver) setPrimaryDriver(customer)
                      }}
                    />
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Primary driver"
                  description="Who will actually be driving. Often the renter, but not always."
                />
                <CardBody className="space-y-3">
                  {primaryDriver ? (
                    <SelectedPerson
                      customer={primaryDriver}
                      onClear={() => setPrimaryDriver(null)}
                      compliance={compliance}
                      showLicence
                    />
                  ) : (
                    <CustomerPicker
                      selectedIds={[]}
                      compliance={compliance}
                      showLicence
                      onSelect={setPrimaryDriver}
                    />
                  )}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Additional drivers"
                  description="Anyone else authorised to drive under this contract."
                />
                <CardBody className="space-y-3">
                  {additionalDrivers.length > 0 ? (
                    <ul className="space-y-2">
                      {additionalDrivers.map((driver) => (
                        <li key={driver.customer_id}>
                          <SelectedPerson
                            customer={driver}
                            compliance={compliance}
                            showLicence
                            onClear={() =>
                              setAdditionalDrivers((current) =>
                                current.filter((entry) => entry.customer_id !== driver.customer_id),
                              )
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <CustomerPicker
                    selectedIds={additionalDrivers.map((driver) => driver.customer_id)}
                    compliance={compliance}
                    showLicence
                    onSelect={(customer) =>
                      setAdditionalDrivers((current) =>
                        current.some((entry) => entry.customer_id === customer.customer_id) ||
                        customer.customer_id === primaryDriver?.customer_id
                          ? current
                          : [...current, customer],
                      )
                    }
                  />
                </CardBody>
              </Card>
            </div>
          ) : null}

          {step === 'pricing' ? (
            <Card>
              <CardHeader
                title="Pricing"
                description="The hire is priced from the rate and the days. Everything else is a line you add."
              />
              <CardBody className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Daily rate" required>
                    <Input
                      value={dailyRate}
                      inputMode="decimal"
                      onChange={(event) => {
                        setHasTouchedRate(true)
                        setDailyRate(event.target.value)
                      }}
                    />
                  </Field>
                  <Field label="Deposit" hint="Held, then returned. Never counted as revenue.">
                    <Input
                      value={deposit}
                      inputMode="decimal"
                      onChange={(event) => {
                        setHasTouchedDeposit(true)
                        setDeposit(event.target.value)
                      }}
                    />
                  </Field>
                  <Field label="Tax rate" hint={`Applied as ${formatTaxRate(taxRateBps)}.`}>
                    <Input
                      value={taxPercent}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(event) => {
                        setHasTouchedTax(true)
                        setTaxPercent(event.target.value)
                      }}
                    />
                  </Field>
                </div>

                <Field label="What the tax is called" hint="Printed on the contract, e.g. VAT.">
                  <Input
                    value={taxLabel}
                    onChange={(event) => setTaxLabel(event.target.value)}
                    maxLength={40}
                  />
                </Field>

                <AddChargeForm
                  currency={currency}
                  onAdd={(line) => setExtraLines((current) => [...current, line])}
                />

                <Field label="Notes" hint="Anything the desk should know. Printed on the contract.">
                  <Textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    rows={3}
                    maxLength={4000}
                  />
                </Field>
              </CardBody>
            </Card>
          ) : null}

          {step === 'review' ? (
            <Card>
              <CardHeader title="Review" description="Everything this contract will say." />
              <CardBody className="space-y-4">
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Detail label="Collection">
                    {startsAt ? formatDateTime(startsAt, { locale, timeZone: zone }) : '—'}
                  </Detail>
                  <Detail label="Return">
                    {endsAt ? formatDateTime(endsAt, { locale, timeZone: zone }) : '—'}
                  </Detail>
                  <Detail label="Vehicle">
                    {vehicle
                      ? `${vehicle.make} ${vehicle.model} · ${vehicle.registration_plate}`
                      : '—'}
                  </Detail>
                  <Detail label="Days charged">{days}</Detail>
                  <Detail label="Renter">{renter?.display_name ?? '—'}</Detail>
                  <Detail label="Primary driver">{primaryDriver?.display_name ?? '—'}</Detail>
                  {additionalDrivers.length > 0 ? (
                    <Detail label="Also driving">
                      {additionalDrivers.map((driver) => driver.display_name).join(', ')}
                    </Detail>
                  ) : null}
                </dl>

                {conflicts.length > 0 ? (
                  <Alert tone="critical" title="This vehicle is committed elsewhere">
                    {conflicts.map((conflict) => (
                      <p key={conflict.rental_id}>
                        {conflict.reference} holds it from{' '}
                        {formatDateTime(new Date(conflict.starts_at), { locale, timeZone: zone })}{' '}
                        to {formatDateTime(new Date(conflict.ends_at), { locale, timeZone: zone })}.
                      </p>
                    ))}
                  </Alert>
                ) : null}

                <Alert tone="info" title="Confirming holds the vehicle">
                  A draft reserves nothing. The moment you confirm, this vehicle is held for these
                  dates and cannot be booked by anyone else.
                </Alert>
              </CardBody>
            </Card>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="ghost"
              leadingIcon={<ArrowLeft />}
              onClick={goBack}
              disabled={stepIndex === 0}
            >
              Back
            </Button>

            {step === 'review' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void submit(false)}
                  isLoading={createRental.isPending}
                >
                  Save as draft
                </Button>
                <Button
                  variant="primary"
                  leadingIcon={<Check />}
                  onClick={() => void submit(true)}
                  isLoading={createRental.isPending}
                >
                  Confirm reservation
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                trailingIcon={<ArrowRight />}
                onClick={goNext}
                disabled={
                  (step === 'period' && !canLeavePeriod) ||
                  (step === 'vehicle' && !canLeaveVehicle) ||
                  (step === 'people' && !canLeavePeople) ||
                  (step === 'pricing' && !canLeavePricing)
                }
              >
                Continue
              </Button>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader title="Quote" />
            <CardBody>
              {days > 0 ? (
                <QuoteSummary
                  quote={quote}
                  locale={locale}
                  depositMinor={depositMinor}
                  taxLabel={taxLabel || settings?.tax_label || null}
                  onRemoveLine={(index) =>
                    setExtraLines((current) =>
                      current.filter((_, position) => position !== index - 1),
                    )
                  }
                  // The hire itself is derived from the period and the rate;
                  // removing it by hand would leave a contract that charges for
                  // extras and nothing for the car.
                  isRemovable={(index) => index > 0}
                />
              ) : (
                <p className="text-ink-subtle text-[0.8125rem]">
                  Set the period and the daily rate to see what this contract comes to.
                </p>
              )}
            </CardBody>
          </Card>

          {vehicle ? (
            <Card>
              <CardHeader title="Chosen vehicle" />
              <CardBody className="space-y-1">
                <p className="text-ink text-[0.875rem] font-medium">
                  {vehicle.make} {vehicle.model}
                </p>
                <p className="identifier text-ink-subtle text-[0.75rem]">
                  {vehicle.registration_plate}
                </p>
                <p className="text-ink-muted text-[0.75rem]">
                  Listed at {formatMoney(vehicle.daily_rate_minor, vehicle.currency, { locale })} a
                  day
                </p>
              </CardBody>
            </Card>
          ) : null}

          {primaryDriver ? (
            <Card>
              <CardHeader title="Driving" />
              <CardBody className="space-y-2">
                <p className="text-ink text-[0.875rem] font-medium">{primaryDriver.display_name}</p>
                <DriverLicenceBadge customer={primaryDriver} compliance={compliance} />
                {!primaryDriver.has_driver_license ? (
                  <p className="text-ink-muted flex items-start gap-1.5 text-[0.75rem]">
                    <TriangleAlert
                      className="text-caution-600 mt-0.5 size-3 shrink-0"
                      aria-hidden="true"
                    />
                    You can still book this, but record a licence before handing over the keys.
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-subtle text-[0.75rem]">{label}</dt>
      <dd className="text-ink mt-0.5 text-[0.8125rem]">{children}</dd>
    </div>
  )
}

function SelectedPerson({
  customer,
  onClear,
  compliance,
  showLicence = false,
}: {
  customer: CustomerDirectoryEntry
  onClear: () => void
  compliance: ReturnType<typeof useComplianceOptions>
  showLicence?: boolean
}) {
  return (
    <div className="border-line flex items-center gap-3 rounded-md border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-ink truncate text-[0.8125rem] font-medium">{customer.display_name}</p>
        <p className="text-ink-subtle truncate text-[0.75rem]">
          {[customer.city, customer.country_code].filter(Boolean).join(', ') ||
            'No address on file'}
        </p>
      </div>
      {showLicence ? <DriverLicenceBadge customer={customer} compliance={compliance} /> : null}
      <Button variant="ghost" size="sm" onClick={onClear} aria-label="Choose someone else">
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}
