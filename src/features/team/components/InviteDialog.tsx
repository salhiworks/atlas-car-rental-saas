import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Alert, Button, Dialog, DialogContent, Field, Input, Select } from '@/components/ui'
import { ROLE_LABELS } from '@/lib/authz/permissions'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { OrgRole } from '@/types/database'

import { INVITABLE_ROLES, ROLE_INVITE_HINT } from '../domain'
import type { IssueInvitationResult } from '../api'

/**
 * The invite dialog.
 *
 * Two fields and a button. Owner is not among the roles — not hidden from a
 * dropdown that would otherwise offer it, but absent from the whole path: the
 * database refuses `owner` on an invitation with a CHECK constraint, and
 * ownership moves through its own workflow.
 */

const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter an email address.')
    .max(320, 'That address is too long.')
    .email('Enter a valid email address, like name@agency.com.'),
  role: z.enum(['admin', 'manager', 'staff']),
})

type InviteInput = z.infer<typeof inviteSchema>

export interface InviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  assignableRoles: readonly Exclude<OrgRole, 'owner'>[]
  isPending: boolean
  onSubmit: (input: InviteInput) => Promise<IssueInvitationResult>
  /**
   * Called when an invitation was created but nothing could carry it.
   *
   * Handed upward rather than shown here, so the one-time link has exactly one
   * presentation whether it came from inviting somebody or from sending an
   * existing invitation again.
   */
  onManualLink: (
    invitationId: string | null,
    link: string,
    roleLabel: string,
    email: string,
    detail: string | null,
  ) => void
}

export function InviteDialog({
  open,
  onOpenChange,
  assignableRoles,
  isPending,
  onSubmit,
  onManualLink,
}: InviteDialogProps) {
  const [formError, setFormError] = useState<string | null>(null)

  const roles = assignableRoles.length > 0 ? assignableRoles : INVITABLE_ROLES

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: roles.includes('staff') ? 'staff' : roles[0]! },
  })

  useEffect(() => {
    if (!open) {
      setFormError(null)
      reset()
    }
  }, [open, reset])

  const role = watch('role')

  const submit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const outcome = await onSubmit(values)
      if (outcome.outcome === 'already_member') {
        setFormError('That person is already a member of this agency.')
        return
      }
      onOpenChange(false)
      if (outcome.manualLink) {
        onManualLink(
          outcome.invitationId,
          outcome.manualLink,
          ROLE_LABELS[values.role],
          values.email.trim(),
          outcome.deliveryDetail,
        )
      }
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Invite someone"
        description="They join this agency only — nothing else in their account changes."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              isLoading={isPending}
              type="submit"
              form="invite-form"
            >
              Send invitation
            </Button>
          </>
        }
      >
        <form
          id="invite-form"
          onSubmit={(event) => void submit(event)}
          className="space-y-4"
          noValidate
        >
          {formError ? <Alert tone="critical">{formError}</Alert> : null}

          <Field label="Email address" error={errors.email?.message} required>
            <Input
              type="email"
              autoComplete="off"
              autoFocus
              placeholder="colleague@agency.com"
              {...register('email')}
            />
          </Field>

          <Field label="Role" error={errors.role?.message} hint={ROLE_INVITE_HINT[role]} required>
            <Select
              options={roles.map((value) => ({ value, label: ROLE_LABELS[value] }))}
              {...register('role')}
            />
          </Field>

          <p className="text-ink-subtle text-[0.75rem] leading-4">
            Ownership is not something an invitation can grant. It moves through Transfer ownership,
            from the current owner, deliberately.
          </p>
        </form>
      </DialogContent>
    </Dialog>
  )
}
