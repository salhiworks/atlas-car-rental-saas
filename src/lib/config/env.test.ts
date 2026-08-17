import { describe, expect, it } from 'vitest'

import { isPrivilegedKey, resolveEnvironment } from './env'

/** Builds an unsigned JWT with the given payload — shape is all this code inspects. */
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`
}

const ANON_KEY = makeJwt({ iss: 'supabase', role: 'anon', ref: 'abcdefghijklmnop' })
const SERVICE_KEY = makeJwt({ iss: 'supabase', role: 'service_role', ref: 'abcdefghijklmnop' })

describe('privileged key detection', () => {
  it('flags a legacy service_role JWT', () => {
    expect(isPrivilegedKey(SERVICE_KEY)).toBe(true)
  })

  it('flags a prefixed secret key', () => {
    expect(isPrivilegedKey('sb_secret_abc123')).toBe(true)
  })

  it('accepts the keys that are meant to be public', () => {
    expect(isPrivilegedKey(ANON_KEY)).toBe(false)
    expect(isPrivilegedKey('sb_publishable_abc123')).toBe(false)
  })

  it('does not throw on malformed input', () => {
    expect(isPrivilegedKey('')).toBe(false)
    expect(isPrivilegedKey('not.a.jwt')).toBe(false)
    expect(isPrivilegedKey('a.b')).toBe(false)
  })
})

describe('environment resolution', () => {
  it('accepts a complete configuration', () => {
    const result = resolveEnvironment({
      VITE_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
      VITE_SUPABASE_ANON_KEY: ANON_KEY,
      VITE_APP_NAME: 'Northwind',
    })

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.env.appName).toBe('Northwind')
      expect(result.env.supabaseUrl).toBe('https://abcdefghijklmnop.supabase.co')
    }
  })

  it('falls back to the default product name', () => {
    const result = resolveEnvironment({
      VITE_SUPABASE_URL: 'https://x.supabase.co',
      VITE_SUPABASE_ANON_KEY: ANON_KEY,
    })
    expect(result.status === 'ok' && result.env.appName).toBe('Atlas')
  })

  it('reports both variables when nothing is configured', () => {
    const result = resolveEnvironment({})

    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.problems.map((problem) => problem.variable)).toEqual([
        'VITE_SUPABASE_URL',
        'VITE_SUPABASE_ANON_KEY',
      ])
    }
  })

  it('refuses to start with a service_role key in the browser bundle', () => {
    const result = resolveEnvironment({
      VITE_SUPABASE_URL: 'https://x.supabase.co',
      VITE_SUPABASE_ANON_KEY: SERVICE_KEY,
    })

    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.problems[0]?.variable).toBe('VITE_SUPABASE_ANON_KEY')
      expect(result.problems[0]?.detail).toMatch(/service_role/i)
    }
  })

  it('rejects a malformed project URL', () => {
    const result = resolveEnvironment({
      VITE_SUPABASE_URL: 'not-a-url',
      VITE_SUPABASE_ANON_KEY: ANON_KEY,
    })
    expect(result.status).toBe('invalid')
  })

  it('rejects plain http except against a local instance', () => {
    expect(
      resolveEnvironment({
        VITE_SUPABASE_URL: 'http://someone-elses-host.example',
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }).status,
    ).toBe('invalid')

    expect(
      resolveEnvironment({
        VITE_SUPABASE_URL: 'http://localhost:54321',
        VITE_SUPABASE_ANON_KEY: ANON_KEY,
      }).status,
    ).toBe('ok')
  })

  it('ignores surrounding whitespace from a pasted value', () => {
    const result = resolveEnvironment({
      VITE_SUPABASE_URL: '  https://x.supabase.co  ',
      VITE_SUPABASE_ANON_KEY: `  ${ANON_KEY}  `,
    })
    expect(result.status).toBe('ok')
  })
})
