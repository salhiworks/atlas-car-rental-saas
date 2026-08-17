import { MailPlus, RotateCw, X } from 'lucide-react'

import { Badge, Button, EmptyState, Skeleton } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/authz/permissions'
import { formatDate } from '@/lib/datetime/format'
import { useNow } from '@/lib/utils/useNow'
import type { TeamInvitationRow } from '@/types/database'

import {
  DELIVERY_LABEL,
  DELIVERY_TONE,
  INVITATION_STATE_LABEL,
  INVITATION_STATE_TONE,
  needsManualDelivery,
  resendAvailableIn,
} from '../domain'

/**
 * Outstanding invitations.
 *
 * The column people misread is DELIVERY. An invitation existing and an email
 * arriving are separate facts, and this panel keeps them separate: the badge on
 * the left is the invitation's own state, the note underneath is what is known
 * about the message. "Email accepted by provider" is as far as this product will
 * go, because a 202 from an email API is not a colleague reading anything.
 *
 * Nothing here can show a token. The list read model does not return one and
 * never has — the only copy that ever existed left in the email, or in the
 * one-time dialog an administrator opened deliberately.
 */

export interface InvitationsPanelProps {
  invitations: readonly TeamInvitationRow[]
  locale: string
  timeZone: string
  isLoading?: boolean
  showingHistory: boolean
  /** True when a search is narrowing the list, so "nothing" means "no match". */
  isFiltered: boolean
  canManage: boolean
  pendingId: string | null
  onResend: (invitation: TeamInvitationRow) => void
  onRevoke: (invitation: TeamInvitationRow) => void
  onInvite: () => void
}

export function InvitationsPanel({
  invitations,
  locale,
  timeZone,
  isLoading = false,
  showingHistory,
  isFiltered,
  canManage,
  pendingId,
  onResend,
  onRevoke,
  onInvite,
}: InvitationsPanelProps) {
  /*
   * The clock, subscribed to rather than read.
   *
   * The resend cooldown is a countdown, so the button has to re-enable itself
   * without anybody clicking anything. Reading Date.now() during render would
   * make this component's output depend on when React happened to call it; a
   * subscription gives it a value that only changes on a tick. Before the first
   * tick it is zero, which is read below as "no cooldown known" — erring toward
   * an enabled button, because the server enforces the floor either way.
   */
  const now = useNow()

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    )
  }

  if (invitations.length === 0) {
    /*
     * "Everyone invited has either joined or been withdrawn" is a claim about
     * the agency. Said while a search box is filtering the list, it is simply
     * false — and it is false in the direction that makes somebody stop looking
     * for an invitation that is sitting right there.
     */
    if (isFiltered) {
      return (
        <p className="text-ink-muted px-4 py-8 text-center text-[0.8125rem]">
          No invitation matches that search.
        </p>
      )
    }

    return (
      <EmptyState
        icon={MailPlus}
        title={showingHistory ? 'No invitations yet' : 'Nothing outstanding'}
        description={
          showingHistory
            ? 'Invite somebody by email and they will appear here until they join.'
            : 'Everyone invited has either joined or been withdrawn.'
        }
        action={
          canManage ? (
            <Button variant="secondary" size="sm" onClick={onInvite}>
              Invite someone
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <ul className="divide-line divide-y">
      {invitations.map((invitation) => {
        const cooldown = now === 0 ? 0 : resendAvailableIn(invitation, now)
        const isPending = invitation.state === 'pending'
        const busy = pendingId === invitation.id

        return (
          <li key={invitation.id} className="px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-[0.8125rem] font-medium">
                    {invitation.email}
                  </span>
                  <Badge tone={INVITATION_STATE_TONE[invitation.state]}>
                    {INVITATION_STATE_LABEL[invitation.state]}
                  </Badge>
                  <Badge tone="neutral">{ROLE_LABELS[invitation.role]}</Badge>
                </div>

                <p className="text-ink-subtle mt-1 text-[0.75rem] leading-4">
                  Invited by {invitation.invited_by_name || 'a colleague'} on{' '}
                  {formatDate(new Date(invitation.created_at), { locale, timeZone })}
                  {isPending ? (
                    <>
                      {' · '}expires{' '}
                      {formatDate(new Date(invitation.expires_at), { locale, timeZone })}
                    </>
                  ) : null}
                  {invitation.state === 'accepted' && invitation.accepted_at ? (
                    <>
                      {' · '}joined{' '}
                      {formatDate(new Date(invitation.accepted_at), { locale, timeZone })}
                    </>
                  ) : null}
                </p>

                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone={DELIVERY_TONE[invitation.delivery_state]}>
                    {DELIVERY_LABEL[invitation.delivery_state]}
                  </Badge>
                  {invitation.delivery_detail ? (
                    <span className="text-ink-subtle text-[0.75rem]">
                      {invitation.delivery_detail}
                    </span>
                  ) : null}
                </div>

                {isPending && needsManualDelivery(invitation) ? (
                  <p className="text-caution-700 mt-1.5 text-[0.75rem] leading-4">
                    Nobody has been emailed this invitation. Use Send again to produce a link you
                    can pass on yourself.
                  </p>
                ) : null}

                {invitation.state === 'revoked' && invitation.revoke_reason ? (
                  <p className="text-ink-subtle mt-1 text-[0.75rem] leading-4">
                    {invitation.revoke_reason}
                  </p>
                ) : null}
              </div>

              {canManage && isPending ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onResend(invitation)}
                    disabled={busy || cooldown > 0}
                    isLoading={busy}
                    title={
                      cooldown > 0
                        ? `Sent moments ago. Available again in ${Math.ceil(cooldown / 1000)}s.`
                        : undefined
                    }
                  >
                    <RotateCw className="size-3.5" aria-hidden="true" />
                    Send again
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRevoke(invitation)}
                    disabled={busy}
                    aria-label={`Withdraw the invitation to ${invitation.email}`}
                    className="size-8 p-0"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
