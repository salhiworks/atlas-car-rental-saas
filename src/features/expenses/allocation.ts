import type { ExpenseAllocation, ExpenseLedgerEntry, ExpenseStatus } from '@/types/database'

/**
 * Who owns a cost, and what follows from that.
 *
 * The three cases are mutually exclusive and the database enforces it, so this
 * module never has to guess: it exists so the interface offers exactly the
 * fields the chosen allocation needs, and so a total can be split without
 * re-deriving what "belongs to a vehicle" means in three different places.
 */

export const EXPENSE_ALLOCATIONS: readonly ExpenseAllocation[] = ['overhead', 'vehicle', 'rental']

export const ALLOCATION_LABELS: Readonly<Record<ExpenseAllocation, string>> = {
  overhead: 'Agency overhead',
  vehicle: 'A vehicle',
  rental: 'A rental',
}

export const ALLOCATION_HINTS: Readonly<Record<ExpenseAllocation, string>> = {
  overhead: 'Rent, software, marketing — no single car or hire owns it.',
  vehicle: 'Tyres, a service, this car’s insurance.',
  rental: 'A delivery, a toll, cleaning that one hire caused.',
}

/** Which extra field the form has to ask for. */
export function requiredRelation(allocation: ExpenseAllocation): 'vehicle' | 'rental' | null {
  if (allocation === 'vehicle') return 'vehicle'
  if (allocation === 'rental') return 'rental'
  return null
}

/**
 * Whether the fields a person has filled in can actually be saved.
 *
 * A mirror of `expenses_allocation_consistent`. The constraint is the
 * authority; this exists so the form can say what is missing before a save is
 * refused, and so the two can be asserted equal in the test suite.
 */
export function allocationIsComplete(
  allocation: ExpenseAllocation,
  relation: { vehicleId: string | null; rentalId: string | null },
): boolean {
  switch (allocation) {
    case 'overhead':
      return relation.vehicleId === null && relation.rentalId === null
    case 'vehicle':
      return relation.vehicleId !== null && relation.rentalId === null
    case 'rental':
      // No vehicle of its own: the car is whichever one the contract is for.
      return relation.rentalId !== null && relation.vehicleId === null
  }
}

/** The columns to write, with the ones the allocation forbids cleared out. */
export function relationColumns(
  allocation: ExpenseAllocation,
  relation: { vehicleId: string | null; rentalId: string | null },
): { vehicle_id: string | null; rental_id: string | null } {
  switch (allocation) {
    case 'overhead':
      return { vehicle_id: null, rental_id: null }
    case 'vehicle':
      return { vehicle_id: relation.vehicleId, rental_id: null }
    case 'rental':
      return { vehicle_id: null, rental_id: relation.rentalId }
  }
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export const STATUS_LABELS: Readonly<Record<ExpenseStatus, string>> = {
  recorded: 'Recorded',
  voided: 'Voided',
}

/** A voided cost counts towards nothing, anywhere. */
export function countsTowardsTotals(status: ExpenseStatus): boolean {
  return status === 'recorded'
}

/**
 * What may still be changed after a cost has been recorded.
 *
 * A voided cost is frozen — it is the record of a correction, and rewriting it
 * would destroy the thing it exists to preserve. A cost that came from the
 * Financing module is owned by that module rather than by the desk.
 */
export function canEdit(expense: Pick<ExpenseLedgerEntry, 'status' | 'source'>): boolean {
  return expense.status === 'recorded' && expense.source !== 'financing'
}

export function canVoid(expense: Pick<ExpenseLedgerEntry, 'status' | 'source'>): boolean {
  return expense.status === 'recorded' && expense.source !== 'financing'
}

/**
 * Why an action is unavailable, in the agency's words.
 *
 * Disabled with a reason rather than hidden: "why can't I edit this?" is the
 * question a desk actually has, and a button that vanishes answers nothing.
 */
export function editBlockedReason(
  expense: Pick<ExpenseLedgerEntry, 'status' | 'source'>,
): string | null {
  if (expense.status === 'voided') return 'A voided cost is kept exactly as it was.'
  if (expense.source === 'financing') {
    return 'This cost comes from a financing agreement and is managed there.'
  }
  return null
}
