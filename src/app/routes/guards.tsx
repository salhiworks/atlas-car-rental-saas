import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'

import { ErrorState } from '@/components/feedback/ErrorState'
import { FullPageLoader } from '@/components/feedback/FullPageLoader'
import { useAuth } from '@/features/auth/auth-context'
import { WorkspaceProvider } from '@/features/workspace/WorkspaceProvider'
import { useWorkspace } from '@/features/workspace/workspace-context'
import type { Permission } from '@/lib/authz/permissions'
import { can } from '@/lib/authz/permissions'
import { AppError } from '@/lib/supabase/errors'

import { paths } from './paths'

/**
 * Requires a session — except at the root path, which a signed-out visitor is
 * shown the public marketing page for instead of being bounced to sign-in.
 *
 * While the session is being restored the guard renders a loader rather than
 * redirecting — otherwise every page reload would bounce a signed-in user
 * through the sign-in screen before the stored session resolves.
 *
 * This is a navigation control, not a security control. The data behind any
 * route is protected by Row Level Security; a user who forces their way to a
 * URL sees an empty screen, never another agency's records.
 */
export function RequireAuth({ publicHome }: { publicHome?: ReactNode } = {}) {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <FullPageLoader label="Restoring your session" />

  if (status === 'unauthenticated') {
    // `paths.overview` ('/') is the one route with a real page to show a
    // signed-out visitor. Every other path still bounces to sign-in — this is
    // the only branch in this guard, not a general public/authenticated router.
    if (publicHome && location.pathname === paths.overview) {
      return <>{publicHome}</>
    }
    return (
      <Navigate to={paths.signIn} state={{ from: location.pathname + location.search }} replace />
    )
  }

  return <Outlet />
}

/** Keeps a signed-in user away from the sign-in and sign-up screens. */
export function RequireAnonymous() {
  const { status } = useAuth()

  if (status === 'loading') return <FullPageLoader />
  if (status === 'authenticated') return <Navigate to={paths.overview} replace />

  return <Outlet />
}

/** Loads the user's agencies for everything below it. */
export function WithWorkspace() {
  return (
    <WorkspaceProvider>
      <Outlet />
    </WorkspaceProvider>
  )
}

/**
 * Requires an active agency.
 *
 * A signed-in user with no membership is sent to onboarding — the case that
 * arises when agency provisioning could not complete during sign-up, or after
 * being removed from the last agency they belonged to.
 */
export function RequireOrganization() {
  const { status, error, refresh } = useWorkspace()

  if (status === 'loading') return <FullPageLoader label="Loading your agency" />

  if (status === 'error') {
    return (
      <div className="bg-canvas flex min-h-dvh items-center justify-center px-4">
        <ErrorState
          error={error}
          title="Your agency could not be loaded"
          onRetry={() => void refresh()}
        />
      </div>
    )
  }

  if (status === 'no-organization') return <Navigate to={paths.createAgency} replace />

  return <Outlet />
}

/** Sends a user who already has an agency away from onboarding. */
export function RequireNoOrganization() {
  const { status } = useWorkspace()

  if (status === 'loading') return <FullPageLoader />
  if (status === 'ready') return <Navigate to={paths.overview} replace />

  return <Outlet />
}

/**
 * Gates a route on a role.
 *
 * Mirrors the RLS policy that governs the same data. Reaching the route without
 * the role would produce an empty or failing screen anyway; this turns that into
 * a clear message.
 */
export function RequirePermission({ permission }: { permission: Permission }) {
  const { role } = useWorkspace()

  if (!can(role, permission)) {
    return (
      <ErrorState
        title="You do not have access to this section"
        error={
          new AppError(
            'permission',
            'Ask an owner or administrator of your agency to grant you access.',
          )
        }
      />
    )
  }

  return <Outlet />
}
