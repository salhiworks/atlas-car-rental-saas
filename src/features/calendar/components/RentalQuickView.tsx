import { ArrowRight, CalendarClock, ExternalLink, Move, TriangleAlert } from 'lucide-react'

import { rentalDetailPath } from '@/app/routes/paths'
import { Alert, Badge, Button, ButtonLink, Dialog, DialogContent } from '@/components/ui'
import {
  OverdueBadge,
  PaymentStatusBadge,
  RentalStatusBadge,
} from '@/features/rentals/components/RentalBadges'
import { ACTION_LABELS, actionState, primaryAction } from '@/features/rentals/lifecycle'
import { formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import type { RentalScheduleEntry } from '@/types/database'

import { formatGap, turnaroundPressure } from '../schedule'

export interface RentalQuickViewProps {
  rental: RentalScheduleEntry
  open: boolean
  onOpenChange: (open: boolean) => void
  locale: string
  timeZone: string
  canReschedule: boolean
  onReschedule: (rental: RentalScheduleEntry) => void
}

/**
 * A booking, read at the counter without leaving the board.
 *
 * Deliberately not a second Rental detail page: it answers the questions asked
 * while looking at a schedule — who, which car, when, what is owed, what
 * happens next — and hands over to the real page for everything else.
 *
 * No identity document numbers appear here. A schedule is looked at across an
 * open counter, and a passport number does not belong on a screen the queue can
 * see.
 */
export function RentalQuickView({
  rental,
  open,
  onOpenChange,
  locale,
  timeZone,
  canReschedule,
  onReschedule,
}: RentalQuickViewProps) {
  const when = (iso: string) => formatDateTime(new Date(iso), { locale, timeZone })

  // The lifecycle module decides what is possible; the Calendar only names it.
  // Anything it cannot safely start here is stated as the next step and left to
  // the rental page, which has the dialogs that do it properly.
  const snapshot = {
    status: rental.status,
    hasPrimaryDriver: rental.primary_driver_id !== null,
    returnedAt: rental.returned_at,
    depositHeldMinor: rental.deposit_held_minor,
    balanceDueMinor: rental.balance_due_minor,
  }
  const next = primaryAction(snapshot)
  const canMove =
    canReschedule &&
    actionState('edit', snapshot).available &&
    (rental.status === 'draft' || rental.status === 'reserved')

  const pressure = turnaroundPressure(rental.turnaround_minutes, rental.is_overdue)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={rental.reference}
        description={`${rental.vehicle_make} ${rental.vehicle_model} · ${rental.vehicle_plate}`}
        size="md"
        footer={
          <>
            {canMove ? (
              <Button
                variant="ghost"
                leadingIcon={<Move />}
                onClick={() => {
                  onOpenChange(false)
                  onReschedule(rental)
                }}
              >
                Move
              </Button>
            ) : null}
            <ButtonLink
              variant="primary"
              trailingIcon={<ExternalLink />}
              to={rentalDetailPath(rental.id)}
            >
              {next ? ACTION_LABELS[next] : 'Open rental'}
            </ButtonLink>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <RentalStatusBadge status={rental.status} />
            <OverdueBadge isOverdue={rental.is_overdue} />
            <PaymentStatusBadge status={rental.payment_status} />
            {rental.has_live_contract ? (
              <Badge tone="neutral">Contract v{rental.contract_version}</Badge>
            ) : null}
            {rental.extension_count > 0 ? (
              <Badge tone="neutral">Extended {rental.extension_count}×</Badge>
            ) : null}
          </div>

          {rental.is_overdue ? (
            <Alert tone="critical" title="Past its return time">
              Due back {when(rental.ends_at)} and not yet returned.
            </Alert>
          ) : null}

          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Detail label="Renter">{rental.customer_name}</Detail>
            <Detail label="Primary driver">
              {rental.primary_driver_name ?? 'Not named'}
              {rental.renter_is_not_driver ? (
                <span className="text-ink-subtle"> · not the renter</span>
              ) : null}
            </Detail>
            <Detail label="Collection">
              {when(rental.starts_at)}
              {rental.picked_up_at ? (
                <span className="text-ink-subtle block text-[0.75rem]">
                  Handed over {when(rental.picked_up_at)}
                </span>
              ) : null}
            </Detail>
            <Detail label="Return">
              {when(rental.ends_at)}
              {rental.returned_at ? (
                <span className="text-ink-subtle block text-[0.75rem]">
                  Returned {when(rental.returned_at)}
                </span>
              ) : null}
              {rental.original_ends_at && rental.original_ends_at !== rental.ends_at ? (
                <span className="text-ink-subtle block text-[0.75rem]">
                  Originally {when(rental.original_ends_at)}
                </span>
              ) : null}
            </Detail>
            <Detail label="From">{rental.pickup_location ?? '—'}</Detail>
            <Detail label="To">{rental.return_location ?? rental.pickup_location ?? '—'}</Detail>
            <Detail label="Still owed">
              {formatMoney(Math.max(rental.balance_due_minor, 0), rental.currency, { locale })}
            </Detail>
            <Detail label="Deposit held">
              {formatMoney(rental.deposit_held_minor, rental.currency, { locale })}
            </Detail>
          </dl>

          {/* The single most useful thing a board can say: what is waiting for
              this car, and how much room there is before it. */}
          {rental.next_rental_id && rental.next_rental_starts_at ? (
            <div
              className={
                pressure === 'collision' || pressure === 'tight'
                  ? 'border-caution-200 bg-caution-50 flex items-start gap-2 rounded-md border p-3'
                  : 'border-line bg-surface-muted flex items-start gap-2 rounded-md border p-3'
              }
            >
              {pressure === 'collision' || pressure === 'tight' ? (
                <TriangleAlert
                  className="text-caution-600 mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <CalendarClock
                  className="text-ink-subtle mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
              )}
              <p className="text-[0.75rem] leading-5">
                <span className="text-ink font-medium">Next on this vehicle</span>
                <span className="text-ink-muted">
                  {' '}
                  · {rental.next_rental_reference} from {when(rental.next_rental_starts_at)}
                </span>
                {rental.turnaround_minutes !== null ? (
                  <span className="text-ink-muted">
                    {' '}
                    <ArrowRight className="inline size-3 align-[-1px]" aria-hidden="true" />{' '}
                    {pressure === 'collision'
                      ? 'the next hire has already started'
                      : `${formatGap(rental.turnaround_minutes)} to turn it around`}
                  </span>
                ) : null}
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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
