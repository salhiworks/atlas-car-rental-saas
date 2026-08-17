import { getStripeGuideOverride } from './env'

/**
 * Product help links.
 *
 * One place for addresses that point at documentation rather than at this
 * application, so a URL is never written twice and never buried in a component.
 * Nothing here is a secret: these are public help pages, and they are in the
 * browser bundle because that is where they are read.
 */

/**
 * How to connect a Stripe account and turn the example pricing into real
 * subscriptions.
 *
 * The canonical guide for this project, written for the person who received it.
 * Hard-coded deliberately: it is a known, stable address, and requiring
 * configuration to show a link we already know would mean most people never see
 * the one thing that explains how to monetize the software they were given.
 */
export const STRIPE_SUBSCRIPTIONS_GUIDE_URL =
  'https://profitstudio.app/video/add-stripe-subscriptions-supabase'

/**
 * An https URL with nothing hidden in it.
 *
 * Parsed rather than pattern-matched: `https:/\/evil` and `https://a@b` both
 * satisfy a regular expression, and one of them is a different host than it
 * appears to be. A `javascript:` or `data:` URL in an anchor is a scripting hole
 * handed over by configuration, so the protocol is checked rather than assumed.
 */
function isSafeHttpsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}

/**
 * Where the Billing page's "Set up Stripe subscriptions" button points.
 *
 * A deployment may override the guide — somebody distributing their own build
 * with their own tutorial should be able to — but an override is used only if it
 * is a safe https address. Anything else falls back to the canonical guide rather
 * than rendering a link somebody else chose the protocol for.
 *
 * Never null: the button always has somewhere real to go.
 */
export function getStripeGuideUrl(): string {
  const override = getStripeGuideOverride()
  return override !== null && isSafeHttpsUrl(override) ? override : STRIPE_SUBSCRIPTIONS_GUIDE_URL
}
