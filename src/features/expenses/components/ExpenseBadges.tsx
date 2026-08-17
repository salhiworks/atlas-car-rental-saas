import { Building2, CarFront, FileSignature, Paperclip } from 'lucide-react'
import { Link } from 'react-router-dom'

import { rentalDetailPath, vehicleDetailPath } from '@/app/routes/paths'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { ExpenseLedgerEntry, ExpenseStatus } from '@/types/database'

/**
 * The small pieces that say what a cost is.
 *
 * Allocation is shown as an icon plus the thing it points at, never as a
 * coloured pill: "which car" is a fact the desk needs to read, not a category
 * to recognise by hue.
 */

export function ExpenseStatusBadge({ status }: { status: ExpenseStatus }) {
  if (status === 'recorded') return null
  // Only the exception is marked. A badge on every recorded row would be noise
  // on ninety-nine rows to flag the one that matters.
  return <Badge tone="critical">Voided</Badge>
}

export interface AllocationCellProps {
  expense: Pick<
    ExpenseLedgerEntry,
    | 'allocation'
    | 'effective_vehicle_id'
    | 'vehicle_plate'
    | 'vehicle_make'
    | 'vehicle_model'
    | 'vehicle_archived'
    | 'rental_id'
    | 'rental_reference'
  >
  /** Suppresses the link where the row is already inside that record's page. */
  linked?: boolean
  className?: string
}

export function AllocationCell({ expense, linked = true, className }: AllocationCellProps) {
  if (expense.allocation === 'overhead') {
    return (
      <span className={cn('text-ink-muted flex items-center gap-1.5 text-[0.8125rem]', className)}>
        <Building2 className="text-ink-subtle size-3.5 shrink-0" aria-hidden="true" />
        Agency overhead
      </span>
    )
  }

  if (expense.allocation === 'rental') {
    return (
      <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
        <FileSignature className="text-ink-subtle size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          {linked && expense.rental_id ? (
            <Link
              to={rentalDetailPath(expense.rental_id)}
              className="identifier text-ink block truncate text-[0.75rem] hover:underline"
            >
              {expense.rental_reference}
            </Link>
          ) : (
            <span className="identifier text-ink block truncate text-[0.75rem]">
              {expense.rental_reference}
            </span>
          )}
          {expense.vehicle_plate ? (
            <span className="text-ink-subtle block truncate text-[0.6875rem]">
              {expense.vehicle_plate}
            </span>
          ) : null}
        </span>
      </span>
    )
  }

  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <CarFront className="text-ink-subtle size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {linked && expense.effective_vehicle_id ? (
          <Link
            to={vehicleDetailPath(expense.effective_vehicle_id)}
            className="text-ink block truncate text-[0.8125rem] hover:underline"
          >
            {expense.vehicle_make} {expense.vehicle_model}
          </Link>
        ) : (
          <span className="text-ink block truncate text-[0.8125rem]">
            {expense.vehicle_make} {expense.vehicle_model}
          </span>
        )}
        <span className="identifier text-ink-subtle block truncate text-[0.6875rem]">
          {expense.vehicle_plate}
          {expense.vehicle_archived ? ' · retired' : ''}
        </span>
      </span>
    </span>
  )
}

export function AttachmentIndicator({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span
      className="text-ink-subtle inline-flex items-center gap-0.5 text-[0.6875rem]"
      title={`${count} ${count === 1 ? 'document' : 'documents'} attached`}
    >
      <Paperclip className="size-3" aria-hidden="true" />
      {count > 1 ? count : null}
      <span className="sr-only">
        {count} {count === 1 ? 'document' : 'documents'} attached
      </span>
    </span>
  )
}
