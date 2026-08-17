import { CalendarClock, ShieldCheck, Stamp, Wrench } from 'lucide-react'
import type { ComponentType } from 'react'

import { CardBody, CardHeader } from '@/components/ui'
import {
  describeCompliance,
  evaluateCompliance,
  evaluateVehicleCompliance,
  type ComplianceOptions,
} from '@/lib/compliance/expiry'
import { formatDate, parseIsoDate } from '@/lib/datetime/format'
import { cn } from '@/lib/utils/cn'
import type { VehicleFleetEntry } from '@/types/database'

import { ComplianceBadge, complianceTone } from './VehicleStatusBadge'

export interface VehicleCompliancePanelProps {
  vehicle: VehicleFleetEntry
  compliance: ComplianceOptions
  locale: string
}

const ROW_ACCENT: Record<string, string> = {
  critical: 'border-s-critical-600',
  caution: 'border-s-caution-600',
  positive: 'border-s-positive-600',
  neutral: 'border-s-line-strong',
  brand: 'border-s-brand-500',
  info: 'border-s-info-600',
}

/**
 * The three renewal dates a vehicle carries, plus its next service.
 *
 * Every state comes from the shared compliance rule, so "Expiring soon" here
 * means precisely what it means in the fleet list, on the dashboard, and in the
 * reminders that will be sent later. Urgency is carried by a hairline accent and
 * one badge rather than by colouring whole panels.
 */
export function VehicleCompliancePanel({
  vehicle,
  compliance,
  locale,
}: VehicleCompliancePanelProps) {
  const state = evaluateVehicleCompliance(vehicle, compliance)
  const service = evaluateCompliance(vehicle.next_service_on, compliance)

  const rows: {
    key: string
    label: string
    icon: ComponentType<{ className?: string }>
    status: ReturnType<typeof evaluateCompliance>
  }[] = [
    { key: 'insurance', label: 'Insurance', icon: ShieldCheck, status: state.insurance },
    { key: 'inspection', label: 'Technical inspection', icon: Stamp, status: state.inspection },
    {
      key: 'registration',
      label: 'Registration and road tax',
      icon: CalendarClock,
      status: state.registration,
    },
    { key: 'service', label: 'Next service', icon: Wrench, status: service },
  ]

  return (
    <>
      <CardHeader
        title="Compliance"
        description={`Warnings begin ${compliance.leadDays} days before a renewal date.`}
      />
      <CardBody className="p-0">
        <ul className="divide-line divide-y">
          {rows.map((row) => {
            const date = row.status.expiresOn
              ? parseIsoDate(row.status.expiresOn, compliance.timeZone)
              : null

            return (
              <li
                key={row.key}
                className={cn(
                  'flex flex-wrap items-center gap-3 border-s-2 px-5 py-3.5',
                  ROW_ACCENT[complianceTone(row.status.state)],
                )}
              >
                <row.icon className="text-ink-subtle size-4 shrink-0" aria-hidden="true" />

                <div className="min-w-0 flex-1">
                  <p className="text-ink text-[0.8125rem] font-medium">{row.label}</p>
                  <p className="text-ink-subtle mt-0.5 text-[0.75rem]">
                    {date
                      ? `${formatDate(date, { locale, timeZone: compliance.timeZone })} · ${describeCompliance(row.status)}`
                      : 'No date recorded'}
                  </p>
                </div>

                <ComplianceBadge state={row.status.state} />
              </li>
            )
          })}
        </ul>
      </CardBody>
    </>
  )
}
