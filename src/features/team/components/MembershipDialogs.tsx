import { useState } from 'react'

import { Alert, Button, ConfirmDialog, Dialog, DialogContent, Field, Select } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/authz/permissions'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { OrgRole, TeamMemberRow } from '@/types/database'

import { ROLE_SUMMARY, assignableRoles } from '../domain'

/**
 * The three dialogs that change who can do what.
 *
 * The confirmation copy states consequences rather than raising alarm. "Are you
 * sure?" tells nobody anything; "their contracts and costs stay exactly as they
 * are, and their account is untouched" is the sentence that lets an owner decide
 * — and it is also true, which matters more.
 */

// -----------------------------------------------------------------------------

export interface ChangeRoleDialogProps {
  member: TeamMemberRow | null
  actorRole: OrgRole | null
  isPending: boolean
  onCancel: () => void
  onConfirm: (role: Exclude<OrgRole, 'owner'>) => Promise<void>
}

export function ChangeRoleDialog({
  member,
  actorRole,
  isPending,
  onCancel,
  onConfirm,
}: ChangeRoleDialogProps) {
  const options = member ? assignableRoles(actorRole, member.role) : []
  const [role, setRole] = useState<Exclude<OrgRole, 'owner'>>('staff')
  const [error, setError] = useState<string | null>(null)

  /*
   * Reset when the dialog is pointed at somebody else.
   *
   * Adjusted during render rather than in an effect: an effect would paint the
   * previous member's role for one frame — which, in a dialog whose whole job is
   * to say what somebody's role currently is, is a wrong answer on screen.
   * React re-runs this component immediately and commits nothing in between.
   */
  const [shownFor, setShownFor] = useState<string | null>(null)
  if (member && member.user_id !== shownFor) {
    setShownFor(member.user_id)
    setRole(member.role === 'owner' ? 'staff' : member.role)
    setError(null)
  }

  const submit = async () => {
    setError(null)
    try {
      await onConfirm(role)
    } catch (cause) {
      setError(toErrorMessage(cause))
    }
  }

  /*
   * No roles to offer means no dialog.
   *
   * With two owners, `assignableRoles('owner', 'owner')` is correctly empty —
   * ownership moves by transfer — but the dialog still opened with an empty
   * dropdown and a live Change role button that submitted the state default,
   * silently proposing 'staff' for a co-owner.
   */
  if (member !== null && options.length === 0) {
    return (
      <Dialog open onOpenChange={(open) => !open && onCancel()}>
        <DialogContent
          title="Nothing to change here"
          size="sm"
          footer={
            <Button variant="primary" onClick={onCancel}>
              Close
            </Button>
          }
        >
          <p className="text-[0.8125rem] leading-5">
            {member.display_name} is an owner. Ownership moves through Transfer ownership, which is
            the only way this agency changes hands.
          </p>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        title="Change role"
        description={member ? `What ${member.display_name} can do in this agency.` : undefined}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              isLoading={isPending}
              disabled={member?.role === role}
            >
              Change role
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <Alert tone="critical">{error}</Alert> : null}

          <Field label="Role" hint={ROLE_SUMMARY[role]}>
            <Select
              value={role}
              onChange={(event) => setRole(event.target.value as Exclude<OrgRole, 'owner'>)}
              options={options.map((value) => ({ value, label: ROLE_LABELS[value] }))}
            />
          </Field>

          <p className="text-ink-subtle text-[0.75rem] leading-4">
            This takes effect immediately, everywhere. They do not need to sign out and back in.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// -----------------------------------------------------------------------------

export interface RemoveMemberDialogProps {
  member: TeamMemberRow | null
  isPending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function RemoveMemberDialog({
  member,
  isPending,
  error,
  onCancel,
  onConfirm,
}: RemoveMemberDialogProps) {
  return (
    <ConfirmDialog
      open={member !== null}
      onOpenChange={(open) => !open && onCancel()}
      title={member ? `Remove ${member.display_name}?` : 'Remove member'}
      confirmLabel="Remove from agency"
      tone="danger"
      isPending={isPending}
      onConfirm={onConfirm}
    >
      <div className="space-y-3 text-[0.8125rem] leading-5">
        {error ? <Alert tone="critical">{error}</Alert> : null}
        <p>
          They lose access to this agency straight away — contracts, customers, vehicles, costs and
          reports.
        </p>
        {/*
          Said plainly because it is what people actually worry about, and
          because it is true: this deletes a membership, not a person and not
          their work.
        */}
        <ul className="text-ink-muted list-disc space-y-1 ps-5">
          <li>Everything they recorded stays exactly as it is, still attributed to them.</li>
          <li>Their account is not deleted, and any other agency they belong to is untouched.</li>
          <li>You can invite them back at any time.</li>
        </ul>
      </div>
    </ConfirmDialog>
  )
}

// -----------------------------------------------------------------------------

export interface LeaveOrganizationDialogProps {
  open: boolean
  organizationName: string
  isOwner: boolean
  isPending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function LeaveOrganizationDialog({
  open,
  organizationName,
  isOwner,
  isPending,
  error,
  onCancel,
  onConfirm,
}: LeaveOrganizationDialogProps) {
  if (isOwner) {
    return (
      <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
        <DialogContent
          title="Transfer ownership first"
          size="sm"
          footer={
            <Button variant="primary" onClick={onCancel}>
              Close
            </Button>
          }
        >
          <p className="text-[0.8125rem] leading-5">
            An agency always has an owner, so you cannot leave {organizationName} while you are it.
            Transfer ownership to another member first, then leave.
          </p>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={`Leave ${organizationName}?`}
      confirmLabel="Leave agency"
      tone="danger"
      isPending={isPending}
      onConfirm={onConfirm}
    >
      <div className="space-y-3 text-[0.8125rem] leading-5">
        {error ? <Alert tone="critical">{error}</Alert> : null}
        <p>
          You lose access to this agency immediately. Your account and your work stay as they are.
        </p>
        <p className="text-ink-muted">
          An administrator would have to invite you again to come back.
        </p>
      </div>
    </ConfirmDialog>
  )
}

// -----------------------------------------------------------------------------

export interface TransferOwnershipDialogProps {
  member: TeamMemberRow | null
  organizationName: string
  isPending: boolean
  onCancel: () => void
  onConfirm: (outgoingRole: Exclude<OrgRole, 'owner'>) => Promise<void>
}

/**
 * Ownership transfer.
 *
 * More weight than a role change, and less noise than a deletion: this is a
 * deliberate handover, not an accident waiting to happen, so the copy is serious
 * and the styling is not. The one thing it insists on is that the outgoing owner
 * chooses what they keep, because "and then what am I?" is the question the
 * dialog exists to answer.
 */
export function TransferOwnershipDialog({
  member,
  organizationName,
  isPending,
  onCancel,
  onConfirm,
}: TransferOwnershipDialogProps) {
  const [outgoingRole, setOutgoingRole] = useState<Exclude<OrgRole, 'owner'>>('admin')
  const [error, setError] = useState<string | null>(null)

  const [shownFor, setShownFor] = useState<string | null>(null)
  if (member && member.user_id !== shownFor) {
    setShownFor(member.user_id)
    setOutgoingRole('admin')
    setError(null)
  }

  const submit = async () => {
    setError(null)
    try {
      await onConfirm(outgoingRole)
    } catch (cause) {
      setError(toErrorMessage(cause))
    }
  }

  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        title="Transfer ownership"
        description={`${organizationName} will have a new owner.`}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submit()} isLoading={isPending}>
              Transfer ownership
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <Alert tone="critical">{error}</Alert> : null}

          <div className="border-line rounded-md border p-3">
            <p className="text-[0.8125rem] leading-5">
              <span className="font-medium">{member?.display_name}</span> becomes the owner of{' '}
              {organizationName}.
            </p>
            <p className="text-ink-muted mt-1 text-[0.75rem] leading-4">{member?.email}</p>
          </div>

          <Field label="Your role afterwards" hint={ROLE_SUMMARY[outgoingRole]}>
            <Select
              value={outgoingRole}
              onChange={(event) => setOutgoingRole(event.target.value as Exclude<OrgRole, 'owner'>)}
              options={(['admin', 'manager', 'staff'] as const).map((value) => ({
                value,
                label: ROLE_LABELS[value],
              }))}
            />
          </Field>

          <ul className="text-ink-muted list-disc space-y-1 ps-5 text-[0.8125rem] leading-5">
            <li>Both changes happen together. The agency is never without an owner.</li>
            <li>Only the new owner can transfer ownership again, including back to you.</li>
            <li>Nothing else changes: no contract, cost or customer record is touched.</li>
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
