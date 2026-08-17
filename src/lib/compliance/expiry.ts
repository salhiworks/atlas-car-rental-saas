/**
 * The one rule for "is this document still valid?".
 *
 * Insurance, technical inspection, road tax, driving licences and service
 * intervals all ask the same question, and the Overview, Notifications, Reports
 * and reminder emails will all ask it again later. Every one of those must get
 * the same answer for the same date, so the calculation lives here and nowhere
 * else.
 *
 * Two things it gets right that an inline `new Date(x) < new Date()` does not:
 *
 *   - Expiry is a *calendar* question. A certificate valid "until 14 March" is
 *     valid for the whole of the agency's 14 March, wherever the browser is.
 *     Comparisons are made between whole days in the agency's own time zone.
 *   - "Expiring soon" is an agency setting, not a constant. The window comes
 *     from `organization_settings.compliance_reminder_lead_days`.
 *
 * The product is country-neutral: nothing here knows what a document means or
 * which jurisdiction requires it. It knows only that a date was recorded, or
 * was not.
 */

import { countDaysInTimeZone, toIsoDateInTimeZone } from '@/lib/datetime/timezone'

export type ComplianceState = 'valid' | 'due-soon' | 'expired' | 'unrecorded'

export interface ComplianceStatus {
  readonly state: ComplianceState
  /**
   * Whole days from today until expiry, in the agency's time zone.
   * Negative once expired, null when nothing is recorded.
   */
  readonly daysRemaining: number | null
  /** The recorded date, unchanged, or null. */
  readonly expiresOn: string | null
}

export interface ComplianceOptions {
  readonly timeZone: string
  /** Days before expiry at which a record starts warning. */
  readonly leadDays: number
  /** Injectable for tests and for evaluating a whole list against one instant. */
  readonly now?: Date
}

export const DEFAULT_COMPLIANCE_LEAD_DAYS = 30

const UNRECORDED: ComplianceStatus = { state: 'unrecorded', daysRemaining: null, expiresOn: null }

function parseIsoDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null

  const [, year, month, day] = match
  return { year: Number(year), month: Number(month), day: Number(day) }
}

/**
 * Classifies a `date` column value.
 *
 * The date is inclusive: a document expiring today is still valid today and
 * expired tomorrow, which is how every certificate and every renewal desk
 * treats it.
 */
export function evaluateCompliance(
  expiresOn: string | null | undefined,
  options: ComplianceOptions,
): ComplianceStatus {
  if (!expiresOn) return UNRECORDED

  const parts = parseIsoDateParts(expiresOn)
  if (!parts) return UNRECORDED

  const { timeZone, leadDays, now = new Date() } = options

  // Compare whole days as the agency reckons them, never instants. Both sides
  // are reduced to a calendar day and then measured in UTC, so no time zone
  // offset can shift the answer across a boundary.
  const today = parseIsoDateParts(toIsoDateInTimeZone(now, timeZone))
  if (!today) return UNRECORDED

  const expiryUtc = Date.UTC(parts.year, parts.month - 1, parts.day)
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day)
  const daysRemaining = Math.round((expiryUtc - todayUtc) / 86_400_000)

  if (daysRemaining < 0) return { state: 'expired', daysRemaining, expiresOn }
  if (daysRemaining <= Math.max(0, leadDays)) return { state: 'due-soon', daysRemaining, expiresOn }
  return { state: 'valid', daysRemaining, expiresOn }
}

/** Ordered worst-first, so a set of records can be reduced to its worst state. */
const SEVERITY: Record<ComplianceState, number> = {
  expired: 3,
  'due-soon': 2,
  unrecorded: 1,
  valid: 0,
}

export function complianceSeverity(state: ComplianceState): number {
  return SEVERITY[state]
}

/**
 * The single worst state across several records — what a fleet list row shows
 * as one indicator instead of four.
 *
 * A missing date is treated as less urgent than an expired one but more urgent
 * than a valid one: it is a gap in the records, not a vehicle that is illegal
 * to hire out.
 */
export function worstCompliance(statuses: readonly ComplianceStatus[]): ComplianceState {
  return statuses.reduce<ComplianceState>((worst, status) => {
    return SEVERITY[status.state] > SEVERITY[worst] ? status.state : worst
  }, 'valid')
}

export interface VehicleComplianceInput {
  insurance_expires_on: string | null
  inspection_expires_on: string | null
  registration_expires_on: string | null
}

export interface VehicleCompliance {
  readonly insurance: ComplianceStatus
  readonly inspection: ComplianceStatus
  readonly registration: ComplianceStatus
  /** Worst of the three, for a single list indicator. */
  readonly overall: ComplianceState
  /** True when something needs attention now — drives the fleet-list warning. */
  readonly needsAttention: boolean
}

/** The three horizons a vehicle carries, evaluated together against one instant. */
export function evaluateVehicleCompliance(
  vehicle: VehicleComplianceInput,
  options: ComplianceOptions,
): VehicleCompliance {
  const insurance = evaluateCompliance(vehicle.insurance_expires_on, options)
  const inspection = evaluateCompliance(vehicle.inspection_expires_on, options)
  const registration = evaluateCompliance(vehicle.registration_expires_on, options)
  const overall = worstCompliance([insurance, inspection, registration])

  return {
    insurance,
    inspection,
    registration,
    overall,
    needsAttention: overall === 'expired' || overall === 'due-soon',
  }
}

export const COMPLIANCE_LABELS: Record<ComplianceState, string> = {
  valid: 'Valid',
  'due-soon': 'Expiring soon',
  expired: 'Expired',
  unrecorded: 'Not recorded',
}

/** Human phrasing for a single record, e.g. "Expires in 12 days". */
export function describeCompliance(status: ComplianceStatus): string {
  const { state, daysRemaining } = status

  switch (state) {
    case 'unrecorded':
      return 'Not recorded'
    case 'expired': {
      const days = Math.abs(daysRemaining ?? 0)
      if (days === 0) return 'Expired today'
      return days === 1 ? 'Expired yesterday' : `Expired ${days} days ago`
    }
    case 'due-soon': {
      const days = daysRemaining ?? 0
      if (days === 0) return 'Expires today'
      return days === 1 ? 'Expires tomorrow' : `Expires in ${days} days`
    }
    case 'valid': {
      const days = daysRemaining ?? 0
      return days > 60 ? 'Valid' : `Valid for ${days} more days`
    }
  }
}

/** Counts days from today, in the agency zone, to an instant. Used for rental context. */
export function daysUntil(instant: Date, timeZone: string, now: Date = new Date()): number {
  return countDaysInTimeZone(now, instant, timeZone)
}
