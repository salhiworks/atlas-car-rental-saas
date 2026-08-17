import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Button, Card, CardBody, Spinner } from '@/components/ui'
import { presentationOf } from '@/features/billing/domain'
import { useBillingOverview, useReconcileBilling } from '@/features/billing/queries'

/**
 * Where Stripe sends an owner after Checkout.
 *
 * THE REDIRECT PROVES NOTHING. Arriving here means a browser followed a URL —
 * that is all. It does not mean a payment succeeded, and this page never says it
 * did. It reads the authoritative local projection, which moves only when a
 * verified Stripe event or a deliberate server read says so, and it says
 * "confirming" until then.
 *
 * Stripe waits up to ten seconds for the webhook before redirecting, so most
 * people never see the waiting state. The ones who do are the reason it exists:
 * a delayed delivery must produce an honest wait and a way forward, not a
 * success message that turns out to be wrong.
 */
export function BillingReturnPage() {
  const navigate = useNavigate()
  const overview = useBillingOverview()
  const reconcile = useReconcileBilling()

  const presentation = overview.data ? presentationOf(overview.data) : null
  const confirmed = presentation === 'active'

  /*
   * Poll the projection — not Stripe — while it is still confirming. The
   * webhook is what updates it; this only re-reads our own database, so an owner
   * refreshing impatiently costs nothing at the provider.
   */
  useEffect(() => {
    if (confirmed || overview.isError) return
    const timer = setInterval(() => void overview.refetch(), 3000)
    return () => clearInterval(timer)
  }, [confirmed, overview])

  useEffect(() => {
    if (!confirmed) return
    const timer = setTimeout(() => navigate(paths.billing, { replace: true }), 1500)
    return () => clearTimeout(timer)
  }, [confirmed, navigate])

  return (
    <div className="mx-auto max-w-md py-10">
      <Card>
        <CardBody className="space-y-4 text-center">
          {confirmed ? (
            <>
              <h1 className="text-[1.0625rem] font-semibold">Subscription active</h1>
              <p className="text-ink-muted text-[0.8125rem]">
                Your subscription is confirmed. Taking you back to Billing.
              </p>
            </>
          ) : overview.isError ? (
            <>
              <h1 className="text-[1.0625rem] font-semibold">We could not read your billing</h1>
              <p className="text-ink-muted text-[0.8125rem]">
                Your payment may still have gone through. Open Billing to check.
              </p>
              <Button onClick={() => void overview.refetch()}>Try again</Button>
            </>
          ) : (
            <>
              <Spinner />
              <h1 className="text-[1.0625rem] font-semibold">Confirming your subscription…</h1>
              <p className="text-ink-muted text-[0.8125rem]">
                We are waiting for our payment provider to confirm it. Nothing is active until it
                does. You can leave this page — it will be confirmed either way.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  isLoading={reconcile.isPending}
                  onClick={() => reconcile.mutate()}
                >
                  Check now
                </Button>
                <Link
                  to={paths.billing}
                  className="text-brand-700 text-[0.8125rem] hover:underline"
                >
                  Go to Billing
                </Link>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
