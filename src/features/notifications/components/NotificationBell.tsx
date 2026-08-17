import * as Dialog from '@radix-ui/react-dialog'
import { Bell, CheckCheck, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Button } from '@/components/ui'
import { useOrganization } from '@/features/workspace/workspace-context'
import { cn } from '@/lib/utils/cn'

import {
  useDismissNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useSnoozeNotification,
  useUnreadCount,
} from '../queries'

import { NotificationList } from './NotificationList'

/**
 * The bell, and the panel behind it.
 *
 * A right-side drawer rather than a small popover, because these rows carry a
 * contract reference, a vehicle, a due time and an amount — a 320px bubble turns
 * all of that into truncation. It is a fixed, restrained width on a desktop and
 * full width on a phone, and it never covers the whole screen on either.
 *
 * The badge counts exactly what the panel will show under Unread: the same
 * database definition, so the two cannot disagree. A badge of 27 above a list of
 * 4 is the classic way a notification system loses somebody's trust.
 */

export interface NotificationBellProps {
  /** Collapsed sidebar shows the bell alone, with the count as a dot. */
  isCompact?: boolean
  className?: string
}

export function NotificationBell({ isCompact = false, className }: NotificationBellProps) {
  const organization = useOrganization()
  const [isOpen, setIsOpen] = useState(false)

  const unread = useUnreadCount()
  const feed = useNotifications('active', 0, isOpen)

  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()
  const dismiss = useDismissNotification()
  const snooze = useSnoozeNotification()

  const count = unread.data ?? 0
  const busy =
    (markRead.isPending && markRead.variables) ||
    (dismiss.isPending && dismiss.variables) ||
    (snooze.isPending && snooze.variables?.fingerprint) ||
    null

  /*
   * Above ninety-nine the exact number stops being information and starts being
   * a layout problem. The accessible name keeps the truth either way.
   */
  const badge = count > 99 ? '99+' : String(count)
  const label =
    count === 0 ? 'Notifications' : `Notifications, ${count} unread item${count === 1 ? '' : 's'}`

  return (
    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'text-ink-muted hover:bg-surface-inset hover:text-ink relative flex size-8 shrink-0',
            'items-center justify-center rounded-md transition-colors outline-none',
            'focus-visible:ring-brand-500 focus-visible:ring-2',
            className,
          )}
        >
          <Bell className="size-4" aria-hidden="true" />
          {count > 0 ? (
            isCompact ? (
              // No room for a number beside a 32px icon; the dot says "something",
              // and the accessible name still says how many.
              <span
                aria-hidden="true"
                className="bg-critical-600 border-canvas absolute end-1 top-1 size-2 rounded-full border"
              />
            ) : (
              <span
                aria-hidden="true"
                className={cn(
                  'bg-critical-600 absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center',
                  'justify-center rounded-full px-1 text-[0.625rem] leading-none font-semibold text-white',
                )}
              >
                {badge}
              </span>
            )
          ) : null}
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#16181a]/30 backdrop-blur-[1px]" />
        <Dialog.Content
          className={cn(
            'bg-surface border-line fixed inset-y-0 end-0 z-50 flex w-full flex-col border-s shadow-overlay',
            'sm:max-w-[26rem]',
            'outline-none',
          )}
          aria-label="Notifications"
        >
          <div className="border-line flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-[0.9375rem] leading-5 font-semibold">
                Notifications
              </Dialog.Title>
              <Dialog.Description className="text-ink-subtle truncate text-[0.75rem]">
                {organization.name}
              </Dialog.Description>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {count > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => markAllRead.mutate()}
                  isLoading={markAllRead.isPending}
                >
                  <CheckCheck className="size-3.5" aria-hidden="true" />
                  Mark all read
                </Button>
              ) : null}
              <Dialog.Close
                className="text-ink-subtle hover:bg-surface-inset hover:text-ink rounded-md p-1.5 transition-colors"
                aria-label="Close notifications"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <NotificationList
              notifications={feed.data ?? []}
              isLoading={feed.isPending}
              error={feed.error}
              onRetry={() => void feed.refetch()}
              locale={organization.locale}
              timeZone={organization.time_zone}
              emptyTitle="Nothing needs your attention"
              emptyDescription="Pick-ups, returns, expiring documents and lender payments appear here as they come due."
              busyFingerprint={typeof busy === 'string' ? busy : null}
              onOpen={() => setIsOpen(false)}
              onMarkRead={(fingerprint) => markRead.mutate(fingerprint)}
              onDismiss={(fingerprint) => dismiss.mutate(fingerprint)}
              onSnooze={(fingerprint, until) => snooze.mutate({ fingerprint, until })}
            />
          </div>

          <div className="border-line bg-surface-muted shrink-0 border-t px-4 py-2.5 text-center">
            <Link
              to={paths.notifications}
              onClick={() => setIsOpen(false)}
              className="text-brand-700 text-[0.8125rem] font-medium hover:underline"
            >
              View all notifications
            </Link>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
