import { ArrowUpRight } from 'lucide-react'

import { Card, CardBody, CardHeader } from '@/components/ui'
import { PRODUCT_BRAND } from '@/lib/config/brand'
import { getAppName } from '@/lib/config/env'

/**
 * What this software is, which build it is, and who wrote it.
 *
 * The one screen inside the product where the publisher is named at length, and
 * it is deliberately here rather than in the chrome: somebody who wants to know
 * what they are running will look in Settings, and everybody else runs their
 * agency without being reminded whose software it is.
 *
 * Nothing on this page is about the agency. The agency's own identity — its
 * name, logo, address and contract wording — lives in the sections above, and
 * that separation is the whole point: this says who made the tool, those say who
 * the business is, and only the latter reaches a renter.
 */
export function AboutSection() {
  const appName = getAppName()
  const isRenamed = appName !== PRODUCT_BRAND.name

  return (
    <Card>
      <CardHeader
        title={`About ${appName}`}
        description="What this software is, and which build you are running."
      />
      <CardBody>
        <dl className="divide-line divide-y">
          <Row label="Product">
            {/*
              A deployment may rename the running application. When it has, both
              names are shown: hiding the original would make the version number
              below unmatchable to anything.
            */}
            <span className="text-ink font-medium">
              {isRenamed ? `${appName} (${PRODUCT_BRAND.fullName})` : PRODUCT_BRAND.fullName}
            </span>
          </Row>

          <Row label="Version">
            <span data-numeric="" className="identifier text-ink">
              {__APP_VERSION__}
            </span>
          </Row>

          <Row label="Created by">
            <a
              href={PRODUCT_BRAND.creatorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-700 hover:text-brand-600 inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              {PRODUCT_BRAND.creator}
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </a>
          </Row>
        </dl>

        <p className="text-ink-subtle border-line mt-5 border-t pt-4 text-[0.75rem] leading-5">
          Free to use, with every module unlocked. Your agency&rsquo;s records, documents and
          contracts are yours — {PRODUCT_BRAND.creator} has no access to them and does not appear on
          anything you issue to a customer.
        </p>
      </CardBody>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
      <dt className="text-ink-muted text-[0.8125rem]">{label}</dt>
      <dd className="min-w-0 text-[0.8125rem]">{children}</dd>
    </div>
  )
}
