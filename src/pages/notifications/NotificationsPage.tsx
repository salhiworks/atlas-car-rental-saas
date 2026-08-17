import { useState } from 'react'

import { Button, Card, CardBody, CardHeader, PageHeader } from '@/components/ui'
import { NotificationList } from '@/features/notifications/components/NotificationList'
import {
  NOTIFICATIONS_PAGE_SIZE,
  useDismissNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useSnoozeNotification,
  useUnreadCount,
} from '@/features/notifications/queries'
import { useOrganization } from '@/features/workspace/workspace-context'
import { cn } from '@/lib/utils/cn'
import type { NotificationScope } from '@/types/database'

/**
 * The full inbox.
 *
 * Three views and a page control, which is the whole of it. Notifications are
 * not a database to browse: there is no search, no faceting and no date range,
 * because an inbox that needs a query builder is an inbox nobody is reading.
 *
 * "All" includes what has been dismissed, so putting something away is
 * recoverable rather than final. Nothing is retained here for its own sake —
 * conditions are derived, so history is whatever is still true plus the events
 * that actually happened.
 */

const TABS: ReadonlyArray<{ scope: NotificationScope; label: string; empty: [string, string] }> = [
  {
    scope: 'active',
    label: 'All',
    empty: [
      'Nothing needs your attention',
      'Pick-ups, returns, expiring documents and lender payments appear here as they come due.',
    ],
  },
  {
    scope: 'unread',
    label: 'Unread',
    empty: ['Nothing unread', 'Everything currently on the list has been seen.'],
  },
  {
    scope: 'attention',
    label: 'Needs attention',
    empty: ['Nothing urgent', 'No overdue returns, expired documents or late lender payments.'],
  },
  {
    scope: 'all',
    label: 'History',
    empty: ['Nothing here yet', 'Dismissed items and past events are kept here.'],
  },
]

export function NotificationsPage() {
  const organization = useOrganization()
  const [scope, setScope] = useState<NotificationScope>('active')
  const [page, setPage] = useState(0)

  const feed = useNotifications(scope, page)
  const unread = useUnreadCount()
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()
  const dismiss = useDismissNotification()
  const snooze = useSnoozeNotification()

  const rows = feed.data ?? []
  const total = rows[0]?.total_count ?? 0
  const tab = TABS.find((entry) => entry.scope === scope) ?? TABS[0]!
  const count = unread.data ?? 0

  const busy =
    (markRead.isPending && markRead.variables) ||
    (dismiss.isPending && dismiss.variables) ||
    (snooze.isPending && snooze.variables?.fingerprint) ||
    null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description={`What needs attention in ${organization.name}.`}
        actions={
          count > 0 ? (
            <Button
              variant="secondary"
              onClick={() => markAllRead.mutate()}
              isLoading={markAllRead.isPending}
            >
              Mark all read
            </Button>
          ) : undefined
        }
      />

      <Card>
        <CardHeader
          title={tab.label}
          description={
            feed.isPending || feed.isError
              ? undefined
              : `${total} ${total === 1 ? 'item' : 'items'}`
          }
          actions={
            <div
              role="tablist"
              aria-label="Notification view"
              className="border-line flex flex-wrap gap-0.5 rounded-md border p-0.5"
            >
              {TABS.map((entry) => (
                <button
                  key={entry.scope}
                  type="button"
                  role="tab"
                  aria-selected={entry.scope === scope}
                  onClick={() => {
                    setScope(entry.scope)
                    setPage(0)
                  }}
                  className={cn(
                    'rounded-[5px] px-2.5 py-1 text-[0.8125rem] transition-colors outline-none',
                    'focus-visible:ring-brand-500 focus-visible:ring-2',
                    entry.scope === scope
                      ? 'bg-surface-inset text-ink font-medium'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          }
        />
        <CardBody className="p-0">
          <NotificationList
            notifications={rows}
            isLoading={feed.isPending}
            error={feed.error}
            onRetry={() => void feed.refetch()}
            locale={organization.locale}
            timeZone={organization.time_zone}
            emptyTitle={tab.empty[0]}
            emptyDescription={tab.empty[1]}
            busyFingerprint={typeof busy === 'string' ? busy : null}
            onMarkRead={(fingerprint) => markRead.mutate(fingerprint)}
            onDismiss={(fingerprint) => dismiss.mutate(fingerprint)}
            onSnooze={(fingerprint, until) => snooze.mutate({ fingerprint, until })}
          />

          {total > NOTIFICATIONS_PAGE_SIZE ? (
            <div className="border-line flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
              <p className="text-ink-subtle text-[0.75rem]">
                {page * NOTIFICATIONS_PAGE_SIZE + 1}–
                {Math.min((page + 1) * NOTIFICATIONS_PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page === 0 || feed.isFetching}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Newer
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={(page + 1) * NOTIFICATIONS_PAGE_SIZE >= total || feed.isFetching}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Older
                </Button>
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  )
}
