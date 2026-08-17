import { getSupabaseClient } from '@/lib/supabase/client'
import { AppError, toAppError } from '@/lib/supabase/errors'
import type {
  AcceptInvitationRow,
  InvitationState,
  OrgRole,
  TeamEventRow,
  TeamInvitationRow,
  TeamMemberRow,
  TeamSeatSummaryRow,
} from '@/types/database'

/**
 * The Team data layer.
 *
 * Every membership change is one RPC. There is no `.from('organization_members')
 * .update(...)` anywhere in this file, and there could not be: the client holds
 * no write privilege on that table at all since 20260821100000. That is
 * deliberate — the rules that govern a membership change (who may grant which
 * role, that nobody edits their own, that an owner always survives, that it is
 * recorded) cannot be expressed as a row policy, so they live in functions and
 * this module calls them.
 *
 * Two operations go through the `team-invitations` Edge Function instead, and
 * only because they need something a browser must not hold: an email provider
 * key, and the application's own trusted address. Everything the function does
 * to the database it does with the caller's own token.
 */

const FUNCTION = 'team-invitations'

/**
 * Keeps the sentence the database wrote.
 *
 * `toAppError` maps SQLSTATE to a generic message, which is right for a raw
 * constraint violation and wrong for this module: every refusal here is a
 * sentence written for the person reading it, and 42501 was being rewritten as
 * "You do not have permission to do that." The one screen where that mattered
 * most is invitation acceptance — somebody signed in as the wrong account was
 * told they lacked permission instead of being told to switch accounts, with no
 * way to work out what to do.
 *
 * Only messages that look like ours are kept: a capital letter, a full stop, and
 * none of the punctuation Postgres uses when it names a relation or a
 * constraint. Anything else — a unique violation from a race, a type error —
 * falls through to the ordinary mapping.
 */
const DOMAIN_CODES = new Set(['42501', '22004', '22023', '23514', '55006', 'P0002'])
const DOMAIN_SENTENCE = /^[A-Z][^"_]*\.$/

function toTeamError(error: unknown): AppError {
  const raised = error as { code?: string; message?: string } | null
  const code = raised?.code
  const message = raised?.message

  if (code && message && DOMAIN_CODES.has(code) && DOMAIN_SENTENCE.test(message)) {
    return new AppError(code === '42501' ? 'permission' : 'validation', message, { code })
  }

  return toAppError(error)
}

export async function fetchTeamMembers(organizationId: string): Promise<TeamMemberRow[]> {
  const { data, error } = await getSupabaseClient().rpc('team_directory', {
    p_organization_id: organizationId,
  })

  if (error) throw toTeamError(error)
  return data ?? []
}

export async function fetchTeamInvitations(
  organizationId: string,
  includeHistory: boolean,
  limit: number,
  offset: number,
): Promise<TeamInvitationRow[]> {
  const { data, error } = await getSupabaseClient().rpc('team_invitations', {
    p_organization_id: organizationId,
    p_include_history: includeHistory,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) throw toTeamError(error)
  return data ?? []
}

export async function fetchTeamEvents(
  organizationId: string,
  limit: number,
  offset: number,
): Promise<TeamEventRow[]> {
  const { data, error } = await getSupabaseClient().rpc('team_events', {
    p_organization_id: organizationId,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) throw toTeamError(error)
  return data ?? []
}

export async function fetchSeatSummary(organizationId: string): Promise<TeamSeatSummaryRow | null> {
  const { data, error } = await getSupabaseClient().rpc('team_seat_summary', {
    p_organization_id: organizationId,
  })

  if (error) throw toTeamError(error)
  return data?.[0] ?? null
}

// -----------------------------------------------------------------------------
// Invitations
// -----------------------------------------------------------------------------

export interface IssueInvitationResult {
  readonly outcome: 'created' | 'reissued' | 'already_member'
  readonly invitationId: string | null
  readonly delivery: string | null
  readonly deliveryDetail: string | null
  /**
   * Present ONLY when no email carried the invitation — no provider configured,
   * or the provider refused. It is a bearer capability: whoever opens it becomes
   * a member. It is shown once, in a dialog that says so, and it is never
   * written to storage, a log, a toast or an analytics call.
   */
  readonly manualLink: string | null
}

interface FunctionErrorBody {
  error?: { category?: string; message?: string }
}

/** What `team-invitations` returns for `create` and `resend`. */
interface IssueResponse {
  outcome: IssueInvitationResult['outcome']
  invitationId?: string
  delivery?: string
  deliveryDetail?: string
  /** Present only when no email carried the invitation. */
  token?: string
  acceptUrl?: string
}

interface PreviewResponse {
  invitation: InvitationPreview
}

/**
 * Reads the message the server already wrote for a person.
 *
 * supabase-js reports a non-2xx from a function as an opaque error with the
 * Response tucked into `context`; without unwrapping it every refusal in this
 * module would read "Edge Function returned a non-2xx status code", which tells
 * an administrator nothing about the invitation they just tried to send.
 */
async function unwrapFunctionError(error: unknown): Promise<never> {
  const context = (error as { context?: Response })?.context
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.clone().json()) as FunctionErrorBody
      if (body?.error?.message) {
        throw new AppError(
          body.error.category === 'permission_denied' ? 'permission' : 'validation',
          body.error.message,
        )
      }
    } catch (parsed) {
      if (parsed instanceof AppError) throw parsed
    }
  }
  throw toAppError(error)
}

/**
 * One call into the invitation function.
 *
 * `FunctionsResponse.error` is typed `any` by the client library, so it is
 * narrowed to `unknown` here rather than destructured straight into a variable
 * — one place where that widening is handled, instead of three.
 */
async function invokeInvitationFunction<T>(
  body: Record<string, unknown>,
  whenEmpty: string,
): Promise<T> {
  const result = await getSupabaseClient().functions.invoke<T>(FUNCTION, { body })
  const error: unknown = result.error

  if (error) await unwrapFunctionError(error)
  if (!result.data) throw new AppError('validation', whenEmpty)

  return result.data
}

/**
 * Composes the acceptance link for manual delivery.
 *
 * Built from the administrator's own origin — the page they are looking at —
 * because they are about to paste it somewhere themselves. The link the SERVER
 * puts in an email is never built this way: that one comes from configuration,
 * so no request can point an invitation at somebody else's domain.
 */
function manualLinkFor(token: string, serverUrl: string | null): string {
  if (serverUrl) return serverUrl
  const url = new URL('/accept-invite', window.location.origin)
  url.hash = `token=${encodeURIComponent(token)}`
  return url.toString()
}

export async function createInvitation(
  organizationId: string,
  email: string,
  role: Exclude<OrgRole, 'owner'>,
): Promise<IssueInvitationResult> {
  const body = await invokeInvitationFunction<IssueResponse>(
    { action: 'create', organization_id: organizationId, email, role },
    'The invitation could not be created.',
  )

  return {
    outcome: body.outcome,
    invitationId: body.invitationId ?? null,
    delivery: body.delivery ?? null,
    deliveryDetail: body.deliveryDetail ?? null,
    manualLink: body.token ? manualLinkFor(body.token, body.acceptUrl ?? null) : null,
  }
}

export async function resendInvitation(invitationId: string): Promise<IssueInvitationResult> {
  const body = await invokeInvitationFunction<IssueResponse>(
    { action: 'resend', invitation_id: invitationId },
    'The invitation could not be reissued.',
  )

  return {
    outcome: body.outcome,
    invitationId: body.invitationId ?? null,
    delivery: body.delivery ?? null,
    deliveryDetail: body.deliveryDetail ?? null,
    manualLink: body.token ? manualLinkFor(body.token, body.acceptUrl ?? null) : null,
  }
}

export async function revokeInvitation(invitationId: string, reason?: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('revoke_team_invitation', {
    p_invitation_id: invitationId,
    p_reason: reason ?? null,
  })

  if (error) throw toTeamError(error)
}

/**
 * Records that an administrator was handed a one-time link.
 *
 * Called when the link is actually shown, not when the delivery function ran:
 * the function reports what the email PROVIDER did, and the disclosure of a
 * bearer capability happens later, in a browser. Without this the `manual_link`
 * state and its audit event were unreachable, so giving somebody a link that
 * grants membership left no trace at all.
 */
export async function recordManualLinkShown(invitationId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('record_invitation_delivery', {
    p_invitation_id: invitationId,
    p_state: 'manual_link',
    p_detail: 'A one-time link was shown to an administrator for manual delivery.',
  })

  // Deliberately not surfaced: the link is already on screen, and failing to
  // record it must not look like the invitation failed.
  if (error) console.error('Could not record the invitation link disclosure.')
}

// -----------------------------------------------------------------------------
// Acceptance
// -----------------------------------------------------------------------------

export interface InvitationPreview {
  readonly organizationName: string
  readonly role: OrgRole
  readonly roleLabel: string
  readonly expiresAt: string | null
  readonly state: InvitationState
  readonly invitedByName: string
  /** `s•••••@agency.com`. Enough to recognise, not enough to be an address. */
  readonly emailMasked: string
}

/**
 * Describes an invitation to somebody who may not be signed in yet.
 *
 * The only thing sent is the token. Nothing identifying comes back — no
 * organization id, no user id, no invitation id — so a valid token buys exactly
 * one thing: knowing which agency invited you.
 */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const body = await invokeInvitationFunction<PreviewResponse>(
    { action: 'preview', token },
    'That invitation link is not valid.',
  )

  if (!body.invitation) throw new AppError('validation', 'That invitation link is not valid.')
  return body.invitation
}

export async function acceptInvitation(token: string): Promise<AcceptInvitationRow> {
  const { data, error } = await getSupabaseClient().rpc('accept_team_invitation', {
    p_token: token,
  })

  if (error) throw toTeamError(error)

  const row = data?.[0]
  if (!row) throw new AppError('validation', 'That invitation could not be accepted.')
  return row
}

// -----------------------------------------------------------------------------
// Membership
// -----------------------------------------------------------------------------

export async function changeMemberRole(
  organizationId: string,
  userId: string,
  role: Exclude<OrgRole, 'owner'>,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('change_team_member_role', {
    p_organization_id: organizationId,
    p_user_id: userId,
    p_role: role,
  })

  if (error) throw toTeamError(error)
}

export async function removeMember(organizationId: string, userId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('remove_team_member', {
    p_organization_id: organizationId,
    p_user_id: userId,
  })

  if (error) throw toTeamError(error)
}

export async function leaveOrganization(organizationId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc('leave_organization', {
    p_organization_id: organizationId,
  })

  if (error) throw toTeamError(error)
}

export async function transferOwnership(
  organizationId: string,
  userId: string,
  outgoingRole: Exclude<OrgRole, 'owner'>,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc('transfer_organization_ownership', {
    p_organization_id: organizationId,
    p_user_id: userId,
    p_outgoing_role: outgoingRole,
  })

  if (error) throw toTeamError(error)
}
