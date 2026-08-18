import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'

import { PrimaryCta } from './PrimaryCta'

export function FinalCta() {
  return (
    <section className="bg-brand-900">
      <div className="mx-auto max-w-[1220px] px-4 py-20 text-center sm:px-6 sm:py-24 lg:px-8">
        <p className="text-brand-200 text-[0.75rem] font-semibold tracking-[0.08em] uppercase">
          Get started
        </p>
        <h2 className="text-ink-inverse mx-auto mt-3 max-w-xl text-[1.875rem] font-semibold tracking-tight sm:text-[2.25rem]">
          Ready to run your rental business from one place?
        </h2>
        <p className="text-brand-100 mx-auto mt-4 max-w-md text-[0.9375rem] leading-6">
          Every module included from the first day — fleet, rentals, payments and reporting, all in
          one workspace.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <PrimaryCta variant="secondary" className="font-semibold" />
          <Link
            to={paths.signIn}
            className="text-brand-100 hover:text-ink-inverse text-sm font-medium transition-colors hover:underline"
          >
            Sign in
          </Link>
        </div>
      </div>
    </section>
  )
}
