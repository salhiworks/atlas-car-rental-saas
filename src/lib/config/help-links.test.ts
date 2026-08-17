import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as EnvModule from './env'

import { getStripeGuideUrl, STRIPE_SUBSCRIPTIONS_GUIDE_URL } from './help-links'

/**
 * Where the Billing page's guide button points.
 *
 * Two rules, and the second one is the security-relevant half: the canonical
 * guide is always available without configuration, and a configured override is
 * used only if it is a safe https address. Configuration is a place an attacker
 * reaches occasionally, and this value lands in an anchor's href.
 */

vi.mock('./env', async () => {
  const actual = await vi.importActual<typeof EnvModule>('./env')
  return { ...actual, getStripeGuideOverride: vi.fn(() => null) }
})

const { getStripeGuideOverride } = await import('./env')
const mockedOverride = vi.mocked(getStripeGuideOverride)

afterEach(() => {
  mockedOverride.mockReturnValue(null)
})

describe('the Stripe guide address', () => {
  it('is the canonical guide when nothing is configured', () => {
    expect(getStripeGuideUrl()).toBe(
      'https://profitstudio.app/video/add-stripe-subscriptions-supabase',
    )
    // Written once, in one place, so it cannot drift between components.
    expect(STRIPE_SUBSCRIPTIONS_GUIDE_URL).toBe(getStripeGuideUrl())
  })

  it('never returns null, so the button always has somewhere to go', () => {
    mockedOverride.mockReturnValue(null)
    expect(typeof getStripeGuideUrl()).toBe('string')
    expect(getStripeGuideUrl().startsWith('https://')).toBe(true)
  })

  it('uses a deployment’s own https guide when one is configured', () => {
    mockedOverride.mockReturnValue('https://docs.example.test/stripe')
    expect(getStripeGuideUrl()).toBe('https://docs.example.test/stripe')
  })

  it('refuses an override that is not a plain https address', () => {
    for (const unsafe of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://docs.example.test/stripe',
      'file:///etc/passwd',
      'not a url at all',
      '',
    ]) {
      mockedOverride.mockReturnValue(unsafe)
      expect(getStripeGuideUrl(), unsafe).toBe(STRIPE_SUBSCRIPTIONS_GUIDE_URL)
    }
  })

  it('refuses an override carrying credentials in the host', () => {
    // `https://evil.test@docs.example.test` is a different host than it looks.
    mockedOverride.mockReturnValue('https://user:pass@docs.example.test/stripe')
    expect(getStripeGuideUrl()).toBe(STRIPE_SUBSCRIPTIONS_GUIDE_URL)

    mockedOverride.mockReturnValue('https://evil.test@docs.example.test/stripe')
    expect(getStripeGuideUrl()).toBe(STRIPE_SUBSCRIPTIONS_GUIDE_URL)
  })

  it('falls back rather than throwing on anything unparseable', () => {
    mockedOverride.mockReturnValue('https://')
    expect(() => getStripeGuideUrl()).not.toThrow()
    expect(getStripeGuideUrl()).toBe(STRIPE_SUBSCRIPTIONS_GUIDE_URL)
  })
})
