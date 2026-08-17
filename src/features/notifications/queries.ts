import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useOrganization } from '@/features/workspace/workspace-context'
import type { NotificationCategory, NotificationScope } from '@/types/database'

import {
  dismiss,
  fetchNotifications,
  fetchPreferences,
  fetchUnreadCount,
  markAllRead,
  markRead,
  setPreference,
  snooze,
} from './api'

/**
 * Query keys for Notifications.
 *
 * EVERY KEY BEGINS WITH THE ORGANIZATION, and here it matters more than
 * anywhere else in the product: the bell is on screen in every workspace, all
 * the time. A key shaped `['notifications', orgId]` would survive the switcher's
 * `removeQueries(['organization'])` and leave one agency's overdue vehicles and
 * customer balances sitting in another agency's header.
 */
export const notificationKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'notifications'] as const,
  feed: (organizationId: string, scope: NotificationScope, page: number) =>
    ['organization', organizationId, 'notifications', 'feed', scope, page] as const,
  unread: (organizationId: string) =>
    ['organization', organizationId, 'notifications', 'unread'] as const,
  preferences: (organizationId: string) =>
    ['organization', organizationId, 'notifications', 'preferences'] as const,
}

export const NOTIFICATIONS_PAGE_SIZE = 25

/**
 * The number on the bell.
 *
 * Refetched on focus like everything else, and on a slow timer while the tab is
 * visible — because some of these conditions become true simply because time
 * passed. A rental is not overdue until it is, and nobody clicks Save on that.
 *
 * Sixty seconds, not one: this is one indexed database call, and a bell that
 * updates within the minute is indistinguishable from one that updates within
 * the second to the person reading it. Nothing here is a background service —
 * when the tab is closed, nothing runs.
 */
export function useUnreadCount() {
  const organization = useOrganization()

  return useQuery({
    queryKey: notificationKeys.unread(organization.id),
    queryFn: () => fetchUnreadCount(organization.id),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })
}

export function useNotifications(scope: NotificationScope, page = 0, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: notificationKeys.feed(organization.id, scope, page),
    queryFn: () =>
      fetchNotifications(
        organization.id,
        scope,
        NOTIFICATIONS_PAGE_SIZE,
        page * NOTIFICATIONS_PAGE_SIZE,
      ),
    enabled,
    staleTime: 15_000,
    /*
     * No `placeholderData`. Keeping the previous page on screen while the next
     * loads is a nice touch on a report and a liability here: the previous page
     * may belong to an agency this person has just left, or to a category a
     * demotion has just taken away.
     */
  })
}

export function useNotificationPreferences(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: notificationKeys.preferences(organization.id),
    queryFn: () => fetchPreferences(organization.id),
    enabled,
    staleTime: 60_000,
  })
}

function invalidate(client: QueryClient, organizationId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: notificationKeys.all(organizationId) }).then(() => {})
}

export function useMarkNotificationRead() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (fingerprint: string) => markRead(organization.id, fingerprint),
    onSuccess: () => invalidate(client, organization.id),
  })
}

export function useMarkAllNotificationsRead() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => markAllRead(organization.id),
    onSuccess: () => invalidate(client, organization.id),
  })
}

export function useDismissNotification() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (fingerprint: string) => dismiss(organization.id, fingerprint),
    onSuccess: () => invalidate(client, organization.id),
  })
}

export function useSnoozeNotification() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { fingerprint: string; until: Date }) =>
      snooze(organization.id, input.fingerprint, input.until),
    onSuccess: () => invalidate(client, organization.id),
  })
}

export function useSetNotificationPreference() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { category: NotificationCategory; muted: boolean }) =>
      setPreference(organization.id, input.category, input.muted),
    onSuccess: () => invalidate(client, organization.id),
  })
}
