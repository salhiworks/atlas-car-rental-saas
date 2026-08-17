import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useOrganization, useWorkspace } from '@/features/workspace/workspace-context'
import type { OrgRole } from '@/types/database'

import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  fetchSeatSummary,
  fetchTeamEvents,
  fetchTeamInvitations,
  fetchTeamMembers,
  leaveOrganization,
  removeMember,
  resendInvitation,
  revokeInvitation,
  transferOwnership,
} from './api'

/**
 * Query keys for Team.
 *
 * EVERY KEY BEGINS WITH THE ORGANIZATION, for the same reason Reports does: the
 * workspace switcher invalidates exactly `['organization']`, so a key shaped
 * `['team', orgId, …]` would survive a switch and render one agency's roster —
 * names, addresses and who its administrators are — under another agency's name.
 */
export const teamKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'team'] as const,
  members: (organizationId: string) => ['organization', organizationId, 'team', 'members'] as const,
  invitations: (organizationId: string, includeHistory: boolean, page: number) =>
    ['organization', organizationId, 'team', 'invitations', includeHistory, page] as const,
  events: (organizationId: string, page: number) =>
    ['organization', organizationId, 'team', 'events', page] as const,
  seats: (organizationId: string) => ['organization', organizationId, 'team', 'seats'] as const,
}

export const INVITATIONS_PAGE_SIZE = 20
export const EVENTS_PAGE_SIZE = 12

export function useTeamMembers() {
  const organization = useOrganization()
  return useQuery({
    queryKey: teamKeys.members(organization.id),
    queryFn: () => fetchTeamMembers(organization.id),
    staleTime: 30_000,
  })
}

export function useTeamInvitations(includeHistory: boolean, page: number, enabled: boolean) {
  const organization = useOrganization()
  return useQuery({
    queryKey: teamKeys.invitations(organization.id, includeHistory, page),
    queryFn: () =>
      fetchTeamInvitations(
        organization.id,
        includeHistory,
        INVITATIONS_PAGE_SIZE,
        page * INVITATIONS_PAGE_SIZE,
      ),
    enabled,
    staleTime: 15_000,
  })
}

export function useTeamEvents(page: number, enabled: boolean) {
  const organization = useOrganization()
  return useQuery({
    queryKey: teamKeys.events(organization.id, page),
    queryFn: () => fetchTeamEvents(organization.id, EVENTS_PAGE_SIZE, page * EVENTS_PAGE_SIZE),
    enabled,
    staleTime: 15_000,
  })
}

export function useSeatSummary(enabled = true) {
  const organization = useOrganization()
  return useQuery({
    queryKey: teamKeys.seats(organization.id),
    queryFn: () => fetchSeatSummary(organization.id),
    enabled,
    staleTime: 30_000,
  })
}

/**
 * After any membership change, everything scoped to this agency is stale.
 *
 * Not just the Team lists: a role change alters what the person may see
 * everywhere, and the workspace's own membership record is what every
 * permission check in the interface reads. Invalidating the whole organization
 * subtree is the honest scope, and Team is not a screen anybody is refreshing
 * fifty times a second.
 */
function invalidateTeam(client: QueryClient, organizationId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: ['organization', organizationId] }).then(() => {})
}

export function useInviteMember() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { email: string; role: Exclude<OrgRole, 'owner'> }) =>
      createInvitation(organization.id, input.email, input.role),
    onSuccess: () => invalidateTeam(client, organization.id),
  })
}

export function useResendInvitation() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (invitationId: string) => resendInvitation(invitationId),
    onSuccess: () => invalidateTeam(client, organization.id),
  })
}

export function useRevokeInvitation() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { invitationId: string; reason?: string }) =>
      revokeInvitation(input.invitationId, input.reason),
    onSuccess: () => invalidateTeam(client, organization.id),
  })
}

/**
 * Membership mutations.
 *
 * Each refreshes the workspace as well as the cache. That is not cosmetic: the
 * workspace holds the caller's own membership row, which is what `usePermission`
 * reads, so a change that alters who may do what has to reach it or the
 * interface keeps offering actions the database has already started refusing.
 */
export function useChangeMemberRole() {
  const organization = useOrganization()
  const { refresh } = useWorkspace()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { userId: string; role: Exclude<OrgRole, 'owner'> }) =>
      changeMemberRole(organization.id, input.userId, input.role),
    onSuccess: async () => {
      await invalidateTeam(client, organization.id)
      await refresh()
    },
  })
}

export function useRemoveMember() {
  const organization = useOrganization()
  const { refresh } = useWorkspace()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (userId: string) => removeMember(organization.id, userId),
    onSuccess: async () => {
      await invalidateTeam(client, organization.id)
      await refresh()
    },
  })
}

export function useLeaveOrganization() {
  const organization = useOrganization()
  const { refresh } = useWorkspace()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => leaveOrganization(organization.id),
    onSuccess: async () => {
      /*
       * Removed, not merely changed. Everything cached under this agency has to
       * go before the workspace reloads, or a stale list renders for a moment
       * under a membership that no longer exists.
       */
      client.removeQueries({ queryKey: ['organization', organization.id] })
      await refresh()
    },
  })
}

export function useTransferOwnership() {
  const organization = useOrganization()
  const { refresh } = useWorkspace()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (input: { userId: string; outgoingRole: Exclude<OrgRole, 'owner'> }) =>
      transferOwnership(organization.id, input.userId, input.outgoingRole),
    onSuccess: async () => {
      await invalidateTeam(client, organization.id)
      await refresh()
    },
  })
}

/**
 * Acceptance, which is the one mutation that happens outside a workspace.
 *
 * An invited person may have no membership at all when they run this, so it
 * takes no organization and clears every organization-scoped key afterwards:
 * whatever was cached was cached under a different set of memberships.
 */
export function useAcceptInvitation() {
  const client = useQueryClient()

  return useMutation({
    mutationFn: (token: string) => acceptInvitation(token),
    onSuccess: () => {
      client.removeQueries({ queryKey: ['organization'] })
      client.removeQueries({ queryKey: ['workspace'] })
    },
  })
}
