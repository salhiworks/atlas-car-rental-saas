import type { Session } from '@supabase/supabase-js'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { getSupabaseClient } from '@/lib/supabase/client'

import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context'

/**
 * Owns the session for the whole application.
 *
 * Restoration order matters: `getSession()` resolves from storage first so a
 * reload does not flash the sign-in screen, and only then does the subscription
 * take over. Until that first resolution the status stays `loading`, which is
 * what keeps ProtectedRoute from redirecting a signed-in user to sign in.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [isRecoverySession, setIsRecoverySession] = useState(false)

  useEffect(() => {
    const supabase = getSupabaseClient()
    let active = true

    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return
        setSession(data.session)
        setStatus(data.session ? 'authenticated' : 'unauthenticated')
      })
      .catch(() => {
        if (!active) return
        // A corrupt or unreachable session store must not leave the app stuck
        // on a loading screen; treat it as signed out.
        setSession(null)
        setStatus('unauthenticated')
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return

      // Never call back into supabase-js from this callback — it runs while the
      // client holds its internal lock and re-entrant calls can deadlock.
      setSession(nextSession)
      setStatus(nextSession ? 'authenticated' : 'unauthenticated')

      if (event === 'PASSWORD_RECOVERY') {
        setIsRecoverySession(true)
      } else if (event === 'SIGNED_OUT') {
        setIsRecoverySession(false)
      }
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const signOut = useCallback(async () => {
    await getSupabaseClient().auth.signOut()
    setSession(null)
    setStatus('unauthenticated')
    setIsRecoverySession(false)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      isRecoverySession,
      signOut,
    }),
    [status, session, isRecoverySession, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
