import { Search, SearchX, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  Select,
  useToast,
} from '@/components/ui'
import { InvitationsPanel } from '@/features/team/components/InvitationsPanel'
import { InviteDialog } from '@/features/team/components/InviteDialog'
import { ManualLinkDialog } from '@/features/team/components/ManualLinkDialog'
import {
  ChangeRoleDialog,
  LeaveOrganizationDialog,
  RemoveMemberDialog,
  TransferOwnershipDialog,
} from '@/features/team/components/MembershipDialogs'
import { TeamActivity } from '@/features/team/components/TeamActivity'
import { TeamMembersTable } from '@/features/team/components/TeamMembersTable'
import { recordManualLinkShown } from '@/features/team/api'
import { ROLE_SUMMARY, assignableRoles } from '@/features/team/domain'
import {
  EVENTS_PAGE_SIZE,
  INVITATIONS_PAGE_SIZE,
  useChangeMemberRole,
  useInviteMember,
  useLeaveOrganization,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useTeamEvents,
  useTeamInvitations,
  useTeamMembers,
  useTransferOwnership,
} from '@/features/team/queries'
import {
  useOrganization,
  usePermission,
  useWorkspace,
} from '@/features/workspace/workspace-context'
import { ROLE_LABELS } from '@/lib/authz/permissions'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { OrgRole, TeamInvitationRow, TeamMemberRow } from '@/types/database'

/**
 * Team.
 *
 * One workspace with three sections — who is here, who has been invited, and
 * what has changed — rather than three pages that each know a third of the
 * answer. Everything below `staff` sees is the roster; invitations and history
 * are an administrator's, because both name people who are not members.
 *
 * Nothing on this page is a security control. Every action it offers is decided
 * again by the database, which holds the only copy of the rules; hiding a button
 * spares somebody a refusal, it does not create one.
 */
export function TeamPage() {
  const organization = useOrganization()
  const { role } = useWorkspace()
  const toast = useToast()

  const canManage = usePermission('team.invite')
  const canSeeHistory = usePermission('team.history')

  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | OrgRole>('all')
  const [showHistory, setShowHistory] = useState(false)
  const [eventPage, setEventPage] = useState(0)
  const [invitationPage, setInvitationPage] = useState(0)
  const [inviteOpen, setInviteOpen] = useState(false)

  const [roleTarget, setRoleTarget] = useState<TeamMemberRow | null>(null)
  const [removeTarget, setRemoveTarget] = useState<TeamMemberRow | null>(null)
  const [transferTarget, setTransferTarget] = useState<TeamMemberRow | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyInvitation, setBusyInvitation] = useState<string | null>(null)
  /**
   * The one-time link, when nothing could carry the invitation.
   *
   * Held here rather than inside whichever dialog produced it, because both
   * inviting somebody and sending an existing invitation again can end this way
   * — and a resend that rotates the token and then throws the new link away
   * leaves an administrator strictly worse off than before they clicked.
   */
  const [manualLink, setManualLink] = useState<{
    link: string
    roleLabel: string
    email: string
    detail: string | null
  } | null>(null)

  /**
   * Shows a one-time link, and records that it was shown.
   *
   * Handing an administrator a bearer capability is an event in the agency's
   * history, not a rendering detail — the delivery function reports what the
   * email provider did, and this is the only place that knows the link reached
   * a person. It also resets the mutation that produced it, so the raw token
   * does not sit in the query client's mutation cache after the dialog closes.
   */
  const showManualLink = (
    invitationId: string | null,
    link: string,
    roleLabel: string,
    email: string,
    detail: string | null,
  ) => {
    setManualLink({ link, roleLabel, email, detail })
    if (invitationId) void recordManualLinkShown(invitationId)
  }

  const membersQuery = useTeamMembers()
  const invitationsQuery = useTeamInvitations(showHistory, invitationPage, canManage)
  const eventsQuery = useTeamEvents(eventPage, canSeeHistory)

  const invite = useInviteMember()
  const resend = useResendInvitation()
  const revoke = useRevokeInvitation()
  const changeRole = useChangeMemberRole()
  const remove = useRemoveMember()
  const leave = useLeaveOrganization()
  const transfer = useTransferOwnership()

  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return members.filter((member) => {
      if (roleFilter !== 'all' && member.role !== roleFilter) return false
      if (!needle) return true
      return (
        member.display_name.toLowerCase().includes(needle) ||
        (member.email ?? '').toLowerCase().includes(needle)
      )
    })
  }, [members, search, roleFilter])

  const invitations = useMemo(() => {
    const rows = invitationsQuery.data ?? []
    const needle = search.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) => row.email.toLowerCase().includes(needle))
  }, [invitationsQuery.data, search])

  const events = eventsQuery.data ?? []
  const eventTotal = events[0]?.total_count ?? 0
  const invitationTotal = invitationsQuery.data?.[0]?.total_count ?? 0
  const invitationsFiltered = search.trim().length > 0

  const isOnlyMember = members.length === 1
  const canInviteRoles = assignableRoles(role, 'staff')

  /*
   * A failed read is not an empty team.
   *
   * Rendering "No members" because a query errored tells an owner their agency
   * is empty, which is a factual claim about their business that the product has
   * no basis for. The error is shown as an error.
   */
  if (membersQuery.isError) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Agency" title="Team" />
        <Card>
          <ErrorState error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />
        </Card>
      </div>
    )
  }

  const handleRemove = () => {
    if (!removeTarget) return
    setActionError(null)
    remove.mutate(removeTarget.user_id, {
      onSuccess: () => {
        toast.success('Member removed', `${removeTarget.display_name} no longer has access.`)
        setRemoveTarget(null)
      },
      onError: (error) => setActionError(toErrorMessage(error)),
    })
  }

  const handleLeave = () => {
    setActionError(null)
    leave.mutate(undefined, {
      onSuccess: () => setLeaveOpen(false),
      onError: (error) => setActionError(toErrorMessage(error)),
    })
  }

  const handleResend = (invitation: TeamInvitationRow) => {
    setBusyInvitation(invitation.id)
    resend.mutate(invitation.id, {
      onSettled: () => setBusyInvitation(null),
      onSuccess: (result) => {
        if (result.manualLink) {
          // A link is a bearer secret, so it never goes in a toast — it goes in
          // the dialog that says what it is.
          showManualLink(
            invitation.id,
            result.manualLink,
            ROLE_LABELS[invitation.role],
            invitation.email,
            result.deliveryDetail,
          )
          return
        }
        toast.success('Invitation sent again', 'The previous link has stopped working.')
      },
      onError: (error) => toast.error('Could not resend', toErrorMessage(error)),
    })
  }

  const handleRevoke = (invitation: TeamInvitationRow) => {
    setBusyInvitation(invitation.id)
    revoke.mutate(
      { invitationId: invitation.id, reason: 'Withdrawn by an administrator.' },
      {
        onSettled: () => setBusyInvitation(null),
        onSuccess: () =>
          toast.success('Invitation withdrawn', 'The link in that email no longer works.'),
        onError: (error) => toast.error('Could not withdraw', toErrorMessage(error)),
      },
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agency"
        title="Team"
        description={`Who can work in ${organization.name}, and what they can do.`}
        actions={
          canManage ? (
            <Button
              variant="primary"
              leadingIcon={<UserPlus />}
              onClick={() => setInviteOpen(true)}
            >
              Invite member
            </Button>
          ) : undefined
        }
      />

      {/*
        A new agency has exactly one person in it. Rather than an empty state
        that implies something is missing, say what the roles are — this is the
        moment somebody is deciding who to bring in and as what.
      */}
      {!membersQuery.isPending && isOnlyMember && canManage ? (
        <Alert tone="info" title="It is just you so far">
          <p className="mb-2">
            Invite the people who work with you and give each of them the access their job needs.
          </p>
          <ul className="space-y-1">
            {(['admin', 'manager', 'staff'] as const).map((value) => (
              <li key={value} className="text-[0.8125rem] leading-5">
                <span className="font-medium">{ROLE_LABELS[value]}</span> — {ROLE_SUMMARY[value]}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Members"
          description={
            membersQuery.isPending
              ? undefined
              : `${members.length} ${members.length === 1 ? 'person' : 'people'} with access`
          }
          actions={
            members.length > 4 ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-56">
                  <Search
                    className="text-ink-subtle pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
                    aria-hidden="true"
                  />
                  <Input
                    aria-label="Search members"
                    placeholder="Name or email"
                    className="h-8 ps-8 text-[0.8125rem]"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <Select
                  aria-label="Filter by role"
                  className="h-8 w-40 text-[0.8125rem]"
                  value={roleFilter}
                  onChange={(event) => setRoleFilter(event.target.value as 'all' | OrgRole)}
                  options={[
                    { value: 'all', label: 'Every role' },
                    { value: 'owner', label: 'Owner' },
                    { value: 'admin', label: 'Administrators' },
                    { value: 'manager', label: 'Managers' },
                    { value: 'staff', label: 'Staff' },
                  ]}
                />
              </div>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {!membersQuery.isPending && filtered.length === 0 ? (
            <EmptyState
              size="sm"
              icon={SearchX}
              title="No member matches that search"
              description="Try a different name or email, or choose another role."
            />
          ) : (
            <TeamMembersTable
              members={filtered}
              actorRole={role}
              locale={organization.locale}
              timeZone={organization.time_zone}
              isLoading={membersQuery.isPending}
              onChangeRole={setRoleTarget}
              onRemove={(member) => {
                setActionError(null)
                setRemoveTarget(member)
              }}
              onTransferOwnership={setTransferTarget}
              onLeave={() => {
                setActionError(null)
                setLeaveOpen(true)
              }}
            />
          )}
        </CardBody>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader
            title="Invitations"
            description={
              showHistory
                ? 'Everything ever sent, most recent first.'
                : 'Outstanding and recently expired.'
            }
            actions={
              <div className="flex items-center gap-2">
                {invitationTotal > INVITATIONS_PAGE_SIZE ? (
                  <Badge tone="neutral">{invitationTotal} total</Badge>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowHistory((value) => !value)
                    setInvitationPage(0)
                  }}
                >
                  {showHistory ? 'Show outstanding only' : 'Show all history'}
                </Button>
              </div>
            }
          />
          <CardBody className="p-0">
            {invitationsQuery.isError ? (
              <ErrorState
                error={invitationsQuery.error}
                onRetry={() => void invitationsQuery.refetch()}
              />
            ) : (
              <InvitationsPanel
                invitations={invitations}
                locale={organization.locale}
                timeZone={organization.time_zone}
                isLoading={invitationsQuery.isPending}
                showingHistory={showHistory}
                isFiltered={invitationsFiltered}
                canManage={canManage}
                pendingId={busyInvitation}
                onResend={handleResend}
                onRevoke={handleRevoke}
                onInvite={() => setInviteOpen(true)}
              />
            )}

            {/*
              Without this the list was pinned to the first twenty rows while the
              header cheerfully reported a larger total, so the twenty-first
              invitation could never be resent or withdrawn from the interface.
            */}
            {invitationTotal > INVITATIONS_PAGE_SIZE ? (
              <div className="border-line flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
                <p className="text-ink-subtle text-[0.75rem]">
                  {invitationPage * INVITATIONS_PAGE_SIZE + 1}–
                  {Math.min((invitationPage + 1) * INVITATIONS_PAGE_SIZE, invitationTotal)} of{' '}
                  {invitationTotal}
                </p>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={invitationPage === 0 || invitationsQuery.isFetching}
                    onClick={() => setInvitationPage((page) => page - 1)}
                  >
                    Newer
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      (invitationPage + 1) * INVITATIONS_PAGE_SIZE >= invitationTotal ||
                      invitationsQuery.isFetching
                    }
                    onClick={() => setInvitationPage((page) => page + 1)}
                  >
                    Older
                  </Button>
                </div>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {canSeeHistory ? (
        <Card>
          <CardHeader
            title="Recent activity"
            description="Invitations, role changes and departures."
          />
          <CardBody className="p-0">
            {eventsQuery.isError ? (
              <ErrorState error={eventsQuery.error} onRetry={() => void eventsQuery.refetch()} />
            ) : (
              <TeamActivity
                events={events}
                locale={organization.locale}
                timeZone={organization.time_zone}
                isLoading={eventsQuery.isPending}
                page={eventPage}
                pageSize={EVENTS_PAGE_SIZE}
                total={eventTotal}
                isFetchingMore={eventsQuery.isFetching}
                onPageChange={setEventPage}
              />
            )}
          </CardBody>
        </Card>
      ) : null}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        assignableRoles={canInviteRoles}
        isPending={invite.isPending}
        onSubmit={(input) => invite.mutateAsync(input)}
        onManualLink={(invitationId, link, roleLabel, email, detail) =>
          showManualLink(invitationId, link, roleLabel, email, detail)
        }
      />

      <ManualLinkDialog
        link={manualLink?.link ?? null}
        roleLabel={manualLink?.roleLabel ?? ''}
        email={manualLink?.email ?? null}
        detail={manualLink?.detail ?? null}
        onClose={() => {
          setManualLink(null)
          // Nothing keeps a copy: the mutation cache held the resolved value,
          // token and all, long after the dialog said "shown once".
          invite.reset()
          resend.reset()
        }}
      />

      <ChangeRoleDialog
        member={roleTarget}
        actorRole={role}
        isPending={changeRole.isPending}
        onCancel={() => setRoleTarget(null)}
        onConfirm={async (nextRole) => {
          if (!roleTarget) return
          await changeRole.mutateAsync({ userId: roleTarget.user_id, role: nextRole })
          toast.success(
            'Role changed',
            `${roleTarget.display_name} is now ${ROLE_LABELS[nextRole]}.`,
          )
          setRoleTarget(null)
        }}
      />

      <RemoveMemberDialog
        member={removeTarget}
        isPending={remove.isPending}
        error={actionError}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={handleRemove}
      />

      <TransferOwnershipDialog
        member={transferTarget}
        organizationName={organization.name}
        isPending={transfer.isPending}
        onCancel={() => setTransferTarget(null)}
        onConfirm={async (outgoingRole) => {
          if (!transferTarget) return
          await transfer.mutateAsync({ userId: transferTarget.user_id, outgoingRole })
          toast.success(
            'Ownership transferred',
            `${transferTarget.display_name} owns ${organization.name}. You are now ${ROLE_LABELS[outgoingRole]}.`,
          )
          setTransferTarget(null)
        }}
      />

      <LeaveOrganizationDialog
        open={leaveOpen}
        organizationName={organization.name}
        isOwner={role === 'owner'}
        isPending={leave.isPending}
        error={actionError}
        onCancel={() => setLeaveOpen(false)}
        onConfirm={handleLeave}
      />
    </div>
  )
}
