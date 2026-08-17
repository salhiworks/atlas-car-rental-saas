import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '@/features/auth/auth-context'
import { queryKeys } from '@/lib/query/keys'
import { toAppError } from '@/lib/supabase/errors'

import { fetchWorkspaces } from './api'
import {
  WorkspaceContext,
  type WorkspaceContextValue,
  type WorkspaceStatus,
} from './workspace-context'

/**
 * Remembers which agency a user was last working in.
 *
 * This is an interface preference, not application data — the authoritative
 * membership list always comes from the database, and a stale or tampered value
 * here can only ever select an agency the user already has access to.
 */
const selectionStorageKey = (userId: string) => `atlas.workspace.${userId}`

function readStoredSelection(userId: string): string | null {
  try {
    return window.localStorage.getItem(selectionStorageKey(userId))
  } catch {
    return null
  }
}

/**
 * Records which agency to open next time.
 *
 * Exported because accepting an invitation happens outside this provider — the
 * person may have had no membership at all a moment earlier — and landing them
 * in the agency they just joined rather than in whichever one sorts first is the
 * difference between an invitation working and an invitation appearing not to.
 */
export function rememberWorkspaceSelection(userId: string, organizationId: string): void {
  try {
    window.localStorage.setItem(selectionStorageKey(userId), organizationId)
  } catch {
    // Private browsing or a full quota — the selection simply is not remembered.
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, status: authStatus } = useAuth()
  const queryClient = useQueryClient()
  /** Set only when the user picks an agency this session; otherwise we fall back to storage. */
  const [explicitSelection, setExplicitSelection] = useState<string | null>(null)

  const userId = user?.id ?? null

  const {
    data: memberships,
    isPending,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.workspace(userId ?? 'anonymous'),
    queryFn: () => fetchWorkspaces(userId!),
    enabled: authStatus === 'authenticated' && userId !== null,
    staleTime: 60_000,
  })

  /**
   * The active agency, derived during render rather than mirrored into state by
   * an effect. Preference order: this session's explicit choice, then the
   * remembered one, then the first available — and any preference that is not
   * in the membership list is simply ignored, so a stale or edited stored value
   * can never select an agency the user is not a member of.
   */
  const active = useMemo(() => {
    const list = memberships ?? []
    if (list.length === 0) return null

    const preferred = explicitSelection ?? (userId ? readStoredSelection(userId) : null)
    return list.find((entry) => entry.organization.id === preferred) ?? list[0] ?? null
  }, [memberships, explicitSelection, userId])

  const switchOrganization = useCallback(
    (organizationId: string) => {
      if (!userId) return
      setExplicitSelection(organizationId)
      rememberWorkspaceSelection(userId, organizationId)
      /*
       * Removed, not invalidated.
       *
       * Invalidation marks a query stale but leaves its data in place, so every
       * mounted list keeps rendering the previous agency's rows until the
       * refetch lands. That is one tenant's customers, contracts and figures
       * displayed under another tenant's name — briefly, and on screen.
       * Removing the entries makes those components fall back to their loading
       * state instead, which is the honest thing for them to show.
       */
      queryClient.removeQueries({ queryKey: ['organization'] })
    },
    [userId, queryClient],
  )

  const refresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  /**
   * Losing access, noticed once and handled once.
   *
   * When somebody is removed from the agency they have open, every query behind
   * every page starts being refused by row-level security at the same moment.
   * Without this the result is a screen full of permission errors and a
   * navigation bar that still lists nine sections.
   *
   * So the first refusal from a query scoped to the active agency re-reads the
   * membership list. If the membership really is gone the derived state below
   * changes on its own — another agency becomes active, or the route guard sends
   * them to onboarding — and the removed agency's cached rows are dropped so
   * nothing can repaint them. If the refusal was about one restricted resource
   * rather than membership, the re-read finds the membership intact and nothing
   * happens.
   *
   * `checkedAt` keeps a page with a dozen failing queries from firing a dozen
   * re-reads. This is recovery, not security: the database has already refused.
   */
  const activeId = active?.organization.id ?? null
  const checkedAt = useRef(0)

  useEffect(() => {
    if (!activeId) return

    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.state.status !== 'error') return

      const key = event.query.queryKey as readonly unknown[]
      if (key[0] !== 'organization' || key[1] !== activeId) return
      if (toAppError(event.query.state.error).kind !== 'permission') return

      const now = Date.now()
      if (now - checkedAt.current < 5_000) return
      checkedAt.current = now

      void refetch().then((result) => {
        const stillAMember = (result.data ?? []).some((entry) => entry.organization.id === activeId)
        if (!stillAMember) {
          queryClient.removeQueries({ queryKey: ['organization', activeId] })
        }
      })
    })
  }, [activeId, queryClient, refetch])

  const value = useMemo<WorkspaceContextValue>(() => {
    const list = memberships ?? []

    let status: WorkspaceStatus
    if (authStatus !== 'authenticated' || isPending) {
      status = 'loading'
    } else if (error) {
      status = 'error'
    } else if (list.length === 0) {
      status = 'no-organization'
    } else if (!active) {
      status = 'loading'
    } else {
      status = 'ready'
    }

    return {
      status,
      memberships: list,
      organization: active?.organization ?? null,
      membership: active?.membership ?? null,
      role: active?.membership.role ?? null,
      error: error instanceof Error ? error : error ? new Error(String(error)) : null,
      switchOrganization,
      refresh,
    }
  }, [memberships, active, authStatus, isPending, error, switchOrganization, refresh])

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}
