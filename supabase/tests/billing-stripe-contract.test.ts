// @vitest-environment node
/**
 * The Stripe boundary, tested deterministically.
 *
 * No Stripe credential exists in this deployment, so nothing here talks to
 * Stripe and nothing here claims to. What it does prove is that the code which
 * WILL talk to Stripe matches the contract Stripe documents — the signature
 * algorithm, the form encoding, the error taxonomy, the field the billing period
 * actually lives on since API version 2025-03-31.basil, and the ordering rules
 * that keep a three-day-old retry from undoing yesterday's reactivation.
 *
 * One of these is stronger than a fixture: the signature tests generate their
 * headers with Stripe's OWN signer, from the `stripe` package, and assert that
 * our verifier accepts exactly what Stripe produces and rejects everything else.
 * That is a real contract test against the vendor's implementation, without a
 * network and without a key.
 */
import Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'

import {
  accessStateForStatus,
  cancellationScheduled,
  checkoutIdempotencyKey,
  checkoutSessionParams,
  customerIdempotencyKey,
  eventObjectId,
  isHandledEventType,
  isLiveStatus,
  isStaleEvent,
  normalizeSubscription,
  parseSubscriptionStatus,
  portalSessionParams,
  SUBSCRIPTION_STATUSES,
  type StripeEvent,
  type StripeSubscription,
} from '../functions/_shared/billing-domain.ts'
import {
  categorizeStripeError,
  describeStripeError,
  encodeForm,
  StripeApiError,
  StripeClient,
  STRIPE_API_VERSION,
} from '../functions/_shared/stripe-api.ts'
import {
  BILLING_ENV_NAMES,
  buildReturnUrl,
  modeOfSecretKey,
  normalizeAppUrl,
  parseCatalogue,
  resolveBillingConfig,
} from '../functions/_shared/stripe-config.ts'
import {
  computeSignature,
  DEFAULT_TOLERANCE_SECONDS,
  parseSignatureHeader,
  verifyStripeSignature,
} from '../functions/_shared/stripe-signature.ts'
import {
  customerIdFromEvent,
  processStripeEvent,
  subscriptionIdFromEvent,
  type WebhookStore,
} from '../functions/_shared/billing-webhook-processing.ts'

const WEBHOOK_SECRET = 'whsec_KGe7ffFqLhkPCJNBPfvGGxNVfPbCFH1r'
const stripe = new Stripe('sk_test_notarealkey', { apiVersion: STRIPE_API_VERSION })

// -----------------------------------------------------------------------------
describe('webhook signatures, against Stripe’s own signer', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' })

  it('accepts a header Stripe itself generated', async () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    })

    const result = await verifyStripeSignature(payload, header, WEBHOOK_SECRET)
    expect(result.ok).toBe(true)
  })

  it('computes the same digest Stripe computes', async () => {
    const timestamp = 1_800_000_000
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp,
    })
    const theirs = header.split(',').find((part) => part.startsWith('v1='))!.slice(3)
    const ours = await computeSignature(`${timestamp}.${payload}`, WEBHOOK_SECRET)

    expect(ours).toBe(theirs)
  })

  it('rejects a body altered after signing, by a single character', async () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
    const tampered = payload.replace('evt_1', 'evt_2')

    const result = await verifyStripeSignature(tampered, header, WEBHOOK_SECRET)
    expect(result).toMatchObject({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects a signature made with a different secret', async () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_someoneelsessecretvaluehere00',
    })

    const result = await verifyStripeSignature(payload, header, WEBHOOK_SECRET)
    expect(result).toMatchObject({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects correct JSON with no signature at all', async () => {
    expect(await verifyStripeSignature(payload, null, WEBHOOK_SECRET)).toMatchObject({
      ok: false,
      reason: 'missing_signature',
    })
    expect(await verifyStripeSignature(payload, '', WEBHOOK_SECRET)).toMatchObject({
      ok: false,
      reason: 'missing_signature',
    })
  })

  it('ignores the v0 scheme, which is how a downgrade would arrive', async () => {
    const timestamp = 1_800_000_000
    const v0 = await computeSignature(`${timestamp}.${payload}`, WEBHOOK_SECRET)
    // A header carrying ONLY a v0 signature, even a correctly computed one.
    const header = `t=${timestamp},v0=${v0}`

    expect(await verifyStripeSignature(payload, header, WEBHOOK_SECRET)).toMatchObject({
      ok: false,
      reason: 'no_supported_scheme',
    })
  })

  it('accepts one of several v1 signatures, as during a secret roll', async () => {
    const timestamp = 1_800_000_000
    const current = await computeSignature(`${timestamp}.${payload}`, WEBHOOK_SECRET)
    const header = `t=${timestamp},v1=${'a'.repeat(64)},v1=${current}`

    const result = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, {
      nowSeconds: () => timestamp,
    })
    expect(result.ok).toBe(true)
  })

  it('refuses a replay outside the tolerance, in both directions', async () => {
    const timestamp = 1_800_000_000
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp,
    })

    const old = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, {
      nowSeconds: () => timestamp + DEFAULT_TOLERANCE_SECONDS + 1,
    })
    expect(old).toMatchObject({ ok: false, reason: 'timestamp_out_of_tolerance' })

    const future = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, {
      nowSeconds: () => timestamp - DEFAULT_TOLERANCE_SECONDS - 1,
    })
    expect(future).toMatchObject({ ok: false, reason: 'timestamp_out_of_tolerance' })

    const inside = await verifyStripeSignature(payload, header, WEBHOOK_SECRET, {
      nowSeconds: () => timestamp + DEFAULT_TOLERANCE_SECONDS - 1,
    })
    expect(inside.ok).toBe(true)
  })

  it('uses Stripe’s own default tolerance', () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300)
  })

  it('reads a malformed header as malformed, not as a mismatch', () => {
    expect(parseSignatureHeader('nonsense')).toBe('malformed_signature')
    expect(parseSignatureHeader('t=notanumber,v1=' + 'a'.repeat(64))).toBe('malformed_signature')
    expect(parseSignatureHeader('v1=' + 'a'.repeat(64))).toBe('malformed_signature')
  })
})

// -----------------------------------------------------------------------------
describe('configuration', () => {
  const complete = {
    [BILLING_ENV_NAMES.secretKey]: 'sk_test_abcdefghijklmnop',
    [BILLING_ENV_NAMES.webhookSecret]: WEBHOOK_SECRET,
    [BILLING_ENV_NAMES.appUrl]: 'https://atlasloca.com',
    [BILLING_ENV_NAMES.catalogue]: '[{"plan_key":"standard","price_id":"price_123"}]',
  }

  it('reports an unconfigured deployment as unconfigured, not as an error', () => {
    const result = resolveBillingConfig({})
    expect(result).toMatchObject({ ok: false, problem: 'missing_secret_key' })
    // And says nothing about which variable is missing.
    expect(result.ok === false && result.detail).not.toMatch(/STRIPE|KEY|env/i)
  })

  it('reads the mode from the key rather than guessing it', () => {
    expect(modeOfSecretKey('sk_test_abc')).toBe('test')
    expect(modeOfSecretKey('rk_live_abc')).toBe('live')
    expect(modeOfSecretKey('pk_test_abc')).toBeNull()
    expect(modeOfSecretKey('whsec_abc')).toBeNull()
  })

  it('refuses a live key beside a test price', () => {
    const result = resolveBillingConfig({
      ...complete,
      [BILLING_ENV_NAMES.secretKey]: 'sk_live_abcdefghijklmnop',
      [BILLING_ENV_NAMES.catalogue]: '[{"plan_key":"standard","price_id":"price_test_123"}]',
    })
    expect(result).toMatchObject({ ok: false, problem: 'mode_mismatch' })
  })

  it('accepts a complete configuration and reports its mode', () => {
    const result = resolveBillingConfig(complete)
    expect(result.ok).toBe(true)
    expect(result.ok && result.config.mode).toBe('test')
    expect(result.ok && result.config.catalogue).toEqual([
      { planKey: 'standard', priceId: 'price_123' },
    ])
  })

  it('requires a webhook secret only where one is required, and never falls back', () => {
    const withoutSecret = { ...complete, [BILLING_ENV_NAMES.webhookSecret]: '' }
    expect(resolveBillingConfig(withoutSecret).ok).toBe(true)
    expect(resolveBillingConfig(withoutSecret, { requireWebhookSecret: true })).toMatchObject({
      ok: false,
      problem: 'missing_webhook_secret',
    })
  })

  it('refuses a catalogue that names a price and a lookup key, or neither', () => {
    expect(parseCatalogue('[{"plan_key":"a","price_id":"price_1","lookup_key":"a"}]')).toBe(
      'invalid_catalogue',
    )
    expect(parseCatalogue('[{"plan_key":"a"}]')).toBe('invalid_catalogue')
    expect(parseCatalogue('[{"plan_key":"a","price_id":"prod_1"}]')).toBe('invalid_catalogue')
    expect(parseCatalogue('[{"plan_key":"A","price_id":"price_1"}]')).toBe('invalid_catalogue')
    expect(parseCatalogue('not json')).toBe('invalid_catalogue')
    expect(parseCatalogue('')).toEqual([])
  })

  it('refuses a duplicate plan key, which would make resolution ambiguous', () => {
    expect(
      parseCatalogue('[{"plan_key":"a","price_id":"price_1"},{"plan_key":"a","price_id":"price_2"}]'),
    ).toBe('invalid_catalogue')
  })
})

// -----------------------------------------------------------------------------
describe('return URLs cannot be pointed anywhere else', () => {
  it('accepts only a configured https origin', () => {
    expect(normalizeAppUrl('https://atlasloca.com/')).toBe('https://atlasloca.com')
    expect(normalizeAppUrl('http://localhost:4173')).toBe('http://localhost:4173')
    expect(normalizeAppUrl('http://atlasloca.com')).toBeNull()
    expect(normalizeAppUrl('https://user:pass@atlasloca.com')).toBeNull()
    expect(normalizeAppUrl('https://atlasloca.com/?next=x')).toBeNull()
    expect(normalizeAppUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeAppUrl('')).toBeNull()
  })

  it('refuses a path that is really another origin', () => {
    const app = 'https://atlasloca.com'
    expect(buildReturnUrl(app, '/billing')).toBe('https://atlasloca.com/billing')
    expect(buildReturnUrl(app, '//evil.example')).toBeNull()
    expect(buildReturnUrl(app, 'https://evil.example')).toBeNull()
    expect(buildReturnUrl(app, '/billing\r\nLocation: https://evil.example')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
describe('the Checkout request', () => {
  const request = {
    organizationId: '5c2b0f4c-3b5a-4a1e-9d0e-1a2b3c4d5e6f',
    customerId: 'cus_123',
    priceId: 'price_123',
    planKey: 'standard',
  }

  it('names the price the server resolved, and returns to a configured URL', () => {
    const params = checkoutSessionParams(request, 'https://atlasloca.com')!

    expect(params.mode).toBe('subscription')
    expect(params.line_items).toEqual([{ price: 'price_123', quantity: 1 }])
    expect(params.customer).toBe('cus_123')
    expect(String(params.success_url)).toBe(
      'https://atlasloca.com/billing/return?session={CHECKOUT_SESSION_ID}',
    )
    expect(String(params.cancel_url)).toBe('https://atlasloca.com/billing')
  })

  it('carries the organization as a cross-check, not as the mapping', () => {
    const params = checkoutSessionParams(request, 'https://atlasloca.com')!
    expect(params.client_reference_id).toBe(request.organizationId)
    // The customer is what resolves the tenant later; metadata only corroborates.
    expect(params.customer).toBe('cus_123')
  })

  it('produces nothing at all when the application URL is not usable', () => {
    expect(checkoutSessionParams(request, 'http://atlasloca.com')).toBeNull()
    expect(portalSessionParams('cus_123', 'ftp://atlasloca.com')).toBeNull()
  })

  it('ties customer creation to the organization, so a retry cannot mint a second', () => {
    expect(customerIdempotencyKey(request.organizationId)).toBe(
      `atlas-customer-${request.organizationId}`,
    )
    // Same organization, same key, every time — the opposite of a random key.
    expect(customerIdempotencyKey(request.organizationId)).toBe(
      customerIdempotencyKey(request.organizationId),
    )
    // And a checkout key is scoped so a later, legitimate purchase is not blocked.
    expect(checkoutIdempotencyKey('org', 'plan', 'a')).not.toBe(
      checkoutIdempotencyKey('org', 'plan', 'b'),
    )
  })
})

// -----------------------------------------------------------------------------
describe('form encoding, as Stripe’s API expects it', () => {
  it('uses bracket syntax for nested values and arrays', () => {
    const encoded = encodeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      metadata: { organization_id: 'org-1' },
    })

    expect(decodeURIComponent(encoded)).toContain('line_items[0][price]=price_1')
    expect(decodeURIComponent(encoded)).toContain('line_items[0][quantity]=1')
    expect(decodeURIComponent(encoded)).toContain('metadata[organization_id]=org-1')
  })

  it('drops undefined and null rather than sending them as words', () => {
    const encoded = encodeForm({ a: 'x', b: undefined, c: null })
    expect(encoded).toBe('a=x')
  })

  it('escapes values that would otherwise change the request', () => {
    const encoded = encodeForm({ 'return_url': 'https://a.test/x?y=1&z=2' })
    expect(encoded).toBe('return_url=https%3A%2F%2Fa.test%2Fx%3Fy%3D1%26z%3D2')
  })
})

// -----------------------------------------------------------------------------
describe('the Stripe client', () => {
  /**
   * A fresh Response per call. A Response body can only be read once, so a
   * shared instance makes the second request fail for a reason that has nothing
   * to do with Stripe.
   */
  function clientWith(body: string, status = 200) {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch
    return {
      fetchImpl,
      client: new StripeClient({ secretKey: 'sk_test_x', mode: 'test', fetchImpl }),
    }
  }

  it('pins the API version on every request', async () => {
    const { client, fetchImpl } = clientWith('{"id":"cus_1"}')
    await client.request('POST', '/customers', { email: 'a@b.test' })

    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!
    expect((init.headers as Record<string, string>)['Stripe-Version']).toBe('2026-07-29.dahlia')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_test_x')
    expect(init.redirect).toBe('error')
  })

  it('sends an idempotency key only when one was asked for', async () => {
    const { client, fetchImpl } = clientWith('{}')
    await client.request('POST', '/customers', {}, { idempotencyKey: 'atlas-customer-1' })
    await client.request('POST', '/customers', {})

    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
    expect((calls[0]![1].headers as Record<string, string>)['Idempotency-Key']).toBe(
      'atlas-customer-1',
    )
    expect((calls[1]![1].headers as Record<string, string>)['Idempotency-Key']).toBeUndefined()
  })

  it('maps Stripe’s error taxonomy onto ours', () => {
    expect(categorizeStripeError(401, {})).toBe('authentication')
    expect(categorizeStripeError(404, {})).toBe('not_found')
    expect(categorizeStripeError(429, {})).toBe('rate_limited')
    expect(categorizeStripeError(500, {})).toBe('stripe_unavailable')
    expect(categorizeStripeError(402, { error: { type: 'card_error' } })).toBe('card_declined')
    expect(categorizeStripeError(400, { error: { type: 'idempotency_error' } })).toBe(
      'idempotency_conflict',
    )
    expect(categorizeStripeError(400, { error: { type: 'invalid_request_error' } })).toBe(
      'invalid_request',
    )
  })

  it('never lets Stripe’s own message reach the caller', async () => {
    const { client } = clientWith(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'No such price: price_123; a similar object exists in live mode',
        },
      }),
      400,
    )

    await expect(client.request('POST', '/checkout/sessions', {})).rejects.toBeInstanceOf(
      StripeApiError,
    )
    await client.request('POST', '/checkout/sessions', {}).catch((error: StripeApiError) => {
      expect(error.message).toBe(describeStripeError('invalid_request'))
      expect(error.message).not.toContain('price_123')
      expect(error.message).not.toContain('live mode')
    })
  })

  it('reports a timeout as a timeout rather than as a Stripe answer', async () => {
    const fetchImpl = vi.fn(() => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      return Promise.reject(error)
    }) as unknown as typeof fetch
    const client = new StripeClient({
      secretKey: 'sk_test_x',
      mode: 'test',
      fetchImpl,
      timeoutMs: 5,
    })

    await client.request('GET', '/customers/cus_1').catch((error: StripeApiError) => {
      expect(error.category).toBe('timeout')
    })
  })
})

// -----------------------------------------------------------------------------
describe('reading a subscription on the current API version', () => {
  const base: StripeSubscription = {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    livemode: false,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: 'si_1',
          quantity: 1,
          current_period_start: 1_800_000_000,
          current_period_end: 1_802_678_400,
          price: {
            id: 'price_1',
            currency: 'eur',
            unit_amount: 4900,
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
  }

  it('takes the period from the subscription ITEM, where it now lives', () => {
    const result = normalizeSubscription(base)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.currentPeriodEnd).toBe(
      new Date(1_802_678_400 * 1000).toISOString(),
    )
  })

  it('finds no period on a subscription-level field, because there is none', () => {
    // A payload shaped like the pre-2025-03-31.basil API: the period at the top
    // level and nothing on the item. Reading the old field would produce a
    // renewal date; reading the right one correctly produces none.
    const legacy = {
      ...base,
      current_period_end: 1_802_678_400,
      items: { data: [{ id: 'si_1', price: base.items!.data![0]!.price }] },
    } as StripeSubscription
    const result = normalizeSubscription(legacy)
    expect(result.ok && result.value.currentPeriodEnd).toBeNull()
  })

  it('takes the earliest end across items, as min_period_end means', () => {
    const mixed: StripeSubscription = {
      ...base,
      items: {
        data: [
          { ...base.items!.data![0]!, current_period_end: 1_805_000_000 },
          { ...base.items!.data![0]!, id: 'si_2', current_period_end: 1_802_678_400 },
        ],
      },
    }
    const result = normalizeSubscription(mixed)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.currentPeriodEnd).toBe(new Date(1_802_678_400 * 1000).toISOString())
  })

  it('reads the mode from livemode, not from the identifier', () => {
    const test = normalizeSubscription(base)
    const live = normalizeSubscription({ ...base, livemode: true })
    expect(test.ok && test.value.mode).toBe('test')
    expect(live.ok && live.value.mode).toBe('live')
  })

  it('refuses a status Stripe has not documented instead of guessing', () => {
    const odd = { ...base, status: 'pending_activation' }
    expect(normalizeSubscription(odd)).toMatchObject({ ok: false, reason: 'unrecognised_status' })
    expect(parseSubscriptionStatus('pending_activation')).toBeNull()
  })

  it('knows all eight statuses and no others', () => {
    expect([...SUBSCRIPTION_STATUSES]).toEqual([
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused',
    ])
  })

  it('treats only active and trialing as normal access', () => {
    expect(SUBSCRIPTION_STATUSES.filter((s) => accessStateForStatus(s) === 'normal')).toEqual([
      'trialing',
      'active',
    ])
    // And nothing produces a restricted state: no restriction policy exists.
    expect(SUBSCRIPTION_STATUSES.some((s) => accessStateForStatus(s) === 'restricted')).toBe(false)
  })

  it('knows which statuses Stripe still bills for', () => {
    expect(SUBSCRIPTION_STATUSES.filter(isLiveStatus)).toEqual([
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'paused',
    ])
  })

  it('sees a cancellation set through either of Stripe’s two fields', () => {
    const byBoolean = normalizeSubscription({ ...base, cancel_at_period_end: true })
    const byTimestamp = normalizeSubscription({ ...base, cancel_at: 1_802_678_400 })

    expect(byBoolean.ok && cancellationScheduled(byBoolean.value)).toBe(true)
    // The portal on flexible billing sets cancel_at and leaves the deprecated
    // boolean false. Reading only the boolean would tell an owner their
    // subscription is continuing when it is not.
    expect(byTimestamp.ok && cancellationScheduled(byTimestamp.value)).toBe(true)
    const neither = normalizeSubscription(base)
    expect(neither.ok && cancellationScheduled(neither.value)).toBe(false)
  })

  it('refuses a subscription with no items rather than storing a blank period', () => {
    expect(normalizeSubscription({ ...base, items: { data: [] } })).toMatchObject({
      ok: false,
      reason: 'missing_items',
    })
  })
})

// -----------------------------------------------------------------------------
describe('events', () => {
  const event = (over: Partial<StripeEvent> = {}): StripeEvent => ({
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: 1_800_000_000,
    data: { object: { id: 'sub_1', customer: 'cus_1' } },
    ...over,
  })

  it('acts only on the event types this integration decided to handle', () => {
    expect(isHandledEventType('customer.subscription.updated')).toBe(true)
    expect(isHandledEventType('invoice.payment_failed')).toBe(true)
    // Stripe sends dozens more. None of them may change what this product does.
    expect(isHandledEventType('invoice.created')).toBe(false)
    expect(isHandledEventType('payment_intent.succeeded')).toBe(false)
    expect(isHandledEventType('charge.refunded')).toBe(false)
  })

  it('finds the object id for the second duplicate guard', () => {
    expect(eventObjectId(event())).toBe('sub_1')
    expect(eventObjectId(event({ data: { object: {} } }))).toBeNull()
  })

  it('finds the subscription whichever shape the event carries it in', () => {
    expect(subscriptionIdFromEvent(event())).toBe('sub_1')
    expect(
      subscriptionIdFromEvent(
        event({
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_1', subscription: 'sub_9' } },
        }),
      ),
    ).toBe('sub_9')
    // The current API version nests it under parent.subscription_details.
    expect(
      subscriptionIdFromEvent(
        event({
          type: 'invoice.paid',
          data: {
            object: {
              id: 'in_1',
              parent: { subscription_details: { subscription: 'sub_7' } },
            },
          },
        }),
      ),
    ).toBe('sub_7')
    // And an account on an older version still sends the flat field.
    expect(
      subscriptionIdFromEvent(
        event({ type: 'invoice.paid', data: { object: { id: 'in_1', subscription: 'sub_6' } } }),
      ),
    ).toBe('sub_6')
  })

  it('takes the customer from the object, and the id itself for a deletion', () => {
    expect(customerIdFromEvent(event())).toBe('cus_1')
    expect(
      customerIdFromEvent(event({ type: 'customer.deleted', data: { object: { id: 'cus_5' } } })),
    ).toBe('cus_5')
  })

  it('recognises an event older than what has already been applied', () => {
    const applied = new Date(1_800_000_000 * 1000).toISOString()
    expect(isStaleEvent(1_799_999_999, applied)).toBe(true)
    expect(isStaleEvent(1_800_000_001, applied)).toBe(false)
    // Same instant is applied, not skipped: the write is idempotent and two
    // events in one second are more likely one change than a regression.
    expect(isStaleEvent(1_800_000_000, applied)).toBe(false)
    expect(isStaleEvent(1_700_000_000, null)).toBe(false)
  })
})

// -----------------------------------------------------------------------------
describe('processing an event', () => {
  function makeStore(over: Partial<WebhookStore> = {}) {
    const calls = {
      claims: [] as string[],
      finished: [] as { id: string; result: string; organizationId: string | null }[],
      failed: [] as { id: string; failureCategory: string }[],
      fetched: [] as string[],
      applied: 0,
    }

    const store: WebhookStore = {
      claimEvent: ({ id }) => {
        calls.claims.push(id)
        return Promise.resolve('claimed' as const)
      },
      finishEvent: (input) => {
        calls.finished.push({
          id: input.id,
          result: input.result,
          organizationId: input.organizationId,
        })
        return Promise.resolve()
      },
      failEvent: (input) => {
        calls.failed.push(input)
        return Promise.resolve()
      },
      fetchSubscription: (id) => {
        calls.fetched.push(id)
        return Promise.resolve({
          id,
          customer: 'cus_1',
          status: 'active',
          livemode: false,
          items: {
            data: [
              {
                id: 'si_1',
                quantity: 1,
                current_period_start: 1_800_000_000,
                current_period_end: 1_802_678_400,
                price: {
                  id: 'price_1',
                  currency: 'eur',
                  unit_amount: 4900,
                  recurring: { interval: 'month', interval_count: 1 },
                },
              },
            ],
          },
        })
      },
      applySubscription: () => {
        calls.applied += 1
        return Promise.resolve('applied' as const)
      },
      applyInvoice: () => Promise.resolve('applied' as const),
      resolveOrganization: () => Promise.resolve('org-1'),
      markCustomerDeleted: () => Promise.resolve(),
      ...over,
    }

    return { store, calls }
  }

  const subscriptionEvent: StripeEvent = {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: 1_800_000_000,
    data: { object: { id: 'sub_1', customer: 'cus_1' } },
  }

  it('reads the subscription from Stripe rather than trusting the payload', async () => {
    const { store, calls } = makeStore()
    const result = await processStripeEvent(subscriptionEvent, store)

    expect(result.outcome).toBe('applied')
    // Stripe's own documented answer to out-of-order delivery.
    expect(calls.fetched).toEqual(['sub_1'])
  })

  it('does the work once however many times the same event is delivered', async () => {
    let first = true
    const { store, calls } = makeStore({
      claimEvent: () => {
        if (first) {
          first = false
          return Promise.resolve('claimed' as const)
        }
        return Promise.resolve('duplicate' as const)
      },
    })

    expect((await processStripeEvent(subscriptionEvent, store)).outcome).toBe('applied')
    for (let i = 0; i < 9; i += 1) {
      expect((await processStripeEvent(subscriptionEvent, store)).outcome).toBe('ignored_duplicate')
    }
    expect(calls.applied).toBe(1)
    expect(calls.fetched).toEqual(['sub_1'])
  })

  it('acknowledges an event it does not act on, so Stripe stops retrying', async () => {
    const { store, calls } = makeStore()
    const result = await processStripeEvent(
      { ...subscriptionEvent, type: 'payment_intent.succeeded' },
      store,
    )

    expect(result.outcome).toBe('ignored_unsupported')
    expect(calls.finished).toEqual([
      { id: 'evt_1', result: 'ignored_unsupported', organizationId: null },
    ])
    expect(calls.fetched).toEqual([])
  })

  it('leaves a failed event open so Stripe’s retry can succeed later', async () => {
    const { store, calls } = makeStore({
      fetchSubscription: () => Promise.reject(new StripeApiError('stripe_unavailable', 'unavailable')),
    })

    const result = await processStripeEvent(subscriptionEvent, store)
    expect(result.outcome).toBe('failed')
    // Recorded as failed, but NOT marked processed: a stamped failure is an
    // event that never syncs.
    expect(calls.failed).toEqual([{ id: 'evt_1', failureCategory: 'StripeApiError' }])
    expect(calls.finished).toEqual([])
  })

  it('reports a stale event as stale and changes nothing', async () => {
    const { store } = makeStore({ applySubscription: () => Promise.resolve('stale' as const) })
    expect((await processStripeEvent(subscriptionEvent, store)).outcome).toBe('ignored_stale')
  })

  it('ignores an event for a customer it has never heard of', async () => {
    const { store } = makeStore({
      applySubscription: () => Promise.resolve('unknown_customer' as const),
    })
    expect((await processStripeEvent(subscriptionEvent, store)).outcome).toBe(
      'ignored_unknown_customer',
    )
  })

  it('surfaces two live subscriptions and settles, rather than retrying for three days', async () => {
    const { store, calls } = makeStore({
      applySubscription: () => Promise.resolve('anomaly' as const),
    })
    const result = await processStripeEvent(subscriptionEvent, store)

    expect(result).toMatchObject({
      outcome: 'failed',
      failureCategory: 'duplicate_live_subscription',
    })
    /*
     * SETTLED, not left open. Retrying cannot resolve "Stripe has two live
     * subscriptions for this customer", and three days of retries would bury the
     * evidence under repeated failures. The anomaly is in the billing history —
     * once — and support resolves it with a reconciliation.
     */
    expect(calls.finished).toEqual([
      { id: 'evt_1', result: 'failed', organizationId: 'org-1' },
    ])
    expect(calls.failed).toEqual([])
  })

  it('leaves an invoice with no subscription open, because Stripe does not order events', async () => {
    const { store, calls } = makeStore({
      applyInvoice: () => Promise.resolve('no_subscription' as const),
    })
    const result = await processStripeEvent(
      {
        id: 'evt_3',
        type: 'invoice.paid',
        created: 1_800_000_000,
        data: { object: { id: 'in_2', customer: 'cus_1', status: 'paid' } },
      },
      store,
    )

    // An invoice can arrive before the subscription it belongs to. Answering 2xx
    // would discard that invoice's outcome permanently.
    expect(result).toMatchObject({ outcome: 'failed', failureCategory: 'awaiting_subscription' })
    expect(calls.failed).toEqual([{ id: 'evt_3', failureCategory: 'awaiting_subscription' }])
    expect(calls.finished).toEqual([])
  })

  it('records which tenant an event resolved to', async () => {
    const { store, calls } = makeStore()
    await processStripeEvent(subscriptionEvent, store)
    expect(calls.finished[0]?.organizationId).toBe('org-1')
  })

  it('records a failed invoice payment without reading a decline code', async () => {
    const seen: unknown[] = []
    const { store } = makeStore({
      applyInvoice: (input) => {
        seen.push(input)
        return Promise.resolve('applied' as const)
      },
    })

    await processStripeEvent(
      {
        id: 'evt_2',
        type: 'invoice.payment_failed',
        created: 1_800_000_000,
        data: {
          object: {
            id: 'in_1',
            customer: 'cus_1',
            status: 'open',
            amount_due: 4900,
            currency: 'eur',
            parent: { subscription_details: { subscription: 'sub_1' } },
          },
        },
      },
      store,
    )

    expect(seen[0]).toMatchObject({
      invoiceId: 'in_1',
      failed: true,
      amountMinor: 4900,
      currency: 'EUR',
      subscriptionId: 'sub_1',
    })
    expect(JSON.stringify(seen[0])).not.toMatch(/decline|card|pan|cvc/i)
  })
})
