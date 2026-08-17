import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type {
  NotificationCategory,
  NotificationPreferenceRow,
  NotificationRow,
  NotificationScope,
} from '@/types/database'

/**
 * The Notifications data layer.
 *
 * Three reads and five writes, and none of the writes creates a notification.
 * There is no client-reachable way to author a message: a person can say they
 * have read something, put it away, or silence a category for themselves, and
 * that is the whole surface. Conditions come from the domains that own them and
 * events are written by triggers on authoritative tables.
 *
 * Nothing is fetched into the browser to be filtered there. The feed function
 * decides what this caller may know before it returns a row, so a member who
 * cannot see Financing never receives a financing amount, a lender name, or a
 * count of how many they are missing.
 */

export async function fetchNotifications(
  organizationId: string,
  scope: NotificationScope,
  limit = 50,
  offset = 0,
): Promise<NotificationRow[]> {
  const { data, error } = await getSupabaseClient().rpc('notification_feed', {
    p_organization_id: organizationId,
    p_scope: scope,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchUnreadCount(organizationId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('notification_unread_count', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)
  return data ?? 0
}

export async function markRead(organizationId: string, fingerprint: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('notification_mark_read', {
    p_organization_id: organizationId,
    p_fingerprint: fingerprint,
  })

  if (error) throw toAppError(error)
}

export async function markAllRead(organizationId: string): Promise<number> {
  const { data, error } = await getSupabaseClient().rpc('notification_mark_all_read', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)
  return data ?? 0
}

export async function dismiss(organizationId: string, fingerprint: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('notification_dismiss', {
    p_organization_id: organizationId,
    p_fingerprint: fingerprint,
  })

  if (error) throw toAppError(error)
}

/**
 * Hides one episode until a moment in the future.
 *
 * The instant is computed here and sent absolute, so the decision is not
 * re-interpreted later against a different clock. The choices are durations from
 * now — four hours, a day, a week — and the database refuses anything in the
 * past or more than a month out.
 */
export async function snooze(
  organizationId: string,
  fingerprint: string,
  until: Date,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('notification_snooze', {
    p_organization_id: organizationId,
    p_fingerprint: fingerprint,
    p_until: until.toISOString(),
  })

  if (error) throw toAppError(error)
}

export async function fetchPreferences(
  organizationId: string,
): Promise<NotificationPreferenceRow[]> {
  const { data, error } = await getSupabaseClient().rpc('notification_preferences_for', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function setPreference(
  organizationId: string,
  category: NotificationCategory,
  muted: boolean,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('notification_preference_set', {
    p_organization_id: organizationId,
    p_category: category,
    p_muted: muted,
  })

  if (error) throw toAppError(error)
}
