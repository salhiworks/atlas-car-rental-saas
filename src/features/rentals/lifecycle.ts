import type { Permission } from '@/lib/authz/permissions'
import type { RentalStatus } from '@/types/database'

/**
 * The rental lifecycle, as the interface understands it.
 *
 * This is a mirror of the trigger in the database, not a substitute for it.
 * `app.guard_rental_status_transition()` is what actually refuses an illegal
 * change; this exists so the screen never offers an action that would be
 * refused, and so the reason is written in the agency's language rather than in
 * an error code.
 *
 *   draft     → reserved | cancelled
 *   reserved  → active   | cancelled
 *   active    → completed
 *   completed → (terminal)
 *   cancelled → (terminal)
 *
 * There is deliberately no way back. Handing a car over cannot un-happen, so an
 * active rental is returned and completed rather than cancelled.
 */

export const RENTAL_STATUS_ORDER: readonly RentalStatus[] = [
  'draft',
  'reserved',
  'active',
  'completed',
  'cancelled',
]

export const RENTAL_STATUS_LABELS: Readonly<Record<RentalStatus, string>> = {
  draft: 'Draft',
  reserved: 'Reserved',
  active: 'Out',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export const RENTAL_STATUS_DESCRIPTIONS: Readonly<Record<RentalStatus, string>> = {
  draft: 'Being put together. The vehicle is not held for these dates yet.',
  reserved: 'Confirmed. The vehicle is held and cannot be booked by anyone else.',
  active: 'The vehicle is with the customer.',
  completed: 'Returned and closed.',
  cancelled: 'Called off before the vehicle was collected.',
}

const TRANSITIONS: Readonly<Record<RentalStatus, readonly RentalStatus[]>> = {
  draft: ['reserved', 'cancelled'],
  reserved: ['active', 'cancelled'],
  active: ['completed'],
  completed: [],
  cancelled: [],
}

export function canTransition(from: RentalStatus, to: RentalStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function isTerminal(status: RentalStatus): boolean {
  return TRANSITIONS[status].length === 0
}

/** A rental still holding the vehicle against other bookings. */
export function holdsVehicle(status: RentalStatus): boolean {
  return status === 'reserved' || status === 'active'
}

// -----------------------------------------------------------------------------
// What the desk can do right now
// -----------------------------------------------------------------------------

export type RentalAction =
  | 'confirm'
  | 'check-out'
  | 'check-in'
  | 'complete'
  | 'cancel'
  | 'extend'
  | 'substitute-vehicle'
  | 'record-payment'
  | 'refund-deposit'
  | 'issue-contract'
  | 'edit'

export interface RentalActionState {
  readonly available: boolean
  /** Why not, in the agency's words. Empty when the action is available. */
  readonly reason: string
}

export interface RentalSnapshot {
  readonly status: RentalStatus
  readonly hasPrimaryDriver: boolean
  readonly returnedAt: string | null
  readonly depositHeldMinor: number
  readonly balanceDueMinor: number
}

export const ACTION_PERMISSIONS: Readonly<Record<RentalAction, Permission>> = {
  confirm: 'rentals.update',
  'check-out': 'rentals.update',
  'check-in': 'rentals.update',
  complete: 'rentals.update',
  cancel: 'rentals.update',
  extend: 'rentals.update',
  'substitute-vehicle': 'rentals.update',
  'record-payment': 'payments.create',
  'refund-deposit': 'payments.create',
  'issue-contract': 'rentals.update',
  edit: 'rentals.update',
}

/**
 * Whether an action applies to a rental in its current state, and why not.
 *
 * Permission is a separate question, answered by `can()` with
 * ACTION_PERMISSIONS — a manager and a member of staff see the same lifecycle,
 * they just differ on what they may do with it.
 */
export function actionState(action: RentalAction, rental: RentalSnapshot): RentalActionState {
  const ok: RentalActionState = { available: true, reason: '' }
  const no = (reason: string): RentalActionState => ({ available: false, reason })

  switch (action) {
    case 'confirm':
      if (rental.status !== 'draft') return no('Only a draft can be confirmed.')
      if (!rental.hasPrimaryDriver) return no('Name the primary driver first.')
      return ok

    case 'check-out':
      if (rental.status !== 'reserved') return no('Confirm the reservation first.')
      return ok

    case 'check-in':
      if (rental.status !== 'active') return no('The vehicle is not out with a customer.')
      if (rental.returnedAt !== null) return no('The return has already been recorded.')
      return ok

    case 'complete':
      if (rental.status !== 'active') return no('Only a rental that is out can be completed.')
      if (rental.returnedAt === null) return no('Record the return first.')
      if (rental.depositHeldMinor > 0) return no('Refund or retain the deposit first.')
      return ok

    case 'cancel':
      if (rental.status === 'active') {
        return no('The vehicle is with the customer. Record the return instead.')
      }
      if (rental.status === 'completed') return no('This rental is closed.')
      if (rental.status === 'cancelled') return no('Already cancelled.')
      return ok

    case 'extend':
      if (!holdsVehicle(rental.status)) return no('Only a live rental can be extended.')
      return ok

    case 'substitute-vehicle':
      if (rental.status !== 'draft' && rental.status !== 'reserved') {
        return no('The vehicle can only be changed before the customer collects it.')
      }
      return ok

    case 'record-payment':
      if (rental.status === 'cancelled') return no('This reservation was cancelled.')
      return ok

    case 'refund-deposit':
      if (rental.depositHeldMinor <= 0) return no('No deposit is being held.')
      return ok

    case 'issue-contract':
      if (rental.status === 'draft') return no('Confirm the reservation first.')
      if (rental.status === 'cancelled') return no('A cancelled reservation has no contract.')
      return ok

    case 'edit':
      if (rental.status === 'completed' || rental.status === 'cancelled') {
        return no('A closed rental cannot be edited.')
      }
      return ok
  }
}

/** The single action the desk is most likely to want next. */
export function primaryAction(rental: RentalSnapshot): RentalAction | null {
  const order: RentalAction[] = ['confirm', 'check-out', 'check-in', 'complete']
  for (const action of order) {
    if (actionState(action, rental).available) return action
  }
  return null
}

export const ACTION_LABELS: Readonly<Record<RentalAction, string>> = {
  confirm: 'Confirm reservation',
  'check-out': 'Check out',
  'check-in': 'Record return',
  complete: 'Complete rental',
  cancel: 'Cancel',
  extend: 'Extend',
  'substitute-vehicle': 'Change vehicle',
  'record-payment': 'Record payment',
  'refund-deposit': 'Refund deposit',
  'issue-contract': 'Issue contract',
  edit: 'Edit',
}
