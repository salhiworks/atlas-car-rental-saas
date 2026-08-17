import type { ReactNode } from 'react'

import { Wordmark } from '@/components/brand/Wordmark'
import { PRODUCT_BRAND } from '@/lib/config/brand'

export interface AuthLayoutProps {
  title: string
  description?: ReactNode
  children: ReactNode
  /** Secondary line beneath the card: "Already have an account?" and similar. */
  footer?: ReactNode
}

/**
 * Frame for every unauthenticated screen.
 *
 * The brand panel is typographic only. A screenshot of a dashboard here would
 * have to be invented, and inventing an interface to sell the interface is the
 * kind of thing that makes a product feel like a template.
 */
export function AuthLayout({ title, description, children, footer }: AuthLayoutProps) {
  return (
    <div className="bg-canvas min-h-dvh lg:grid lg:grid-cols-[minmax(0,44%)_minmax(0,56%)]">
      <aside className="bg-brand-900 hidden flex-col justify-between p-10 lg:flex">
        <Wordmark tone="inverse" />

        <div className="max-w-md">
          <p className="text-brand-200 eyebrow">Fleet rental management</p>
          <h2 className="text-ink-inverse mt-3 text-2xl leading-9 font-semibold tracking-tight">
            Every vehicle, contract and payment in one place.
          </h2>
          <p className="text-brand-100 mt-4 text-[0.875rem] leading-6">
            Track availability, sign contracts, record payments and watch the numbers that decide
            whether the fleet is earning.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-brand-200 text-[0.75rem]">
            Your agency's data is isolated from every other agency on the platform.
          </p>
          {/*
            The publisher credit, and the only place before signing in that names
            anybody but the product. It belongs to the software, not to the
            agency about to use it — which is why it lives here and never on
            anything the agency issues.
          */}
          <p className="text-brand-200/80 text-[0.75rem]">
            {PRODUCT_BRAND.fullName} ·{' '}
            <a
              href={PRODUCT_BRAND.creatorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-ink-inverse underline underline-offset-2 transition-colors"
            >
              {PRODUCT_BRAND.attribution}
            </a>
          </p>
        </div>
      </aside>

      <main className="flex min-h-dvh flex-col justify-center px-4 py-10 sm:px-6 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="lg:hidden">
            <Wordmark />
          </div>

          <div className="mt-8 lg:mt-0">
            <h1 className="text-xl leading-7 font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="text-ink-muted mt-1.5 text-[0.8125rem] leading-5">{description}</p>
            ) : null}
          </div>

          <div className="mt-6">{children}</div>

          {footer ? (
            <div className="text-ink-muted mt-6 text-center text-[0.8125rem]">{footer}</div>
          ) : null}

          {/* Below `lg` the brand panel is not rendered, so the credit appears
              once here instead of not at all. */}
          <p className="text-ink-subtle mt-8 text-center text-[0.75rem] lg:hidden">
            {PRODUCT_BRAND.fullName} ·{' '}
            <a
              href={PRODUCT_BRAND.creatorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-ink underline underline-offset-2 transition-colors"
            >
              {PRODUCT_BRAND.attribution}
            </a>
          </p>
        </div>
      </main>
    </div>
  )
}
