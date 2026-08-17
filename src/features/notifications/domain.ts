import type { NotificationCategory, NotificationRow, NotificationSeverity } from '@/types/database'
import { getAppName } from '@/lib/config/env'

/**
 * The words, written here from the typed facts the database returned.
 *
 * Nothing in this product stores a rendered sentence. A notification is a
 * `kind` and the things it is about, so the phrasing can be corrected — or
 * translated — without rewriting anything that already happened.
 *
 * The tone is deliberately flat. This is fleet software: a car is late back, a
 * document has expired, a lender has not been paid. None of that is improved by
 * exclamation marks, and a list where everything shouts is a list where nothing
 * is read.
 */

export const CATEGORY_LABELS: Readonly<Record<NotificationCategory, string>> = {
  rentals: 'Rentals',
  compliance: 'Vehicle compliance',
  financing: 'Financing',
  gps: 'Tracking',
  team: 'Team',
  billing: 'Subscription',
}

/** Said in terms of what the person will actually be told. */
export const CATEGORY_DESCRIPTIONS: Readonly<Record<NotificationCategory, string>> = {
  rentals: 'Pick-ups and returns due, overdue returns, and unpaid contracts.',
  compliance: 'Insurance, inspection and registration approaching expiry or expired.',
  financing: 'Lender payments due and overdue.',
  gps: 'Tracker connections and positions that have gone quiet.',
  team: 'People joining, leaving and changing role.',
  billing: `Your ${getAppName()} subscription: payments, plan changes and cancellation.`,
}

export const SEVERITY_LABELS: Readonly<Record<NotificationSeverity, string>> = {
  urgent: 'Urgent',
  attention: 'Needs attention',
  info: 'For information',
}

const DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  insurance: 'Insurance',
  inspection: 'Inspection',
  registration: 'Registration',
}

function readContext(row: NotificationRow, key: string): string | null {
  const context = row.context
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return null
  const value = (context as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** "Banque Populaire · Instalment 3", or whichever half is known. */
function instalment(row: NotificationRow): string | null {
  const lender = readContext(row, 'lender')
  const context = row.context
  const sequence =
    typeof context === 'object' && context !== null && !Array.isArray(context)
      ? (context as Record<string, unknown>).sequence
      : null
  const number = typeof sequence === 'number' ? `Instalment ${sequence}` : null

  return [lender, number].filter(Boolean).join(' · ') || null
}

export interface NotificationCopy {
  /** One line, the thing that happened or is about to. */
  readonly title: string
  /** Context underneath, or null when the title already says everything. */
  readonly detail: string | null
}

/**
 * The sentence for one notification.
 *
 * Every value interpolated here is returned by React as a text node, never as
 * markup — a vehicle whose plate somebody typed as `<script>` renders as those
 * characters, on screen, harmlessly.
 */
export function describe(row: NotificationRow): NotificationCopy {
  const subject = row.subject_label ?? 'This record'
  const vehicle = readContext(row, 'vehicle')

  switch (row.kind) {
    case 'rental_pickup_due':
      return {
        title: `${subject} is due for collection`,
        detail: vehicle
          ? `${vehicle}${row.secondary_label ? ` · ${row.secondary_label}` : ''}`
          : null,
      }
    case 'rental_return_due':
      return {
        title: `${subject} is due back`,
        detail: vehicle
          ? `${vehicle}${row.secondary_label ? ` · ${row.secondary_label}` : ''}`
          : null,
      }
    case 'rental_return_overdue':
      return {
        title: `${subject} is overdue for return`,
        detail: vehicle
          ? `${vehicle}${row.secondary_label ? ` · ${row.secondary_label}` : ''}`
          : null,
      }
    case 'rental_balance_outstanding':
      // Deliberately not "overdue invoice": this product has no invoice due
      // date, so it cannot say how late anything is.
      return {
        title: `${subject} has an outstanding balance`,
        detail: row.secondary_label,
      }
    case 'vehicle_compliance_due': {
      const document = DOCUMENT_LABELS[readContext(row, 'document') ?? ''] ?? 'A document'
      return { title: `${document} for ${subject} expires soon`, detail: vehicle }
    }
    case 'vehicle_compliance_expired': {
      const document = DOCUMENT_LABELS[readContext(row, 'document') ?? ''] ?? 'A document'
      return { title: `${document} for ${subject} has expired`, detail: vehicle }
    }
    /*
     * An agreement forty days behind has three instalments outstanding, and all
     * three are "overdue on BR-FIN-2026". The instalment number is what tells
     * them apart, and the feed already carries it — without it the list reads as
     * the same alert repeated, which is how somebody pays one and assumes the
     * other two were duplicates.
     */
    case 'financing_due':
      return {
        title: `Financing payment due on ${subject}`,
        detail: instalment(row),
      }
    case 'financing_overdue':
      return {
        title: `Financing payment overdue on ${subject}`,
        detail: instalment(row),
      }
    case 'gps_connection_unhealthy':
      // What is known: the provider connection is not healthy. NOT that any
      // vehicle is offline, and not for how long.
      return {
        title: 'A tracking connection is not healthy',
        detail: readContext(row, 'detail'),
      }
    case 'gps_position_stale': {
      const signal = readContext(row, 'signal')
      return {
        title:
          signal === 'no_position'
            ? `No position has been reported for ${subject}`
            : signal === 'provider_offline'
              ? `The provider reports ${subject} offline`
              : `${subject} has not reported a position recently`,
        detail: readContext(row, 'detail'),
      }
    }
    case 'team_invitation_accepted':
      return { title: `${subject} joined the agency`, detail: null }
    case 'team_ownership_transferred':
      return { title: `${subject} is now the owner`, detail: row.secondary_label }
    case 'team_role_changed':
      return { title: `${subject}'s role changed`, detail: null }
    case 'team_member_removed':
      return { title: `${subject} was removed from the agency`, detail: null }

    /*
     * Billing. Said about OUR subscription, never about a rental payment — and
     * never in words that claim more than Stripe told us. "A payment did not go
     * through" is what an invoice attempt failing means; "your card was
     * declined" is a different sentence about a fact we do not have.
     */
    case 'billing_subscription_activated':
      return { title: 'Your subscription is active', detail: planDetail(row) }
    case 'billing_payment_failed':
      return {
        title: 'A subscription payment did not go through',
        detail: 'Open Billing to check the payment method.',
      }
    case 'billing_payment_recovered':
      return { title: 'Your subscription is active again', detail: planDetail(row) }
    case 'billing_cancellation_scheduled':
      return {
        title: 'Your subscription is set to end',
        detail: 'It stays active until the end of the current period.',
      }
    case 'billing_subscription_ended':
      return { title: 'Your subscription has ended', detail: planDetail(row) }
    case 'billing_plan_changed':
      return { title: 'Your subscription plan changed', detail: planDetail(row) }
    /*
     * The current condition rather than an event: derived from live billing
     * state, and it resolves itself when the subscription is healthy again. No
     * amount and no invoice — the detail belongs on the Billing page, behind the
     * owner check.
     */
    case 'billing_attention_required':
      return {
        title: 'Your subscription needs attention',
        detail: 'Open Billing to see what is required.',
      }
  }
}

/** The plan a billing notification is about, when the event named one. */
function planDetail(row: NotificationRow): string | null {
  const plan = readContext(row, 'plan_key')
  const previous = readContext(row, 'previous_plan_key')
  if (plan === null) return null
  return previous !== null && previous !== plan ? `${previous} → ${plan}` : plan
}

/**
 * Whether an item can be put away.
 *
 * A derived CONDITION can be: hiding "this document expired" is a personal
 * choice and the document is still expired, and the same is true of "your
 * subscription needs attention". An EVENT is already in the past and dismissing
 * it means nothing beyond marking it read, so it is not offered — which is why
 * this is decided by kind rather than by category alone. Billing carries both.
 */
export function isDismissable(row: NotificationRow): boolean {
  if (row.category === 'team') return false
  if (row.category === 'billing') return row.kind === 'billing_attention_required'
  return true
}

/** How long to put something away for, counted from the moment it is chosen. */
export const SNOOZE_CHOICES = [
  { label: 'Later today', hours: 4 },
  { label: 'Tomorrow', hours: 24 },
  { label: 'Next week', hours: 24 * 7 },
] as const
