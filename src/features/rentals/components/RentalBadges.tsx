import { Badge, type BadgeTone } from '@/components/ui'
import type { ContractStatus, RentalPaymentStatus, RentalStatus } from '@/types/database'

import { RENTAL_STATUS_LABELS } from '../lifecycle'

/**
 * The badges that say where a rental stands.
 *
 * Three separate questions — where it is in its life, whether it has been paid
 * for, and whether it is late — get three separate badges rather than one
 * combined status. A rental that is out and overdue and unpaid is three facts,
 * and collapsing them loses whichever the desk needed.
 */

const STATUS_TONES: Record<RentalStatus, BadgeTone> = {
  draft: 'neutral',
  reserved: 'info',
  active: 'brand',
  completed: 'positive',
  cancelled: 'neutral',
}

export function RentalStatusBadge({ status }: { status: RentalStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} withDot>
      {RENTAL_STATUS_LABELS[status]}
    </Badge>
  )
}

const PAYMENT_TONES: Record<RentalPaymentStatus, BadgeTone> = {
  unpaid: 'caution',
  partially_paid: 'caution',
  paid: 'positive',
  overpaid: 'info',
}

const PAYMENT_LABELS: Record<RentalPaymentStatus, string> = {
  unpaid: 'Unpaid',
  partially_paid: 'Part paid',
  paid: 'Paid',
  overpaid: 'Overpaid',
}

export function PaymentStatusBadge({
  status,
  hideWhenPaid = false,
}: {
  status: RentalPaymentStatus
  hideWhenPaid?: boolean
}) {
  if (hideWhenPaid && status === 'paid') return null
  return <Badge tone={PAYMENT_TONES[status]}>{PAYMENT_LABELS[status]}</Badge>
}

export function OverdueBadge({ isOverdue }: { isOverdue: boolean }) {
  if (!isOverdue) return null
  return <Badge tone="critical">Overdue</Badge>
}

const CONTRACT_TONES: Record<ContractStatus, BadgeTone> = {
  issued: 'info',
  signed: 'positive',
  superseded: 'neutral',
  voided: 'neutral',
}

const CONTRACT_LABELS: Record<ContractStatus, string> = {
  issued: 'Issued',
  signed: 'Signed',
  superseded: 'Superseded',
  voided: 'Voided',
}

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  return <Badge tone={CONTRACT_TONES[status]}>{CONTRACT_LABELS[status]}</Badge>
}
