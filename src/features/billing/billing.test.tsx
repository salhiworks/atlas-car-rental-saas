import { describe, expect, it } from 'vitest'

import type { BillingOverviewRow, BillingPlanRow } from '@/types/database'

import {
  canChoosePlan,
  canOpenPortal,
  describeStatus,
  intervalPhrase,
  presentationOf,
} from './domain'
import {
  exampleAmount,
  exampleIntervalPhrase,
  formatExampleAmount,
  MONETIZATION_EXAMPLES,
} from './monetizationExamples'

/**
 * What the Billing page is allowed to say.
 *
 * Every assertion here is about a sentence somebody would act on. "Your
 * subscription is active" when a webhook has not arrived; "your card was
 * declined" when all we know is that an invoice attempt failed; "cancelled" when
 * the subscription runs for another three weeks; a Manage billing button when
 * there is no customer to manage. Each of those is a small lie with a real
 * consequence, and each has a test.
 */

const overview = (over: Partial<BillingOverviewRow> = {}): BillingOverviewRow => ({
  access_state: 'platform_unconfigured',
  platform_configured: false,
  stripe_configured: false,
  catalog_configured: false,
  mode: null,
  has_customer: false,
  billing_email: null,
  subscription_id: null,
  status: null,
  plan_key: null,
  plan_name: null,
  currency: null,
  amount_minor: null,
  billing_interval: null,
  interval_count: null,
  current_period_start: null,
  current_period_end: null,
  cancel_scheduled: false,
  cancel_effective_at: null,
  canceled_at: null,
  ended_at: null,
  trial_end: null,
  payment_failed_at: null,
  latest_invoice_status: null,
  synced_at: null,
  pending_checkout: false,
  pending_checkout_at: null,
  active_members: 3,
  active_vehicles: 7,
  ...over,
})

const configured = {
  platform_configured: true,
  stripe_configured: true,
  catalog_configured: true,
  mode: 'test' as const,
}

// -----------------------------------------------------------------------------
describe('an unconfigured deployment', () => {
  it('is its own state, not a missing subscription', () => {
    expect(presentationOf(overview())).toBe('platform_unconfigured')
  })

  it('says billing is not set up, and never that something is wrong', () => {
    const copy = describeStatus(overview())
    expect(copy.label).toBe('Not configured')
    expect(copy.tone).toBe('neutral')
    expect(copy.detail).not.toMatch(/problem|failed|overdue|expired|action required/i)
  })

  it('offers no plan and no portal, because neither would work', () => {
    expect(canChoosePlan(overview())).toBe(false)
    expect(canOpenPortal(overview())).toBe(false)
  })

  it('distinguishes no Stripe from no catalogue', () => {
    expect(presentationOf(overview({ ...configured, catalog_configured: false }))).toBe(
      'catalogue_unconfigured',
    )
  })
})

// -----------------------------------------------------------------------------
describe('a Checkout that has not been confirmed', () => {
  it('is confirming, and is never active', () => {
    const row = overview({ ...configured, pending_checkout: true })

    expect(presentationOf(row)).toBe('synchronizing')
    const copy = describeStatus(row)
    expect(copy.label).toBe('Confirming')
    // The redirect proves nothing. This is the sentence that keeps that true.
    expect(copy.detail).not.toMatch(/active|thank you|success/i)
  })

  it('is not confused with an agency that simply has no plan', () => {
    expect(presentationOf(overview(configured))).toBe('no_subscription')
    expect(describeStatus(overview(configured)).label).toBe('No subscription')
  })
})

// -----------------------------------------------------------------------------
describe('what each Stripe status is called on screen', () => {
  it('says a payment failed and will be retried, not that a card was declined', () => {
    const copy = describeStatus(overview({ ...configured, status: 'past_due' }))

    expect(copy.label).toBe('Payment failed')
    expect(copy.detail).toMatch(/try again/i)
    // We know an attempt failed. We do not know the card is dead.
    expect(copy.detail).not.toMatch(/declined|card was|invalid card|expired card/i)
  })

  it('distinguishes "we stopped retrying" from "we are retrying"', () => {
    const pastDue = describeStatus(overview({ ...configured, status: 'past_due' }))
    const unpaid = describeStatus(overview({ ...configured, status: 'unpaid' }))

    expect(pastDue.detail).toMatch(/try again/i)
    expect(unpaid.detail).toMatch(/no further payment attempts/i)
    expect(pastDue.detail).not.toBe(unpaid.detail)
  })

  it('distinguishes a scheduled cancellation from a cancelled subscription', () => {
    const scheduled = describeStatus(
      overview({ ...configured, status: 'active', cancel_scheduled: true }),
    )
    const ended = describeStatus(overview({ ...configured, status: 'canceled' }))

    expect(scheduled.label).toBe('Cancels at period end')
    expect(scheduled.detail).toMatch(/stays active/i)
    expect(ended.label).toBe('Cancelled')
    expect(scheduled.label).not.toBe(ended.label)
  })

  it('separates a subscription that never started from one that ended', () => {
    expect(describeStatus(overview({ ...configured, status: 'incomplete_expired' })).label).toBe(
      'Not started',
    )
    expect(describeStatus(overview({ ...configured, status: 'canceled' })).label).toBe('Cancelled')
  })

  it('names all eight of Stripe’s statuses, with no two alike', () => {
    const labels = (
      [
        'active',
        'trialing',
        'past_due',
        'unpaid',
        'incomplete',
        'incomplete_expired',
        'paused',
        'canceled',
      ] as const
    ).map((status) => describeStatus(overview({ ...configured, status })).label)

    expect(new Set(labels).size).toBe(labels.length)
  })

  it('never shouts, and never invents urgency', () => {
    for (const status of ['past_due', 'unpaid', 'canceled', 'incomplete'] as const) {
      const copy = describeStatus(overview({ ...configured, status }))
      expect(copy.label).not.toMatch(/!|URGENT|IMMEDIATELY|ACT NOW/)
      expect(copy.detail).not.toMatch(/immediately|suspended|lose access|deleted/i)
    }
  })
})

// -----------------------------------------------------------------------------
describe('which actions are offered', () => {
  it('offers Manage billing only when there is a customer to manage', () => {
    expect(canOpenPortal(overview({ ...configured, has_customer: false }))).toBe(false)
    expect(canOpenPortal(overview({ ...configured, has_customer: true }))).toBe(true)
    // Not even with a customer, if the server cannot reach Stripe.
    expect(canOpenPortal(overview({ has_customer: true }))).toBe(false)
  })

  it('offers plan selection to an agency with no subscription, and not to a subscribed one', () => {
    expect(canChoosePlan(overview(configured))).toBe(true)
    expect(canChoosePlan(overview({ ...configured, status: 'active' }))).toBe(false)
    expect(canChoosePlan(overview({ ...configured, status: 'past_due' }))).toBe(false)
    // An ended subscription may be replaced.
    expect(canChoosePlan(overview({ ...configured, status: 'canceled' }))).toBe(true)
  })

  it('offers nothing at all while the platform is unconfigured', () => {
    expect(canChoosePlan(overview())).toBe(false)
    expect(canOpenPortal(overview())).toBe(false)
  })
})

// -----------------------------------------------------------------------------
describe('prices read correctly', () => {
  it('says the interval the way a person would', () => {
    expect(intervalPhrase('month', 1)).toBe('per month')
    expect(intervalPhrase('year', 1)).toBe('per year')
    expect(intervalPhrase('month', 3)).toBe('every 3 months')
  })
})

// -----------------------------------------------------------------------------
describe('the card is named for what it holds', () => {
  it('is a current plan only when there is one', () => {
    /*
     * A browser check found this: the status card was titled "Current plan" for
     * an agency that had never subscribed, directly above the words "No
     * subscription". Small, and exactly the kind of sentence this module is
     * supposed to refuse to write.
     */
    expect(describeStatus(overview({ ...configured })).label).toBe('No subscription')
    expect(presentationOf(overview({ ...configured }))).toBe('no_subscription')
    expect(presentationOf(overview({ ...configured, status: 'active' }))).toBe('active')
  })
})

// -----------------------------------------------------------------------------
describe('the monetization examples', () => {
  it('shows the exact suggested monthly prices', () => {
    const monthly = MONETIZATION_EXAMPLES.map((plan) => [
      plan.name,
      formatExampleAmount(plan, 'monthly', 'en-US'),
    ])

    expect(monthly).toEqual([
      ['Starter', '$49'],
      ['Growth', '$99'],
      ['Scale', '$199'],
    ])
  })

  it('shows the exact suggested yearly prices', () => {
    const yearly = MONETIZATION_EXAMPLES.map((plan) => [
      plan.name,
      formatExampleAmount(plan, 'yearly', 'en-US'),
    ])

    expect(yearly).toEqual([
      ['Starter', '$490'],
      ['Growth', '$990'],
      ['Scale', '$1,990'],
    ])
  })

  it('changes only the amount and the phrase when the interval changes', () => {
    const growth = MONETIZATION_EXAMPLES.find((plan) => plan.id === 'growth')!

    expect(exampleAmount(growth, 'monthly')).toBe(99)
    expect(exampleAmount(growth, 'yearly')).toBe(990)
    expect(exampleIntervalPhrase('monthly')).toBe('per month')
    expect(exampleIntervalPhrase('yearly')).toBe('per year')
    // The tier itself is the same tier; nothing about it is per-interval.
    expect(growth.includes).toHaveLength(5)
  })

  it('marks one tier as suggested, and never as most popular', () => {
    const suggested = MONETIZATION_EXAMPLES.filter((plan) => plan.isSuggested)
    expect(suggested.map((plan) => plan.id)).toEqual(['growth'])

    // Nothing has been sold, so there is no popularity to report.
    const serialised = JSON.stringify(MONETIZATION_EXAMPLES)
    expect(serialised).not.toMatch(/most popular|best value|save \d|% off|limited time/i)
  })

  it('promises no feature this product does not have', () => {
    const everything = MONETIZATION_EXAMPLES.flatMap((plan) => plan.includes).join(' ')
    for (const unsupported of [
      'priority support',
      'SLA',
      'white-label',
      'dedicated account manager',
      '24/7',
      'phone support',
    ]) {
      expect(everything.toLowerCase()).not.toContain(unsupported.toLowerCase())
    }
  })

  it('makes no financial promise to whoever sells this', () => {
    const everything = JSON.stringify(MONETIZATION_EXAMPLES)
    for (const oversell of [
      'guaranteed',
      'passive income',
      'easy money',
      'thousands',
      'highly profitable',
      'per month in revenue',
    ]) {
      expect(everything.toLowerCase()).not.toContain(oversell)
    }
  })
})

// -----------------------------------------------------------------------------
describe('the showcase catalogue cannot become a charge', () => {
  it('carries nothing a Checkout Session could be built from', () => {
    /*
     * The trust boundary, asserted on the shape of the data rather than on a
     * promise about how it is used. A Stripe price id, a plan_key the server
     * would recognise, or a minor-unit amount would each be a step towards this
     * illustration being mistaken for something sellable.
     */
    for (const plan of MONETIZATION_EXAMPLES) {
      const keys = Object.keys(plan)
      expect(keys).not.toContain('stripe_price_id')
      expect(keys).not.toContain('stripePriceId')
      expect(keys).not.toContain('plan_key')
      expect(keys).not.toContain('planKey')
      expect(keys).not.toContain('amount_minor')

      // And no value in it looks like a Stripe object of any kind.
      expect(JSON.stringify(plan)).not.toMatch(/price_|prod_|cus_|sub_|sk_|whsec_/)
    }
  })

  it('shares no identifier with the server’s sellable catalogue', () => {
    /*
     * `billing_available_plans` returns rows keyed by `plan_key`, and the server
     * resolves a Checkout price from that key alone. These ids are deliberately
     * not plan keys — and in this deployment the server catalogue is empty, so
     * sending 'starter' produces `plan_unavailable`. supabase/tests/billing.test.ts
     * asserts that refusal against a real PostgreSQL.
     */
    const showcaseIds = MONETIZATION_EXAMPLES.map((plan) => plan.id)
    expect(showcaseIds).toEqual(['starter', 'growth', 'scale'])

    // A BillingPlanRow — the sellable shape — has a plan_key and a currency
    // domain value. The showcase type has neither, so one cannot be passed where
    // the other is expected without the compiler objecting.
    const sellable: BillingPlanRow = {
      plan_key: 'configured_plan',
      display_name: 'Configured',
      description: null,
      currency: 'EUR',
      amount_minor: 4900,
      billing_interval: 'month',
      interval_count: 1,
      entitlements: {},
      is_current: false,
    }
    expect(showcaseIds).not.toContain(sellable.plan_key)
  })

  it('does not change what the product allows', () => {
    /*
     * The packaging lists modules under tiers, and none of it is enforced. The
     * access state is derived from billing state alone — this file has no input
     * to it — so an unconfigured platform stays `platform_unconfigured` whatever
     * the cards say, and every module stays available.
     */
    const row = overview()
    expect(row.access_state).toBe('platform_unconfigured')
    expect(presentationOf(row)).toBe('platform_unconfigured')
    // Neither a checkout nor a portal is reachable from showcase mode.
    expect(canChoosePlan(row)).toBe(false)
    expect(canOpenPortal(row)).toBe(false)
  })

  it('is replaced by the real catalogue the moment one is configured', () => {
    // Configured and unsubscribed: the page's own plan selection takes over, and
    // the showcase is not what a person chooses from.
    const configuredRow = overview({ ...configured })
    expect(presentationOf(configuredRow)).toBe('no_subscription')
    expect(canChoosePlan(configuredRow)).toBe(true)

    // Configured and subscribed: authoritative subscription state, no examples.
    const subscribed = overview({ ...configured, status: 'active', has_customer: true })
    expect(presentationOf(subscribed)).toBe('active')
    expect(canChoosePlan(subscribed)).toBe(false)
    expect(canOpenPortal(subscribed)).toBe(true)
  })
})
