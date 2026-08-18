import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'

import { OverviewMock } from './ProductMocks'
import { PrimaryCta } from './PrimaryCta'

const CAPABILITIES = ['Fleet', 'Rentals', 'Contracts', 'Payments', 'Reports', 'Team']

export function Hero() {
  return (
    <section className="mx-auto max-w-[1220px] px-4 pt-14 pb-10 sm:px-6 sm:pt-16 sm:pb-14 lg:px-8">
      <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] lg:gap-12">
        <div>
          <p className="text-ink-subtle text-[0.75rem] font-semibold tracking-[0.08em] uppercase">
            Car rental management
          </p>
          <h1 className="text-ink mt-3 text-[2.25rem] leading-[1.1] font-semibold tracking-tight sm:text-[2.75rem] lg:text-[3.25rem]">
            Run your entire rental business from one place.
          </h1>
          <p className="text-ink-muted mt-5 max-w-xl text-base leading-7 sm:text-lg lg:text-[1.1875rem] lg:leading-8">
            Manage your fleet, rentals, contracts, customers, payments, expenses and day-to-day
            operations from one connected workspace.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <PrimaryCta className="font-semibold" />
            <Link
              to={paths.signIn}
              className="border-line-strong text-ink hover:bg-surface-inset flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors sm:h-auto sm:border-none sm:px-2 sm:hover:bg-transparent sm:hover:underline"
            >
              Sign in
            </Link>
          </div>

          <p className="text-ink-subtle mt-7 text-[0.8125rem] font-medium tracking-wide">
            {CAPABILITIES.join('  ·  ')}
          </p>
        </div>

        <div>
          <OverviewMock />
        </div>
      </div>
    </section>
  )
}
