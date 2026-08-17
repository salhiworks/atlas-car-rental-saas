import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PERMISSIONS } from '@/lib/authz/permissions'
import type { OrgRole, TeamEventRow, TeamInvitationRow, TeamMemberRow } from '@/types/database'

import { InvitationsPanel } from './components/InvitationsPanel'
import { ChangeRoleDialog } from './components/MembershipDialogs'
import { InviteDialog } from './components/InviteDialog'
import { ManualLinkDialog } from './components/ManualLinkDialog'
import { TeamActivity } from './components/TeamActivity'
import { TeamMembersTable } from './components/TeamMembersTable'
import { assignableRoles, canActOnMember, describeEvent, needsManualDelivery } from './domain'

/**
 * The Team interface.
 *
 * None of this is a security control — every action here is decided again by the
 * database, which holds the only copy of the rules. What these tests protect is
 * the other half: that the interface does not OFFER something the database will
 * refuse, does not claim an email arrived when nobody knows whether it did, and
 * never renders a name or an address as anything but text.
 */

const member = (over: Partial<TeamMemberRow> = {}): TeamMemberRow => ({
  user_id: 'u-1',
  display_name: 'Sara Bennani',
  email: 'sara@agency.test',
  role: 'staff',
  joined_at: '2026-03-01T09:00:00Z',
  job_title: null,
  is_self: false,
  ...over,
})

const invitation = (over: Partial<TeamInvitationRow> = {}): TeamInvitationRow => ({
  id: 'i-1',
  email: 'new@agency.test',
  role: 'manager',
  state: 'pending',
  created_at: '2026-08-01T09:00:00Z',
  expires_at: '2026-08-08T09:00:00Z',
  last_sent_at: null,
  send_count: 0,
  delivery_state: 'pending',
  delivery_detail: null,
  invited_by_name: 'Sara Bennani',
  revoke_reason: null,
  accepted_at: null,
  resend_available_at: null,
  total_count: 1,
  ...over,
})

const display = { locale: 'en', timeZone: 'Africa/Casablanca' }

// -----------------------------------------------------------------------------
describe('the role rules the interface offers', () => {
  it('never offers owner, from any role', () => {
    for (const actor of ['owner', 'admin', 'manager', 'staff'] as const) {
      for (const target of ['owner', 'admin', 'manager', 'staff'] as const) {
        expect(assignableRoles(actor, target)).not.toContain('owner')
      }
    }
  })

  it('mirrors app.may_grant_role: never above the actor, never below administrator', () => {
    expect(assignableRoles('owner', 'staff')).toEqual(['admin', 'manager', 'staff'])
    expect(assignableRoles('admin', 'staff')).toEqual(['admin', 'manager', 'staff'])
    // A manager runs the day; deciding who runs it is a different authority.
    expect(assignableRoles('manager', 'staff')).toEqual([])
    expect(assignableRoles('staff', 'staff')).toEqual([])
    expect(assignableRoles(null, 'staff')).toEqual([])
  })

  it('puts an owner out of an administrator’s reach entirely', () => {
    expect(assignableRoles('admin', 'owner')).toEqual([])
    expect(canActOnMember('admin', 'owner')).toBe(false)
    expect(canActOnMember('owner', 'owner')).toBe(true)
    // Equal rank is allowed, which is the documented rule for two administrators.
    expect(canActOnMember('admin', 'admin')).toBe(true)
    expect(canActOnMember('manager', 'staff')).toBe(false)
  })

  it('keeps Team administration at administrator in the declared matrix', () => {
    const matrix = PERMISSIONS as Record<string, OrgRole>
    expect(matrix['team.view']).toBe('staff')
    expect(matrix['team.invite']).toBe('admin')
    expect(matrix['team.update']).toBe('admin')
    expect(matrix['team.remove']).toBe('admin')
    expect(matrix['team.history']).toBe('admin')
    expect(matrix['team.transferOwnership']).toBe('owner')
  })
})

// -----------------------------------------------------------------------------
describe('the roster', () => {
  const handlers = {
    onChangeRole: vi.fn(),
    onRemove: vi.fn(),
    onTransferOwnership: vi.fn(),
    onLeave: vi.fn(),
  }

  it('offers a staff member no action against anybody', () => {
    render(
      <TeamMembersTable
        members={[member({ user_id: 'a', role: 'owner', display_name: 'Owner' }), member()]}
        actorRole="staff"
        {...display}
        {...handlers}
      />,
    )

    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument()
  })

  it('offers an administrator nothing against the owner', () => {
    render(
      <TeamMembersTable
        members={[member({ user_id: 'a', role: 'owner', display_name: 'Owner One' })]}
        actorRole="admin"
        {...display}
        {...handlers}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Actions for Owner One' })).not.toBeInTheDocument()
  })

  it('offers an owner transfer, and only against somebody else', async () => {
    const user = userEvent.setup()
    render(
      <TeamMembersTable
        members={[
          member({ user_id: 'a', role: 'owner', display_name: 'Owner One', is_self: true }),
          member({ user_id: 'b', role: 'admin', display_name: 'Admin One' }),
        ]}
        actorRole="owner"
        {...display}
        {...handlers}
      />,
    )

    // Against themselves the owner is offered nothing: leaving requires a
    // transfer first, and there is no self-demotion path.
    expect(screen.queryByRole('button', { name: 'Actions for Owner One' })).not.toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: 'Actions for Admin One' })[0]!)
    expect(await screen.findByText('Transfer ownership…')).toBeInTheDocument()
    expect(screen.getByText('Change role')).toBeInTheDocument()
    expect(screen.getByText('Remove from agency')).toBeInTheDocument()
  })

  it('offers a non-owner a way out and no way to remove themselves', async () => {
    const user = userEvent.setup()
    render(
      <TeamMembersTable
        members={[
          member({ user_id: 'a', role: 'admin', display_name: 'Admin One', is_self: true }),
        ]}
        actorRole="admin"
        {...display}
        {...handlers}
      />,
    )

    await user.click(screen.getAllByRole('button', { name: 'Actions for Admin One' })[0]!)
    expect(await screen.findByText('Leave this agency')).toBeInTheDocument()
    expect(screen.queryByText('Remove from agency')).not.toBeInTheDocument()
    expect(screen.queryByText('Change role')).not.toBeInTheDocument()
  })

  it('renders a name as text, never as markup', () => {
    render(
      <TeamMembersTable
        members={[member({ display_name: '<img src=x onerror=alert(1)>' })]}
        actorRole="staff"
        {...display}
        {...handlers}
      />,
    )

    expect(screen.getAllByText('<img src=x onerror=alert(1)>').length).toBeGreaterThan(0)
    expect(document.querySelector('img')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
describe('what the invitation list claims', () => {
  const handlers = { onResend: vi.fn(), onRevoke: vi.fn(), onInvite: vi.fn() }

  it('never says an email was delivered', () => {
    render(
      <InvitationsPanel
        invitations={[invitation({ delivery_state: 'accepted_by_provider' })]}
        {...display}
        showingHistory={false}
        isFiltered={false}
        canManage
        pendingId={null}
        {...handlers}
      />,
    )

    expect(screen.getByText('Email accepted by provider')).toBeInTheDocument()
    expect(screen.queryByText(/delivered/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/received/i)).not.toBeInTheDocument()
  })

  it('says plainly when nobody has been emailed anything', () => {
    render(
      <InvitationsPanel
        invitations={[invitation({ delivery_state: 'not_configured' })]}
        {...display}
        showingHistory={false}
        isFiltered={false}
        canManage
        pendingId={null}
        {...handlers}
      />,
    )

    expect(screen.getByText('No email configured')).toBeInTheDocument()
    expect(screen.getByText(/Nobody has been emailed this invitation/)).toBeInTheDocument()
  })

  it('treats a failed send as still needing delivery', () => {
    expect(needsManualDelivery(invitation({ delivery_state: 'failed' }))).toBe(true)
    expect(needsManualDelivery(invitation({ delivery_state: 'accepted_by_provider' }))).toBe(false)
    // Settled invitations need nothing, whatever their delivery said.
    expect(needsManualDelivery(invitation({ state: 'revoked', delivery_state: 'failed' }))).toBe(
      false,
    )
  })

  it('says a search found nothing rather than claiming the agency has nothing', () => {
    /*
     * "Everyone invited has either joined or been withdrawn" is a claim about
     * the agency. Said while a search is filtering the list it is false, and
     * false in the direction that makes somebody stop looking for an invitation
     * that is sitting right there.
     */
    render(
      <InvitationsPanel
        invitations={[]}
        {...display}
        showingHistory={false}
        isFiltered
        canManage
        pendingId={null}
        {...handlers}
      />,
    )

    expect(screen.getByText('No invitation matches that search.')).toBeInTheDocument()
    expect(screen.queryByText(/joined or been withdrawn/)).not.toBeInTheDocument()
  })

  it('offers no resend or withdraw on a settled invitation', () => {
    render(
      <InvitationsPanel
        invitations={[invitation({ state: 'accepted', accepted_at: '2026-08-02T09:00:00Z' })]}
        {...display}
        showingHistory
        isFiltered={false}
        canManage
        pendingId={null}
        {...handlers}
      />,
    )

    expect(screen.queryByRole('button', { name: /Send again/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Withdraw/ })).not.toBeInTheDocument()
    expect(screen.getByText('Joined')).toBeInTheDocument()
  })

  it('offers a manager nothing to click', () => {
    render(
      <InvitationsPanel
        invitations={[invitation()]}
        {...display}
        showingHistory={false}
        isFiltered={false}
        canManage={false}
        pendingId={null}
        {...handlers}
      />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps a withdrawn invitation visible with its reason', () => {
    render(
      <InvitationsPanel
        invitations={[invitation({ state: 'revoked', revoke_reason: 'Left before starting.' })]}
        {...display}
        showingHistory
        isFiltered={false}
        canManage
        pendingId={null}
        {...handlers}
      />,
    )

    expect(screen.getByText('Withdrawn')).toBeInTheDocument()
    expect(screen.getByText('Left before starting.')).toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
describe('the invite dialog', () => {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    isPending: false,
    onSubmit: vi.fn(),
    onManualLink: vi.fn(),
  }

  it('does not offer owner, and says why', () => {
    render(<InviteDialog {...props} assignableRoles={['admin', 'manager', 'staff']} />)

    const select = screen.getByLabelText(/Role/)
    const options = within(select)
      .getAllByRole('option')
      .map((node) => node.textContent)
    expect(options).toEqual(['Administrator', 'Manager', 'Staff'])
    expect(
      screen.getByText(/Ownership is not something an invitation can grant/),
    ).toBeInTheDocument()
  })

  it('refuses an address that is not one before anything is sent', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<InviteDialog {...props} onSubmit={onSubmit} assignableRoles={['manager', 'staff']} />)

    await user.type(screen.getByLabelText(/Email address/), 'not-an-address')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('reports an existing member instead of pretending to invite them', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({
      outcome: 'already_member',
      invitationId: null,
      delivery: null,
      deliveryDetail: null,
      manualLink: null,
    })
    render(<InviteDialog {...props} onSubmit={onSubmit} assignableRoles={['staff']} />)

    await user.type(screen.getByLabelText(/Email address/), 'colleague@agency.test')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    expect(await screen.findByText(/already a member of this agency/)).toBeInTheDocument()
  })

  it('hands the one-time link upward rather than swallowing it', async () => {
    const user = userEvent.setup()
    const onManualLink = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue({
      outcome: 'created',
      invitationId: 'i-9',
      delivery: 'not_configured',
      deliveryDetail: 'No email provider is configured for this project.',
      manualLink: 'https://app.test/accept-invite#token=abc',
    })
    render(
      <InviteDialog
        {...props}
        onSubmit={onSubmit}
        onManualLink={onManualLink}
        assignableRoles={['staff']}
      />,
    )

    await user.type(screen.getByLabelText(/Email address/), 'new@agency.test')
    await user.click(screen.getByRole('button', { name: 'Send invitation' }))

    // The invitation id travels with the link: showing it is an event in the
    // agency's history, and the caller needs to be able to record it.
    expect(onManualLink).toHaveBeenCalledWith(
      'i-9',
      'https://app.test/accept-invite#token=abc',
      'Staff',
      'new@agency.test',
      'No email provider is configured for this project.',
    )
  })
})

// -----------------------------------------------------------------------------
describe('changing a role', () => {
  it('refuses to open an empty dropdown against a co-owner', () => {
    /*
     * With two owners, assignableRoles('owner','owner') is correctly empty —
     * ownership moves by transfer — but the dialog still opened with an empty
     * select and a live button that submitted the state default, silently
     * proposing 'staff' for a co-owner.
     */
    render(
      <ChangeRoleDialog
        member={member({ role: 'owner', display_name: 'Co Owner' })}
        actorRole="owner"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('Nothing to change here')).toBeInTheDocument()
    expect(screen.getByText(/Ownership moves through Transfer ownership/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change role' })).not.toBeInTheDocument()
  })

  it('offers the roles an owner may actually grant to an administrator', () => {
    render(
      <ChangeRoleDialog
        member={member({ role: 'admin', display_name: 'Admin One' })}
        actorRole="owner"
        isPending={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    const options = within(screen.getByLabelText(/Role/)).getAllByRole('option')
    expect(options.map((node) => node.textContent)).toEqual(['Administrator', 'Manager', 'Staff'])
  })
})

// -----------------------------------------------------------------------------
describe('the one-time link', () => {
  it('says what it is before it says what it is for', () => {
    render(
      <ManualLinkDialog
        link="https://app.test/accept-invite#token=abc"
        roleLabel="Manager"
        email="new@agency.test"
        detail="No email provider is configured for this project."
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Treat this link like a password')).toBeInTheDocument()
    expect(screen.getByText(/issuing another link replaces this one/)).toBeInTheDocument()
    expect(screen.getByText('https://app.test/accept-invite#token=abc')).toBeInTheDocument()
  })

  it('is closed when there is no link, so nothing lingers on screen', () => {
    render(
      <ManualLinkDialog
        link={null}
        roleLabel="Manager"
        email={null}
        detail={null}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByText('Send this link yourself')).not.toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
describe('membership history', () => {
  const event = (over: Partial<TeamEventRow> = {}): TeamEventRow => ({
    id: 'e-1',
    event: 'role_changed',
    occurred_at: '2026-08-10T10:00:00Z',
    actor_name: 'Sara Bennani',
    target_name: 'Youssef Alami',
    target_email: null,
    previous_role: 'staff',
    new_role: 'manager',
    detail: null,
    total_count: 1,
    ...over,
  })

  it('reads as a sentence about people, not a JSON dump', () => {
    render(
      <TeamActivity
        events={[event()]}
        {...display}
        page={0}
        pageSize={12}
        total={1}
        isFetchingMore={false}
        onPageChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Sara Bennani')).toBeInTheDocument()
    expect(screen.getByText(/changed/)).toBeInTheDocument()
    expect(screen.getByText(/from staff to manager/)).toBeInTheDocument()
  })

  it('describes each kind of event without inventing a role it does not have', () => {
    expect(describeEvent(event({ event: 'member_left', new_role: null }))).toMatchObject({
      actor: 'Youssef Alami',
      verb: 'left the agency',
      trailer: 'as staff',
    })
    expect(
      describeEvent(
        event({ event: 'invitation_created', target_email: 'x@y.test', previous_role: null }),
      ),
    ).toMatchObject({ verb: 'invited', subject: 'x@y.test', trailer: 'as manager' })
    expect(
      describeEvent(event({ event: 'invitation_link_revealed', target_email: 'x@y.test' })),
    ).toMatchObject({ trailer: 'to send by hand' })
  })

  it('pages in both directions instead of replacing what it was asked to extend', async () => {
    // "Show earlier activity" swapped events 1-12 for 13-24 with no way back,
    // on a card still headed "Recent activity".
    const onPageChange = vi.fn()
    const { rerender } = render(
      <TeamActivity
        events={[event({ total_count: 30 })]}
        {...display}
        page={0}
        pageSize={12}
        total={30}
        isFetchingMore={false}
        onPageChange={onPageChange}
      />,
    )

    expect(screen.getByText('1–12 of 30')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Earlier' }))
    expect(onPageChange).toHaveBeenCalledWith(1)

    rerender(
      <TeamActivity
        events={[event({ total_count: 30 })]}
        {...display}
        page={1}
        pageSize={12}
        total={30}
        isFetchingMore={false}
        onPageChange={onPageChange}
      />,
    )
    expect(screen.getByText('13–24 of 30')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Newer' })).toBeEnabled()
  })

  it('renders an actor name as text even when it looks like markup', () => {
    render(
      <TeamActivity
        events={[event({ actor_name: '<script>alert(1)</script>' })]}
        {...display}
        page={0}
        pageSize={12}
        total={1}
        isFetchingMore={false}
        onPageChange={vi.fn()}
      />,
    )

    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })
})
