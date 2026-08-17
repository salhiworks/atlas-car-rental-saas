import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { useOrganization } from '@/features/workspace/workspace-context'

import {
  fetchBillingHistory,
  fetchBillingOverview,
  fetchBillingPlans,
  openBillingPortal,
  reconcileBilling,
  refreshBillingPlatform,
  setBillingEmail,
  startCheckout,
} from './api'

/**
 * Query keys for Billing.
 *
 * EVERY KEY BEGINS WITH THE ORGANIZATION. The workspace switcher removes exactly
 * `['organization']`, and the membership-loss watcher matches on the first two
 * elements — so a key shaped `['billing', orgId]` would survive both and leave
 * one agency's plan, price and payment problem on screen under another's name.
 * That is the single worst thing this module could leak.
 */
export const billingKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'billing'] as const,
  overview: (organizationId: string) =>
    ['organization', organizationId, 'billing', 'overview'] as const,
  plans: (organizationId: string) => ['organization', organizationId, 'billing', 'plans'] as const,
  history: (organizationId: string) =>
    ['organization', organizationId, 'billing', 'history'] as const,
  platform: (organizationId: string) =>
    ['organization', organizationId, 'billing', 'platform'] as const,
}

function invalidate(client: QueryClient, organizationId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: billingKeys.all(organizationId) }).then(() => {})
}

/**
 * Asks the server once, when the page opens, what it is configured to do.
 *
 * This is the only query in the product that can reach Stripe, and it runs on
 * one page. `staleTime` is long because a deployment's configuration does not
 * change while somebody reads a page, and because the answer costs a Stripe
 * round trip.
 */
export function useBillingPlatform() {
  const organization = useOrganization()

  return useQuery({
    queryKey: billingKeys.platform(organization.id),
    queryFn: () => refreshBillingPlatform(organization.id),
    staleTime: 5 * 60_000,
    // A failure here must not take the page down: the projection below still
    // answers, and the page can say what it knows.
    retry: false,
  })
}

/**
 * The projection, which is what the page actually renders.
 *
 * Deliberately independent of the platform query above: if the server is
 * unreachable, an owner still sees their current plan and renewal date from the
 * database rather than an error page.
 */
export function useBillingOverview() {
  const organization = useOrganization()

  return useQuery({
    queryKey: billingKeys.overview(organization.id),
    queryFn: () => fetchBillingOverview(organization.id),
    staleTime: 30_000,
    /*
     * No `placeholderData`. Keeping the previous agency's plan on screen for a
     * frame while a new one loads is exactly the flash this module must not have.
     */
  })
}

export function useBillingPlans(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: billingKeys.plans(organization.id),
    queryFn: () => fetchBillingPlans(organization.id),
    enabled,
    staleTime: 5 * 60_000,
  })
}

export function useBillingHistory(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: billingKeys.history(organization.id),
    queryFn: () => fetchBillingHistory(organization.id),
    enabled,
    staleTime: 60_000,
  })
}

/**
 * Starts Checkout and hands the browser to Stripe.
 *
 * The attempt token is minted once per mount, so every click of the same button
 * shares one idempotency key at the server and Stripe returns the same session
 * rather than creating another. A disabled button is a courtesy; this is the
 * control.
 */
export function useStartCheckout(attempt: string) {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (planKey: string) => startCheckout(organization.id, planKey, attempt),
    onSuccess: async (result) => {
      await invalidate(client, organization.id)
      if (result.url) window.location.assign(result.url)
    },
  })
}

export function useOpenPortal() {
  const organization = useOrganization()

  return useMutation({
    mutationFn: () => openBillingPortal(organization.id),
    onSuccess: (result) => {
      // The portal cannot be embedded, and a portal URL expires in minutes: it
      // is used immediately and never stored.
      if (result.url) window.location.assign(result.url)
    },
  })
}

export function useReconcileBilling() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: () => reconcileBilling(organization.id),
    onSuccess: () => invalidate(client, organization.id),
  })
}

export function useSetBillingEmail() {
  const organization = useOrganization()
  const client = useQueryClient()

  return useMutation({
    mutationFn: (email: string | null) => setBillingEmail(organization.id, email),
    onSuccess: () => invalidate(client, organization.id),
  })
}
