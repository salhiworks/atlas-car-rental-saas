import { createContext, useContext } from 'react'

import type { Permission } from '@/lib/authz/permissions'
import { can } from '@/lib/authz/permissions'
import type { Organization, OrganizationMember, OrgRole } from '@/types/database'

export interface WorkspaceMembership {
  readonly organization: Organization
  readonly membership: OrganizationMember
}

export type WorkspaceStatus = 'loading' | 'ready' | 'no-organization' | 'error'

export interface WorkspaceContextValue {
  readonly status: WorkspaceStatus
  /** Every agency the signed-in user belongs to. */
  readonly memberships: readonly WorkspaceMembership[]
  /** The agency currently being worked in. Null unless status is 'ready'. */
  readonly organization: Organization | null
  readonly membership: OrganizationMember | null
  readonly role: OrgRole | null
  readonly error: Error | null
  readonly switchOrganization: (organizationId: string) => void
  readonly refresh: () => Promise<void>
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error('useWorkspace must be used inside <WorkspaceProvider>.')
  }
  return context
}

/**
 * The active agency. Throws if called outside a route that guarantees one —
 * which is deliberate: a component that reads the organization should never
 * have to branch on it being absent.
 */
export function useOrganization(): Organization {
  const { organization } = useWorkspace()
  if (!organization) {
    throw new Error('useOrganization was called outside an organization-scoped route.')
  }
  return organization
}

export function useRole(): OrgRole | null {
  return useWorkspace().role
}

/**
 * Whether the interface should offer an action.
 *
 * This mirrors the RLS policy that will actually decide the outcome; it hides
 * controls, it does not secure them.
 */
export function usePermission(permission: Permission): boolean {
  return can(useWorkspace().role, permission)
}
