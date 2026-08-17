import { CheckCheck } from 'lucide-react'

import { ErrorState } from '@/components/feedback/ErrorState'
import { EmptyState, Skeleton } from '@/components/ui'
import type { NotificationRow } from '@/types/database'

import { NotificationItem } from './NotificationItem'

/**
 * The list, and the four different things "nothing on screen" can mean.
 *
 * A failed query is not an empty inbox. Reports shipped that bug once — a
 * refused request rendering as a clean, reassuring nothing — and it is worse
 * here, because the entire purpose of this surface is to be believed when it
 * says there is nothing to do.
 */

export interface NotificationListProps {
  notifications: readonly NotificationRow[]
  isLoading: boolean
  error: unknown
  onRetry: () => void
  locale: string
  timeZone: string
  emptyTitle: string
  emptyDescription: string
  busyFingerprint: string | null
  onOpen?: () => void
  onMarkRead: (fingerprint: string) => void
  onDismiss: (fingerprint: string) => void
  onSnooze: (fingerprint: string, until: Date) => void
}

export function NotificationList({
  notifications,
  isLoading,
  error,
  onRetry,
  locale,
  timeZone,
  emptyTitle,
  emptyDescription,
  busyFingerprint,
  onOpen,
  onMarkRead,
  onDismiss,
  onSnooze,
}: NotificationListProps) {
  if (error) {
    // Said plainly, with a way to try again. Never "you're all caught up".
    return <ErrorState error={error} title="Notifications could not be loaded" onRetry={onRetry} />
  }

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    )
  }

  if (notifications.length === 0) {
    return <EmptyState icon={CheckCheck} title={emptyTitle} description={emptyDescription} />
  }

  return (
    <ul className="divide-line divide-y">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.fingerprint}
          notification={notification}
          locale={locale}
          timeZone={timeZone}
          onOpen={onOpen}
          onMarkRead={onMarkRead}
          onDismiss={onDismiss}
          onSnooze={onSnooze}
          isBusy={busyFingerprint === notification.fingerprint}
        />
      ))}
    </ul>
  )
}
