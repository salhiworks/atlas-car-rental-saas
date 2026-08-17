import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { resetEnvironmentCache } from './lib/config/env'

/**
 * The environment is stubbed rather than inherited.
 *
 * A developer with a working `.env.local` and CI with none must run the same
 * test and get the same result — otherwise this passes on one machine and fails
 * on the other for reasons that have nothing to do with the code.
 */
function setEnvironment(values: Record<string, string>) {
  vi.stubEnv('VITE_SUPABASE_URL', values.VITE_SUPABASE_URL ?? '')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', values.VITE_SUPABASE_ANON_KEY ?? '')
  resetEnvironmentCache()
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

beforeEach(() => {
  resetEnvironmentCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvironmentCache()
})

describe('App without a configured database', () => {
  beforeEach(() => {
    setEnvironment({})
  })

  it('explains what is missing instead of starting', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: /connect a database to continue/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('VITE_SUPABASE_URL')).toBeInTheDocument()
    expect(screen.getByText('VITE_SUPABASE_ANON_KEY')).toBeInTheDocument()
  })

  it('does not render the application shell or any figures', () => {
    render(<App />)

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByText(/revenue/i)).not.toBeInTheDocument()
  })
})

describe('App configured with a privileged key', () => {
  beforeEach(() => {
    setEnvironment({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: makeJwt({ role: 'service_role', ref: 'example' }),
    })
  })

  it('refuses to start rather than shipping an RLS-bypassing key to browsers', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: /connect a database to continue/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/service_role/i)).toBeInTheDocument()
  })
})
