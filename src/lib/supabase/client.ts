import { type SupabaseClient, createClient } from '@supabase/supabase-js'

import type { Database } from '@/types/database'

import { getEnvironment } from '../config/env'

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super('Supabase is not configured. See .env.example.')
    this.name = 'SupabaseNotConfiguredError'
  }
}

let client: SupabaseClient<Database> | null = null

export function isSupabaseConfigured(): boolean {
  return getEnvironment().status === 'ok'
}

/**
 * The single Supabase client for the application.
 *
 * Constructed lazily so that an unconfigured deployment renders an explanatory
 * screen instead of crashing at module-evaluation time before React mounts.
 */
export function getSupabaseClient(): SupabaseClient<Database> {
  if (client) return client

  const result = getEnvironment()
  if (result.status !== 'ok') throw new SupabaseNotConfiguredError()

  client = createClient<Database>(result.env.supabaseUrl, result.env.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Required so email confirmation and password recovery links establish a
      // session when the user lands back on the app.
      detectSessionInUrl: true,
      // PKCE keeps the authorization code exchange safe in a public client and
      // avoids leaving tokens in the URL fragment.
      flowType: 'pkce',
      storageKey: 'atlas.auth.session',
    },
    global: {
      headers: { 'x-client-info': 'atlas-web' },
    },
  })

  return client
}

/** For tests: drops the memoised client so a new environment takes effect. */
export function resetSupabaseClient(): void {
  client = null
}
