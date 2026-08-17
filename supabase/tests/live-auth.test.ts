// @vitest-environment node
/**
 * The live suite's sign-in helper.
 *
 * This is test infrastructure being tested, which is worth doing exactly once:
 * a live run failed 262 checks because one `signInWithPassword` returned
 * `fetch failed`, the harness had already published its module-level client, and
 * two hundred later checks went on to assert against a client with no session.
 * One transport blip, 262 failures, and a root cause buried in the middle of the
 * log.
 *
 * So the helper draws one line — a request that never got an answer may be
 * retried; an answer from Auth may not — and these tests hold it to it in both
 * directions. Retrying past a real `400 Invalid login credentials` would be the
 * worse defect of the two, because the suite would stop testing authentication
 * and never say so.
 *
 * The two error shapes below are not invented. They were read off the live
 * project: supabase-js returns AuthRetryableFetchError with status 0 for a
 * connection failure, and AuthApiError with status 400 and
 * code 'invalid_credentials' for a refusal.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  AuthTransportError,
  describeAuthFailure,
  isAuthTransportFailure,
  signInTestUser,
} from '../../scripts/live-auth.mjs'

/** What supabase-js returns when the request never reached GoTrue. */
const transportError = () =>
  Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError', status: 0 })

/** What it returns when GoTrue answered and refused. */
const authError = (status = 400, code = 'invalid_credentials', message = 'Invalid login credentials') =>
  Object.assign(new Error(message), { name: 'AuthApiError', status, code })

const session = { access_token: 'token-value' }
const user = { id: 'user-1' }

/**
 * A client whose sign-in follows a script, one entry per attempt.
 *
 * Each attempt gets its OWN client object, which is what lets the tests assert
 * that a failed attempt's client is never the one returned.
 */
function scriptedClient(outcomes: unknown[]) {
  const made: { id: number }[] = []
  let attempt = 0

  const makeClient = () => {
    const id = made.length + 1
    const client = {
      id,
      auth: {
        signInWithPassword: () => {
          const outcome = outcomes[attempt]
          attempt += 1
          if (outcome instanceof Error) return Promise.resolve({ data: null, error: outcome })
          if (outcome === 'throw') return Promise.reject(transportError())
          if (outcome === 'no-session') {
            return Promise.resolve({ data: { session: null, user: null }, error: null })
          }
          return Promise.resolve({ data: { session, user }, error: null })
        },
      },
    }
    made.push(client)
    return client
  }

  return { makeClient, made, attempts: () => attempt }
}

const noSleep = () => Promise.resolve()

// -----------------------------------------------------------------------------
describe('what counts as a transport failure', () => {
  it('reads the status rather than the wording', () => {
    // No answer at all.
    expect(isAuthTransportFailure(transportError())).toBe(true)
    expect(isAuthTransportFailure(Object.assign(new Error('socket hang up'), {}))).toBe(true)

    // An answer. The product is speaking, whatever the message says.
    expect(isAuthTransportFailure(authError(400))).toBe(false)
    expect(isAuthTransportFailure(authError(401, 'unauthorized', 'Unauthorized'))).toBe(false)
    expect(isAuthTransportFailure(authError(403, 'forbidden', 'Forbidden'))).toBe(false)
    expect(isAuthTransportFailure(authError(422, 'email_not_confirmed', 'Email not confirmed'))).toBe(
      false,
    )
  })

  it('treats a 5xx as infrastructure, exactly as sql() already does', () => {
    expect(isAuthTransportFailure(authError(502, undefined, 'Bad Gateway'))).toBe(true)
    expect(isAuthTransportFailure(authError(503, undefined, 'Service Unavailable'))).toBe(true)
  })

  it('describes a failure without carrying a credential', () => {
    const described = describeAuthFailure(authError())
    expect(described).toContain('AuthApiError(400)')
    expect(described).not.toMatch(/password|token|secret/i)
  })
})

// -----------------------------------------------------------------------------
describe('transient transport recovery', () => {
  it('retries once and succeeds, publishing only the working client', async () => {
    const { makeClient, made, attempts } = scriptedClient([transportError(), 'ok'])

    const result = await signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, {
      sleep: noSleep,
    })

    expect(attempts()).toBe(2)
    expect(result.attempts).toBe(2)
    expect(result.session.access_token).toBe('token-value')
    // The client handed back is the one that actually signed in — never the
    // candidate from the failed attempt.
    expect((result.client as { id: number }).id).toBe(2)
    expect(made).toHaveLength(2)
  })

  it('recovers from a thrown transport error as well as a returned one', async () => {
    const { makeClient, attempts } = scriptedClient(['throw', 'ok'])

    const result = await signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, {
      sleep: noSleep,
    })
    expect(attempts()).toBe(2)
    expect(result.session.access_token).toBe('token-value')
  })

  it('waits between attempts, briefly and boundedly', async () => {
    const slept: number[] = []
    const { makeClient } = scriptedClient([transportError(), transportError(), 'ok'])

    await signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, {
      sleep: (ms: number) => {
        slept.push(ms)
        return Promise.resolve()
      },
    })

    expect(slept).toEqual([250, 750])
    // A live suite must fail promptly when Auth is genuinely down.
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThan(2000)
  })
})

// -----------------------------------------------------------------------------
describe('exhausted transport retry', () => {
  it('fails once, clearly, and hands back nothing', async () => {
    const { makeClient, attempts } = scriptedClient([
      transportError(),
      transportError(),
      transportError(),
    ])

    let thrown: unknown
    try {
      await signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, { sleep: noSleep })
    } catch (error) {
      thrown = error
    }

    expect(attempts()).toBe(3)
    expect(thrown).toBeInstanceOf(AuthTransportError)
    const failure = thrown as AuthTransportError
    // One root-cause sentence, not two hundred secondary ones.
    expect(failure.message).toContain('Auth transport/harness failure after 3 attempts')
    expect(failure.category).toBe('auth_transport_failure')
    expect(failure.lastDetail).toContain('AuthRetryableFetchError(0)')
  })

  it('never tries a fourth time', async () => {
    const { makeClient, attempts } = scriptedClient([
      transportError(),
      transportError(),
      transportError(),
      'ok',
    ])

    await expect(
      signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, { sleep: noSleep }),
    ).rejects.toBeInstanceOf(AuthTransportError)
    expect(attempts()).toBe(3)
  })
})

// -----------------------------------------------------------------------------
describe('a real Auth answer is never retried', () => {
  it('reports invalid credentials once, exactly as they arrived', async () => {
    const { makeClient, attempts } = scriptedClient([authError(), 'ok'])

    let thrown: unknown
    try {
      await signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, { sleep: noSleep })
    } catch (error) {
      thrown = error
    }

    // One attempt. Retrying here would let the suite pass its way through a
    // broken sign-in and stop testing authentication at all.
    expect(attempts()).toBe(1)
    expect((thrown as Error).message).toBe('Invalid login credentials')
    expect(thrown).not.toBeInstanceOf(AuthTransportError)
  })

  it('does not retry a 401 or a 403', async () => {
    for (const status of [401, 403]) {
      const { makeClient, attempts } = scriptedClient([authError(status, 'x', `HTTP ${status}`), 'ok'])
      await expect(
        signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, { sleep: noSleep }),
      ).rejects.toThrow(`HTTP ${status}`)
      expect(attempts(), String(status)).toBe(1)
    }
  })

  it('does not retry an unconfirmed account', async () => {
    const { makeClient, attempts } = scriptedClient([
      authError(400, 'email_not_confirmed', 'Email not confirmed'),
      'ok',
    ])
    await expect(
      signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, { sleep: noSleep }),
    ).rejects.toThrow('Email not confirmed')
    expect(attempts()).toBe(1)
  })
})

// -----------------------------------------------------------------------------
describe('nothing unusable is ever published', () => {
  it('succeeds on the first try with no delay', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    const { makeClient, attempts } = scriptedClient(['ok'])

    const result = await signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, { sleep })

    expect(attempts()).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(result.attempts).toBe(1)
  })

  it('refuses a response that carried no session', async () => {
    /*
     * A 200 without a session is not a session. Returning the client anyway is
     * how a later check ends up asserting against an anonymous request and
     * reporting the result as a product failure.
     */
    const { makeClient } = scriptedClient(['no-session'])

    await expect(
      signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, { sleep: noSleep }),
    ).rejects.toBeInstanceOf(AuthTransportError)
  })

  it('leaves a caller’s existing client untouched when sign-in fails', async () => {
    /*
     * The amplification defect, in miniature. The harness used to assign its
     * module-level client BEFORE signing in, so a failure left either a
     * session-less client or the previous person's session in shared state, and
     * every later check ran against it.
     *
     * The helper cannot assign anything: it returns a client, and a caller
     * writing `x = await signInTestUser(...)` never overwrites `x` on failure.
     * What it must not do is hand back a candidate from a failed attempt.
     */
    let published: unknown = { id: 'previous-owner-client' }
    const { makeClient, made } = scriptedClient([transportError(), transportError(), transportError()])

    await expect(
      (async () => {
        published = await signInTestUser(makeClient, { email: 'a@b.test', password: 'x' }, {
          sleep: noSleep,
        })
      })(),
    ).rejects.toBeInstanceOf(AuthTransportError)

    // Unchanged, and demonstrably not one of the three candidates.
    expect(published).toEqual({ id: 'previous-owner-client' })
    expect(made.map((c) => c.id)).toEqual([1, 2, 3])
  })
})
