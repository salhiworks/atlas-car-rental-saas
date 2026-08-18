import {
  CalendarRange,
  CarFront,
  FileSignature,
  LayoutDashboard,
  MapPinned,
  TrendingUp,
  UsersRound,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Fragment } from 'react'

import { Badge, type BadgeTone } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

/**
 * A composed illustration of the real Atlas interface — not a screenshot.
 *
 * Built from the same tokens and primitives (Card surface, hairline borders,
 * Badge tones, the actual navigation icon set) as the authenticated product,
 * with clearly fictional sample content. No production data, no customer PII,
 * and nothing here is a live view: it exists only to show what the shipped
 * screens look like without shipping a demo backend.
 */
const PREVIEW_NAV_ICONS = [
  LayoutDashboard,
  FileSignature,
  CarFront,
  CalendarRange,
  TrendingUp,
  UsersRound,
] as const

export function AppPreviewFrame({
  children,
  label,
  activeIcon = 0,
  className,
}: {
  children: ReactNode
  /** Describes what this illustration shows — read by assistive tech in place of its (purely decorative) content. */
  label: string
  activeIcon?: number
  className?: string
}) {
  return (
    <div
      className={cn(
        'bg-surface border-line shadow-overlay flex overflow-hidden rounded-xl border',
        className,
      )}
      role="img"
      aria-label={label}
    >
      <div
        className="bg-canvas border-line hidden w-14 shrink-0 flex-col items-center gap-3 border-e py-4 sm:flex"
        aria-hidden="true"
      >
        <span className="bg-brand-700 mb-2 size-6 rounded-md" />
        {PREVIEW_NAV_ICONS.map((Icon, index) => (
          <span
            key={index}
            className={cn(
              'flex size-8 items-center justify-center rounded-md',
              index === activeIcon ? 'bg-brand-50 text-brand-700' : 'text-ink-subtle',
            )}
          >
            <Icon className="size-4" />
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 p-5 sm:p-6">{children}</div>
    </div>
  )
}

function MetricTile({
  label,
  value,
  delta,
  tone,
}: {
  label: string
  value: string
  delta?: string
  tone?: 'positive'
}) {
  return (
    <div className="border-line rounded-lg border px-3.5 py-3">
      <p className="text-ink-subtle text-[0.6875rem] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-lg leading-6 font-semibold tabular-nums',
          tone === 'positive' ? 'text-positive-700' : 'text-ink',
        )}
      >
        {value}
      </p>
      {delta ? <p className="text-positive-700 mt-0.5 text-[0.6875rem]">{delta}</p> : null}
    </div>
  )
}

const FLEET_STATUS = [
  { vehicle: 'Toyota Corolla', state: 'Available', tone: 'positive' as BadgeTone },
  { vehicle: 'Ford Transit', state: 'Rented', tone: 'info' as BadgeTone },
  { vehicle: 'Hyundai Tucson', state: 'Available', tone: 'positive' as BadgeTone },
]

export function OverviewMock() {
  return (
    <AppPreviewFrame
      label="Illustration of the Atlas Overview dashboard, showing this month's revenue, active rentals, fleet utilization, fleet status and today's scheduled pickups and returns"
      activeIcon={0}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-ink text-[0.9375rem] font-semibold">Overview</p>
          <p className="text-ink-subtle text-[0.75rem]">How Northgate Rentals is running</p>
        </div>
        <span className="border-line-strong text-ink-muted hidden rounded-md border px-2.5 py-1 text-[0.6875rem] font-medium sm:inline-block">
          This month
        </span>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-2.5">
        <MetricTile label="Revenue" value="$18,240" delta="+12% vs last month" />
        <MetricTile label="Active rentals" value="12" />
        <MetricTile label="Fleet utilization" value="78%" />
      </div>

      <div className="border-line mt-4 rounded-lg border">
        <p className="border-line text-ink border-b px-3.5 py-2.5 text-[0.75rem] font-semibold">
          Fleet status
        </p>
        <div className="flex flex-wrap gap-2 p-3.5">
          {FLEET_STATUS.map((row) => (
            <Badge key={row.vehicle} tone={row.tone} withDot>
              {row.vehicle} · {row.state}
            </Badge>
          ))}
        </div>
      </div>

      <div className="border-line mt-4 rounded-lg border">
        <p className="border-line text-ink border-b px-3.5 py-2.5 text-[0.75rem] font-semibold">
          Today
        </p>
        <ul className="divide-line divide-y">
          <li className="flex items-center justify-between px-3.5 py-2.5 text-[0.75rem]">
            <span className="text-ink-muted">Pickup · Toyota Corolla · SN-2201</span>
            <span className="text-ink-subtle">9:00 AM</span>
          </li>
          <li className="flex items-center justify-between px-3.5 py-2.5 text-[0.75rem]">
            <span className="text-ink-muted">Return · Ford Transit · SN-1187</span>
            <span className="text-ink-subtle">2:30 PM</span>
          </li>
          <li className="flex items-center justify-between px-3.5 py-2.5 text-[0.75rem]">
            <span className="text-ink-muted">Reservation confirmed · Hyundai Tucson</span>
            <span className="text-ink-subtle">Just now</span>
          </li>
        </ul>
      </div>
    </AppPreviewFrame>
  )
}

const RENTAL_ROWS: {
  contract: string
  customer: string
  vehicle: string
  status: string
  tone: BadgeTone
}[] = [
  {
    contract: 'RNT-2026-0142',
    customer: 'Amara Diallo',
    vehicle: 'Hyundai Tucson',
    status: 'Active',
    tone: 'positive',
  },
  {
    contract: 'RNT-2026-0141',
    customer: 'Liam Foster',
    vehicle: 'Toyota Corolla',
    status: 'Reserved',
    tone: 'info',
  },
  {
    contract: 'RNT-2026-0140',
    customer: 'Priya Nair',
    vehicle: 'Ford Transit',
    status: 'Completed',
    tone: 'neutral',
  },
]

const LIFECYCLE_STAGES = ['Reservation', 'Contract', 'Pickup', 'Active', 'Return']
const LIFECYCLE_ACTIVE_INDEX = 3

export function RentalsMock() {
  return (
    <AppPreviewFrame
      label="Illustration of the Atlas Rentals list, showing the reservation-to-return lifecycle and contracts with their customer, vehicle and status"
      activeIcon={1}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-ink text-[0.9375rem] font-semibold">Rentals</p>
        <span className="bg-brand-700 text-ink-inverse rounded-md px-2.5 py-1 text-[0.6875rem] font-medium">
          New rental
        </span>
      </div>

      <div className="border-line mt-4 flex items-center rounded-lg border px-3.5 py-3">
        {LIFECYCLE_STAGES.map((stage, index) => (
          <Fragment key={stage}>
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={cn(
                  'size-2.5 rounded-full',
                  index <= LIFECYCLE_ACTIVE_INDEX ? 'bg-brand-600' : 'bg-line-strong',
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  'text-[0.625rem] font-medium whitespace-nowrap',
                  index <= LIFECYCLE_ACTIVE_INDEX ? 'text-ink' : 'text-ink-subtle',
                )}
              >
                {stage}
              </span>
            </div>
            {index < LIFECYCLE_STAGES.length - 1 ? (
              <span
                className={cn(
                  'mx-1.5 h-px flex-1',
                  index < LIFECYCLE_ACTIVE_INDEX ? 'bg-brand-600' : 'bg-line-strong',
                )}
                aria-hidden="true"
              />
            ) : null}
          </Fragment>
        ))}
      </div>

      <div className="border-line mt-4 divide-y overflow-hidden rounded-lg border">
        {RENTAL_ROWS.map((row) => (
          <div
            key={row.contract}
            className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-3"
          >
            <div className="min-w-0">
              <p className="identifier text-ink text-[0.75rem]">{row.contract}</p>
              <p className="text-ink-muted text-[0.75rem]">
                {row.customer} · {row.vehicle}
              </p>
            </div>
            <Badge tone={row.tone} withDot>
              {row.status}
            </Badge>
          </div>
        ))}
      </div>
    </AppPreviewFrame>
  )
}

const FLEET_ROWS = [
  { vehicle: 'Toyota Corolla', start: 15, width: 42, tone: 'bg-brand-500' },
  { vehicle: 'Ford Transit', start: 40, width: 25, tone: 'bg-info-600' },
  { vehicle: 'Hyundai Tucson', start: 10, width: 50, tone: 'bg-caution-600' },
  { vehicle: 'Kia Sportage', start: 55, width: 30, tone: 'bg-brand-500' },
] as const

export function FleetMock() {
  return (
    <AppPreviewFrame
      label="Illustration of the Atlas Calendar, showing which vehicles are booked and which are available across the week"
      activeIcon={3}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-ink text-[0.9375rem] font-semibold">Calendar</p>
        <span className="border-line-strong text-ink-muted rounded-md border px-2.5 py-1 text-[0.6875rem] font-medium">
          3 vehicles available today
        </span>
      </div>

      <div className="border-line mt-4 space-y-3.5 rounded-lg border p-3.5">
        {FLEET_ROWS.map((row) => (
          <div key={row.vehicle} className="flex items-center gap-3">
            <span className="text-ink-muted w-24 shrink-0 truncate text-[0.75rem]">
              {row.vehicle}
            </span>
            <span className="bg-surface-inset relative h-3.5 flex-1 overflow-hidden rounded-full">
              <span
                className={cn('absolute inset-y-0 rounded-full', row.tone)}
                style={{ insetInlineStart: `${row.start}%`, width: `${row.width}%` }}
              />
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-4">
        <span className="text-ink-muted flex items-center gap-1.5 text-[0.6875rem]">
          <span className="bg-brand-500 size-2 rounded-full" />
          Booked
        </span>
        <span className="text-ink-muted flex items-center gap-1.5 text-[0.6875rem]">
          <span className="bg-surface-inset border-line-strong size-2 rounded-full border" />
          Available
        </span>
      </div>
    </AppPreviewFrame>
  )
}

const REPORT_BARS = [
  { label: 'May', revenue: 55, expenses: 30 },
  { label: 'Jun', revenue: 68, expenses: 34 },
  { label: 'Jul', revenue: 74, expenses: 38 },
  { label: 'Aug', revenue: 82, expenses: 36 },
]

export function ReportsMock() {
  return (
    <AppPreviewFrame
      label="Illustration of the Atlas Reports page, showing revenue, expenses, the operating result and monthly performance"
      activeIcon={4}
    >
      <p className="text-ink text-[0.9375rem] font-semibold">Reports</p>

      <div className="mt-4 grid grid-cols-3 gap-2.5">
        <MetricTile label="Revenue" value="$82,140" />
        <MetricTile label="Expenses" value="$36,920" />
        <MetricTile label="Operating result" value="$45,220" tone="positive" />
      </div>

      <div className="border-line mt-4 rounded-lg border p-3.5">
        <div className="flex h-28 items-end gap-4 sm:gap-6">
          {REPORT_BARS.map((bar) => (
            <div key={bar.label} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-20 w-full items-end gap-0.5">
                <span
                  className="w-1/2 rounded-t-sm"
                  style={{
                    height: `${bar.revenue}%`,
                    backgroundColor: 'var(--color-chart-revenue)',
                  }}
                />
                <span
                  className="w-1/2 rounded-t-sm"
                  style={{
                    height: `${bar.expenses}%`,
                    backgroundColor: 'var(--color-chart-expenses)',
                  }}
                />
              </div>
              <span className="text-ink-subtle text-[0.6875rem]">{bar.label}</span>
            </div>
          ))}
        </div>

        <div className="border-line mt-3 flex items-center gap-4 border-t pt-3">
          <span className="text-ink-muted flex items-center gap-1.5 text-[0.6875rem]">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: 'var(--color-chart-revenue)' }}
            />
            Revenue
          </span>
          <span className="text-ink-muted flex items-center gap-1.5 text-[0.6875rem]">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: 'var(--color-chart-expenses)' }}
            />
            Expenses
          </span>
        </div>
      </div>
    </AppPreviewFrame>
  )
}

const TEAM_ROWS = [
  { name: 'Amara Diallo', role: 'Owner' },
  { name: 'Liam Foster', role: 'Manager' },
  { name: 'Priya Nair', role: 'Staff' },
]

export function OperationsMock() {
  return (
    <AppPreviewFrame
      label="Illustration of the Atlas Team page, showing team members and their roles, customers on file, GPS tracking connection status and a compliance reminder"
      activeIcon={5}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-ink text-[0.9375rem] font-semibold">Team</p>
        <span className="text-ink-subtle text-[0.75rem]">24 customers on file</span>
      </div>

      <div className="border-line mt-4 divide-y overflow-hidden rounded-lg border">
        {TEAM_ROWS.map((member) => (
          <div key={member.name} className="flex items-center justify-between px-3.5 py-2.5">
            <div className="flex items-center gap-2.5">
              <span className="bg-brand-50 text-brand-700 flex size-7 items-center justify-center rounded-full text-[0.6875rem] font-semibold">
                {member.name
                  .split(' ')
                  .map((part) => part[0])
                  .join('')}
              </span>
              <span className="text-ink text-[0.75rem] font-medium">{member.name}</span>
            </div>
            <span className="text-ink-subtle text-[0.6875rem]">{member.role}</span>
          </div>
        ))}
      </div>

      <div className="border-line mt-3 divide-y overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between px-3.5 py-3">
          <span className="text-ink-muted flex items-center gap-2 text-[0.75rem]">
            <MapPinned className="text-ink-subtle size-4" aria-hidden="true" />
            GPS tracking
          </span>
          <Badge tone="positive" withDot>
            Connected
          </Badge>
        </div>
        <div className="flex items-center justify-between px-3.5 py-3">
          <span className="text-ink-muted text-[0.75rem]">
            Reminder · registration expiring — Toyota Corolla
          </span>
          <Badge tone="caution">14 days</Badge>
        </div>
      </div>
    </AppPreviewFrame>
  )
}
