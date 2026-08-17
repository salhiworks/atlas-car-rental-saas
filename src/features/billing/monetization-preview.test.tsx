import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as HelpLinksModule from '@/lib/config/help-links'

import { MonetizationPreview } from './components/MonetizationPreview'

/**
 * The free-build screen, as a person reads it.
 *
 * Two things are being protected. First, that nobody can mistake an illustration
 * for a charge: the prices are examples, the packaging is not enforced, and there
 * is no way to start a payment from this page. Second, that it does not read as a
 * configuration error — this is an intended product mode, and telling somebody
 * their software is broken when it is working is its own kind of untruth.
 */

/*
 * The guide URL is resolved through help-links, which falls back to the canonical
 * address when no override is configured. Mocked here so the override branch is
 * reachable without touching import.meta.env; the default is asserted against the
 * real constant.
 */
vi.mock('@/lib/config/help-links', async () => {
  const actual = await vi.importActual<typeof HelpLinksModule>('@/lib/config/help-links')
  return { ...actual, getStripeGuideUrl: vi.fn(() => actual.STRIPE_SUBSCRIPTIONS_GUIDE_URL) }
})

const { getStripeGuideUrl, STRIPE_SUBSCRIPTIONS_GUIDE_URL } =
  await import('@/lib/config/help-links')
const mockedGuideUrl = vi.mocked(getStripeGuideUrl)

afterEach(() => {
  mockedGuideUrl.mockReturnValue(STRIPE_SUBSCRIPTIONS_GUIDE_URL)
})

function renderPreview() {
  return render(<MonetizationPreview locale="en-US" />)
}

// -----------------------------------------------------------------------------
describe('the free build is stated, not apologised for', () => {
  it('says the build is free and everything is unlocked', () => {
    renderPreview()

    expect(screen.getByRole('heading', { name: 'Free build' })).toBeInTheDocument()
    expect(screen.getByText('All features unlocked')).toBeInTheDocument()
    expect(screen.getByText(/No subscription or payment is required/)).toBeInTheDocument()
  })

  it('reads as a product mode, not as something to fix', () => {
    renderPreview()
    const body = document.body.textContent ?? ''

    /*
     * "Stripe" itself is fine and necessary — "Connect your own Stripe account"
     * is the point of the page. What must not appear is the vocabulary of a
     * misconfiguration: a variable name, a missing secret, or an instruction to
     * contact somebody about a product that is working correctly.
     */
    for (const wrong of [
      'not set up',
      'not configured',
      'contact support',
      'Something went wrong',
      'is missing',
      'STRIPE_',
      'BILLING_',
      'VITE_',
      'environment variable',
    ]) {
      expect(body.toLowerCase()).not.toContain(wrong.toLowerCase())
    }

    /*
     * Secrets are mentioned exactly once, and as reassurance rather than as a
     * demand: "your keys stay server-side" is a sentence that answers a worry.
     * "Set your secret key" would be an instruction nobody can follow from here.
     */
    expect(body).toMatch(/secret keys stay server-side and are never exposed/i)
    expect(body).not.toMatch(/enter your|paste your|add your (stripe )?(secret|api) key/i)
  })

  it('explains that the prices are the reader’s to customize', () => {
    renderPreview()
    expect(
      screen.getByText(/example pricing you can customize if you want to sell Atlas/i),
    ).toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
describe('example pricing', () => {
  it('shows three tiers with their monthly prices', () => {
    renderPreview()

    for (const [name, price, audience] of [
      ['Starter', '$49', 'For small rental agencies'],
      ['Growth', '$99', 'For growing rental businesses'],
      ['Scale', '$199', 'For larger fleet operations'],
    ] as const) {
      const card = screen.getByRole('heading', { name }).closest('li')!
      expect(within(card).getByText(price)).toBeInTheDocument()
      expect(within(card).getByText(audience)).toBeInTheDocument()
      expect(within(card).getByText('per month')).toBeInTheDocument()
    }
  })

  it('switches every price to the yearly figure', async () => {
    renderPreview()
    await userEvent.click(screen.getByRole('radio', { name: 'Yearly' }))

    expect(screen.getByText('$490')).toBeInTheDocument()
    expect(screen.getByText('$990')).toBeInTheDocument()
    expect(screen.getByText('$1,990')).toBeInTheDocument()
    expect(screen.queryByText('$49')).not.toBeInTheDocument()
    expect(screen.getAllByText('per year')).toHaveLength(3)
  })

  it('starts on monthly and announces which interval is chosen', async () => {
    renderPreview()

    const monthly = screen.getByRole('radio', { name: 'Monthly' })
    const yearly = screen.getByRole('radio', { name: 'Yearly' })
    // The selection is in the accessibility tree, not only in the colour.
    expect(monthly).toHaveAttribute('aria-checked', 'true')
    expect(yearly).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(yearly)
    expect(yearly).toHaveAttribute('aria-checked', 'true')
    expect(monthly).toHaveAttribute('aria-checked', 'false')
  })

  it('is reachable and operable from the keyboard', async () => {
    renderPreview()
    const yearly = screen.getByRole('radio', { name: 'Yearly' })

    yearly.focus()
    expect(yearly).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(yearly).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('$990')).toBeInTheDocument()
  })

  it('says the prices are examples without repeating it ten times', () => {
    renderPreview()

    // Once per card, plus the section explanation. Enough to be unmistakable,
    // few enough that the page does not read as a disclaimer.
    expect(screen.getAllByText('Example price')).toHaveLength(3)
    expect(screen.getByText(/Nothing here is charged/)).toBeInTheDocument()
  })

  it('marks Growth as suggested, and nothing as most popular', () => {
    renderPreview()

    const growth = screen.getByRole('heading', { name: 'Growth' }).closest('li')!
    expect(within(growth).getByText('Suggested')).toBeInTheDocument()
    expect(screen.queryByText(/most popular/i)).not.toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
describe('no payment can be started from this page', () => {
  it('offers no subscribe, checkout or portal action', () => {
    renderPreview()

    for (const forbidden of [
      /subscribe/i,
      /choose plan/i,
      /start (free )?trial/i,
      /manage billing/i,
      /pay now/i,
      /upgrade/i,
      /add payment/i,
      /card/i,
    ]) {
      expect(screen.queryByRole('button', { name: forbidden })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: forbidden })).not.toBeInTheDocument()
    }
  })

  it('states that nothing is restricted', () => {
    renderPreview()
    expect(screen.getByText(/Nothing is restricted in this build/i)).toBeInTheDocument()
  })

  it('does not claim Stripe has been verified here', () => {
    renderPreview()
    const body = document.body.textContent ?? ''

    // The infrastructure exists; an end-to-end run against a real Stripe account
    // has not happened, and this page must not imply otherwise.
    expect(body).toMatch(/billing infrastructure is already prepared/i)
    expect(body).not.toMatch(/verified|tested end-to-end|connected to Stripe|live and working/i)
  })

  it('never invites somebody to paste a secret into the browser', () => {
    renderPreview()
    expect(screen.queryByLabelText(/secret|api key|webhook/i)).not.toBeInTheDocument()
    expect(document.querySelectorAll('input')).toHaveLength(0)
    expect(document.body.textContent).toMatch(/stay server-side and are never exposed/i)
  })
})

// -----------------------------------------------------------------------------
describe('the Stripe guide link', () => {
  it('points at the canonical guide with no configuration at all', () => {
    renderPreview()

    const link = screen.getByRole('link', { name: /Set up Stripe subscriptions/ })
    // A known public address should not need configuring before anybody can see
    // it — otherwise most people never find the one page that explains how to
    // monetize the software they were given.
    expect(link).toHaveAttribute(
      'href',
      'https://profitstudio.app/video/add-stripe-subscriptions-supabase',
    )
  })

  it('opens in its own tab, safely', () => {
    renderPreview()
    const link = screen.getByRole('link', { name: /Set up Stripe subscriptions/ })

    expect(link).toHaveAttribute('target', '_blank')
    // noopener AND noreferrer: a new tab must not get a handle back on this one.
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it('uses a deployment’s own guide when one is configured', () => {
    mockedGuideUrl.mockReturnValue('https://docs.example.test/atlas/stripe')
    renderPreview()

    expect(screen.getByRole('link', { name: /Set up Stripe subscriptions/ })).toHaveAttribute(
      'href',
      'https://docs.example.test/atlas/stripe',
    )
  })

  it('sits beside the callout rather than replacing it', () => {
    renderPreview()
    expect(screen.getByRole('heading', { name: 'Ready to monetize it?' })).toBeInTheDocument()
    expect(
      screen.getByText(/Connect your own Stripe account and turn your pricing into real/),
    ).toBeInTheDocument()
    expect(screen.getByText(/The billing infrastructure is already prepared/)).toBeInTheDocument()
  })
})

// -----------------------------------------------------------------------------
describe('the tone', () => {
  it('promises no earnings', () => {
    renderPreview()
    const body = (document.body.textContent ?? '').toLowerCase()

    for (const oversell of [
      'guaranteed',
      'passive income',
      'easy money',
      'thousands',
      'highly profitable',
      'start earning',
      'make money fast',
    ]) {
      expect(body).not.toContain(oversell)
    }
  })

  it('does not shout or invent urgency', () => {
    renderPreview()
    const body = document.body.textContent ?? ''

    expect(body).not.toMatch(/!!|ACT NOW|LIMITED|HURRY|🎉|🚀/)
  })
})
