/**
 * Turning what Stripe says into what this application stores, and building the
 * requests that go the other way.
 *
 * Everything here is a pure function over plain data. That is the point: these
 * are the decisions that would otherwise sit unreachable inside an Edge Function
 * entry point — which price a plan key resolves to, where the billing period
 * lives on the current API version, whether an arriving event is older than what
 * we already hold, what a success URL is allowed to be.
 */

import { buildReturnUrl, type StripeMode } from './stripe-config.ts'

// -----------------------------------------------------------------------------
// Stripe object shapes, as far as this integration reads them
// -----------------------------------------------------------------------------

export interface StripePrice {
  readonly id: string
  readonly object?: string
  readonly active?: boolean
  readonly currency?: string
  readonly unit_amount?: number | null
  readonly lookup_key?: string | null
  readonly livemode?: boolean
  readonly product?: string | { id?: string }
  readonly recurring?: {
    readonly interval?: string
    readonly interval_count?: number
  } | null
  readonly nickname?: string | null
}

export interface StripeSubscriptionItem {
  readonly id?: string
  readonly quantity?: number | null
  readonly price?: StripePrice | null
  /** Since 2025-03-31.basil the billing period lives here, not on the parent. */
  readonly current_period_start?: number | null
  readonly current_period_end?: number | null
}

export interface StripeSubscription {
  readonly id: string
  readonly object?: string
  readonly customer?: string | { id?: string }
  readonly status?: string
  readonly livemode?: boolean
  readonly cancel_at_period_end?: boolean
  readonly cancel_at?: number | null
  readonly canceled_at?: number | null
  readonly ended_at?: number | null
  readonly trial_start?: number | null
  readonly trial_end?: number | null
  readonly items?: { readonly data?: readonly StripeSubscriptionItem[] } | null
  readonly latest_invoice?: string | { id?: string } | null
}

export interface StripeInvoice {
  readonly id: string
  readonly customer?: string | { id?: string }
  readonly status?: string
  readonly amount_due?: number | null
  readonly amount_paid?: number | null
  readonly currency?: string | null
  readonly subscription?: string | { id?: string } | null
  readonly parent?: {
    readonly subscription_details?: { readonly subscription?: string | { id?: string } } | null
  } | null
}

export interface StripeCheckoutSession {
  readonly id: string
  readonly customer?: string | { id?: string } | null
  readonly subscription?: string | { id?: string } | null
  readonly status?: string
  readonly expires_at?: number | null
  readonly client_reference_id?: string | null
  readonly metadata?: Record<string, string> | null
}

export interface StripeEvent {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly livemode?: boolean
  readonly data?: { readonly object?: unknown } | null
}

/** Stripe returns some references as an id and some as an expanded object. */
export function idOf(value: string | { id?: string } | null | undefined): string | null {
  if (typeof value === 'string') return value === '' ? null : value
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id
  return null
}

function secondsToIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return new Date(value * 1000).toISOString()
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

/**
 * Stripe's status, or nothing.
 *
 * A status Stripe has not documented is not mapped to a guess. It is reported as
 * unrecognised, the event is left unapplied, and an owner sees a state that says
 * so — which is the honest outcome, and one that shows up in the ledger instead
 * of silently granting or revoking access.
 */
export function parseSubscriptionStatus(value: unknown): SubscriptionStatus | null {
  return typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
    ? (value as SubscriptionStatus)
    : null
}

/** The four states this product actually acts on. Mirrors public.billing_access_state. */
export type BillingAccessState = 'platform_unconfigured' | 'normal' | 'attention' | 'restricted'

/**
 * The same mapping app.billing_access_state_of performs, for the server's own
 * use. Kept in step with it by a test that asserts both agree for all eight
 * statuses — two implementations of one rule is exactly how the rule drifts.
 */
export function accessStateForStatus(status: SubscriptionStatus): BillingAccessState {
  return status === 'active' || status === 'trialing' ? 'normal' : 'attention'
}

/** Whether Stripe still considers this subscription live. */
export function isLiveStatus(status: SubscriptionStatus): boolean {
  return (
    status === 'trialing' ||
    status === 'active' ||
    status === 'past_due' ||
    status === 'unpaid' ||
    status === 'paused'
  )
}

// -----------------------------------------------------------------------------
// The projection
// -----------------------------------------------------------------------------

export interface NormalizedSubscription {
  readonly stripeSubscriptionId: string
  readonly stripeCustomerId: string
  readonly mode: StripeMode
  readonly status: SubscriptionStatus
  readonly stripePriceId: string | null
  readonly currency: string | null
  readonly amountMinor: number | null
  readonly interval: 'day' | 'week' | 'month' | 'year' | null
  readonly intervalCount: number | null
  readonly quantity: number | null
  readonly currentPeriodStart: string | null
  readonly currentPeriodEnd: string | null
  readonly cancelAtPeriodEnd: boolean
  readonly cancelAt: string | null
  readonly canceledAt: string | null
  readonly endedAt: string | null
  readonly trialStart: string | null
  readonly trialEnd: string | null
}

export type NormalizeFailure =
  | 'missing_customer'
  | 'unrecognised_status'
  | 'missing_items'

/**
 * The subscription, flattened into the columns the projection holds.
 *
 * THE PERIOD. On this API version there is no `subscription.current_period_end`;
 * each item carries its own. This takes the EARLIEST end across items, which for
 * the single-item subscriptions this product sells is simply "the period", and
 * for a mixed-interval subscription is the same instant Stripe's own
 * `cancel_at: min_period_end` helper resolves to. Reading a field that no longer
 * exists would silently store nulls and quietly stop showing a renewal date.
 *
 * THE PRICE. Taken from the first item, because one recurring item is what a
 * plan means here. A subscription that somehow carries several is stored with
 * the first item's price and its own quantity; the catalogue lookup then finds
 * no plan, which surfaces as a plan-less subscription an owner can see rather
 * than as an invented plan they cannot.
 */
export function normalizeSubscription(
  subscription: StripeSubscription,
): { ok: true; value: NormalizedSubscription } | { ok: false; reason: NormalizeFailure } {
  const customer = idOf(subscription.customer)
  if (customer === null) return { ok: false, reason: 'missing_customer' }

  const status = parseSubscriptionStatus(subscription.status)
  if (status === null) return { ok: false, reason: 'unrecognised_status' }

  const items = subscription.items?.data ?? []
  if (items.length === 0) return { ok: false, reason: 'missing_items' }

  const ends = items
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number' && value > 0)
  const starts = items
    .map((item) => item.current_period_start)
    .filter((value): value is number => typeof value === 'number' && value > 0)

  const first = items[0]!
  const price = first.price ?? null
  const interval = price?.recurring?.interval
  const intervalValue =
    interval === 'day' || interval === 'week' || interval === 'month' || interval === 'year'
      ? interval
      : null

  return {
    ok: true,
    value: {
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customer,
      // `livemode` is Stripe's own answer and the only reliable one; an
      // identifier without `_test_` in it is not proof of anything.
      mode: subscription.livemode === false ? 'test' : 'live',
      status,
      stripePriceId: price?.id ?? null,
      currency: typeof price?.currency === 'string' ? price.currency.toUpperCase() : null,
      amountMinor: typeof price?.unit_amount === 'number' ? price.unit_amount : null,
      interval: intervalValue,
      intervalCount: typeof price?.recurring?.interval_count === 'number'
        ? price.recurring.interval_count
        : null,
      quantity: typeof first.quantity === 'number' ? first.quantity : null,
      currentPeriodStart: starts.length > 0 ? secondsToIso(Math.min(...starts)) : null,
      currentPeriodEnd: ends.length > 0 ? secondsToIso(Math.min(...ends)) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      cancelAt: secondsToIso(subscription.cancel_at),
      canceledAt: secondsToIso(subscription.canceled_at),
      endedAt: secondsToIso(subscription.ended_at),
      trialStart: secondsToIso(subscription.trial_start),
      trialEnd: secondsToIso(subscription.trial_end),
    },
  }
}

/**
 * Whether a subscription is set to end.
 *
 * Two facts, either of which means it. The Customer Portal on flexible billing
 * sets `cancel_at` and leaves `cancel_at_period_end` false, so reading only the
 * deprecated boolean tells an owner their subscription is continuing when it is
 * not.
 */
export function cancellationScheduled(subscription: NormalizedSubscription): boolean {
  return subscription.cancelAtPeriodEnd || subscription.cancelAt !== null
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

/**
 * The events this integration acts on, and no others.
 *
 * Stripe sends dozens. Handling only what changes a stored fact keeps the ledger
 * honest about what was ignored, and means a new Stripe event type cannot alter
 * this application's behaviour until somebody decides that it should.
 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.deleted',
] as const

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number]

export function isHandledEventType(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type)
}

/**
 * The Stripe object id an event is about, for the ledger's duplicate guard.
 *
 * Stripe documents that two distinct Event objects can describe one change, so
 * the event id alone does not deduplicate them; `(object id, type, created)`
 * does, and this is the first part of that key.
 */
export function eventObjectId(event: StripeEvent): string | null {
  const object = event.data?.object
  if (object && typeof object === 'object' && typeof (object as { id?: unknown }).id === 'string') {
    return (object as { id: string }).id
  }
  return null
}

/**
 * Whether an arriving event describes something older than what we hold.
 *
 * Stripe states plainly that it does not guarantee ordering, and retries for
 * three days — so a cancellation generated on Tuesday can arrive after
 * Wednesday's reactivation. The comparison is between the events' own creation
 * times. Arrival time is never used: it describes our network, not Stripe's
 * sequence of facts.
 *
 * Equal timestamps are applied rather than skipped: two events created in the
 * same second are more likely to be the same change than a regression, and the
 * projection write is idempotent.
 */
export function isStaleEvent(eventCreatedAt: number, appliedAt: string | null): boolean {
  if (appliedAt === null) return false
  const applied = Date.parse(appliedAt)
  if (Number.isNaN(applied)) return false
  return eventCreatedAt * 1000 < applied
}

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

export interface CheckoutRequest {
  readonly organizationId: string
  readonly customerId: string
  readonly priceId: string
  readonly planKey: string
}

/**
 * The parameters for a subscription Checkout Session.
 *
 * The price comes from the resolved catalogue entry and never from a request
 * body — that is the whole of the defence against price tampering, and it is why
 * this function takes a `CheckoutRequest` whose priceId the caller obtained by
 * looking up a plan key server-side.
 *
 * `client_reference_id` carries the organization so a completed session can be
 * cross-checked, but it is a CROSS-CHECK and not the mapping: the tenant is
 * resolved from our own customer table, because metadata is a free-form field
 * and an authorization decision must not rest on one.
 */
export function checkoutSessionParams(
  request: CheckoutRequest,
  appUrl: string,
): Record<string, unknown> | null {
  const successUrl = buildReturnUrl(appUrl, '/billing/return?session={CHECKOUT_SESSION_ID}')
  const cancelUrl = buildReturnUrl(appUrl, '/billing')
  if (successUrl === null || cancelUrl === null) return null

  return {
    mode: 'subscription',
    customer: request.customerId,
    // Stripe requires this to update a customer's address from Checkout; without
    // it a customer created without an address cannot gain one here.
    customer_update: { address: 'auto', name: 'auto' },
    line_items: [{ price: request.priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: request.organizationId,
    subscription_data: {
      metadata: { organization_id: request.organizationId, plan_key: request.planKey },
    },
    metadata: { organization_id: request.organizationId, plan_key: request.planKey },
  }
}

export function portalSessionParams(
  customerId: string,
  appUrl: string,
): Record<string, unknown> | null {
  const returnUrl = buildReturnUrl(appUrl, '/billing')
  if (returnUrl === null) return null

  return { customer: customerId, return_url: returnUrl }
}

/**
 * The idempotency key for creating an organization's Stripe customer.
 *
 * Tied to the organization and to nothing else, so two tabs, two retries and two
 * cold starts all describe the same logical operation and Stripe returns the
 * same customer. Deliberately NOT random — a random key per attempt is a key
 * that guarantees duplicates — and deliberately not time-based, which would
 * expire the protection exactly when a slow retry needed it.
 */
export function customerIdempotencyKey(organizationId: string): string {
  return `atlas-customer-${organizationId}`
}

/**
 * The idempotency key for a Checkout session.
 *
 * Scoped to the organization, the plan AND a caller-supplied attempt token, so a
 * double-clicked button collapses into one session while a legitimate second
 * purchase later — after a cancellation, say — is not blocked by a key that
 * never expires.
 */
export function checkoutIdempotencyKey(
  organizationId: string,
  planKey: string,
  attempt: string,
): string {
  return `atlas-checkout-${organizationId}-${planKey}-${attempt}`
}
