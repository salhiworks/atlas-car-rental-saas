import {
  ArrowLeft,
  CalendarClock,
  Check,
  MoreHorizontal,
  Repeat,
  Trash2,
  UserRound,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { customerDetailPath, paths, vehicleDetailPath } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  Input,
  PageHeader,
  Skeleton,
  useToast,
} from '@/components/ui'
import { RentalCostPanel } from '@/features/expenses/components/RentalCostPanel'
import { AddChargeForm } from '@/features/rentals/components/AddChargeForm'
import { ConditionPhotos } from '@/features/rentals/components/ConditionPhotos'
import { ContractPanel } from '@/features/rentals/components/ContractPanel'
import { ExtendDialog } from '@/features/rentals/components/ExtendDialog'
import { HandoverDialog } from '@/features/rentals/components/HandoverDialog'
import { PaymentDialog } from '@/features/rentals/components/PaymentDialog'
import { PaymentsPanel } from '@/features/rentals/components/PaymentsPanel'
import { QuoteSummary } from '@/features/rentals/components/QuoteSummary'
import {
  OverdueBadge,
  PaymentStatusBadge,
  RentalStatusBadge,
} from '@/features/rentals/components/RentalBadges'
import { SubstituteVehicleDialog } from '@/features/rentals/components/SubstituteVehicleDialog'
import {
  ACTION_LABELS,
  RENTAL_STATUS_DESCRIPTIONS,
  actionState,
  primaryAction,
  type RentalAction,
} from '@/features/rentals/lifecycle'
import { quoteFromRows } from '@/features/rentals/pricing'
import {
  useAddCharge,
  useCancelRental,
  useCompleteRental,
  useConfirmRental,
  useDeleteRental,
  useRemoveCharge,
  useRental,
  useRentalBoardEntry,
  useRentalDrivers,
  useRentalLineItems,
  useRentalUsage,
} from '@/features/rentals/queries'
import { useDistanceUnit } from '@/features/workspace/useOrganizationSettings'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatDateTime } from '@/lib/datetime/format'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * One rental contract, and everything the desk does to it.
 *
 * The actions offered are the ones the lifecycle actually allows in the current
 * state; the rest are shown disabled with the reason, rather than hidden. A
 * button that vanishes teaches nobody anything, and "why can't I complete
 * this?" is the question the desk actually has.
 */
export function RentalDetailPage() {
  const { rentalId } = useParams<{ rentalId: string }>()
  const organization = useOrganization()
  const distanceUnit = useDistanceUnit()
  const navigate = useNavigate()
  const toast = useToast()

  const canUpdate = usePermission('rentals.update')
  const canDelete = usePermission('rentals.delete')
  const canRecordPayment = usePermission('payments.create')
  const canVoidPayment = usePermission('payments.delete')
  const canManagePhotos = usePermission('rentals.update')
  const canRemovePhotos = usePermission('rentals.delete')
  const canViewExpenses = usePermission('expenses.view')
  const canRecordExpense = usePermission('expenses.create')

  const rentalQuery = useRental(rentalId)
  const boardQuery = useRentalBoardEntry(rentalId)
  const linesQuery = useRentalLineItems(rentalId)
  const driversQuery = useRentalDrivers(rentalId)
  const usageQuery = useRentalUsage(rentalId)

  const confirmRental = useConfirmRental(rentalId ?? '')
  const completeRental = useCompleteRental(rentalId ?? '')
  const cancelRental = useCancelRental(rentalId ?? '')
  const addCharge = useAddCharge(rentalId ?? '')
  const removeCharge = useRemoveCharge()
  const deleteRental = useDeleteRental()

  const [handover, setHandover] = useState<'pickup' | 'return' | null>(null)
  const [payment, setPayment] = useState<'charge' | 'deposit' | 'refund-deposit' | null>(null)
  const [isExtending, setIsExtending] = useState(false)
  const [isSubstituting, setIsSubstituting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [cancelReason, setCancelReason] = useState('')

  const rental = rentalQuery.data
  const board = boardQuery.data
  const lines = useMemo(() => linesQuery.data ?? [], [linesQuery.data])
  const drivers = driversQuery.data ?? []

  const locale = organization.locale
  const timeZone = organization.time_zone
  const when = (iso: string) => formatDateTime(new Date(iso), { locale, timeZone })

  const quote = useMemo(
    () =>
      quoteFromRows(
        lines,
        rental?.currency ?? organization.default_currency,
        rental?.tax_rate_bps ?? 0,
      ),
    [lines, rental?.currency, rental?.tax_rate_bps, organization.default_currency],
  )

  if (rentalQuery.isError) {
    return (
      <Card>
        <ErrorState error={rentalQuery.error} onRetry={() => void rentalQuery.refetch()} />
      </Card>
    )
  }

  if (!rental || !rentalId) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardBody>
        </Card>
      </div>
    )
  }

  const snapshot = {
    status: rental.status,
    hasPrimaryDriver: drivers.some((driver) => driver.driver_role === 'primary'),
    returnedAt: rental.returned_at,
    depositHeldMinor: rental.deposit_held_minor,
    balanceDueMinor: rental.balance_due_minor,
  }

  const state = (action: RentalAction) => actionState(action, snapshot)
  const next = primaryAction(snapshot)

  const runPrimary = async () => {
    try {
      if (next === 'confirm') {
        await confirmRental.mutateAsync()
        toast.success('Reservation confirmed', 'The vehicle is now held for these dates.')
      } else if (next === 'check-out') {
        setHandover('pickup')
      } else if (next === 'check-in') {
        setHandover('return')
      } else if (next === 'complete') {
        await completeRental.mutateAsync()
        toast.success('Rental completed', 'The vehicle is back in the fleet.')
      }
    } catch (error) {
      toast.error('Could not do that', toErrorMessage(error))
    }
  }

  const confirmCancel = async () => {
    try {
      await cancelRental.mutateAsync(cancelReason.trim() || null)
      toast.success('Reservation cancelled', 'The vehicle is free again, and the record is kept.')
      setIsCancelling(false)
      setCancelReason('')
    } catch (error) {
      toast.error('Could not cancel this', toErrorMessage(error))
    }
  }

  const confirmDelete = async () => {
    try {
      await deleteRental.mutateAsync(rentalId)
      toast.success('Draft removed', 'Nothing was attached to it.')
      void navigate(paths.rentals)
    } catch (error) {
      toast.error('Could not remove this draft', toErrorMessage(error))
    }
  }

  const vehicleLabel = board
    ? `${board.vehicle_make} ${board.vehicle_model} · ${board.vehicle_plate}`
    : 'this vehicle'

  const menuActions: RentalAction[] = ['extend', 'substitute-vehicle', 'cancel']

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={paths.rentals}
          className="text-ink-subtle hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem] transition-colors"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All rentals
        </Link>
      </div>

      <PageHeader
        title={rental.reference}
        eyebrow="Rental contract"
        description={RENTAL_STATUS_DESCRIPTIONS[rental.status]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canUpdate && next ? (
              <Button
                variant="primary"
                leadingIcon={<Check />}
                onClick={() => void runPrimary()}
                isLoading={confirmRental.isPending || completeRental.isPending}
              >
                {ACTION_LABELS[next]}
              </Button>
            ) : null}

            {canUpdate ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" aria-label="More actions">
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {menuActions.map((action) => {
                    const status = state(action)
                    return (
                      <DropdownMenuItem
                        key={action}
                        disabled={!status.available}
                        onSelect={() => {
                          if (action === 'extend') setIsExtending(true)
                          if (action === 'substitute-vehicle') setIsSubstituting(true)
                          if (action === 'cancel') setIsCancelling(true)
                        }}
                      >
                        {action === 'extend' ? <CalendarClock className="size-4" /> : null}
                        {action === 'substitute-vehicle' ? <Repeat className="size-4" /> : null}
                        {action === 'cancel' ? <XCircle className="size-4" /> : null}
                        {ACTION_LABELS[action]}
                      </DropdownMenuItem>
                    )
                  })}

                  {canDelete && usageQuery.data?.can_delete ? (
                    <DropdownMenuItem onSelect={() => setIsDeleting(true)}>
                      <Trash2 className="size-4" />
                      Delete draft
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <RentalStatusBadge status={rental.status} />
        <PaymentStatusBadge status={rental.payment_status} />
        <OverdueBadge isOverdue={board?.is_overdue ?? false} />
        {rental.extension_count > 0 ? (
          <span className="text-ink-subtle text-[0.75rem]">
            Extended {rental.extension_count} {rental.extension_count === 1 ? 'time' : 'times'}
          </span>
        ) : null}
      </div>

      {next && !state(next).available ? (
        <Alert tone="caution" title={`Cannot ${ACTION_LABELS[next].toLowerCase()} yet`}>
          {state(next).reason}
        </Alert>
      ) : null}

      {rental.status === 'cancelled' && rental.cancellation_reason ? (
        <Alert tone="info" title="Cancelled">
          {rental.cancellation_reason}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="The hire" />
            <CardBody>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <Detail label="Collection">{when(rental.starts_at)}</Detail>
                <Detail label="Return">
                  {when(rental.ends_at)}
                  {rental.original_ends_at && rental.original_ends_at !== rental.ends_at ? (
                    <span className="text-ink-subtle block text-[0.75rem]">
                      Originally {when(rental.original_ends_at)}
                    </span>
                  ) : null}
                </Detail>
                <Detail label="Collected from">{rental.pickup_location ?? '—'}</Detail>
                <Detail label="Returned to">{rental.return_location ?? '—'}</Detail>
                <Detail label="Days charged">{rental.billable_days ?? '—'}</Detail>
                <Detail label="Vehicle">
                  {board ? (
                    <Link to={vehicleDetailPath(board.vehicle_id)} className="hover:underline">
                      {vehicleLabel}
                    </Link>
                  ) : (
                    '—'
                  )}
                </Detail>
              </dl>

              {rental.notes ? (
                <div className="border-line mt-4 border-t pt-3">
                  <p className="text-ink-subtle text-[0.75rem]">Notes</p>
                  <p className="text-ink mt-1 text-[0.8125rem] whitespace-pre-wrap">
                    {rental.notes}
                  </p>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="People"
              description="The renter signs and pays. The drivers are who may take the keys."
            />
            <CardBody className="space-y-3">
              {board ? (
                <Person
                  name={board.customer_name}
                  role="Renter"
                  to={customerDetailPath(board.customer_id)}
                />
              ) : null}

              {drivers.map((driver) => (
                <Person
                  key={driver.id}
                  name={driver.customer?.display_name ?? 'Unknown'}
                  role={driver.driver_role === 'primary' ? 'Primary driver' : 'Additional driver'}
                  to={customerDetailPath(driver.customer_id)}
                  detail={
                    driver.license_number
                      ? `Licence ${driver.license_number}${driver.license_expires_on ? `, expires ${driver.license_expires_on}` : ''}`
                      : null
                  }
                />
              ))}

              {drivers.length === 0 ? (
                <Alert tone="caution" title="Nobody is named as the driver">
                  A reservation cannot be confirmed until a primary driver is on the contract.
                </Alert>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Charges"
              description="What the contract totals to. Every figure comes from these lines."
            />
            <CardBody className="space-y-4">
              <QuoteSummary
                quote={quote}
                locale={locale}
                depositMinor={rental.deposit_minor}
                taxLabel={rental.tax_label}
                {...(canUpdate && rental.status !== 'completed' && rental.status !== 'cancelled'
                  ? {
                      onRemoveLine: (index: number) => {
                        const line = lines[index]
                        if (line) void removeCharge.mutateAsync(line.id)
                      },
                    }
                  : {})}
              />

              {canUpdate && rental.status !== 'completed' && rental.status !== 'cancelled' ? (
                <AddChargeForm
                  currency={rental.currency}
                  isPending={addCharge.isPending}
                  onAdd={(line) =>
                    void addCharge.mutateAsync({
                      kind: line.kind,
                      description: line.description,
                      quantity: line.quantity,
                      unitAmountMinor: line.unitAmountMinor,
                      amountMinor: line.amountMinor,
                      isTaxable: line.isTaxable,
                      sortOrder: lines.length,
                    })
                  }
                />
              ) : null}
            </CardBody>
          </Card>

          <PaymentsPanel
            rentalId={rentalId}
            currency={rental.currency}
            locale={locale}
            timeZone={timeZone}
            canRecord={canRecordPayment && rental.status !== 'cancelled'}
            canVoid={canVoidPayment}
            onRecordCharge={() => setPayment('charge')}
            onTakeDeposit={() => setPayment('deposit')}
            onRefundDeposit={() => setPayment('refund-deposit')}
            depositHeldMinor={rental.deposit_held_minor}
            depositAgreedMinor={rental.deposit_minor}
            balanceDueMinor={rental.balance_due_minor}
          />

          {/* Below payments, because what the customer owes is settled before
              what the hire cost the agency is even relevant. */}
          {canViewExpenses ? (
            <RentalCostPanel
              rentalId={rentalId}
              locale={locale}
              canRecord={canRecordExpense && rental.status !== 'cancelled'}
            />
          ) : null}

          <ConditionPhotos
            rentalId={rentalId}
            canUpload={canManagePhotos}
            canDelete={canRemovePhotos}
            locale={locale}
            timeZone={timeZone}
          />
        </div>

        <aside className="space-y-6">
          <Card>
            <CardHeader title="Hand-over" />
            <CardBody>
              <dl className="space-y-3">
                <Detail label="Collected">
                  {rental.picked_up_at ? when(rental.picked_up_at) : 'Not yet'}
                </Detail>
                <Detail label="Odometer out">
                  {rental.pickup_odometer === null
                    ? '—'
                    : `${rental.pickup_odometer.toLocaleString(locale)} ${distanceUnit}`}
                </Detail>
                <Detail label="Fuel out">
                  {rental.pickup_fuel_percent === null ? '—' : `${rental.pickup_fuel_percent}%`}
                </Detail>
                {rental.pickup_condition_notes ? (
                  <Detail label="Condition out">{rental.pickup_condition_notes}</Detail>
                ) : null}

                <Detail label="Returned">
                  {rental.returned_at ? when(rental.returned_at) : 'Not yet'}
                </Detail>
                <Detail label="Odometer in">
                  {rental.return_odometer === null
                    ? '—'
                    : `${rental.return_odometer.toLocaleString(locale)} ${distanceUnit}`}
                </Detail>
                <Detail label="Fuel in">
                  {rental.return_fuel_percent === null ? '—' : `${rental.return_fuel_percent}%`}
                </Detail>
                {rental.return_condition_notes ? (
                  <Detail label="Condition in">{rental.return_condition_notes}</Detail>
                ) : null}

                {rental.pickup_odometer !== null && rental.return_odometer !== null ? (
                  <Detail label="Distance covered">
                    {(rental.return_odometer - rental.pickup_odometer).toLocaleString(locale)}{' '}
                    {distanceUnit}
                  </Detail>
                ) : null}
              </dl>

              {canUpdate && (state('check-out').available || state('check-in').available) ? (
                <Button
                  variant="secondary"
                  className="mt-4 w-full"
                  onClick={() => setHandover(state('check-out').available ? 'pickup' : 'return')}
                >
                  {state('check-out').available ? 'Check out' : 'Record return'}
                </Button>
              ) : null}
            </CardBody>
          </Card>

          <ContractPanel
            rentalId={rentalId}
            organizationId={organization.id}
            canIssue={canUpdate && state('issue-contract').available}
            canIssueReason={state('issue-contract').reason}
            locale={locale}
            timeZone={timeZone}
          />
        </aside>
      </div>

      {handover ? (
        <HandoverDialog
          open
          onOpenChange={(open) => (open ? undefined : setHandover(null))}
          rentalId={rentalId}
          phase={handover}
          timeZone={timeZone}
          distanceUnit={distanceUnit}
          currentOdometer={handover === 'pickup' ? null : rental.pickup_odometer}
        />
      ) : null}

      {payment ? (
        <PaymentDialog
          open
          onOpenChange={(open) => (open ? undefined : setPayment(null))}
          rentalId={rentalId}
          currency={rental.currency}
          locale={locale}
          timeZone={timeZone}
          balanceDueMinor={rental.balance_due_minor}
          depositHeldMinor={rental.deposit_held_minor}
          depositAgreedMinor={rental.deposit_minor}
          intent={payment}
        />
      ) : null}

      {isExtending ? (
        <ExtendDialog
          open
          onOpenChange={setIsExtending}
          rentalId={rentalId}
          vehicleId={rental.vehicle_id}
          currentEndsAt={rental.ends_at}
          startsAt={rental.starts_at}
          dailyRateMinor={rental.daily_rate_minor}
          currency={rental.currency}
          locale={locale}
          timeZone={timeZone}
        />
      ) : null}

      {isSubstituting ? (
        <SubstituteVehicleDialog
          open
          onOpenChange={setIsSubstituting}
          rentalId={rentalId}
          currentVehicleLabel={vehicleLabel}
          startsAt={rental.starts_at}
          endsAt={rental.ends_at}
          locale={locale}
        />
      ) : null}

      <ConfirmDialog
        open={isCancelling}
        onOpenChange={(open) => {
          setIsCancelling(open)
          if (!open) setCancelReason('')
        }}
        title="Cancel this reservation"
        description="The vehicle is released for these dates. The contract, its charges and any money already taken stay on the record."
        confirmLabel="Cancel reservation"
        isPending={cancelRental.isPending}
        onConfirm={() => void confirmCancel()}
      >
        <Field label="Why" hint="Kept with the contract so the history explains itself.">
          <Input
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            maxLength={500}
            placeholder="Customer's flight was cancelled"
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={isDeleting}
        onOpenChange={setIsDeleting}
        title="Delete this draft"
        description="Nothing has been issued or paid against it, so there is no history to keep. This cannot be undone."
        confirmLabel="Delete draft"
        isPending={deleteRental.isPending}
        onConfirm={() => void confirmDelete()}
      />
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

function Person({
  name,
  role,
  to,
  detail,
}: {
  name: string
  role: string
  to: string
  detail?: string | null
}) {
  return (
    <div className="border-line flex items-center gap-3 rounded-md border px-3 py-2.5">
      <UserRound className="text-ink-subtle size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <Link
          to={to}
          className="text-ink block truncate text-[0.8125rem] font-medium hover:underline"
        >
          {name}
        </Link>
        <p className="text-ink-subtle truncate text-[0.75rem]">
          {role}
          {detail ? ` · ${detail}` : ''}
        </p>
      </div>
    </div>
  )
}
