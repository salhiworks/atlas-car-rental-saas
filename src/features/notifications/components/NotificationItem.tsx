import { Check, Clock, X } from 'lucide-react'
import { Link } from 'react-router-dom'

import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui'
import { formatDate, formatDateTime, parseIsoDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { NotificationRow, NotificationSeverity } from '@/types/database'

import { SNOOZE_CHOICES, describe, isDismissable } from '../domain'

import { NotificationIcon } from './NotificationIcon'

/**
 * One row in the notification centre.
 *
 * A compact line: an icon, a sentence, the context under it, and the time it is
 * about. Unread is carried by weight and a dot, not by colour alone; severity is
 * carried by a word, not only by a tint. Somebody who cannot distinguish the two
 * greens still reads the same list.
 *
 * The whole row is the link to the record, because that is what a person wants
 * from a notification about a car that is late. The two secondary controls sit
 * outside it so they are reachable without following the link.
 */

export interface NotificationItemProps {
  notification: NotificationRow
  locale: string
  timeZone: string
  onOpen?: () => void
  onMarkRead: (fingerprint: string) => void
  onDismiss: (fingerprint: string) => void
  onSnooze: (fingerprint: string, until: Date) => void
  isBusy?: boolean
}

const SEVERITY_TONE: Record<NotificationSeverity, 'critical' | 'caution' | 'neutral'> = {
  urgent: 'critical',
  attention: 'caution',
  info: 'neutral',
}

export function NotificationItem({
  notification,
  locale,
  timeZone,
  onOpen,
  onMarkRead,
  onDismiss,
  onSnooze,
  isBusy = false,
}: NotificationItemProps) {
  const copy = describe(notification)
  const isUnread = notification.read_at === null

  /*
   * When this is about, in the agency's own reckoning. A due date is a calendar
   * fact and is shown as one; an instant carries its time, because "due back at
   * 14:00" is the useful half of a return reminder.
   */
  const when = notification.due_on
    ? formatDate(parseIsoDate(notification.due_on, timeZone) ?? new Date(notification.due_on), {
        locale,
        timeZone,
      })
    : notification.occurred_at
      ? formatDateTime(new Date(notification.occurred_at), { locale, timeZone })
      : null

  const amount =
    notification.amount_minor !== null && notification.currency
      ? formatMoney(notification.amount_minor, notification.currency, { locale })
      : null

  return (
    <li
      className={cn(
        'group relative flex min-w-0 items-start gap-3 px-4 py-3 transition-colors',
        isUnread ? 'bg-brand-50/40' : 'hover:bg-surface-inset/60',
      )}
    >
      <NotificationIcon kind={notification.kind} severity={notification.severity} />

      <div className="min-w-0 flex-1">
        <Link
          to={notification.action_path ?? '#'}
          onClick={() => {
            if (isUnread) onMarkRead(notification.fingerprint)
            onOpen?.()
          }}
          className="focus-visible:ring-brand-500 rounded-sm outline-none focus-visible:ring-2"
        >
          <p
            className={cn(
              'text-[0.8125rem] leading-5 break-words',
              isUnread ? 'font-medium' : 'text-ink-muted',
            )}
          >
            {copy.title}
          </p>
        </Link>

        {copy.detail ? (
          <p className="text-ink-subtle mt-0.5 truncate text-[0.75rem] leading-4">{copy.detail}</p>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* The word, not only the colour. */}
          {notification.severity !== 'info' ? (
            <Badge tone={SEVERITY_TONE[notification.severity]}>
              {notification.severity === 'urgent' ? 'Urgent' : 'Needs attention'}
            </Badge>
          ) : null}
          {when ? <span className="text-ink-subtle text-[0.75rem]">{when}</span> : null}
          {amount ? (
            <span
              data-numeric=""
              className="text-ink-muted text-[0.75rem] font-medium tabular-nums"
            >
              {amount}
            </span>
          ) : null}
          {isUnread ? (
            <span className="text-brand-700 text-[0.75rem] font-medium">Unread</span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {isUnread ? (
          <Button
            variant="ghost"
            size="sm"
            className="size-8 p-0"
            aria-label={`Mark "${copy.title}" as read`}
            disabled={isBusy}
            onClick={() => onMarkRead(notification.fingerprint)}
          >
            <Check className="size-4" aria-hidden="true" />
          </Button>
        ) : null}

        {isDismissable(notification) && notification.dismissed_at === null ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="size-8 p-0"
                aria-label={`Options for "${copy.title}"`}
                disabled={isBusy}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SNOOZE_CHOICES.map((choice) => (
                <DropdownMenuItem
                  key={choice.label}
                  onSelect={() =>
                    onSnooze(
                      notification.fingerprint,
                      new Date(Date.now() + choice.hours * 60 * 60 * 1000),
                    )
                  }
                >
                  <Clock aria-hidden="true" />
                  {choice.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => onDismiss(notification.fingerprint)}>
                <X aria-hidden="true" />
                Dismiss
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  )
}
