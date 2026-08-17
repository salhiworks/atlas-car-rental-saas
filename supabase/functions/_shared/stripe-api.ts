/**
 * The Stripe REST client.
 *
 * WHY NOT `npm:stripe`.
 *
 * Stripe's own guidance for Supabase Edge Functions is `import Stripe from
 * 'npm:stripe@^22'`, and in a project whose function entry points were testable
 * that is what this would be. Here they are not: `index.ts` is outside tsconfig,
 * outside eslint, and unimportable by Vitest. An SDK usable only there would put
 * every request this module builds — the price it names, the customer it names,
 * the URLs it returns to — beyond reach of a test.
 *
 * So this speaks the documented REST contract over an injected `fetch`, exactly
 * as `_shared/wialon-adapter.ts` does for the tracking provider. That is this
 * repository's established shape for a provider boundary, and it makes every
 * parameter, header, error branch and timeout assertable without a network.
 *
 * What it implements, from the current documentation:
 *
 *   * form encoding, including Stripe's bracket syntax for nested values and
 *     arrays (`line_items[0][price]`), because Stripe's API is
 *     `application/x-www-form-urlencoded` and not JSON
 *   * `Stripe-Version`, pinned. Without it Stripe uses the account's default
 *     version, so somebody clicking "upgrade" in a dashboard would silently
 *     change what this code receives
 *   * `Idempotency-Key` where a retry must not create a second object
 *   * the documented error envelope, normalised into our own categories
 *
 * It deliberately does NOT implement: automatic retries (the caller decides),
 * pagination (nothing here lists), or webhook construction (that is
 * `_shared/stripe-signature.ts`, so it can be tested against Stripe's own
 * signer).
 */

import type { StripeMode } from './stripe-config.ts'

/**
 * The Stripe API version this integration is written against.
 *
 * 2026-07-29.dahlia is the current stable release and the version stripe-node
 * v22 pins by default. It is stated here, once, because two things in this
 * module depend on it and would break silently if the account default moved:
 *
 *   * the subscription period lives on subscription ITEMS, not on the
 *     subscription — `current_period_start` / `current_period_end` were removed
 *     from the subscription in 2025-03-31.basil
 *   * `cancel_at_period_end` is deprecated in favour of `cancel_at`, and both
 *     are read
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia'

const STRIPE_BASE_URL = 'https://api.stripe.com/v1'
const DEFAULT_TIMEOUT_MS = 20_000

export type StripeErrorCategory =
  | 'authentication'
  | 'permission'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'card_declined'
  | 'idempotency_conflict'
  | 'stripe_unavailable'
  | 'network'
  | 'timeout'
  | 'malformed_response'

/**
 * A Stripe failure, in our vocabulary.
 *
 * Carries a category and a sentence written here — never Stripe's own message.
 * A provider error body commonly echoes the request that caused it, and the
 * request carried the credential.
 */
export class StripeApiError extends Error {
  readonly category: StripeErrorCategory
  readonly status: number | null
  /** Stripe's request id, when it sent one. Safe to log, and the only thing
   *  Stripe support will ask for. */
  readonly requestId: string | null

  constructor(
    category: StripeErrorCategory,
    message: string,
    status: number | null = null,
    requestId: string | null = null,
  ) {
    super(message)
    this.name = 'StripeApiError'
    this.category = category
    this.status = status
    this.requestId = requestId
  }
}

export interface StripeClientOptions {
  readonly secretKey: string
  readonly mode: StripeMode
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly apiVersion?: string
}

/** A form value: Stripe accepts scalars, nested objects and arrays. */
export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [key: string]: FormValue }

/**
 * Stripe's form encoding, including the bracket syntax for structure.
 *
 * `{ line_items: [{ price: 'price_1', quantity: 1 }] }` becomes
 * `line_items[0][price]=price_1&line_items[0][quantity]=1`, which is what the
 * documentation's curl examples show and what the SDKs produce.
 *
 * `undefined` and `null` are dropped rather than sent as the strings "undefined"
 * and "null" — a distinction that matters, because Stripe reads an empty string
 * as "unset this field" and would happily unset something.
 */
export function encodeForm(params: Record<string, FormValue>): string {
  const pairs: string[] = []

  const walk = (prefix: string, value: FormValue): void => {
    if (value === undefined || value === null) return

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item))
      return
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        walk(`${prefix}[${key}]`, nested)
      }
      return
    }
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`)
  }

  for (const [key, value] of Object.entries(params)) walk(key, value)
  return pairs.join('&')
}

interface StripeErrorEnvelope {
  error?: {
    type?: string
    code?: string
    message?: string
  }
}

/**
 * Stripe's documented error taxonomy, mapped to ours.
 *
 * The status code decides most of it; `error.type` refines the 402/400 cases.
 * Nothing from `error.message` reaches the caller.
 */
export function categorizeStripeError(status: number, body: StripeErrorEnvelope): StripeErrorCategory {
  const type = body.error?.type ?? ''

  if (status === 401) return 'authentication'
  if (status === 403) return 'permission'
  if (status === 404) return 'not_found'
  if (status === 409) return 'idempotency_conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'stripe_unavailable'

  if (type === 'card_error') return 'card_declined'
  if (type === 'idempotency_error') return 'idempotency_conflict'
  if (type === 'rate_limit_error') return 'rate_limited'
  if (type === 'authentication_error') return 'authentication'
  if (type === 'api_error') return 'stripe_unavailable'

  return 'invalid_request'
}

/** A sentence for each category, written for a person reading a Billing page. */
export function describeStripeError(category: StripeErrorCategory): string {
  switch (category) {
    case 'authentication':
    case 'permission':
      return 'Subscription billing is configured incorrectly. Contact support.'
    case 'not_found':
      return 'That subscription could not be found at our payment provider.'
    case 'rate_limited':
      return 'Our payment provider is busy. Try again in a moment.'
    case 'card_declined':
      return 'The payment was declined. Try a different payment method.'
    case 'idempotency_conflict':
      return 'That request is already being processed.'
    case 'stripe_unavailable':
    case 'network':
    case 'timeout':
      return 'Our payment provider is unavailable right now. Try again shortly.'
    case 'invalid_request':
    case 'malformed_response':
      return 'That billing request could not be completed.'
  }
}

export interface StripeRequestOptions {
  /** Ties a retry to the logical operation rather than to the attempt. */
  readonly idempotencyKey?: string
  /** `expand[]`, for the one place this integration needs a nested object. */
  readonly expand?: readonly string[]
}

/**
 * One Stripe account, one credential, one pinned version.
 *
 * Constructed per request in the Edge Function, so a rotated secret takes effect
 * on the next invocation rather than on the next cold start.
 */
export class StripeClient {
  private readonly secretKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly apiVersion: string
  readonly mode: StripeMode

  constructor(options: StripeClientOptions) {
    this.secretKey = options.secretKey
    this.mode = options.mode
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.apiVersion = options.apiVersion ?? STRIPE_API_VERSION
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, FormValue> = {},
    options: StripeRequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Stripe-Version': this.apiVersion,
    }

    const body = { ...params }
    if (options.expand && options.expand.length > 0) {
      body.expand = [...options.expand]
    }

    let url = `${STRIPE_BASE_URL}${path}`
    let payload: string | undefined

    if (method === 'GET') {
      const query = encodeForm(body)
      if (query !== '') url = `${url}?${query}`
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      payload = encodeForm(body)
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        // A credential must never follow a redirect to a host nobody configured.
        redirect: 'error',
      })
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      throw new StripeApiError(
        aborted ? 'timeout' : 'network',
        describeStripeError(aborted ? 'timeout' : 'network'),
      )
    } finally {
      clearTimeout(timer)
    }

    const requestId = response.headers.get('Request-Id')
    const text = await response.text()

    let parsed: unknown
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new StripeApiError(
        'malformed_response',
        describeStripeError('malformed_response'),
        response.status,
        requestId,
      )
    }

    if (!response.ok) {
      const category = categorizeStripeError(response.status, parsed as StripeErrorEnvelope)
      throw new StripeApiError(category, describeStripeError(category), response.status, requestId)
    }

    return parsed as T
  }
}
