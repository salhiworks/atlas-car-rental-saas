import { Check } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'

import { cn } from '@/lib/utils/cn'

import { FleetMock, OperationsMock, RentalsMock, ReportsMock } from './ProductMocks'

interface Story {
  eyebrow: string
  heading: string
  body: string
  points: readonly string[]
  visual: ComponentType
  reverse?: boolean
}

const STORIES: readonly Story[] = [
  {
    eyebrow: 'Rentals & contracts',
    heading: 'From reservation to return, every rental stays connected.',
    body: 'A rental moves through one lifecycle — reservation, contract, pickup, active hire, return — and every stage is one screen, not a spreadsheet stitched to a filing cabinet.',
    points: [
      'Reservations and rental contracts',
      'Driver and customer context on every booking',
      'Payments and deposits, tracked separately',
      'Pickup and return, with contract PDFs',
    ],
    visual: RentalsMock,
  },
  {
    eyebrow: 'Fleet & scheduling',
    heading: "Know what's available before you promise it.",
    body: 'The fleet, the calendar and the booking screen all read the same availability, so a car that is already promised never gets offered twice.',
    points: [
      'Fleet status at a glance',
      'Calendar view of every booking',
      'Occupancy for the whole fleet, not vehicle by vehicle',
      'Upcoming pickups, returns and compliance dates',
    ],
    visual: FleetMock,
    reverse: true,
  },
  {
    eyebrow: 'Business performance',
    heading: 'Understand what the fleet is actually doing financially.',
    body: "Revenue, expenses and financing stay in one ledger, so the agency can see its operating result and each vehicle's economics without exporting anything.",
    points: [
      'Revenue and expenses by period',
      'Operating result, not a guess',
      'Per-vehicle economics and financing',
      'Reports and outstanding balances',
    ],
    visual: ReportsMock,
  },
  {
    eyebrow: 'Agency operations',
    heading: 'Keep the agency working from one system.',
    body: "Customers, the team and the fleet's live position share one workspace, with roles that match who actually does the work.",
    points: [
      'Customers and drivers, with identification on file',
      'Team members with roles that match their job',
      'GPS tracking, when a provider is connected',
      'Notifications and reminders for what needs attention',
    ],
    visual: OperationsMock,
    reverse: true,
  },
]

function StoryRow({ story }: { story: Story }) {
  const Visual = story.visual

  return (
    <div
      className={cn(
        'grid items-center gap-10 py-14 sm:py-16 lg:grid-cols-2 lg:gap-16',
        story.reverse && 'lg:[&>*:first-child]:order-2',
      )}
    >
      <div>
        <p className="text-ink-subtle text-[0.75rem] font-semibold tracking-[0.08em] uppercase">
          {story.eyebrow}
        </p>
        <h2 className="text-ink mt-2.5 text-[1.75rem] leading-tight font-semibold tracking-tight sm:text-2xl lg:text-[2rem]">
          {story.heading}
        </h2>
        <p className="text-ink-muted mt-4 max-w-lg text-base leading-7">{story.body}</p>
        <ul className="mt-6 space-y-2.5">
          {story.points.map((point) => (
            <li key={point} className="flex items-start gap-2.5 text-[0.875rem]">
              <Check className="text-brand-600 mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="text-ink">{point}</span>
            </li>
          ))}
        </ul>
      </div>
      <Visual />
    </div>
  )
}

export function StorySections(): ReactNode {
  return (
    <>
      {STORIES.map((story, index) => (
        <section
          key={story.heading}
          id={index === 0 ? 'operations' : index === 2 ? 'insights' : undefined}
          className={cn(
            'border-line scroll-mt-20 border-t',
            index % 2 === 1 && 'bg-canvas-sunken/70',
          )}
        >
          <div className="mx-auto max-w-[1220px] px-4 sm:px-6 lg:px-8">
            <StoryRow story={story} />
          </div>
        </section>
      ))}
    </>
  )
}
