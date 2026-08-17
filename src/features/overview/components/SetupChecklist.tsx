import { Check } from 'lucide-react'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { cn } from '@/lib/utils/cn'
import type { Organization, OrganizationOverviewRow } from '@/types/database'

interface ChecklistStep {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly isComplete: boolean
  /** Present only when the step can actually be completed today. */
  readonly actionLabel?: string
  readonly actionTo?: string
}

export interface SetupChecklistProps {
  organization: Organization
  overview: OrganizationOverviewRow
  canEditSettings: boolean
}

/**
 * Progress through first-run setup, computed from the agency's actual records.
 *
 * Every state here is read from the database — a step is ticked because the data
 * is there, never because the interface assumed it. Steps whose module is not
 * open yet are listed without a button rather than given one that leads nowhere.
 */
export function SetupChecklist({ organization, overview, canEditSettings }: SetupChecklistProps) {
  const hasContactDetails = Boolean(
    organization.phone ?? organization.email ?? organization.address_line1,
  )

  const steps: ChecklistStep[] = [
    {
      id: 'agency',
      title: 'Create your agency',
      detail: `${organization.name} is set up in ${organization.default_currency}, ${organization.time_zone.replace(/_/g, ' ')}.`,
      isComplete: true,
      ...(canEditSettings ? { actionLabel: 'Change', actionTo: paths.settings } : {}),
    },
    {
      id: 'contact',
      title: 'Add your business details',
      detail: 'Address, phone and email appear on contracts and receipts.',
      isComplete: hasContactDetails,
      ...(canEditSettings ? { actionLabel: 'Add details', actionTo: paths.settings } : {}),
    },
    {
      id: 'logo',
      title: 'Upload your logo',
      detail: 'Used across the workspace and on the documents you issue.',
      isComplete: organization.logo_path !== null,
      ...(canEditSettings ? { actionLabel: 'Upload', actionTo: paths.settings } : {}),
    },
    {
      id: 'fleet',
      title: 'Add your first vehicle',
      detail: 'Fleet records open next. Nothing to prepare in the meantime.',
      isComplete: overview.fleet_total > 0,
    },
    {
      id: 'customers',
      title: 'Record your first customer',
      detail: 'Renter and driver details, for residents and visitors alike.',
      isComplete: overview.customers_total > 0,
    },
    {
      id: 'contract',
      title: 'Create your first contract',
      detail: 'Availability, pricing and payments, from booking to return.',
      isComplete: overview.rentals_total > 0,
    },
  ]

  const completed = steps.filter((step) => step.isComplete).length

  return (
    <div>
      <div className="border-line flex items-baseline justify-between border-b px-5 py-4">
        <div>
          <h2 className="text-[0.9375rem] leading-5 font-semibold">Getting set up</h2>
          <p className="text-ink-muted mt-0.5 text-[0.8125rem]">
            A few things to finish before your first rental.
          </p>
        </div>
        <p data-numeric="" className="text-ink-subtle text-[0.8125rem] font-medium">
          {completed} of {steps.length}
        </p>
      </div>

      <ol className="divide-line divide-y">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-3 px-5 py-3.5">
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border',
                step.isComplete
                  ? 'bg-brand-700 border-brand-800 text-ink-inverse'
                  : 'border-line-strong bg-surface',
              )}
            >
              {step.isComplete ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-[0.8125rem] font-medium',
                  step.isComplete ? 'text-ink-muted' : 'text-ink',
                )}
              >
                {step.title}
                <span className="sr-only">{step.isComplete ? ' — done' : ' — not done yet'}</span>
              </p>
              <p className="text-ink-subtle mt-0.5 text-[0.75rem] leading-4">{step.detail}</p>
            </div>

            {step.actionTo && step.actionLabel ? (
              // A link, not a button in link's clothing: this navigates, so it
              // should open in a new tab on middle-click like any other link.
              <Link
                to={step.actionTo}
                className="text-ink-muted hover:bg-surface-inset hover:text-ink shrink-0 rounded-md px-2.5 py-1.5 text-[0.8125rem] font-medium transition-colors"
              >
                {step.actionLabel}
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
