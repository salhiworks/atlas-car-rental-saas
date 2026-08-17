/**
 * What to do with a Stripe event once it is known to be genuine.
 *
 * The decisions here are the ones that go wrong quietly: which events to act on,
 * how not to act on the same one twice, how not to let Tuesday's cancellation
 * overwrite Wednesday's reactivation, and how to resolve an event to a tenant
 * without trusting a field an attacker could write.
 *
 * They are separated from the Edge Function entry point and given an injected
 * store so all of it is reachable from a test — including the branches that only
 * happen during a retry storm at three in the morning.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not apply the event's own payload to the projection. Stripe's guidance
 * for out-of-order delivery is to re-read the object, and that is what happens:
 * the handler takes the identifier from the event and asks Stripe for the
 * current subscription. A snapshot payload is a description of the past by the
 * time it arrives; the fetch is the present.
 */

import {
  eventObjectId,
  idOf,
  isHandledEventType,
  normalizeSubscription,
  type StripeCheckoutSession,
  type StripeEvent,
  type StripeInvoice,
  type StripeSubscription,
} from './billing-domain.ts'

export type WebhookOutcome =
  | 'applied'
  | 'ignored_unsupported'
  | 'ignored_duplicate'
  | 'ignored_stale'
  | 'ignored_unknown_customer'
  | 'failed'

export interface WebhookResult {
  readonly outcome: WebhookOutcome
  /** A category for the ledger. Never a Stripe message, never a payload. */
  readonly failureCategory?: string
  readonly organizationId?: string | null
}

/**
 * Everything the handler needs from the database and from Stripe.
 *
 * An interface rather than a client so a test can drive every branch — a
 * duplicate claim, an unknown customer, a stale event, a Stripe read that fails
 * — without a network or a database.
 */
export interface WebhookStore {
  /** Returns 'claimed' or 'duplicate'. Idempotency lives here. */
  claimEvent(event: {
    id: string
    type: string
    createdAt: string
    objectId: string | null
  }): Promise<'claimed' | 'duplicate'>

  /** Concludes an event: Stripe will not be asked for it again. */
  finishEvent(input: {
    id: string
    result: WebhookOutcome
    organizationId: string | null
  }): Promise<void>

  /**
   * Records a failure and LEAVES THE EVENT OPEN so Stripe's retry can try
   * again. Separate from finishEvent because stamping a failure as processed is
   * how a transient error becomes a subscription that never syncs.
   */
  failEvent(input: { id: string; failureCategory: string }): Promise<void>

  /** The canonical subscription, read from Stripe now. */
  fetchSubscription(subscriptionId: string): Promise<StripeSubscription>

  /** Applies a normalized subscription; returns the projection's own verdict. */
  applySubscription(input: {
    subscription: ReturnType<typeof normalizeSubscription>
    eventCreatedAt: string
    eventId: string
  }): Promise<'applied' | 'stale' | 'unknown_customer' | 'anomaly'>

  applyInvoice(input: {
    customerId: string
    subscriptionId: string | null
    invoiceId: string
    invoiceStatus: string | null
    amountMinor: number | null
    currency: string | null
    failed: boolean
    eventCreatedAt: string
    eventId: string
  }): Promise<'applied' | 'unknown_customer' | 'no_subscription' | 'stale'>

  /** The organization a Stripe customer maps to, for the ledger. */
  resolveOrganization(customerId: string): Promise<string | null>

  /** Marks a customer gone. Never deletes the mapping: the identifier must not
   *  be reused, and support needs to know what happened. */
  markCustomerDeleted(customerId: string): Promise<void>
}

/**
 * The subscription id an event points at, whichever kind of event it is.
 *
 * On the current API version an invoice carries its subscription under
 * `parent.subscription_details.subscription`; the older top-level `subscription`
 * field is read as well, because an account pinned to an older version still
 * sends it and reading both costs nothing.
 */
export function subscriptionIdFromEvent(event: StripeEvent): string | null {
  const object = event.data?.object

  if (event.type.startsWith('customer.subscription.')) {
    return (object as StripeSubscription | undefined)?.id ?? null
  }

  if (event.type.startsWith('checkout.session.')) {
    return idOf((object as StripeCheckoutSession | undefined)?.subscription ?? null)
  }

  if (event.type.startsWith('invoice.')) {
    const invoice = object as StripeInvoice | undefined
    return (
      idOf(invoice?.parent?.subscription_details?.subscription ?? null) ??
      idOf(invoice?.subscription ?? null)
    )
  }

  return null
}

export function customerIdFromEvent(event: StripeEvent): string | null {
  const object = event.data?.object as { customer?: unknown; id?: unknown } | undefined
  if (!object) return null

  if (event.type === 'customer.deleted') {
    return typeof object.id === 'string' ? object.id : null
  }
  return idOf(object.customer as string | { id?: string } | null | undefined)
}

/**
 * Handles one verified event.
 *
 * The order is deliberate: claim first, so a concurrent redelivery loses the
 * race and stops; then decide; then finish. A handler that decides before it
 * claims processes the same event twice under load, which is precisely the
 * situation Stripe's retry schedule creates.
 */
export async function processStripeEvent(
  event: StripeEvent,
  store: WebhookStore,
): Promise<WebhookResult> {
  const createdAt = new Date(event.created * 1000).toISOString()

  if (!isHandledEventType(event.type)) {
    /*
     * Recorded and acknowledged. Stripe keeps retrying anything that is not a
     * 2xx, so refusing to answer an event we simply do not act on would produce
     * three days of pointless deliveries.
     */
    await store.claimEvent({
      id: event.id,
      type: event.type,
      createdAt,
      objectId: eventObjectId(event),
    })
    await store.finishEvent({ id: event.id, result: 'ignored_unsupported', organizationId: null })
    return { outcome: 'ignored_unsupported' }
  }

  const claim = await store.claimEvent({
    id: event.id,
    type: event.type,
    createdAt,
    objectId: eventObjectId(event),
  })
  if (claim === 'duplicate') {
    return { outcome: 'ignored_duplicate' }
  }

  try {
    if (event.type === 'customer.deleted') {
      const customerId = customerIdFromEvent(event)
      if (customerId === null) {
        await store.failEvent({ id: event.id, failureCategory: 'missing_customer' })
        return { outcome: 'failed', failureCategory: 'missing_customer' }
      }
      const organizationId = await store.resolveOrganization(customerId)
      await store.markCustomerDeleted(customerId)
      await store.finishEvent({ id: event.id, result: 'applied', organizationId })
      return { outcome: 'applied' }
    }

    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const invoice = event.data?.object as StripeInvoice | undefined
      const customerId = customerIdFromEvent(event)
      if (!invoice || customerId === null) {
        await store.failEvent({ id: event.id, failureCategory: 'missing_customer' })
        return { outcome: 'failed', failureCategory: 'missing_customer' }
      }

      const result = await store.applyInvoice({
        customerId,
        subscriptionId: subscriptionIdFromEvent(event),
        invoiceId: invoice.id,
        invoiceStatus: invoice.status ?? null,
        amountMinor:
          typeof invoice.amount_due === 'number' ? invoice.amount_due : null,
        currency: typeof invoice.currency === 'string' ? invoice.currency.toUpperCase() : null,
        failed: event.type === 'invoice.payment_failed',
        eventCreatedAt: createdAt,
        eventId: event.id,
      })

      /*
       * `no_subscription` is NOT settled. Stripe does not order its events, so an
       * invoice can arrive before the subscription it belongs to — answering 2xx
       * would discard that invoice's outcome permanently. Left open so the retry
       * finds the subscription in place.
       */
      if (result === 'no_subscription') {
        await store.failEvent({ id: event.id, failureCategory: 'awaiting_subscription' })
        return { outcome: 'failed', failureCategory: 'awaiting_subscription' }
      }

      const outcome: WebhookOutcome =
        result === 'unknown_customer'
          ? 'ignored_unknown_customer'
          : result === 'stale'
            ? 'ignored_stale'
            : 'applied'
      await store.finishEvent({
        id: event.id,
        result: outcome,
        organizationId: await store.resolveOrganization(customerId),
      })
      return { outcome }
    }

    /*
     * Everything else is about a subscription, and every one of them is handled
     * the same way: find the subscription id, ask Stripe what that subscription
     * is NOW, and apply that. Not the payload — the payload describes the moment
     * the event was generated, which may be days before it arrives.
     */
    const subscriptionId = subscriptionIdFromEvent(event)
    if (subscriptionId === null) {
      /*
       * A checkout that completed without a subscription (an abandoned or
       * asynchronous payment), or an expired session. Nothing to project;
       * acknowledged so Stripe stops.
       */
      await store.finishEvent({ id: event.id, result: 'ignored_unsupported', organizationId: null })
      return { outcome: 'ignored_unsupported' }
    }

    const canonical = await store.fetchSubscription(subscriptionId)
    const normalized = normalizeSubscription(canonical)

    if (!normalized.ok) {
      await store.failEvent({ id: event.id, failureCategory: normalized.reason })
      return { outcome: 'failed', failureCategory: normalized.reason }
    }

    const applied = await store.applySubscription({
      subscription: normalized,
      eventCreatedAt: createdAt,
      eventId: event.id,
    })

    const outcome: WebhookOutcome =
      applied === 'applied'
        ? 'applied'
        : applied === 'stale'
          ? 'ignored_stale'
          : applied === 'unknown_customer'
            ? 'ignored_unknown_customer'
            : 'failed'

    if (applied === 'anomaly') {
      /*
       * A second live subscription for one agency, which is a Stripe-side
       * anomaly a retry cannot resolve. SETTLED, deliberately: three days of
       * retries would bury the evidence under repeated failures rather than
       * fixing anything. It is recorded in the billing history — once, by a
       * unique index — and support resolves it with a reconciliation.
       */
      await store.finishEvent({
        id: event.id,
        result: 'failed',
        organizationId: normalized.ok
          ? await store.resolveOrganization(normalized.value.stripeCustomerId)
          : null,
      })
      return { outcome: 'failed', failureCategory: 'duplicate_live_subscription' }
    }

    await store.finishEvent({
      id: event.id,
      result: outcome,
      organizationId: await store.resolveOrganization(normalized.value.stripeCustomerId),
    })
    return { outcome }
  } catch (error) {
    /*
     * A failure is recorded with a category and re-raised to the caller, which
     * answers 500 so Stripe retries. The claim row stays with processed_at null,
     * so the retry is allowed to try again rather than being deduplicated away.
     */
    const category = error instanceof Error ? error.name : 'unknown'
    await store.failEvent({ id: event.id, failureCategory: category })
    return { outcome: 'failed', failureCategory: category }
  }
}
