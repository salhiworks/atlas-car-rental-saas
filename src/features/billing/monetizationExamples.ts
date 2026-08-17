/**
 * Example pricing, for somebody deciding how to sell this product.
 *
 * READ THIS BEFORE USING ANYTHING IN THIS FILE.
 *
 * These are illustrations. They are not Stripe Products, not Stripe Prices, not
 * a subscription, not an entitlement, and not a limit. Nothing here authorizes
 * anything, charges anything, or restricts anything. This build is fully
 * unlocked, and it stays that way whatever these cards say.
 *
 * WHY THE NAMES ARE THIS LONG. There are two catalogues in this module and they
 * must never be confused:
 *
 *   `MONETIZATION_EXAMPLES` (this file)  presentation only. Lives in the browser
 *                                        bundle, because it decides nothing. A
 *                                        `$99` here is a picture of a price.
 *
 *   `public.billing_plans` (the database) server-authoritative. The only thing a
 *                                        Checkout Session can be created from.
 *                                        Populated by the billing service from
 *                                        Stripe, never by this file, and empty
 *                                        in this deployment.
 *
 * The trust boundary between them is the whole point. A browser sends a PLAN KEY
 * and the server turns it into a Stripe price by looking it up in
 * `billing_plans`. The keys below are deliberately absent from that table, so
 * sending one produces `plan_unavailable` — a test asserts exactly that. There is
 * no code path from these numbers to a charge.
 *
 * The packaging is likewise a suggestion. None of it is enforced: every module
 * listed under every tier is available to every role that its own permission
 * allows, exactly as before Billing existed. If the person who receives this
 * project wants three different tiers, or one, or none, they change this file and
 * nothing else breaks.
 */

/** A tier's billing period, for the preview toggle only. */
export type ExampleInterval = 'monthly' | 'yearly'

/**
 * One illustrative tier.
 *
 * Deliberately NOT shaped like `BillingPlanRow`, the server's sellable plan. No
 * `stripe_price_id`, no `plan_key`, no `currency` domain type, no `amount_minor`
 * — because a type that looked like the real one could be passed somewhere that
 * expects the real one. Amounts here are whole units of display currency and are
 * only ever formatted.
 */
export interface MonetizationExample {
  /** An identifier for React keys and tests. Never sent to a server. */
  readonly id: 'starter' | 'growth' | 'scale'
  readonly name: string
  /** Who the tier is pitched at, in one line. */
  readonly audience: string
  readonly monthlyAmount: number
  readonly yearlyAmount: number
  /** ISO 4217, for formatting. Not the currency of any subscription. */
  readonly displayCurrency: 'USD'
  /**
   * Suggested packaging. NOT ENFORCED ANYWHERE — see the module comment. Listed
   * so somebody can see how the existing modules might be split commercially.
   */
  readonly includes: readonly string[]
  /**
   * A restrained note on one tier. Deliberately "Suggested" rather than "Most
   * popular": nothing has been sold yet, so there is no popularity to report.
   */
  readonly isSuggested?: boolean
}

export const MONETIZATION_EXAMPLES: readonly MonetizationExample[] = [
  {
    id: 'starter',
    name: 'Starter',
    audience: 'For small rental agencies',
    monthlyAmount: 49,
    yearlyAmount: 490,
    displayCurrency: 'USD',
    includes: [
      'Fleet & vehicle management',
      'Customers & drivers',
      'Rentals & contracts',
      'Calendar',
      'Expenses',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    audience: 'For growing rental businesses',
    monthlyAmount: 99,
    yearlyAmount: 990,
    displayCurrency: 'USD',
    includes: [
      'Everything in Starter',
      'Reports & analytics',
      'Vehicle financing',
      'Team management',
      'Notifications & reminders',
    ],
    isSuggested: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    audience: 'For larger fleet operations',
    monthlyAmount: 199,
    yearlyAmount: 1990,
    displayCurrency: 'USD',
    includes: [
      'Everything in Growth',
      'GPS tracking integration',
      'Advanced fleet operations',
      'Built for larger teams and fleets',
    ],
  },
]

/** The amount to show for a tier at the selected interval. */
export function exampleAmount(plan: MonetizationExample, interval: ExampleInterval): number {
  return interval === 'monthly' ? plan.monthlyAmount : plan.yearlyAmount
}

/** "per month" / "per year", for the price line. */
export function exampleIntervalPhrase(interval: ExampleInterval): string {
  return interval === 'monthly' ? 'per month' : 'per year'
}

/**
 * Formats an example amount.
 *
 * Whole units, because these are round illustrative figures and "$49.00" reads
 * like an invoice. Real subscription amounts are minor units and go through
 * formatMoney, which is a different function for a different kind of number.
 */
export function formatExampleAmount(
  plan: MonetizationExample,
  interval: ExampleInterval,
  locale: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: plan.displayCurrency,
    maximumFractionDigits: 0,
  }).format(exampleAmount(plan, interval))
}
