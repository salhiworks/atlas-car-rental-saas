import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AuthContext, type AuthContextValue, type AuthStatus } from '@/features/auth/auth-context'
import {
  WorkspaceContext,
  type WorkspaceContextValue,
  type WorkspaceStatus,
} from '@/features/workspace/workspace-context'
import type { OrgRole } from '@/types/database'

import { RequireAnonymous, RequireAuth, RequireOrganization, RequirePermission } from './guards'
import { paths } from './paths'

function authValue(status: AuthStatus): AuthContextValue {
  return {
    status,
    session: null,
    user: status === 'authenticated' ? ({ id: 'user-1' } as AuthContextValue['user']) : null,
    isRecoverySession: false,
    signOut: () => Promise.resolve(),
  }
}

function workspaceValue(
  status: WorkspaceStatus,
  role: OrgRole | null = 'staff',
): WorkspaceContextValue {
  return {
    status,
    memberships: [],
    organization: null,
    membership: null,
    role,
    error: null,
    switchOrganization: () => undefined,
    refresh: () => Promise.resolve(),
  }
}

function renderRoutes(options: {
  initialPath: string
  auth: AuthStatus
  workspace?: WorkspaceStatus
  role?: OrgRole | null
  children: ReactNode
}) {
  return render(
    <AuthContext.Provider value={authValue(options.auth)}>
      <WorkspaceContext.Provider
        value={workspaceValue(options.workspace ?? 'ready', options.role ?? 'staff')}
      >
        <MemoryRouter initialEntries={[options.initialPath]}>
          <Routes>
            {options.children}
            <Route path={paths.signIn} element={<p>Sign in screen</p>} />
            <Route path={paths.createAgency} element={<p>Create agency screen</p>} />
          </Routes>
        </MemoryRouter>
      </WorkspaceContext.Provider>
    </AuthContext.Provider>,
  )
}

describe('RequireAuth', () => {
  it('renders the protected page for a signed-in user', () => {
    renderRoutes({
      initialPath: '/protected',
      auth: 'authenticated',
      children: (
        <Route element={<RequireAuth />}>
          <Route path="/protected" element={<p>Protected content</p>} />
        </Route>
      ),
    })

    expect(screen.getByText('Protected content')).toBeInTheDocument()
  })

  it('redirects a signed-out user to sign in', () => {
    renderRoutes({
      initialPath: '/protected',
      auth: 'unauthenticated',
      children: (
        <Route element={<RequireAuth />}>
          <Route path="/protected" element={<p>Protected content</p>} />
        </Route>
      ),
    })

    expect(screen.getByText('Sign in screen')).toBeInTheDocument()
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
  })

  it('waits rather than redirecting while the session is being restored', () => {
    // This is what stops a page reload from flashing the sign-in screen at a
    // user who is, in fact, signed in.
    renderRoutes({
      initialPath: '/protected',
      auth: 'loading',
      children: (
        <Route element={<RequireAuth />}>
          <Route path="/protected" element={<p>Protected content</p>} />
        </Route>
      ),
    })

    expect(screen.queryByText('Sign in screen')).not.toBeInTheDocument()
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})

describe('RequireAnonymous', () => {
  it('keeps a signed-in user off the sign-in screen', () => {
    renderRoutes({
      initialPath: paths.signIn,
      auth: 'authenticated',
      children: (
        <Route element={<RequireAnonymous />}>
          <Route path={paths.signIn} element={<p>Sign in form</p>} />
        </Route>
      ),
    })

    expect(screen.queryByText('Sign in form')).not.toBeInTheDocument()
  })
})

describe('RequireOrganization', () => {
  it('renders the page when an agency is active', () => {
    renderRoutes({
      initialPath: '/app',
      auth: 'authenticated',
      workspace: 'ready',
      children: (
        <Route element={<RequireOrganization />}>
          <Route path="/app" element={<p>Agency workspace</p>} />
        </Route>
      ),
    })

    expect(screen.getByText('Agency workspace')).toBeInTheDocument()
  })

  it('sends a user with no agency to onboarding', () => {
    renderRoutes({
      initialPath: '/app',
      auth: 'authenticated',
      workspace: 'no-organization',
      children: (
        <Route element={<RequireOrganization />}>
          <Route path="/app" element={<p>Agency workspace</p>} />
        </Route>
      ),
    })

    expect(screen.getByText('Create agency screen')).toBeInTheDocument()
  })
})

describe('RequirePermission', () => {
  it('renders the section for a role that holds the permission', () => {
    renderRoutes({
      initialPath: '/reports',
      auth: 'authenticated',
      role: 'manager',
      children: (
        <Route element={<RequirePermission permission="reports.view" />}>
          <Route path="/reports" element={<p>Reports</p>} />
        </Route>
      ),
    })

    expect(screen.getByText('Reports')).toBeInTheDocument()
  })

  it('explains the refusal instead of showing an empty section', () => {
    renderRoutes({
      initialPath: '/reports',
      auth: 'authenticated',
      role: 'staff',
      children: (
        <Route element={<RequirePermission permission="reports.view" />}>
          <Route path="/reports" element={<p>Reports</p>} />
        </Route>
      ),
    })

    expect(screen.queryByText('Reports')).not.toBeInTheDocument()
    expect(screen.getByText(/do not have access to this section/i)).toBeInTheDocument()
    expect(screen.getByText(/owner or administrator/i)).toBeInTheDocument()
  })
})
