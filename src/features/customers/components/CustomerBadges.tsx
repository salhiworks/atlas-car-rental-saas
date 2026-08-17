import { Badge, type BadgeTone } from '@/components/ui'
import {
  COMPLIANCE_LABELS,
  type ComplianceOptions,
  type ComplianceState,
  evaluateCompliance,
} from '@/lib/compliance/expiry'
import type { CustomerDirectoryEntry } from '@/types/database'

import { DRIVER_ELIGIBILITY_LABELS, type DriverEligibility, driverEligibility } from '../identity'

/**
 * Status presentation for customers.
 *
 * Expiry states come from the shared compliance rule that Vehicles uses, so a
 * licence "expiring soon" here means exactly what an insurance certificate
 * "expiring soon" means there — same window, same agency time zone, one
 * implementation.
 */

const ELIGIBILITY_TONE: Record<DriverEligibility, BadgeTone> = {
  eligible: 'positive',
  expired: 'critical',
  'no-licence': 'neutral',
  'expiry-unknown': 'caution',
}

export function resolveDriverEligibility(
  customer: Pick<CustomerDirectoryEntry, 'has_driver_license' | 'driver_license_expires_on'>,
  compliance: ComplianceOptions,
): { eligibility: DriverEligibility; expiry: ComplianceState } {
  const expiry = evaluateCompliance(customer.driver_license_expires_on, compliance).state

  return {
    eligibility: driverEligibility(
      {
        hasLicence: customer.has_driver_license,
        expiresOn: customer.driver_license_expires_on,
      },
      expiry,
    ),
    expiry,
  }
}

export function DriverLicenceBadge({
  customer,
  compliance,
  className,
}: {
  customer: Pick<CustomerDirectoryEntry, 'has_driver_license' | 'driver_license_expires_on'>
  compliance: ComplianceOptions
  className?: string
}) {
  const { eligibility, expiry } = resolveDriverEligibility(customer, compliance)

  // A licence that is valid but close to expiry is worth flagging before the
  // customer arrives to collect a car, not after.
  if (eligibility === 'eligible' && expiry === 'due-soon') {
    return (
      <Badge tone="caution" className={className}>
        Licence expiring soon
      </Badge>
    )
  }

  return (
    <Badge tone={ELIGIBILITY_TONE[eligibility]} className={className}>
      {DRIVER_ELIGIBILITY_LABELS[eligibility]}
    </Badge>
  )
}

const COMPLIANCE_TONE: Record<ComplianceState, BadgeTone> = {
  valid: 'positive',
  'due-soon': 'caution',
  expired: 'critical',
  unrecorded: 'neutral',
}

export function DocumentStateBadge({
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

export function ArchivedBadge({ className }: { className?: string }) {
  return (
    <Badge tone="neutral" className={className}>
      Archived
    </Badge>
  )
}
