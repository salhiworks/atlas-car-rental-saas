import { Crown, MoreHorizontal, ShieldCheck, UserMinus, UserCog } from 'lucide-react'

import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SkeletonTable,
} from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { ROLE_LABELS } from '@/lib/authz/permissions'
import { cn } from '@/lib/utils/cn'
import type { OrgRole, TeamMemberRow } from '@/types/database'

import { canActOnMember } from '../domain'

/**
 * The roster.
 *
 * A compact table on a desktop and a stacked list on a phone, because a
 * five-column table at 390px is a horizontal scrollbar with names in it.
 *
 * The row menu offers only what this viewer may actually do, which is not a
 * security measure — the database refuses the rest either way — but an
 * administrator who is shown "Remove" against the owner and then told no has
 * learned nothing except that the interface is guessing.
 */

export interface TeamMembersTableProps {
  members: readonly TeamMemberRow[]
  actorRole: OrgRole | null
  locale: string
  timeZone: string
  isLoading?: boolean
  onChangeRole: (member: TeamMemberRow) => void
  onRemove: (member: TeamMemberRow) => void
  onTransferOwnership: (member: TeamMemberRow) => void
  onLeave: () => void
}

const ROLE_TONE: Record<OrgRole, 'brand' | 'info' | 'neutral'> = {
  owner: 'brand',
  admin: 'info',
  manager: 'neutral',
  staff: 'neutral',
}

interface RowActions {
  canChangeRole: boolean
  canRemove: boolean
  canTransfer: boolean
  canLeave: boolean
}

function actionsFor(member: TeamMemberRow, actorRole: OrgRole | null): RowActions {
  if (member.is_self) {
    return {
      canChangeRole: false,
      canRemove: false,
      canTransfer: false,
      // An owner leaves by transferring first; the dialog says so.
      canLeave: actorRole !== 'owner',
    }
  }

  const allowed = canActOnMember(actorRole, member.role)
  return {
    canChangeRole: allowed,
    canRemove: allowed,
    // Only an owner transfers, and only to somebody who is not already one.
    canTransfer: actorRole === 'owner' && member.role !== 'owner',
    canLeave: false,
  }
}

function RowMenu({
  member,
  actions,
  onChangeRole,
  onRemove,
  onTransferOwnership,
  onLeave,
}: {
  member: TeamMemberRow
  actions: RowActions
  onChangeRole: () => void
  onRemove: () => void
  onTransferOwnership: () => void
  onLeave: () => void
}) {
  const hasAny =
    actions.canChangeRole || actions.canRemove || actions.canTransfer || actions.canLeave
  if (!hasAny) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Actions for ${member.display_name}`}
          className="size-8 p-0"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.canChangeRole ? (
          <DropdownMenuItem onSelect={onChangeRole}>
            <UserCog aria-hidden="true" />
            Change role
          </DropdownMenuItem>
        ) : null}

        {/*
          Ownership transfer is separated by a rule and sits at the bottom. It is
          the one action on this menu that cannot be undone by the person taking
          it, and putting it a pixel away from "Change role" is how it gets
          clicked by accident.
        */}
        {actions.canTransfer ? (
          <>
            {actions.canChangeRole ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={onTransferOwnership}>
              <Crown aria-hidden="true" />
              Transfer ownership…
            </DropdownMenuItem>
          </>
        ) : null}

        {actions.canRemove ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem tone="critical" onSelect={onRemove}>
              <UserMinus aria-hidden="true" />
              Remove from agency
            </DropdownMenuItem>
          </>
        ) : null}

        {actions.canLeave ? (
          <DropdownMenuItem tone="critical" onSelect={onLeave}>
            <UserMinus aria-hidden="true" />
            Leave this agency
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TeamMembersTable({
  members,
  actorRole,
  locale,
  timeZone,
  isLoading = false,
  onChangeRole,
  onRemove,
  onTransferOwnership,
  onLeave,
}: TeamMembersTableProps) {
  if (isLoading) {
    return (
      <div className="p-4">
        <SkeletonTable rows={4} />
      </div>
    )
  }

  return (
    <>
      {/* Desktop */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[40rem] text-[0.8125rem]">
          <caption className="sr-only">
            Members of this agency, their role and when they joined
          </caption>
          <thead>
            <tr className="border-line text-ink-subtle text-2xs border-b tracking-wide uppercase">
              <th scope="col" className="px-4 py-2 text-start font-medium">
                Member
              </th>
              <th scope="col" className="px-4 py-2 text-start font-medium">
                Email
              </th>
              <th scope="col" className="px-4 py-2 text-start font-medium">
                Role
              </th>
              <th scope="col" className="px-4 py-2 text-start font-medium">
                Joined
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {members.map((member) => {
              const actions = actionsFor(member, actorRole)
              return (
                <tr key={member.user_id} className="hover:bg-surface-inset/60 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{member.display_name}</span>
                      {member.is_self ? (
                        <span className="text-ink-subtle text-[0.75rem]">(you)</span>
                      ) : null}
                    </div>
                    {member.job_title ? (
                      <p className="text-ink-subtle truncate text-[0.75rem]">{member.job_title}</p>
                    ) : null}
                  </td>
                  <td className="text-ink-muted max-w-[16rem] px-4 py-2.5">
                    <span className="block truncate">{member.email ?? '—'}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={ROLE_TONE[member.role]}>
                      {member.role === 'owner' ? (
                        <ShieldCheck className="size-3" aria-hidden="true" />
                      ) : null}
                      {ROLE_LABELS[member.role]}
                    </Badge>
                  </td>
                  <td className="text-ink-muted px-4 py-2.5 whitespace-nowrap">
                    {formatDate(new Date(member.joined_at), { locale, timeZone })}
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    <RowMenu
                      member={member}
                      actions={actions}
                      onChangeRole={() => onChangeRole(member)}
                      onRemove={() => onRemove(member)}
                      onTransferOwnership={() => onTransferOwnership(member)}
                      onLeave={onLeave}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Phone */}
      <ul className="divide-line divide-y md:hidden">
        {members.map((member) => {
          const actions = actionsFor(member, actorRole)
          return (
            <li key={member.user_id} className="flex min-w-0 items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-[0.8125rem] font-medium">
                    {member.display_name}
                  </span>
                  {member.is_self ? (
                    <span className="text-ink-subtle text-[0.75rem]">(you)</span>
                  ) : null}
                  <Badge tone={ROLE_TONE[member.role]}>{ROLE_LABELS[member.role]}</Badge>
                </div>
                <p className="text-ink-muted mt-0.5 truncate text-[0.75rem]">
                  {member.email ?? '—'}
                </p>
                <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                  Joined {formatDate(new Date(member.joined_at), { locale, timeZone })}
                </p>
              </div>
              <div className={cn('shrink-0')}>
                <RowMenu
                  member={member}
                  actions={actions}
                  onChangeRole={() => onChangeRole(member)}
                  onRemove={() => onRemove(member)}
                  onTransferOwnership={() => onTransferOwnership(member)}
                  onLeave={onLeave}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
