import {
  AlertTriangle,
  CalendarClock,
  CarFront,
  CircleDollarSign,
  CreditCard,
  Landmark,
  MapPinOff,
  ReceiptText,
  UserPlus,
  Users,
} from 'lucide-react'

import { cn } from '@/lib/utils/cn'
import type { NotificationKind, NotificationSeverity } from '@/types/database'

/**
 * The badge in front of a notification row.
 *
 * The glyph is chosen by returning an element rather than by picking a
 * component into a variable: the two read the same on screen, and only one of
 * them is a component being conjured up during a render.
 *
 * The tint follows severity and is never the only thing carrying it — the row
 * states the severity in words beside this, so the list is the same list to
 * somebody who cannot separate the two colours.
 */

const SEVERITY_TONE: Record<NotificationSeverity, string> = {
  urgent: 'text-critical-600 bg-critical-50',
  attention: 'text-caution-700 bg-caution-50',
  info: 'text-ink-subtle bg-surface-inset',
}

function Glyph({ kind }: { kind: NotificationKind }) {
  const className = 'size-4'

  switch (kind) {
    case 'rental_pickup_due':
    case 'rental_return_due':
      return <CalendarClock className={className} />
    case 'rental_return_overdue':
      return <AlertTriangle className={className} />
    case 'rental_balance_outstanding':
      return <CircleDollarSign className={className} />
    case 'vehicle_compliance_due':
    case 'vehicle_compliance_expired':
      return <CarFront className={className} />
    case 'financing_due':
    case 'financing_overdue':
      return <Landmark className={className} />
    case 'gps_connection_unhealthy':
    case 'gps_position_stale':
      return <MapPinOff className={className} />
    case 'team_invitation_accepted':
      return <UserPlus className={className} />
    case 'team_ownership_transferred':
    case 'team_role_changed':
    case 'team_member_removed':
      return <Users className={className} />
    case 'billing_payment_failed':
    case 'billing_attention_required':
      return <AlertTriangle className={className} />
    case 'billing_plan_changed':
      return <ReceiptText className={className} />
    case 'billing_subscription_activated':
    case 'billing_payment_recovered':
    case 'billing_cancellation_scheduled':
    case 'billing_subscription_ended':
      return <CreditCard className={className} />
  }
}

export function NotificationIcon({
  kind,
  severity,
}: {
  kind: NotificationKind
  severity: NotificationSeverity
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md',
        SEVERITY_TONE[severity],
      )}
    >
      <Glyph kind={kind} />
    </span>
  )
}
