import type {
  BillingAccessState,
  BillingEventKind,
  BillingInterval,
  BillingOverviewRow,
  StripeSubscriptionStatus,
} from '@/types/database'

/**
 * The words the Billing page uses, written from typed facts.
 *
 * Two rules run through all of it.
 *
 * The first: never say a thing we do not know. "Subscription billing is not
 * configured" is not "your subscription has a problem"; "an invoice payment
 * failed" is not "your card was declined"; "cancels on the 4th" is not
 * "cancelled". Each of those pairs is a sentence somebody would act on wrongly.
 *
 * The second: this is account administration inside a working product, not a
 * pricing page. No urgency, no savings claims, no upgrade nudges. An owner came
 * here to check a date or fix a payment method.
 */

export const ACCESS_STATE_LABELS: Readonly<Record<BillingAccessState, string>> = {
  platform_unconfigured: 'Not configured',
  normal: 'Active',
  attention: 'Needs attention',
  restricted: 'Restricted',
}

export const INTERVAL_LABELS: Readonly<Record<BillingInterval, string>> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
  year: 'Yearly',
}

/** "per month", for a price. Plural handled because Stripe allows a count. */
export function intervalPhrase(interval: BillingInterval, count: number): string {
  const unit =
    interval === 'day'
      ? 'day'
      : interval === 'week'
        ? 'week'
        : interval === 'month'
          ? 'month'
          : 'year'
  return count === 1 ? `per ${unit}` : `every ${count} ${unit}s`
}

export const EVENT_KIND_LABELS: Readonly<Record<BillingEventKind, string>> = {
  customer_created: 'Billing account created',
  checkout_started: 'Checkout started',
  checkout_completed: 'Checkout completed',
  subscription_activated: 'Subscription activated',
  subscription_updated: 'Subscription updated',
  plan_changed: 'Plan changed',
  payment_failed: 'Payment failed',
  payment_recovered: 'Payment recovered',
  cancellation_scheduled: 'Cancellation scheduled',
  cancellation_reverted: 'Cancellation withdrawn',
  subscription_ended: 'Subscription ended',
  reconciled: 'Refreshed from provider',
  anomaly_detected: 'Needs review',
}

/**
 * The one thing the page is about, derived once.
 *
 * Seven states, because collapsing them is how a page ends up saying "no
 * subscription" to an agency whose payment is being retried, or "not configured"
 * to one whose checkout is still being confirmed.
 */
export type BillingPresentation =
  | 'platform_unconfigured'
  | 'catalogue_unconfigured'
  | 'no_subscription'
  | 'synchronizing'
  | 'active'
  | 'attention'
  | 'ended'

export function presentationOf(overview: BillingOverviewRow): BillingPresentation {
  // Deployment configuration comes first: an unconfigured platform is not a
  // tenant problem, and nothing else on the page is meaningful without it.
  if (!overview.stripe_configured) return 'platform_unconfigured'
  if (!overview.catalog_configured) return 'catalogue_unconfigured'

  if (overview.status === null) {
    // A checkout has been started and Stripe has not told us the outcome. This
    // is the state that must never read as "subscribed".
    return overview.pending_checkout ? 'synchronizing' : 'no_subscription'
  }

  if (overview.status === 'active' || overview.status === 'trialing') return 'active'
  if (overview.status === 'canceled' || overview.status === 'incomplete_expired') return 'ended'
  return 'attention'
}

export interface StatusCopy {
  readonly label: string
  readonly detail: string
  readonly tone: 'good' | 'caution' | 'critical' | 'neutral'
}

/**
 * What the status badge says, and the sentence under it.
 *
 * Written per Stripe status rather than per access state, because the difference
 * between "we are retrying the payment" and "we have stopped retrying" is the
 * difference between waiting and acting.
 */
export function describeStatus(overview: BillingOverviewRow): StatusCopy {
  const presentation = presentationOf(overview)

  if (presentation === 'platform_unconfigured' || presentation === 'catalogue_unconfigured') {
    return {
      label: 'Not configured',
      detail: 'Subscription billing is not set up for this deployment.',
      tone: 'neutral',
    }
  }
  if (presentation === 'synchronizing') {
    return {
      label: 'Confirming',
      detail: 'We are waiting for our payment provider to confirm your subscription.',
      tone: 'neutral',
    }
  }
  if (presentation === 'no_subscription') {
    return { label: 'No subscription', detail: 'Choose a plan to continue.', tone: 'caution' }
  }

  switch (overview.status as StripeSubscriptionStatus) {
    case 'active':
      return overview.cancel_scheduled
        ? {
            label: 'Cancels at period end',
            detail: 'Your subscription stays active until then.',
            tone: 'caution',
          }
        : { label: 'Active', detail: 'Your subscription is in good standing.', tone: 'good' }
    case 'trialing':
      return { label: 'Trial', detail: 'Your trial is running.', tone: 'good' }
    case 'past_due':
      // Precisely what is known: an attempt failed and more will be made.
      return {
        label: 'Payment failed',
        detail: 'A payment did not go through. Our provider will try again.',
        tone: 'critical',
      }
    case 'unpaid':
      return {
        label: 'Unpaid',
        detail: 'No further payment attempts will be made until an invoice is paid.',
        tone: 'critical',
      }
    case 'incomplete':
      return {
        label: 'Incomplete',
        detail: 'The first payment was not completed.',
        tone: 'critical',
      }
    case 'incomplete_expired':
      return {
        label: 'Not started',
        detail: 'The first payment was never completed, so the subscription did not start.',
        tone: 'caution',
      }
    case 'paused':
      return {
        label: 'Paused',
        detail: 'The subscription is paused and is not being invoiced.',
        tone: 'caution',
      }
    case 'canceled':
      return { label: 'Cancelled', detail: 'This subscription has ended.', tone: 'caution' }
  }
}

/**
 * Whether a working "Manage billing" action can exist.
 *
 * A button that opens nothing is worse than no button. The portal needs a
 * configured server AND a Stripe customer for this agency; without both, the
 * page says why instead of offering an action that will fail.
 */
export function canOpenPortal(overview: BillingOverviewRow): boolean {
  return overview.stripe_configured && overview.has_customer
}

/** Whether choosing a plan is a real option right now. */
export function canChoosePlan(overview: BillingOverviewRow): boolean {
  const presentation = presentationOf(overview)
  return (
    overview.platform_configured && (presentation === 'no_subscription' || presentation === 'ended')
  )
}
