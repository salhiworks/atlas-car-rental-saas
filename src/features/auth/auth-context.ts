import type { Session, User } from '@supabase/supabase-js'
import { createContext, useContext } from 'react'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export interface AuthContextValue {
  readonly status: AuthStatus
  readonly session: Session | null
  readonly user: User | null
  /**
   * True while the user is in a password-recovery session established by a
   * reset link. The reset screen uses this to distinguish "arrived from an
   * email link" from "already signed in and browsing".
   */
  readonly isRecoverySession: boolean
  readonly signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>.')
  }
  return context
}

/** The signed-in user, or null while loading or signed out. */
export function useCurrentUser(): User | null {
  return useAuth().user
}
