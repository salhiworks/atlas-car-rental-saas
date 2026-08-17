import { useId, useState } from 'react'

import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardBody,
  CardHeader,
  PageHeader,
  Skeleton,
  useToast,
} from '@/components/ui'
import {
  ACCESS_STATE_LABELS,
  canChoosePlan,
  canOpenPortal,
  describeStatus,
  EVENT_KIND_LABELS,
  intervalPhrase,
  presentationOf,
  type StatusCopy,
} from '@/features/billing/domain'
import { MonetizationPreview } from '@/features/billing/components/MonetizationPreview'
import {
  useBillingHistory,
  useBillingOverview,
  useBillingPlatform,
  useBillingPlans,
  useOpenPortal,
  useReconcileBilling,
  useStartCheckout,
} from '@/features/billing/queries'
import { useOrganization } from '@/features/workspace/workspace-context'
import { formatDate, formatDateTime } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { BillingOverviewRow, BillingPlanRow } from '@/types/database'
import { getAppName } from '@/lib/config/env'

/**
 * Billing — what this agency pays to use Atlas.
 *
 * Owner-only, and enforced in the database rather than by this file: an
 * administrator who types the URL is refused by `billing_overview`, not by a
 * missing menu entry.
 *
 * THE STATE THIS DEPLOYMENT IS IN. No Stripe credentials and no plan catalogue
 * are configured, so what an owner sees here is a finished, quiet page saying
 * exactly that, and saying that nothing is required of them. It is not an error
 * page, not a "coming soon" placeholder, and — importantly — not a pricing page
 * with disabled buttons pretending plans exist.
 *
 * WHAT IT NEVER DOES. It never reads a subscription's state from a redirect. A
 * return from Checkout says "confirming" and then reads the projection, which
 * moves only when a verified Stripe event or a deliberate server read says so.
 */

const BADGE_TONE: Record<StatusCopy['tone'], BadgeTone> = {
  good: 'positive',
  caution: 'caution',
  critical: 'critical',
  neutral: 'neutral',
}

function money(amountMinor: number, currency: string, locale: string): string {
  return formatMoney(amountMinor, currency, { locale })
}

/** One labelled fact. Two columns on a desktop, stacked on a phone. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-subtle text-[0.75rem]">{label}</dt>
      <dd className="mt-0.5 text-[0.8125rem] break-words">{children}</dd>
    </div>
  )
}

function PlanCard({
  plan,
  locale,
  isBusy,
  onChoose,
}: {
  plan: BillingPlanRow
  locale: string
  isBusy: boolean
  onChoose: (planKey: string) => void
}) {
  return (
    <li className="border-line flex min-w-0 flex-col rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.875rem] font-semibold">{plan.display_name}</p>
          {plan.description ? (
            <p className="text-ink-subtle mt-1 text-[0.75rem] leading-4">{plan.description}</p>
          ) : null}
        </div>
        {plan.is_current ? <Badge tone="positive">Current</Badge> : null}
      </div>

      <p className="mt-3">
        {/* The exact price Stripe charges, in the currency Stripe charges it in. */}
        <span data-numeric="" className="text-[1.125rem] font-semibold tabular-nums">
          {money(plan.amount_minor, plan.currency, locale)}
        </span>{' '}
        <span className="text-ink-subtle text-[0.75rem]">
          {intervalPhrase(plan.billing_interval, plan.interval_count)}
        </span>
      </p>

      <Button
        className="mt-4"
        variant={plan.is_current ? 'secondary' : 'primary'}
        disabled={plan.is_current || isBusy}
        isLoading={isBusy}
        onClick={() => onChoose(plan.plan_key)}
      >
        {plan.is_current ? 'Current plan' : 'Choose plan'}
      </Button>
    </li>
  )
}

export function BillingPage() {
  const organization = useOrganization()
  const toast = useToast()

  /*
   * One token per mount. Every click of Choose plan therefore shares a single
   * idempotency key at the server, so two clicks — or two tabs opened from this
   * page — cannot produce two Stripe sessions.
   */
  const attempt = useId()
  const [chosen, setChosen] = useState<string | null>(null)

  const platform = useBillingPlatform()
  const overview = useBillingOverview()
  const plans = useBillingPlans(overview.data?.platform_configured === true)
  const history = useBillingHistory(overview.data?.stripe_configured === true)

  const checkout = useStartCheckout(attempt)
  const portal = useOpenPortal()
  const reconcile = useReconcileBilling()

  if (overview.isError) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Agency"
          title="Billing"
          description={`Your ${getAppName()} subscription.`}
        />
        <ErrorState
          error={overview.error}
          title="Billing could not be loaded"
          onRetry={() => void overview.refetch()}
        />
      </div>
    )
  }

  if (overview.isPending || !overview.data) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Agency"
          title="Billing"
          description={`Your ${getAppName()} subscription.`}
        />
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-52" />
          </CardBody>
        </Card>
      </div>
    )
  }

  const data: BillingOverviewRow = overview.data
  const presentation = presentationOf(data)
  const status = describeStatus(data)
  const locale = organization.locale
  const isShowcase =
    presentation === 'platform_unconfigured' || presentation === 'catalogue_unconfigured'

  const choose = (planKey: string) => {
    setChosen(planKey)
    checkout.mutate(planKey, {
      onError: (error) => toast.error('Checkout could not be started', error.message),
      onSettled: () => setChosen(null),
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agency"
        title="Billing"
        description={
          /*
           * Two audiences, two sentences. With a payment account connected this
           * page is an agency's subscription; without one it is a decision about
           * whether to sell the product, and the subtitle says which it is.
           */
          isShowcase
            ? `Turn ${getAppName()} into a subscription SaaS.`
            : `Your ${getAppName()} subscription for ${organization.name}.`
        }
        actions={
          canOpenPortal(data) ? (
            <Button
              variant="secondary"
              isLoading={portal.isPending}
              onClick={() =>
                portal.mutate(undefined, {
                  onError: (error) => toast.error('Billing portal unavailable', error.message),
                })
              }
            >
              Manage billing
            </Button>
          ) : undefined
        }
      />

      {/*
        No payment account connected: the free build, and how to monetize it.

        The underlying truth is unchanged — no Stripe customer, no subscription,
        no enforcement — and the reason this build is unlocked is still that
        subscription enforcement has not been switched on. What changed is what a
        person is shown: an owner deciding whether to sell this software is better
        served by example pricing than by a report that a secret is absent, which
        they could not act on anyway.
      */}
      {presentation === 'platform_unconfigured' || presentation === 'catalogue_unconfigured' ? (
        <MonetizationPreview locale={locale} />
      ) : null}

      {/* Confirming a Checkout. The one state that must never read as subscribed. */}
      {presentation === 'synchronizing' ? (
        <Alert tone="info" title="Confirming your subscription">
          We are waiting for our payment provider to confirm it. This usually takes a few seconds.
          Nothing is active until it does.
        </Alert>
      ) : null}

      {presentation !== 'platform_unconfigured' && presentation !== 'catalogue_unconfigured' ? (
        <Card>
          <CardHeader
            /*
             * Named for what the card actually contains. "Current plan" above the
             * words "No subscription" is a small untruth, and a browser check
             * caught it on an agency that had never subscribed.
             */
            title={data.status !== null ? 'Current plan' : 'Subscription'}
            description={data.plan_name ?? undefined}
            actions={
              /* The word, not only the colour. */
              <Badge tone={BADGE_TONE[status.tone]}>{status.label}</Badge>
            }
          />
          <CardBody className="space-y-4">
            <p className="text-ink-muted text-[0.8125rem] leading-5">{status.detail}</p>

            {data.status !== null ? (
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.amount_minor !== null && data.currency && data.billing_interval ? (
                  <Fact label="Price">
                    <span data-numeric="" className="font-medium tabular-nums">
                      {money(data.amount_minor, data.currency, locale)}
                    </span>{' '}
                    <span className="text-ink-subtle">
                      {intervalPhrase(data.billing_interval, data.interval_count ?? 1)}
                    </span>
                  </Fact>
                ) : null}

                {data.trial_end ? (
                  <Fact label="Trial ends">
                    {formatDate(new Date(data.trial_end), {
                      locale,
                      timeZone: organization.time_zone,
                    })}
                  </Fact>
                ) : null}

                {/*
                  "Renews on" and "cancels on" are different sentences about the
                  same date, and showing the wrong one is how somebody misses a
                  cancellation they meant to withdraw.
                */}
                {data.cancel_scheduled && data.cancel_effective_at ? (
                  <Fact label="Cancels on">
                    {formatDate(new Date(data.cancel_effective_at), {
                      locale,
                      timeZone: organization.time_zone,
                    })}
                  </Fact>
                ) : data.current_period_end ? (
                  <Fact label="Renews on">
                    {formatDate(new Date(data.current_period_end), {
                      locale,
                      timeZone: organization.time_zone,
                    })}
                  </Fact>
                ) : null}

                {data.ended_at ? (
                  <Fact label="Ended">
                    {formatDate(new Date(data.ended_at), {
                      locale,
                      timeZone: organization.time_zone,
                    })}
                  </Fact>
                ) : null}

                {data.billing_email ? (
                  <Fact label="Invoices go to">{data.billing_email}</Fact>
                ) : null}

                {data.synced_at ? (
                  <Fact label="Last confirmed">
                    {formatDateTime(new Date(data.synced_at), {
                      locale,
                      timeZone: organization.time_zone,
                    })}
                  </Fact>
                ) : null}
              </dl>
            ) : null}

            {/*
              Usage as facts. Nothing here is a limit, because nothing was sold
              that limits either number.
            */}
            <dl className="border-line grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4">
              <Fact label="Active team members">
                <span data-numeric="" className="tabular-nums">
                  {data.active_members}
                </span>
              </Fact>
              <Fact label="Vehicles in service">
                <span data-numeric="" className="tabular-nums">
                  {data.active_vehicles}
                </span>
              </Fact>
              <Fact label="Access">{ACCESS_STATE_LABELS[data.access_state]}</Fact>
            </dl>

            {data.stripe_configured ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  isLoading={reconcile.isPending}
                  onClick={() =>
                    reconcile.mutate(undefined, {
                      onSuccess: () => toast.success('Billing refreshed'),
                      onError: (error) => toast.error('Could not refresh billing', error.message),
                    })
                  }
                >
                  Refresh billing status
                </Button>
                <span className="text-ink-subtle text-[0.75rem]">
                  Reads your subscription again from our payment provider.
                </span>
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {/* Plan selection, only when there is genuinely something to choose. */}
      {canChoosePlan(data) ? (
        <Card>
          <CardHeader
            title="Choose a plan"
            description={`Payment is handled by our payment provider. ${getAppName()} never sees your card.`}
          />
          <CardBody>
            {plans.isError ? (
              <ErrorState
                error={plans.error}
                title="Plans could not be loaded"
                onRetry={() => void plans.refetch()}
              />
            ) : plans.isPending ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : plans.data.length === 0 ? (
              <p className="text-ink-muted text-[0.8125rem]">
                No plans are available for this deployment yet.
              </p>
            ) : (
              <ul
                className={cn(
                  'grid grid-cols-1 gap-3',
                  plans.data.length > 1 ? 'sm:grid-cols-2' : 'sm:max-w-md',
                )}
              >
                {plans.data.map((plan) => (
                  <PlanCard
                    key={plan.plan_key}
                    plan={plan}
                    locale={locale}
                    isBusy={checkout.isPending && chosen === plan.plan_key}
                    onChoose={choose}
                  />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ) : null}

      {/* Recent billing activity. Concise: Stripe holds the invoices. */}
      {data.stripe_configured && history.data && history.data.length > 0 ? (
        <Card>
          <CardHeader
            title="Recent billing activity"
            description="Invoices and receipts are available through Manage billing."
          />
          <CardBody className="p-0">
            <ul className="divide-line divide-y">
              {history.data.map((event, index) => (
                <li key={`${event.occurred_at}-${index}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <p className="text-[0.8125rem] font-medium">{EVENT_KIND_LABELS[event.kind]}</p>
                    <span className="text-ink-subtle text-[0.75rem]">
                      {formatDateTime(new Date(event.occurred_at), {
                        locale,
                        timeZone: organization.time_zone,
                      })}
                    </span>
                  </div>
                  <p className="text-ink-subtle mt-0.5 text-[0.75rem] leading-4">{event.summary}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {/*
        A configuration problem the server reported, and only one that is worth an
        owner's attention: a deployment with no Stripe account is the ordinary
        free build and is already explained above. This line is for the case where
        Stripe IS configured and something about it is wrong.
      */}
      {!isShowcase && platform.data?.state === 'billing_not_configured' && platform.data.message ? (
        <p className="text-ink-subtle text-[0.75rem]">{platform.data.message}</p>
      ) : null}
    </div>
  )
}
