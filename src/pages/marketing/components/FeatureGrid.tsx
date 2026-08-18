import {
  Banknote,
  Bell,
  CalendarRange,
  CarFront,
  CreditCard,
  FileSignature,
  Landmark,
  MapPinned,
  Settings,
  TrendingUp,
  Users,
  UsersRound,
} from 'lucide-react'
import type { ComponentType } from 'react'

const MODULES: {
  label: string
  description: string
  icon: ComponentType<{ className?: string }>
}[] = [
  { label: 'Rentals & contracts', description: 'Reservation through return.', icon: FileSignature },
  { label: 'Calendar', description: 'Every booking, at a glance.', icon: CalendarRange },
  { label: 'Vehicles / Fleet', description: 'Status, documents, condition.', icon: CarFront },
  { label: 'Customers & drivers', description: 'Identification kept on file.', icon: Users },
  { label: 'Payments', description: 'Rental revenue and deposits.', icon: CreditCard },
  { label: 'Expenses', description: 'Fleet running costs.', icon: Banknote },
  { label: 'Vehicle financing', description: 'Agreements and lender payments.', icon: Landmark },
  { label: 'Reports', description: 'Operating result, by vehicle.', icon: TrendingUp },
  {
    label: 'GPS tracking',
    description: 'When a tracking provider is connected.',
    icon: MapPinned,
  },
  { label: 'Team management', description: 'Roles matched to the job.', icon: UsersRound },
  { label: 'Notifications & reminders', description: 'What needs attention.', icon: Bell },
  { label: 'Agency settings', description: 'Branding and contract terms.', icon: Settings },
]

export function FeatureGrid() {
  return (
    <section id="features" className="border-line scroll-mt-20 border-t">
      <div className="mx-auto max-w-[1220px] px-4 py-14 sm:px-6 sm:py-18 lg:px-8">
        <div className="max-w-xl">
          <p className="text-ink-subtle text-[0.75rem] font-semibold tracking-[0.08em] uppercase">
            Everything included
          </p>
          <h2 className="text-ink mt-2.5 text-[1.75rem] font-semibold tracking-tight sm:text-2xl lg:text-[2rem]">
            Every module, in one workspace.
          </h2>
          <p className="text-ink-muted mt-3 text-base leading-7">
            Nothing here is locked behind a separate add-on to buy later.
          </p>
        </div>

        <ul className="border-line bg-line mt-8 grid grid-cols-1 gap-px overflow-hidden rounded-lg border sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map(({ label, description, icon: Icon }) => (
            <li key={label} className="bg-surface flex items-start gap-3.5 p-5">
              <span className="bg-brand-50 text-brand-700 flex size-10 shrink-0 items-center justify-center rounded-md">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-ink text-[0.9375rem] font-semibold">{label}</p>
                <p className="text-ink-muted mt-0.5 text-[0.8125rem] leading-5">{description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
