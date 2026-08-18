import { Building2, CalendarClock, Scale, ShieldCheck, UserCheck, Wallet } from 'lucide-react'
import type { ComponentType } from 'react'

const POINTS: {
  title: string
  body: string
  icon: ComponentType<{ className?: string }>
}[] = [
  {
    title: 'Availability is protected, not promised',
    body: "A vehicle can't be booked twice for overlapping dates — the scheduling itself refuses it, not a rule someone has to remember to check.",
    icon: ShieldCheck,
  },
  {
    title: 'Reservation to return, as one lifecycle',
    body: 'Every rental moves through the same stages in order, so the contract, the pickup and the return are always the same record, not three.',
    icon: CalendarClock,
  },
  {
    title: 'Renter and driver are kept distinct',
    body: 'The person who signs and pays is not assumed to be the person driving — because on a lot of contracts, they are not the same person.',
    icon: UserCheck,
  },
  {
    title: 'Deposits separated from rental revenue',
    body: "A deposit is not income the moment it's collected, and the books reflect that from the start.",
    icon: Wallet,
  },
  {
    title: 'Vehicle costs kept apart from financing',
    body: 'What a vehicle costs to run and what it costs to own are two different figures — mixing them hides which one is the actual problem.',
    icon: Scale,
  },
  {
    title: 'One agency, one workspace, kept apart from every other',
    body: "Every team member's role and every record they touch stays inside their own agency, automatically.",
    icon: Building2,
  },
]

export function Differentiation() {
  return (
    <section className="border-line border-t">
      <div className="mx-auto max-w-[1220px] px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-ink-subtle text-[0.75rem] font-semibold tracking-[0.08em] uppercase">
            Built for rental operations
          </p>
          <h2 className="text-ink mt-3 text-[1.875rem] font-semibold tracking-tight sm:text-[2.25rem]">
            Built for rental operations. Not adapted from a generic CRM.
          </h2>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((point) => (
            <div key={point.title}>
              <point.icon className="text-brand-600 size-5.5" aria-hidden="true" />
              <h3 className="text-ink mt-3 text-base font-semibold">{point.title}</h3>
              <p className="text-ink-muted mt-2 text-[0.8125rem] leading-6">{point.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
