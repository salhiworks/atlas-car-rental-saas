/**
 * Signing a test user in, against the real project.
 *
 * WHY THIS EXISTS.
 *
 * One live run failed 262 checks. Exactly one thing had gone wrong: a single
 * `signInWithPassword` returned `fetch failed` — a connection that never reached
 * GoTrue, with no HTTP status and no body. Everything after it failed for a
 * second-hand reason, because the harness had already assigned its module-level
 * client before the sign-in was known to have worked, and two hundred later
 * checks went on to "test" the product through a client with no session.
 *
 * That is a harness defect twice over: it turned one transport blip into 262
 * assertion failures, and it made the root cause the hardest thing in the log to
 * find. This module fixes both halves.
 *
 * THE RULE, WHICH IS THE SAME ONE `sql()` ALREADY FOLLOWS.
 *
 *   A tooling or network failure may be retried. An answer from the product may
 *   not.
 *
 * So a request that never obtained an HTTP response is retried, twice, with a
 * short bounded wait. `400 Invalid login credentials` is retried zero times and
 * reported exactly as it arrived — a suite that retries its way past a real
 * authentication failure is a suite that has stopped testing authentication.
 *
 * WHAT IT DELIBERATELY IS NOT. It is not a general retry engine. Nothing here
 * wraps an RLS check, a billing RPC, a permission refusal or an expected 4xx.
 * Retrying those would let a nondeterministic product defect disappear, which is
 * the failure mode worse than a flaky suite.
 */

/** Attempts in total: the first, plus at most two retries. */
export const MAX_ATTEMPTS = 3

/** Waited between attempts. Short and bounded — a broken Auth must fail fast. */
export const BACKOFF_MS = [250, 750]

/**
 * Raised when authentication could not be ESTABLISHED, as opposed to refused.
 *
 * Distinct from an Auth failure on purpose: this one says the suite could not
 * ask the question, and everything downstream of it is unknown rather than
 * broken.
 */
export class AuthTransportError extends Error {
  constructor(message, attempts, lastDetail) {
    super(message)
    this.name = 'AuthTransportError'
    this.category = 'auth_transport_failure'
    this.attempts = attempts
    /** A short, safe description. Never a token, never a password. */
    this.lastDetail = lastDetail
  }
}

/**
 * Whether a failure means "the request never got an answer".
 *
 * Read from the error's own properties rather than its wording. supabase-js
 * gives two clearly different shapes, confirmed against the live project:
 *
 *   transport   name: 'AuthRetryableFetchError', status: 0,   code: undefined
 *   auth answer name: 'AuthApiError',            status: 400, code: 'invalid_credentials'
 *
 * `status` is the discriminator: an integer status means GoTrue answered, and an
 * answer is the product speaking. Absent or zero means nothing came back.
 *
 * A 5xx is treated as retryable infrastructure rather than an answer about these
 * credentials — the same judgement `sql()` already makes for `unexpected status
 * 5xx`. A 4xx never is.
 */
export function isAuthTransportFailure(error) {
  if (!error) return false

  const status = error.status
  if (typeof status === 'number' && Number.isFinite(status) && status !== 0) {
    // GoTrue answered. 5xx is infrastructure; anything else is the product.
    return status >= 500
  }

  // No status at all: a thrown TypeError from fetch, an aborted socket, a DNS
  // failure. The name corroborates it when supabase-js supplies one.
  return true
}

/** A one-line, safe description of a failure. Carries no credential. */
export function describeAuthFailure(error) {
  if (!error) return 'unknown'
  const status = typeof error.status === 'number' ? error.status : 'no-status'
  const name = error.name ?? 'Error'
  return `${name}(${status}): ${String(error.message ?? '').slice(0, 120)}`
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Signs a test user in and hands back a client that is known to be usable.
 *
 * THE CLIENT IS CREATED HERE AND RETURNED ONLY ON SUCCESS. Callers assign their
 * module-level variable from the RESULT, so a failed sign-in cannot leave a
 * half-built client sitting in shared state pretending to be a session. On
 * failure this throws and assigns nothing at all — including nothing stale from
 * a previous phase or a different person.
 *
 * @param makeClient   () => SupabaseClient — a fresh, signed-out client.
 * @param credentials  { email, password }
 * @param options      { maxAttempts, backoffMs, sleep } — injectable for tests.
 */
export async function signInTestUser(makeClient, credentials, options = {}) {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  const backoff = options.backoffMs ?? BACKOFF_MS
  const sleep = options.sleep ?? wait

  let lastDetail = 'unknown'

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // A fresh candidate every attempt: a client whose sign-in failed is not
    // reused, and nothing is published until the session is confirmed.
    const candidate = makeClient()

    let result
    try {
      result = await candidate.auth.signInWithPassword(credentials)
    } catch (thrown) {
      // supabase-js normally returns errors, but a transport failure can still
      // escape as a throw. Treated as transport, which is what it is.
      result = { data: null, error: thrown }
    }

    const error = result?.error

    if (!error) {
      /*
       * Confirmed before publication. A response without a session is not a
       * session, and returning the client anyway is how a later check ends up
       * asserting against an anonymous request and calling the result a product
       * failure.
       */
      const session = result?.data?.session
      if (session?.access_token && result?.data?.user?.id) {
        return { client: candidate, session, user: result.data.user, attempts: attempt }
      }
      lastDetail = 'signed in without a session'
      throw new AuthTransportError(
        `Auth transport/harness failure after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${lastDetail}`,
        attempt,
        lastDetail,
      )
    }

    lastDetail = describeAuthFailure(error)

    // A real answer from Auth. Reported as it arrived, once, with no retry: this
    // is the product speaking, and the suite exists to hear it.
    if (!isAuthTransportFailure(error)) {
      throw error instanceof Error ? error : new Error(String(error?.message ?? error))
    }

    if (attempt < maxAttempts) {
      await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0)
    }
  }

  throw new AuthTransportError(
    `Auth transport/harness failure after ${maxAttempts} attempts: ${lastDetail}`,
    maxAttempts,
    lastDetail,
  )
}
