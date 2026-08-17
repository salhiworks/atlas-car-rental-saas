import type {
  InvitationDelivery,
  InvitationState,
  OrgRole,
  TeamEventRow,
  TeamInvitationRow,
} from '@/types/database'

/**
 * The words the Team page uses, in one place.
 *
 * Two rules run through all of it. Roles are described by what the person can
 * actually do in this product, not by adjectives — "elevated access" tells an
 * owner nothing about whether to give somebody the key to the financing
 * agreements. And delivery is described by what is known: an email API
 * returning 202 is not a colleague receiving an email, and the difference is the
 * whole reason somebody is looking at this column.
 */

/** Roles an invitation may carry. Owner is transferred, never invited. */
export const INVITABLE_ROLES: readonly Exclude<OrgRole, 'owner'>[] = ['admin', 'manager', 'staff']

export const ROLE_SUMMARY: Readonly<Record<OrgRole, string>> = {
  owner: 'Everything an administrator can do, plus transferring ownership of the agency.',
  admin: 'Manages the team, agency settings, financing agreements and the whole fleet.',
  manager: 'Runs the day: fleet, contracts, costs, tracking and reports. Cannot manage the team.',
  staff: 'Front desk: books contracts, records customers and takes payments.',
}

/** One line, for the invite dialog. Longer than a label, shorter than a matrix. */
export const ROLE_INVITE_HINT: Readonly<Record<Exclude<OrgRole, 'owner'>, string>> = {
  admin: 'Can invite and remove people, and change agency settings.',
  manager: 'Sees costs, financing and reports. Cannot change the team.',
  staff: 'Books and settles contracts. No access to financing or reports.',
}

export const INVITATION_STATE_LABEL: Readonly<Record<InvitationState, string>> = {
  pending: 'Waiting',
  accepted: 'Joined',
  expired: 'Expired',
  revoked: 'Withdrawn',
}

export const INVITATION_STATE_TONE: Readonly<
  Record<InvitationState, 'neutral' | 'brand' | 'positive' | 'caution'>
> = {
  pending: 'brand',
  accepted: 'positive',
  expired: 'caution',
  revoked: 'neutral',
}

/**
 * What is actually known about the email.
 *
 * `accepted_by_provider` is the one that matters: the provider took the message
 * and this product cannot see what happened next. Saying "Delivered" there would
 * be the difference between an administrator waiting patiently and an
 * administrator picking up the phone.
 */
export const DELIVERY_LABEL: Readonly<Record<InvitationDelivery, string>> = {
  pending: 'Not sent yet',
  accepted_by_provider: 'Email accepted by provider',
  failed: 'Email failed',
  manual_link: 'Link shared manually',
  not_configured: 'No email configured',
}

export const DELIVERY_TONE: Readonly<
  Record<InvitationDelivery, 'neutral' | 'positive' | 'caution' | 'critical'>
> = {
  pending: 'neutral',
  accepted_by_provider: 'positive',
  failed: 'critical',
  manual_link: 'caution',
  not_configured: 'caution',
}

/** True when this invitation still needs somebody to get the link to the person. */
export function needsManualDelivery(invitation: TeamInvitationRow): boolean {
  return (
    invitation.state === 'pending' &&
    (invitation.delivery_state === 'failed' ||
      invitation.delivery_state === 'not_configured' ||
      invitation.delivery_state === 'pending')
  )
}

export function resendAvailableIn(invitation: TeamInvitationRow, now: number = Date.now()): number {
  if (!invitation.resend_available_at) return 0
  return Math.max(0, new Date(invitation.resend_available_at).getTime() - now)
}

/**
 * One sentence per event, assembled from typed columns.
 *
 * Nothing here interpolates a raw JSON blob into markup. The names and addresses
 * are text somebody typed, and they are rendered by React as text nodes rather
 * than concatenated into HTML anywhere in this file — this returns the parts,
 * and the component renders them.
 */
export interface EventSentence {
  readonly actor: string
  readonly verb: string
  readonly subject: string | null
  readonly trailer: string | null
}

const ROLE_WORD: Readonly<Record<OrgRole, string>> = {
  owner: 'owner',
  admin: 'administrator',
  manager: 'manager',
  staff: 'staff',
}

export function describeEvent(event: TeamEventRow): EventSentence {
  const who = event.actor_name || 'Someone'
  const target = event.target_name || event.target_email || 'someone'
  const asRole = event.new_role ? ROLE_WORD[event.new_role] : null
  const wasRole = event.previous_role ? ROLE_WORD[event.previous_role] : null

  switch (event.event) {
    case 'invitation_created':
      return {
        actor: who,
        verb: 'invited',
        subject: event.target_email,
        trailer: asRole ? `as ${asRole}` : null,
      }
    case 'invitation_resent':
      return { actor: who, verb: 'sent a new link to', subject: event.target_email, trailer: null }
    case 'invitation_revoked':
      return {
        actor: who,
        verb: 'withdrew the invitation to',
        subject: event.target_email,
        trailer: event.detail,
      }
    case 'invitation_accepted':
      return {
        actor: target,
        verb: 'joined',
        subject: null,
        trailer: asRole ? `as ${asRole}` : null,
      }
    case 'invitation_link_revealed':
      return {
        actor: who,
        verb: 'took a one-time link for',
        subject: event.target_email,
        trailer: 'to send by hand',
      }
    case 'role_changed':
      return {
        actor: who,
        verb: 'changed',
        subject: target,
        trailer: wasRole && asRole ? `from ${wasRole} to ${asRole}` : null,
      }
    case 'member_removed':
      return {
        actor: who,
        verb: 'removed',
        subject: target,
        trailer: wasRole ? `who was ${wasRole}` : null,
      }
    case 'member_left':
      return {
        actor: target,
        verb: 'left the agency',
        subject: null,
        trailer: wasRole ? `as ${wasRole}` : null,
      }
    case 'ownership_transferred':
      return {
        actor: who,
        verb: 'transferred ownership to',
        subject: target,
        trailer: event.detail,
      }
  }
}

/**
 * Which roles this member may be moved to by this actor.
 *
 * Mirrors app.may_grant_role() and app.may_act_on_member(). It decides what to
 * offer; the database decides what happens. Owner never appears — moving it is
 * the transfer workflow, which is a different action with a different dialog.
 */
export function assignableRoles(
  actorRole: OrgRole | null,
  targetRole: OrgRole,
): readonly Exclude<OrgRole, 'owner'>[] {
  if (!actorRole) return []
  if (actorRole !== 'owner' && actorRole !== 'admin') return []
  // An owner is out of an administrator's reach entirely.
  if (targetRole === 'owner' && actorRole !== 'owner') return []
  if (targetRole === 'owner') return []

  const rank = { owner: 40, admin: 30, manager: 20, staff: 10 } as const
  return INVITABLE_ROLES.filter((role) => rank[role] <= rank[actorRole])
}

/** Mirrors app.may_act_on_member(): equal rank is fine, above it is not. */
export function canActOnMember(actorRole: OrgRole | null, targetRole: OrgRole): boolean {
  if (!actorRole) return false
  const rank = { owner: 40, admin: 30, manager: 20, staff: 10 } as const
  return rank[actorRole] >= rank.admin && rank[targetRole] <= rank[actorRole]
}
