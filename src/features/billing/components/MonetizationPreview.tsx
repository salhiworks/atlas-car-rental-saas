import { ArrowRight, Check, Sparkles } from 'lucide-react'
import { useId, useState } from 'react'

import { Badge, Card, CardBody, CardHeader } from '@/components/ui'
import { PRODUCT_BRAND } from '@/lib/config/brand'
import { getAppName } from '@/lib/config/env'
import { getStripeGuideUrl } from '@/lib/config/help-links'
import { cn } from '@/lib/utils/cn'

import {
  exampleIntervalPhrase,
  formatExampleAmount,
  MONETIZATION_EXAMPLES,
  type ExampleInterval,
} from '../monetizationExamples'

/**
 * What Billing shows when no payment account is connected.
 *
 * This build is complete and unlocked, and the honest reason is not that somebody
 * was given a free subscription — it is that subscription enforcement has not
 * been switched on, because no payment account is connected. So the page says
 * that plainly, and then does something more useful than reporting a
 * configuration state: it shows the person who owns this software how they could
 * sell it.
 *
 * EVERYTHING BELOW IS AN ILLUSTRATION. The prices are not Stripe prices, the
 * packaging is not enforced, and no button here can start a payment. See
 * ../monetizationExamples.ts for why the two catalogues can never be confused.
 *
 * It is deliberately not a landing page. No hero, no gradient, no countdown, no
 * "most popular" — this is an administration workspace, and the reader is an
 * owner deciding something, not a visitor being sold to.
 */
export function MonetizationPreview({ locale }: { locale: string }) {
  const [interval, setInterval] = useState<ExampleInterval>('monthly')
  const groupId = useId()
  const guideUrl = getStripeGuideUrl()

  return (
    <>
      {/*
        The status, stated once, calmly.

        Deliberately not an Alert: `tone="warning"` would make an intended product
        mode look like something the reader must fix. This is a Card with a quiet
        brand accent, which is what "everything is fine and here is why" looks
        like.
      */}
      <Card>
        <CardBody className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <span
            aria-hidden="true"
            className="bg-brand-50 text-brand-700 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md"
          >
            <Sparkles className="size-4" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-[0.9375rem] font-semibold">Free build</h2>
              {/* The word, not only the colour. */}
              <Badge tone="positive">All features unlocked</Badge>
            </div>
            <p className="text-ink-muted mt-1 max-w-[68ch] text-[0.8125rem] leading-5">
              This version of {getAppName()} is fully unlocked. No subscription or payment is
              required, and every module stays available to your team.
            </p>
            <p className="text-ink-subtle mt-1.5 max-w-[68ch] text-[0.75rem] leading-4">
              The plans below are example pricing you can customize if you want to sell{' '}
              {getAppName()} to rental agencies.
            </p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Example pricing"
          description="Suggested pricing you can customize when you connect your own payment account. Nothing here is charged."
          actions={
            /*
             * A radiogroup rather than two buttons: it is a choice between two
             * options, one of which is always selected, and a screen reader
             * should hear it that way. `aria-checked` carries the state, so the
             * selection is never conveyed by colour alone.
             */
            <div
              role="radiogroup"
              aria-label="Example billing interval"
              className="border-line flex shrink-0 rounded-md border p-0.5"
            >
              {(['monthly', 'yearly'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  id={`${groupId}-${option}`}
                  aria-checked={interval === option}
                  onClick={() => setInterval(option)}
                  className={cn(
                    'rounded-[5px] px-3 py-1 text-[0.8125rem] transition-colors outline-none',
                    'focus-visible:ring-brand-500 focus-visible:ring-2',
                    interval === option
                      ? 'bg-surface-inset text-ink font-medium'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {option === 'monthly' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>
          }
        />
        <CardBody>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MONETIZATION_EXAMPLES.map((plan) => (
              <li
                key={plan.id}
                className={cn(
                  'flex min-w-0 flex-col rounded-lg border p-4',
                  plan.isSuggested ? 'border-brand-300 bg-brand-50/30' : 'border-line',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-[0.875rem] font-semibold">{plan.name}</h3>
                    <p className="text-ink-subtle mt-0.5 text-[0.75rem] leading-4">
                      {plan.audience}
                    </p>
                  </div>
                  {plan.isSuggested ? <Badge tone="brand">Suggested</Badge> : null}
                </div>

                <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5">
                  <span
                    data-numeric=""
                    className="text-[1.375rem] leading-7 font-semibold tabular-nums"
                  >
                    {formatExampleAmount(plan, interval, locale)}
                  </span>
                  <span className="text-ink-subtle text-[0.75rem]">
                    {exampleIntervalPhrase(interval)}
                  </span>
                </p>
                {/*
                  The one place a card mentions it: enough that no reader can
                  mistake the number for a charge, not so often that the page
                  reads as a disclaimer.
                */}
                <p className="text-ink-subtle mt-1 text-[0.6875rem]">Example price</p>

                <ul className="mt-3 space-y-1.5">
                  {plan.includes.map((item) => (
                    <li key={item} className="flex items-start gap-1.5">
                      <Check
                        aria-hidden="true"
                        className="text-brand-600 mt-0.5 size-3.5 shrink-0"
                      />
                      <span className="text-ink-muted text-[0.75rem] leading-4">{item}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          <p className="text-ink-subtle mt-4 text-[0.75rem] leading-4">
            These packages are suggestions. Nothing is restricted in this build — every module is
            available to your team according to their role.
          </p>
          <p className="text-ink-subtle mt-1.5 text-[0.75rem] leading-4">
            Your Stripe secret keys stay server-side and are never exposed in the browser.
          </p>
        </CardBody>
      </Card>

      {/*
        The conclusion of the page: the one thing to do next.

        Deliberately short. The previous version explained Checkout, the Portal
        and webhook synchronisation here, which is true but is documentation — and
        this position in the page is for a decision, not a reference. The guide has
        room for the detail.
      */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1 basis-[22rem]">
            <h2 className="text-[0.9375rem] font-semibold">Ready to monetize it?</h2>
            <p className="text-ink-muted mt-1 max-w-[60ch] text-[0.8125rem] leading-5">
              Connect your own Stripe account and turn your pricing into real recurring
              subscriptions.
            </p>
            <p className="text-ink-subtle mt-1.5 max-w-[60ch] text-[0.75rem] leading-4">
              The billing infrastructure is already prepared. Follow the guide to connect Stripe,
              create your plans, and activate subscriptions.
            </p>
            {/*
              The one page where naming the publisher is the point rather than a
              credit: it explains that this software was given away, and the
              guide it links to is theirs. Said once, in a sentence, and not
              repeated anywhere an agency's own customers can see.
            */}
            <p className="text-ink-subtle mt-1.5 max-w-[60ch] text-[0.75rem] leading-4">
              {getAppName()} is free software by{' '}
              <a
                href={PRODUCT_BRAND.creatorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-700 hover:text-brand-600 underline underline-offset-2"
              >
                {PRODUCT_BRAND.creator}
              </a>
              , who also wrote the guide.
            </p>
          </div>

          {/*
            An external guide, opened in its own tab so the product stays where it is
            while somebody follows a video. `noopener` as well as `noreferrer`:
            a new tab must not get a handle back on this one.
          */}
          <a
            href={guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'bg-brand-600 hover:bg-brand-700 inline-flex min-h-9 shrink-0 items-center gap-1.5',
              'rounded-md px-3.5 text-[0.8125rem] font-medium text-white transition-colors',
              'outline-none focus-visible:ring-brand-500 focus-visible:ring-2 focus-visible:ring-offset-2',
            )}
          >
            Set up Stripe subscriptions
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </a>
        </CardBody>
      </Card>
    </>
  )
}
