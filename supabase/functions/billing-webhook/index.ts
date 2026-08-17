/**
 * The Stripe webhook.
 *
 * The only unauthenticated endpoint in this product, and the only one that can
 * change a subscription. What stands in for a caller check is the signature:
 * without a valid one, nothing here reads the body as an event, records
 * anything, or touches the database.
 *
 * IT FAILS CLOSED. With no webhook secret configured — the state of this
 * deployment — every request is refused. There is deliberately no development
 * branch that trusts unsigned JSON: a fallback like that is a fallback somebody
 * ships.
 *
 * THE RAW BODY. Read with `request.text()` before anything parses it. Stripe's
 * requirement is the body "without any changes", and parsing then re-serialising
 * fails verification every time.
 *
 * IT ACKNOWLEDGES WHAT IT DECIDED. A 2xx means "we have dealt with this" —
 * including "we deliberately ignore this event type". A 5xx means "try again",
 * and Stripe will, for three days. Answering 2xx to a genuine failure is how a
 * subscription silently never syncs.
 *
 * NOTHING HERE LOGS THE SIGNATURE, THE SECRET, THE PAYLOAD, OR A CUSTOMER
 * IDENTIFIER. The event id and its type are safe and are all support needs.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import {
  normalizeSubscription,
  type StripeEvent,
  type StripeSubscription,
} from '../_shared/billing-domain.ts'
import {
  processStripeEvent,
  type WebhookOutcome,
  type WebhookStore,
} from '../_shared/billing-webhook-processing.ts'
import { StripeClient } from '../_shared/stripe-api.ts'
import { resolveBillingConfig } from '../_shared/stripe-config.ts'
import { verifyStripeSignature } from '../_shared/stripe-signature.ts'

/*
 * No CORS. A browser has no business calling this, and advertising that it may
 * would invite exactly the unsigned requests this endpoint exists to refuse.
 */
const PLAIN_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Referrer-Policy': 'no-referrer',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: PLAIN_HEADERS })
}

function serviceClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** The store the processing module writes through, bound to real RPCs. */
function makeStore(service: SupabaseClient, stripe: StripeClient): WebhookStore {
  return {
    async claimEvent({ id, type, createdAt, objectId }) {
      const { data, error } = await service.rpc('billing_claim_webhook_event', {
        p_stripe_event_id: id,
        p_event_type: type,
        p_event_created_at: createdAt,
        p_object_id: objectId,
      })
      // A claim we could not make is treated as ours to retry, never as done.
      if (error) throw new Error('claim_failed')
      return data === 'duplicate' ? 'duplicate' : 'claimed'
    },

    async finishEvent({ id, result, organizationId }) {
      const { error } = await service.rpc('billing_finish_webhook_event', {
        p_stripe_event_id: id,
        p_result: result,
        p_organization_id: organizationId,
        p_failure_category: null,
      })
      /*
       * A ledger write that failed must not be answered with a 2xx: the event
       * would then be neither recorded as processed nor retried, which is the
       * one outcome worse than either.
       */
      if (error) throw new Error('ledger_failed')
    },

    async failEvent({ id, failureCategory }) {
      const { error } = await service.rpc('billing_fail_webhook_event', {
        p_stripe_event_id: id,
        p_failure_category: failureCategory,
      })
      if (error) throw new Error('ledger_failed')
    },

    async fetchSubscription(subscriptionId) {
      /*
       * Stripe's own answer to its own lack of ordering guarantees: read the
       * object now rather than believing a payload that may be three days old.
       * The price is expanded because the projection stores the money.
       */
      return await stripe.request<StripeSubscription>(
        'GET',
        `/subscriptions/${subscriptionId}`,
        {},
        { expand: ['items.data.price'] },
      )
    },

    async applySubscription({ subscription, eventCreatedAt, eventId }) {
      if (!subscription.ok) return 'unknown_customer'
      const value = subscription.value

      const { data, error } = await service.rpc('billing_apply_subscription', {
        p_stripe_subscription_id: value.stripeSubscriptionId,
        p_stripe_customer_id: value.stripeCustomerId,
        p_mode: value.mode,
        p_status: value.status,
        p_stripe_price_id: value.stripePriceId,
        p_currency: value.currency,
        p_amount_minor: value.amountMinor,
        p_interval: value.interval,
        p_interval_count: value.intervalCount,
        p_quantity: value.quantity,
        p_current_period_start: value.currentPeriodStart,
        p_current_period_end: value.currentPeriodEnd,
        p_cancel_at_period_end: value.cancelAtPeriodEnd,
        p_cancel_at: value.cancelAt,
        p_canceled_at: value.canceledAt,
        p_ended_at: value.endedAt,
        p_trial_start: value.trialStart,
        p_trial_end: value.trialEnd,
        p_event_at: eventCreatedAt,
        p_event_id: eventId,
      })
      if (error) throw new Error('apply_failed')

      return (data as 'applied' | 'stale' | 'unknown_customer' | 'anomaly') ?? 'applied'
    },

    async applyInvoice(input) {
      const { data, error } = await service.rpc('billing_apply_invoice', {
        p_stripe_customer_id: input.customerId,
        p_stripe_subscription_id: input.subscriptionId,
        p_invoice_id: input.invoiceId,
        p_invoice_status: input.invoiceStatus,
        p_amount_minor: input.amountMinor,
        p_currency: input.currency,
        p_failed: input.failed,
        p_event_at: input.eventCreatedAt,
        p_event_id: input.eventId,
      })
      if (error) throw new Error('apply_failed')
      return (data as 'applied' | 'unknown_customer' | 'no_subscription' | 'stale') ?? 'applied'
    },

    async resolveOrganization(customerId) {
      // The ledger's tenant column, from the same mapping that resolves every
      // other event. It was never populated before, which left the column and
      // its index permanently empty and made a support question unanswerable.
      const { data } = await service
        .from('billing_customers')
        .select('organization_id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle()
      return (data?.organization_id as string | undefined) ?? null
    },

    async markCustomerDeleted(customerId) {
      /*
       * Through a service function, like every other billing write.
       *
       * This was a direct table update, and it was the only write in the module
       * that was not an RPC. The guard trigger refused it — correctly — and
       * because supabase-js returns errors rather than throwing, the refusal was
       * discarded and the event was recorded as applied. A deleted Stripe
       * customer stayed live in the projection forever, and Stripe was told the
       * event had been handled.
       */
      const { error } = await service.rpc('billing_mark_customer_deleted', {
        p_stripe_customer_id: customerId,
      })
      if (error) throw new Error('apply_failed')
    },
  }
}

/** Outcomes that mean "settled". Anything else asks Stripe to try again. */
const SETTLED: readonly WebhookOutcome[] = [
  'applied',
  'ignored_unsupported',
  'ignored_duplicate',
  'ignored_stale',
  'ignored_unknown_customer',
]

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json({ ok: false }, 405)

  const configured = resolveBillingConfig(Deno.env.toObject(), { requireWebhookSecret: true })
  if (!configured.ok) {
    /*
     * Unconfigured, so nothing is trusted. 503 rather than 200: a 200 would tell
     * Stripe the event was handled, and it never was.
     */
    console.error('billing-webhook: refused (not_configured)')
    return json({ ok: false, error: { category: 'not_configured' } }, 503)
  }

  const config = configured.config
  const payload = await request.text()
  const signature = request.headers.get('Stripe-Signature')

  const verified = await verifyStripeSignature(payload, signature, config.webhookSecret!)
  if (!verified.ok) {
    console.error(`billing-webhook: refused (${verified.reason})`)
    return json({ ok: false, error: { category: 'invalid_signature' } }, 400)
  }

  let event: StripeEvent
  try {
    event = JSON.parse(payload) as StripeEvent
  } catch {
    return json({ ok: false, error: { category: 'malformed_event' } }, 400)
  }
  if (
    typeof event.id !== 'string' ||
    typeof event.type !== 'string' ||
    typeof event.created !== 'number'
  ) {
    return json({ ok: false, error: { category: 'malformed_event' } }, 400)
  }

  /*
   * A signed event from the other Stripe mode. Configuration is wrong somewhere;
   * applying it would mix a test subscription into live billing.
   */
  if ((event.livemode === true ? 'live' : 'test') !== config.mode) {
    console.error(`billing-webhook: refused (mode_mismatch) ${event.id}`)
    return json({ ok: false, error: { category: 'mode_mismatch' } }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (supabaseUrl === '' || serviceKey === '') {
    return json({ ok: false, error: { category: 'not_configured' } }, 503)
  }

  const service = serviceClient(supabaseUrl, serviceKey)
  const stripe = new StripeClient({ secretKey: config.secretKey, mode: config.mode })

  let result
  try {
    result = await processStripeEvent(event, makeStore(service, stripe))
  } catch {
    console.error(`billing-webhook: ${event.type} failed unexpectedly ${event.id}`)
    return json({ ok: false }, 500)
  }

  if (!SETTLED.includes(result.outcome)) {
    // Left open in the ledger; Stripe will retry, and the retry will re-claim it.
    console.error(
      `billing-webhook: ${event.type} not settled (${result.failureCategory ?? result.outcome}) ${event.id}`,
    )
    return json({ ok: false, outcome: result.outcome }, 500)
  }

  return json({ ok: true, outcome: result.outcome })
})
