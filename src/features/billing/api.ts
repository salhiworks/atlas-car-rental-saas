import { getSupabaseClient } from '@/lib/supabase/client'
import { AppError, toAppError } from '@/lib/supabase/errors'
import type {
  BillingAccessState,
  BillingHistoryRow,
  BillingOverviewRow,
  BillingPlanRow,
} from '@/types/database'

/**
 * The Billing data layer.
 *
 * Four reads, one write, and three server operations. None of them can change
 * what this agency is subscribed to: the projection is written by verified Stripe
 * events and by deliberate server-side reads, and a browser cannot reach either.
 *
 * WHAT THE BROWSER IS NEVER TRUSTED WITH. It names a plan KEY, never a Stripe
 * price — the server turns one into the other, and a price arriving from here is
 * not read at all. It names an organization, which the server re-checks against
 * the caller's own membership before doing anything. And a redirect back from
 * Checkout unlocks nothing: the page reads the projection, which moves only when
 * the trusted path says so.
 */

const FUNCTION = 'billing'

interface FunctionErrorBody {
  error?: { category?: string; message?: string }
}

/** A billing action's outcome, as the server describes it. */
export interface BillingActionResult {
  ok: true
  /** Present when the deployment has no Stripe configuration. */
  state?: 'billing_not_configured' | 'configured' | 'reconciled' | 'no_billing_account'
  message?: string
  /** A Stripe-hosted URL to navigate to. Never stored, never logged. */
  url?: string
  reused?: boolean
  plans?: number
  applied?: number
  mode?: 'test' | 'live'
}

/**
 * Reads the sentence the server already wrote for a person.
 *
 * supabase-js reports a non-2xx from a function as an opaque error with the
 * Response tucked into `context`; without unwrapping it every refusal here would
 * read "Edge Function returned a non-2xx status code", which tells an owner
 * nothing about the payment they were trying to set up.
 */
async function unwrapFunctionError(error: unknown): Promise<never> {
  const context = (error as { context?: Response })?.context
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.clone().json()) as FunctionErrorBody
      if (body?.error?.message) {
        throw new AppError(
          body.error.category === 'permission_denied' ? 'permission' : 'validation',
          body.error.message,
        )
      }
    } catch (parsed) {
      if (parsed instanceof AppError) throw parsed
    }
  }
  throw toAppError(error)
}

async function invokeBilling(body: Record<string, unknown>): Promise<BillingActionResult> {
  const result = await getSupabaseClient().functions.invoke<BillingActionResult>(FUNCTION, { body })
  const error: unknown = result.error

  if (error) await unwrapFunctionError(error)
  if (!result.data) throw new AppError('validation', 'Billing did not answer. Try again.')

  return result.data
}

export async function fetchBillingOverview(organizationId: string): Promise<BillingOverviewRow> {
  const { data, error } = await getSupabaseClient().rpc('billing_overview', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)
  const row = data?.[0]
  if (!row) throw new AppError('notFound', 'Billing could not be read for this agency.')

  return row
}

export async function fetchBillingAccessState(organizationId: string): Promise<BillingAccessState> {
  const { data, error } = await getSupabaseClient().rpc('billing_access', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)
  return data ?? 'platform_unconfigured'
}

export async function fetchBillingPlans(organizationId: string): Promise<BillingPlanRow[]> {
  const { data, error } = await getSupabaseClient().rpc('billing_available_plans', {
    p_organization_id: organizationId,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchBillingHistory(
  organizationId: string,
  limit = 20,
): Promise<BillingHistoryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('billing_history', {
    p_organization_id: organizationId,
    p_limit: limit,
  })

  if (error) throw toAppError(error)
  return data ?? []
}

export async function setBillingEmail(organizationId: string, email: string | null): Promise<void> {
  const { error } = await getSupabaseClient().rpc('billing_set_email', {
    p_organization_id: organizationId,
    p_email: email,
  })

  if (error) throw toAppError(error)
}

/**
 * Asks the server what it can actually do.
 *
 * The Billing page calls this once when it opens, and it is the only routine
 * path that reaches Stripe: the server refreshes the sellable catalogue and
 * records whether it holds credentials at all. Ordinary navigation elsewhere in
 * the product never touches Stripe — the database projection answers every access
 * question.
 */
export function refreshBillingPlatform(organizationId: string): Promise<BillingActionResult> {
  return invokeBilling({ action: 'status', organizationId })
}

/**
 * Starts Checkout for a configured plan.
 *
 * `attempt` scopes the server's idempotency key, so a double-clicked button and
 * a retried request collapse into one Stripe session while a legitimate purchase
 * later is not blocked by a key that never expires.
 */
export function startCheckout(
  organizationId: string,
  planKey: string,
  attempt: string,
): Promise<BillingActionResult> {
  return invokeBilling({ action: 'checkout', organizationId, planKey, attempt })
}

export function openBillingPortal(organizationId: string): Promise<BillingActionResult> {
  return invokeBilling({ action: 'portal', organizationId })
}

/**
 * Re-reads Stripe and updates the projection.
 *
 * For a webhook that has not arrived, one that never will, or a support
 * question. Deliberately a person's action rather than something the page does
 * on a timer: the projection is what serves normal access decisions, and Stripe
 * is asked only when somebody asks.
 */
export function reconcileBilling(organizationId: string): Promise<BillingActionResult> {
  return invokeBilling({ action: 'reconcile', organizationId })
}
