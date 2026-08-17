/**
 * The SaaS billing boundary.
 *
 * Four things need a server, and only four are here:
 *
 *   1. The Stripe secret key, which cannot be in a browser bundle.
 *   2. The application's own origin, which cannot be taken from a request —
 *      honouring a client-supplied Host or return target would turn a Checkout
 *      return into an open redirect.
 *   3. Turning a plan KEY into a Stripe PRICE. The browser never names a price;
 *      if it could, it could subscribe an agency to any price in our account.
 *   4. Reading Stripe on the caller's behalf, from a credential the caller does
 *      not hold.
 *
 * Everything else — who may see billing, who may act on it, what the projection
 * says, how ordering and idempotency work — is in the database, in
 * 20260823100000_billing_model.sql, and this function cannot weaken any of it.
 *
 * AUTHORIZATION. Every action establishes the caller from their own JWT, then
 * checks their role through a client carrying THEIR token, so row-level
 * security applies exactly as it does to a browser. Only after that is a
 * service-role client constructed, and it is never handed an identifier the
 * caller supplied and this function has not already checked.
 *
 * THIS DEPLOYMENT IS NOT CONFIGURED. Every action therefore answers
 * `billing_not_configured` before any Stripe request is attempted. That is a
 * deliberate, named state — not an outage, not an error, and not something the
 * rest of the product ever sees.
 *
 * NOTHING HERE LOGS A KEY, A SIGNATURE, A CHECKOUT URL, A CUSTOMER IDENTIFIER
 * OR A REQUEST BODY.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

import {
  checkoutIdempotencyKey,
  checkoutSessionParams,
  customerIdempotencyKey,
  normalizeSubscription,
  portalSessionParams,
  type StripeSubscription,
} from '../_shared/billing-domain.ts'
import { StripeApiError, StripeClient } from '../_shared/stripe-api.ts'
import {
  describeConfigProblem,
  resolveBillingConfig,
  type BillingConfig,
} from '../_shared/stripe-config.ts'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // Billing responses can carry a Checkout or Portal URL, which is a bearer
  // capability for one customer's billing. It must not travel in a Referer.
  'Referrer-Policy': 'no-referrer',
}

type Role = 'owner' | 'admin' | 'manager' | 'staff'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function failure(category: string, message: string, status = 400): Response {
  return json({ ok: false, error: { category, message } }, status)
}

function serviceClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** The caller's role in one agency, read under their own row-level security. */
async function roleIn(
  asUser: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<Role | null> {
  const { data } = await asUser
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  return (data?.role as Role | undefined) ?? null
}

/**
 * Tells the database what the server found when it looked for its credentials.
 *
 * The database cannot read an environment variable, and the browser must never
 * be the authority on whether billing is live — so this is the one path by which
 * `billing_platform_state` ever changes.
 */
async function reportPlatformState(
  service: SupabaseClient,
  configured: boolean,
  mode: 'test' | 'live' | null,
  reason: string,
): Promise<void> {
  await service.rpc('billing_report_platform_state', {
    p_configured: configured,
    p_mode: mode,
    p_reason: reason,
  })
}

/**
 * Refreshes the sellable catalogue from Stripe.
 *
 * The configured entries name a price or a lookup key; the money is read from
 * Stripe and never from configuration, so nobody can publish a plan that says
 * one amount here and charges another there. A price that is archived at
 * Stripe, or that belongs to the other mode, is dropped rather than sold.
 */
async function refreshCatalogue(
  service: SupabaseClient,
  stripe: StripeClient,
  config: BillingConfig,
): Promise<number> {
  const plans: Record<string, unknown>[] = []

  for (const [index, entry] of config.catalogue.entries()) {
    let price: {
      id: string
      active?: boolean
      currency?: string
      unit_amount?: number | null
      livemode?: boolean
      lookup_key?: string | null
      product?: string | { id?: string }
      nickname?: string | null
      recurring?: { interval?: string; interval_count?: number } | null
    }

    if (entry.priceId !== undefined) {
      price = await stripe.request('GET', `/prices/${entry.priceId}`)
    } else {
      const found = await stripe.request<{ data?: (typeof price)[] }>('GET', '/prices', {
        lookup_keys: [entry.lookupKey!],
        active: true,
        limit: 1,
      })
      const first = found.data?.[0]
      if (!first) continue
      price = first
    }

    if (price.active === false) continue
    if (!price.recurring?.interval) continue
    if ((price.livemode === true ? 'live' : 'test') !== config.mode) continue
    if (typeof price.unit_amount !== 'number' || typeof price.currency !== 'string') continue

    /*
     * A Stripe nickname is free text of any length, and the display_name column
     * accepts 1..80 characters. An empty or over-long nickname would fail the
     * whole catalogue refresh — and therefore the Billing page — for every plan,
     * so it falls back to the plan key rather than taking the deployment down.
     */
    const nickname = (price.nickname ?? '').trim()
    const displayName =
      nickname.length >= 1 && nickname.length <= 80 ? nickname : entry.planKey

    plans.push({
      plan_key: entry.planKey,
      display_name: displayName,
      stripe_price_id: price.id,
      stripe_product_id: typeof price.product === 'string' ? price.product : (price.product?.id ?? null),
      lookup_key: price.lookup_key ?? null,
      currency: price.currency.toUpperCase(),
      amount_minor: price.unit_amount,
      interval: price.recurring.interval,
      interval_count: price.recurring.interval_count ?? 1,
      mode: config.mode,
      sort_order: index,
    })
  }

  const { data } = await service.rpc('billing_replace_catalogue', { p_plans: plans })
  return typeof data === 'number' ? data : plans.length
}

/**
 * The organization's Stripe customer, created at most once.
 *
 * Three independent guards, because two owner tabs pressing Subscribe at the
 * same instant is the ordinary case: the database claim is serialised by an
 * advisory lock and a primary key, and the Stripe request carries an idempotency
 * key derived from the organization so even a retried HTTP call returns the same
 * customer rather than making another.
 */
async function ensureCustomer(
  service: SupabaseClient,
  stripe: StripeClient,
  organizationId: string,
): Promise<string> {
  const { data: existing } = await service
    .from('billing_customers')
    .select('stripe_customer_id, deleted_at')
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (existing?.stripe_customer_id && existing.deleted_at === null) {
    return existing.stripe_customer_id as string
  }

  /*
   * A mapping exists but Stripe has deleted that customer.
   *
   * Creating another and handing it to Checkout would leave the agency mapped to
   * the dead one — app.billing_claim_customer keeps the first mapping, by design
   * — so every later webhook would resolve to a customer nobody can charge. Until
   * somebody deliberately re-links the agency, this is reported rather than
   * papered over.
   */
  if (existing?.stripe_customer_id && existing.deleted_at !== null) {
    throw new StripeApiError(
      'invalid_request',
      'This agency’s billing account was closed at our payment provider. Contact support.',
      409,
    )
  }

  const { data: organization } = await service
    .from('organizations')
    .select('name, email')
    .eq('id', organizationId)
    .maybeSingle()

  const created = await stripe.request<{ id: string }>(
    'POST',
    '/customers',
    {
      name: organization?.name ?? undefined,
      email: organization?.email ?? undefined,
      metadata: { organization_id: organizationId },
    },
    { idempotencyKey: customerIdempotencyKey(organizationId) },
  )

  const { data: claimed } = await service.rpc('billing_claim_customer', {
    p_organization_id: organizationId,
    p_stripe_customer_id: created.id,
    p_mode: stripe.mode,
    p_billing_email: organization?.email ?? null,
  })

  // The claim returns whichever customer is now mapped. If another request won
  // the race, that one is authoritative and this one's is abandoned — which is
  // why the idempotency key matters: Stripe returns the same object, so there is
  // nothing orphaned to abandon.
  const row = Array.isArray(claimed) ? claimed[0] : claimed
  return (row?.stripe_customer_id as string | undefined) ?? created.id
}

// -----------------------------------------------------------------------------

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (request.method !== 'POST') return failure('method_not_allowed', 'Use POST.', 405)

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return failure('malformed_request', 'That request could not be read.')
  }

  const action = typeof body.action === 'string' ? body.action : ''
  const organizationId = typeof body.organizationId === 'string' ? body.organizationId : ''
  if (organizationId === '') return failure('malformed_request', 'No agency was named.')

  const authorization = request.headers.get('Authorization') ?? ''
  if (authorization === '') return failure('auth_error', 'Sign in to manage billing.', 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (supabaseUrl === '' || anonKey === '' || serviceKey === '') {
    return failure('not_configured', 'Billing is unavailable right now.', 500)
  }

  const asUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: auth, error: authError } = await asUser.auth.getUser()
  if (authError || !auth?.user) return failure('auth_error', 'Sign in to manage billing.', 401)

  /*
   * The role check, against the caller's own membership, before anything
   * privileged exists. An organization id in a request body is a claim; this is
   * what turns it into a fact.
   */
  const role = await roleIn(asUser, organizationId, auth.user.id)
  if (role === null) {
    // The same answer a nonexistent agency gets. Confirming that another
    // tenant's agency exists is itself a leak.
    return failure('not_found', 'That agency could not be found.', 404)
  }
  if (role !== 'owner') {
    return failure('permission_denied', 'Only an owner can manage billing.', 403)
  }

  const service = serviceClient(supabaseUrl, serviceKey)
  const configured = resolveBillingConfig(Deno.env.toObject())

  if (!configured.ok) {
    /*
     * The expected state of this deployment. Recorded so the Billing page can
     * say so truthfully, answered with a named outcome, and never dressed up as
     * a temporary failure.
     */
    await reportPlatformState(service, false, null, describeConfigProblem(configured.problem))
    return json({
      ok: true,
      state: 'billing_not_configured',
      message: describeConfigProblem(configured.problem),
    })
  }

  const config = configured.config
  const stripe = new StripeClient({ secretKey: config.secretKey, mode: config.mode })

  try {
    switch (action) {
      /*
       * What the Billing page asks on load: is billing configured, and what is
       * sellable? Stripe is read here and nowhere else in the ordinary flow, so
       * routine navigation never touches it.
       */
      case 'status': {
        const plans = await refreshCatalogue(service, stripe, config)
        await reportPlatformState(
          service,
          true,
          config.mode,
          plans > 0
            ? 'Stripe is configured.'
            : 'Stripe is configured, but no sellable plan was found.',
        )
        return json({ ok: true, state: 'configured', mode: config.mode, plans })
      }

      case 'checkout': {
        const planKey = typeof body.planKey === 'string' ? body.planKey : ''
        if (planKey === '') return failure('malformed_request', 'No plan was chosen.')

        /*
         * The plan key becomes a price HERE, from the catalogue, and a price
         * arriving in the request body is not read at all. That is the whole
         * defence against price tampering.
         */
        const { data: resolved } = await service.rpc('billing_resolve_plan', {
          p_plan_key: planKey,
          p_mode: config.mode,
        })
        const plan = Array.isArray(resolved) ? resolved[0] : resolved
        if (!plan?.stripe_price_id) {
          return failure('plan_unavailable', 'That plan is not available.', 404)
        }

        // An agency that already has a live subscription does not get a second.
        const { data: live } = await service
          .from('billing_subscriptions')
          .select('stripe_subscription_id')
          .eq('organization_id', organizationId)
          .in('status', ['trialing', 'active', 'past_due', 'unpaid', 'paused'])
          .maybeSingle()
        if (live) {
          return failure('already_subscribed', 'This agency already has a subscription.', 409)
        }

        // A Checkout session this agency already has open is reused rather than
        // replaced: every extra session is another chance for two to complete.
        const { data: openSession } = await service.rpc('billing_open_checkout', {
          p_organization_id: organizationId,
          p_plan_key: planKey,
        })
        if (typeof openSession === 'string' && openSession !== '') {
          const existing = await stripe.request<{ url?: string; status?: string }>(
            'GET',
            `/checkout/sessions/${openSession}`,
          )
          if (existing.status === 'open' && typeof existing.url === 'string') {
            return json({ ok: true, url: existing.url, reused: true })
          }
        }

        const customerId = await ensureCustomer(service, stripe, organizationId)
        const params = checkoutSessionParams(
          { organizationId, customerId, priceId: plan.stripe_price_id, planKey },
          config.appUrl,
        )
        if (params === null) {
          return failure('not_configured', 'Billing is not configured correctly.', 500)
        }

        const attempt = typeof body.attempt === 'string' ? body.attempt.slice(0, 64) : 'default'
        const session = await stripe.request<{ id: string; url?: string; expires_at?: number }>(
          'POST',
          '/checkout/sessions',
          params as Record<string, never>,
          { idempotencyKey: checkoutIdempotencyKey(organizationId, planKey, attempt) },
        )

        await service.rpc('billing_record_checkout', {
          p_organization_id: organizationId,
          p_stripe_session_id: session.id,
          p_plan_key: planKey,
          p_stripe_price_id: plan.stripe_price_id,
          p_mode: config.mode,
          p_expires_at: new Date((session.expires_at ?? 0) * 1000).toISOString(),
          p_created_by: auth.user.id,
        })

        if (typeof session.url !== 'string') {
          return failure('checkout_unavailable', 'Checkout could not be opened.', 502)
        }
        return json({ ok: true, url: session.url, reused: false })
      }

      case 'portal': {
        /*
         * The customer is resolved from OUR mapping, never from the request. A
         * caller-supplied Stripe customer id would be a portal session for
         * somebody else's billing.
         */
        const { data: mapping } = await service
          .from('billing_customers')
          .select('stripe_customer_id, deleted_at')
          .eq('organization_id', organizationId)
          .maybeSingle()

        if (!mapping?.stripe_customer_id || mapping.deleted_at !== null) {
          return failure('no_billing_account', 'This agency has no billing account yet.', 404)
        }

        const params = portalSessionParams(mapping.stripe_customer_id as string, config.appUrl)
        if (params === null) {
          return failure('not_configured', 'Billing is not configured correctly.', 500)
        }

        const session = await stripe.request<{ url?: string }>(
          'POST',
          '/billing_portal/sessions',
          params as Record<string, never>,
        )
        if (typeof session.url !== 'string') {
          return failure('portal_unavailable', 'The billing portal could not be opened.', 502)
        }
        return json({ ok: true, url: session.url })
      }

      /*
       * Reconciliation. For a delayed webhook, a delivery that never arrived, or
       * a support investigation — it reads Stripe and applies what it finds.
       * Never called on a route render: the projection serves ordinary access
       * decisions, and Stripe is asked only when somebody asks.
       */
      case 'reconcile': {
        const { data: mapping } = await service
          .from('billing_customers')
          .select('stripe_customer_id')
          .eq('organization_id', organizationId)
          .maybeSingle()

        if (!mapping?.stripe_customer_id) {
          return json({ ok: true, state: 'no_billing_account', applied: 0 })
        }

        /*
         * Stamped BEFORE the read, not after.
         *
         * The projection refuses anything older than what produced its current
         * contents. A clock taken after the read would be newer than any webhook
         * generated DURING the read — so those events would arrive, be judged
         * stale, and be dropped for good. Taken before, the read is exactly as
         * fresh as the moment it describes, and a genuinely newer webhook still
         * wins.
         */
        const readAt = new Date().toISOString()

        const list = await stripe.request<{ data?: StripeSubscription[] }>('GET', '/subscriptions', {
          customer: mapping.stripe_customer_id,
          status: 'all',
          limit: 10,
          expand: ['data.items.data.price'],
        })

        let applied = 0
        for (const subscription of list.data ?? []) {
          const normalized = normalizeSubscription(subscription)
          if (!normalized.ok) continue

          const value = normalized.value
          const { data: outcome } = await service.rpc('billing_apply_subscription', {
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
            p_event_at: readAt,
            p_event_id: null,
          })
          if (outcome === 'applied') applied += 1
        }

        await service.rpc('billing_note_event', {
          p_organization_id: organizationId,
          p_kind: 'reconciled',
          p_summary: 'Billing was refreshed from our payment provider.',
          p_actor_user_id: auth.user.id,
          p_stripe_object_id: null,
        })

        return json({ ok: true, state: 'reconciled', applied })
      }

      default:
        return failure('malformed_request', 'That billing action is not supported.')
    }
  } catch (error) {
    /*
     * A category and a sentence written here. Never Stripe's message: a provider
     * error body commonly echoes the request, and the request carried the
     * credential.
     */
    if (error instanceof StripeApiError) {
      console.error(`billing: ${action} failed (${error.category})`)
      const status = error.category === 'rate_limited' ? 429 : 502
      return failure(error.category, error.message, status)
    }
    console.error(`billing: ${action} failed (unexpected)`)
    return failure('billing_unavailable', 'Billing is unavailable right now.', 500)
  }
})
