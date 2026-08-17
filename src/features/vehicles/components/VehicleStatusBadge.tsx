import { Badge, type BadgeTone } from '@/components/ui'
import type { ComplianceState } from '@/lib/compliance/expiry'
import { COMPLIANCE_LABELS } from '@/lib/compliance/expiry'
import type { VehicleStatus } from '@/types/database'

/**
 * The single definition of how a vehicle state looks.
 *
 * Every list row, detail header and dashboard tile reads from here, so a car
 * that is "In maintenance" is the same colour and the same word everywhere.
 */
const VEHICLE_STATUS: Record<VehicleStatus, { label: string; tone: BadgeTone; hint: string }> = {
  available: {
    label: 'Available',
    tone: 'positive',
    hint: 'On the lot and ready to hire out.',
  },
  rented: {
    label: 'Rented',
    tone: 'info',
    hint: 'Currently out with a customer.',
  },
  reserved: {
    label: 'Reserved',
    tone: 'caution',
    hint: 'Committed to a booking that has started.',
  },
  maintenance: {
    label: 'In maintenance',
    tone: 'critical',
    hint: 'Being serviced or repaired; not bookable.',
  },
  unavailable: {
    label: 'Off the road',
    tone: 'neutral',
    hint: 'Withdrawn from service; not bookable.',
  },
}

export function vehicleStatusLabel(status: VehicleStatus): string {
  return VEHICLE_STATUS[status].label
}

export function vehicleStatusHint(status: VehicleStatus): string {
  return VEHICLE_STATUS[status].hint
}

export function VehicleStatusBadge({
  status,
  className,
}: {
  status: VehicleStatus
  className?: string
}) {
  const { label, tone } = VEHICLE_STATUS[status]
  return (
    <Badge tone={tone} withDot className={className}>
      {label}
    </Badge>
  )
}

const COMPLIANCE_TONE: Record<ComplianceState, BadgeTone> = {
  valid: 'positive',
  'due-soon': 'caution',
  expired: 'critical',
  unrecorded: 'neutral',
}

export function complianceTone(state: ComplianceState): BadgeTone {
  return COMPLIANCE_TONE[state]
}

export function ComplianceBadge({
  state,
  label,
  className,
}: {
  state: ComplianceState
  label?: string
  className?: string
}) {
  return (
    <Badge tone={COMPLIANCE_TONE[state]} className={className}>
      {label ?? COMPLIANCE_LABELS[state]}
    </Badge>
  )
}
