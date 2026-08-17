/**
 * Stripe webhook signature verification.
 *
 * WHY THIS IS NOT `stripe.webhooks.constructEventAsync`.
 *
 * The official SDK is the recommended way to do this, and in a project where
 * Edge Function entry points were testable it would be the right call. Here they
 * are not: `supabase/functions/*\/index.ts` is excluded from tsconfig and from
 * eslint, calls `Deno.serve` with no export, and cannot be imported by Vitest.
 * Putting the one piece of code that decides whether an unauthenticated request
 * is genuine into that file would mean shipping it untested, which is the wrong
 * trade for a security boundary.
 *
 * So verification lives here, in a module the test suite imports directly, and
 * it implements the algorithm Stripe documents under "Verify webhook signatures
 * manually" — the same four steps their libraries perform:
 *
 *   1. Split the Stripe-Signature header on commas, then each element on the
 *      first `=`. Keep `t` and every `v1`. Ignore every other scheme: Stripe's
 *      own instruction is "to prevent downgrade attacks, ignore all schemes that
 *      aren't v1", and the `v0` scheme they send alongside test events is
 *      exactly such a scheme.
 *   2. Build the signed payload as `${timestamp}.${raw body}`.
 *   3. HMAC-SHA256 it with the endpoint's signing secret, hex-encoded.
 *   4. Compare in constant time against each v1, then check the timestamp
 *      against a tolerance. Multiple v1 signatures are normal — Stripe sends one
 *      per active secret for up to 24 hours after a secret is rolled.
 *
 * The test suite cross-checks this implementation against the official SDK's own
 * signature generator, so "matches Stripe" is asserted rather than asserted-by-
 * comment.
 *
 * Web Crypto, not node:crypto, so the same code runs in Deno and in the test
 * runner. That is also why every function here is async: SubtleCrypto has no
 * synchronous form, which is the same reason the Stripe SDK requires
 * `constructEventAsync` outside Node.
 */

/** Stripe's own default, in seconds. Never set this to 0 — that disables the
 *  recency check entirely, which is Stripe's explicit warning. */
export const DEFAULT_TOLERANCE_SECONDS = 300

export type SignatureFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'no_supported_scheme'
  | 'signature_mismatch'
  | 'timestamp_out_of_tolerance'

export interface SignatureVerification {
  readonly ok: boolean
  readonly reason?: SignatureFailure
  /** The header's own timestamp, seconds since the epoch, when it parsed. */
  readonly timestamp?: number
}

interface ParsedHeader {
  readonly timestamp: number
  readonly signatures: readonly string[]
}

/**
 * Splits a Stripe-Signature header into its timestamp and its v1 signatures.
 *
 * Exported because a malformed header is a case worth testing on its own: the
 * difference between "somebody sent us nonsense" and "somebody sent us a valid
 * header with the wrong signature" is the difference between a misconfiguration
 * and an attack, and the ledger records which.
 */
export function parseSignatureHeader(header: string | null): ParsedHeader | SignatureFailure {
  if (header === null || header.trim() === '') return 'missing_signature'

  let timestamp: number | null = null
  const signatures: string[] = []

  for (const element of header.split(',')) {
    const separator = element.indexOf('=')
    if (separator <= 0) continue

    const scheme = element.slice(0, separator).trim()
    const value = element.slice(separator + 1).trim()

    if (scheme === 't') {
      // Seconds since the epoch, as an integer. Anything else is malformed
      // rather than merely wrong.
      if (!/^\d{1,15}$/.test(value)) return 'malformed_signature'
      timestamp = Number(value)
    } else if (scheme === 'v1') {
      // Lowercase hex of a SHA-256 HMAC: 64 characters, always.
      if (/^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase())
    }
    // Every other scheme, v0 included, is deliberately discarded.
  }

  if (timestamp === null) return 'malformed_signature'
  if (signatures.length === 0) return 'no_supported_scheme'

  return { timestamp, signatures }
}

const encoder = new TextEncoder()

/** Hex-encoded HMAC-SHA256, the shape Stripe's header carries. */
export async function computeSignature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))

  return Array.from(new Uint8Array(signed))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Constant-time comparison of two equal-length hex strings.
 *
 * A `===` here would leak the correct signature one byte at a time to anybody
 * willing to measure. The early length check is safe to make in variable time:
 * the length of a SHA-256 hex digest is not a secret.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false

  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

/**
 * Whether this raw body really came from Stripe.
 *
 * `payload` must be the body exactly as it arrived — Stripe's requirement is
 * that it be "the body string that Stripe sends in UTF-8 encoding without any
 * changes". Parsing the JSON and re-serialising it fails, every time, which is
 * why the caller reads `await request.text()` and hands the string here before
 * anything else looks at it.
 *
 * `nowSeconds` is injectable so the tolerance branch is reachable in a test
 * without waiting five minutes.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  options: { toleranceSeconds?: number; nowSeconds?: () => number } = {},
): Promise<SignatureVerification> {
  const parsed = parseSignatureHeader(header)
  if (typeof parsed === 'string') return { ok: false, reason: parsed }

  const expected = await computeSignature(`${parsed.timestamp}.${payload}`, secret)
  const matches = parsed.signatures.some((candidate) => timingSafeEqual(candidate, expected))

  /*
   * Signature first, tolerance second, and the order matters for what we say
   * afterwards: an expired signature that is otherwise valid is a slow retry or
   * a clock problem, while a mismatched one is somebody sending us something
   * they should not. Reporting them as the same failure would hide both.
   */
  if (!matches) return { ok: false, reason: 'signature_mismatch', timestamp: parsed.timestamp }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = options.nowSeconds ? options.nowSeconds() : Math.floor(Date.now() / 1000)

  /*
   * Stripe generates a fresh timestamp for every delivery attempt, so a
   * two-day-old event being retried still arrives inside a five-minute window.
   * The check is therefore about replay, not about age.
   *
   * Both directions: a timestamp far in the future is as wrong as one far in the
   * past, and only one of the two is ever an honest clock skew.
   */
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance', timestamp: parsed.timestamp }
  }

  return { ok: true, timestamp: parsed.timestamp }
}
