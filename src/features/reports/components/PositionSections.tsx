import { Landmark, MapPinned, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'

import { financingDetailPath, vehicleDetailPath } from '@/app/routes/paths'
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState } from '@/components/ui'
import { formatDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type {
  ReportComplianceRow,
  ReportFinancingRow,
  ReportGpsCoverageRow,
} from '@/types/database'

import {
  COMPLIANCE_LABELS,
  COST_INCOMPLETE_NOTE,
  GPS_SNAPSHOT_NOTE,
  complianceNeedingAttention,
  formatBps,
  formatCount,
  trackedShare,
} from '../domain'

import { ReportMetric } from './ReportMetric'

// =============================================================================
// Financing
// =============================================================================

/**
 * What the agency owes, and what it has paid.
 *
 * One row per ACTIVE agreement rather than one per vehicle: a car that has been
 * refinanced carries a closed agreement with a balance too, and summing per
 * vehicle would count that debt twice.
 *
 * Three figures are kept apart because merging any two of them produces a
 * number nobody can act on. CASH is everything paid to a lender. COST is
 * interest and fees — never principal, which converts one balance into another
 * and is not the price of anything. PRINCIPAL REMAINING is shown only where the
 * arithmetic supports it; where a payment's composition was never stated, the
 * balance is genuinely unknown and says so rather than reading zero.
 */
export function FinancingSection({
  rows,
  currency,
  locale,
  timeZone,
  isLoading,
}: {
  rows: readonly ReportFinancingRow[]
  currency: string | null
  locale: string
  timeZone: string
  isLoading: boolean
}) {
  const scoped = currency ? rows.filter((row) => row.currency === currency) : rows

  const totals = scoped.reduce(
    (sum, row) => ({
      cash: sum.cash + Number(row.cash_paid_minor),
      cost: sum.cost + Number(row.financing_cost_minor),
      principal:
        row.principal_known && row.remaining_principal_minor !== null
          ? sum.principal + Number(row.remaining_principal_minor)
          : sum.principal,
      unknown: sum.unknown + (row.principal_known ? 0 : 1),
      overdue: sum.overdue + Number(row.overdue_minor),
      incomplete: sum.incomplete + (row.cost_complete ? 0 : 1),
    }),
    { cash: 0, cost: 0, principal: 0, unknown: 0, overdue: 0, incomplete: 0 },
  )

  if (!isLoading && rows.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={Landmark}
            title="No active financing"
            description="Loans and leases against fleet vehicles appear here once an agreement is active."
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="Active agreements"
          value={formatCount(scoped.length, locale)}
          caption="One row per agreement, so a refinanced car is counted once."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Paid to lenders"
          value={currency ? formatMoney(totals.cash, currency, { locale }) : '—'}
          caption="Lifetime cash across these agreements."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Cost of borrowing"
          value={
            currency
              ? `${totals.incomplete > 0 ? 'At least ' : ''}${formatMoney(totals.cost, currency, { locale })}`
              : '—'
          }
          caption="Interest and fees. Principal repayment is not a cost."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Remaining principal"
          value={
            totals.unknown === scoped.length && scoped.length > 0
              ? 'Not derivable'
              : currency
                ? formatMoney(totals.principal, currency, { locale })
                : '—'
          }
          caption={
            totals.unknown > 0
              ? `${totals.unknown} agreement${totals.unknown === 1 ? '' : 's'} excluded — balance not derivable.`
              : 'Across agreements whose balance can be derived.'
          }
          isLoading={isLoading}
        />
      </div>

      {totals.incomplete > 0 ? (
        <Alert tone="caution" title="Cost breakdown incomplete">
          {COST_INCOMPLETE_NOTE} This affects {totals.incomplete} agreement
          {totals.incomplete === 1 ? '' : 's'}.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="By agreement"
          description="Archived vehicles are included: a debt does not stop existing because the car left the fleet."
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-[0.8125rem]">
              <thead>
                <tr className="border-line text-ink-subtle text-2xs border-b tracking-wide uppercase">
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    Vehicle
                  </th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    Lender
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Paid
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Cost
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Remaining
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Overdue
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Next due
                  </th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {scoped.map((row) => (
                  <tr key={row.agreement_id} className="hover:bg-surface-muted">
                    <td className="px-4 py-2.5">
                      <Link
                        to={vehicleDetailPath(row.vehicle_id)}
                        className="text-brand-700 identifier font-medium hover:underline"
                      >
                        {row.registration_plate}
                      </Link>
                      {row.vehicle_archived ? (
                        <Badge tone="neutral" className="ms-1.5">
                          Archived
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link
                        to={financingDetailPath(row.agreement_id)}
                        className="hover:text-brand-700 hover:underline"
                      >
                        {row.lender_name}
                      </Link>
                      <p className="text-ink-subtle text-[0.75rem] capitalize">
                        {row.agreement_type.replace(/_/g, ' ')}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {formatMoney(row.cash_paid_minor, row.currency, { locale })}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {row.cost_complete ? '' : 'At least '}
                      {formatMoney(row.financing_cost_minor, row.currency, { locale })}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {row.principal_known && row.remaining_principal_minor !== null ? (
                        formatMoney(row.remaining_principal_minor, row.currency, { locale })
                      ) : (
                        <span
                          className="text-ink-subtle"
                          title="No payment composition was stated."
                        >
                          Not derivable
                        </span>
                      )}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-2.5 text-end tabular-nums',
                        row.overdue_minor > 0 && 'text-critical-700 font-medium',
                      )}
                    >
                      {row.overdue_minor > 0
                        ? formatMoney(row.overdue_minor, row.currency, { locale })
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      {row.next_due_on ? (
                        <>
                          <span className="tabular-nums">
                            {formatDate(new Date(`${row.next_due_on}T12:00:00Z`), {
                              locale,
                              timeZone,
                            })}
                          </span>
                          {row.next_due_minor ? (
                            <p className="text-ink-subtle text-[0.75rem] tabular-nums">
                              {formatMoney(row.next_due_minor, row.currency, { locale })}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

// =============================================================================
// Tracking
// =============================================================================

/**
 * Tracking coverage — a snapshot, and it says so.
 *
 * There is no scheduler on this deployment: positions refresh while somebody has
 * the tracking workspace open, and nothing is collected overnight. So there is
 * no uptime here, no average position age for a month, and no count of vehicles
 * that went offline last night, because none of that was ever recorded. Every
 * figure is stamped with the moment it was read.
 *
 * Connectivity has three buckets. A provider that reports nothing has not said
 * the tracker is offline, and folding "unknown" into "offline" would send
 * somebody out to look for a van parked exactly where it should be.
 */
export function TrackingSection({
  coverage,
  locale,
  timeZone,
  isLoading,
}: {
  coverage: ReportGpsCoverageRow | null
  locale: string
  timeZone: string
  isLoading: boolean
}) {
  if (!isLoading && (!coverage || Number(coverage.devices_total) === 0)) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={MapPinned}
            title="No tracking devices synchronised"
            description="Connect a tracking provider and synchronise its devices, and this reports how much of the fleet is covered."
          />
        </CardBody>
      </Card>
    )
  }

  const share = trackedShare(coverage)

  return (
    <div className="space-y-5">
      <Alert tone="info">{GPS_SNAPSHOT_NOTE}</Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="Fleet with a tracker"
          value={share === null ? '—' : formatBps(Math.round(share * 10_000), locale)}
          caption={
            coverage
              ? `${formatCount(coverage.vehicles_tracked, locale)} of ${formatCount(coverage.vehicles_total, locale)} active vehicles.`
              : undefined
          }
          isLoading={isLoading}
          emphasis="strong"
        />
        <ReportMetric
          label="Without a tracker"
          value={formatCount(coverage?.vehicles_untracked, locale)}
          caption="Active vehicles with no device assigned."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Current positions"
          value={formatCount(coverage?.positions_fresh, locale)}
          caption={
            coverage
              ? `Reported within ${coverage.fresh_minutes} minutes — the agency's own threshold.`
              : undefined
          }
          isLoading={isLoading}
        />
        <ReportMetric
          label="Spare devices"
          value={formatCount(coverage?.devices_spare, locale)}
          caption="Synchronised but not fitted to a vehicle."
          isLoading={isLoading}
        />
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title="Position freshness"
            description="How old the newest position is for each tracked vehicle, right now."
          />
          <CardBody>
            <dl className="divide-line divide-y">
              <Line label="Current" value={formatCount(coverage?.positions_fresh, locale)} />
              <Line label="Delayed" value={formatCount(coverage?.positions_stale, locale)} />
              <Line
                label="Last known only"
                value={formatCount(coverage?.positions_very_stale, locale)}
                hint={coverage ? `Older than ${coverage.stale_minutes} minutes.` : undefined}
              />
              <Line
                label="Clock ahead"
                value={formatCount(coverage?.positions_future, locale)}
                hint="Timestamped in the future. Usually a tracker clock set wrong."
              />
              <Line
                label="Never reported"
                value={formatCount(coverage?.positions_unknown, locale)}
                hint="Assigned, but no usable position has arrived."
              />
            </dl>
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title="Devices and providers"
            description="Connection health is counted per provider connection, not per vehicle."
          />
          <CardBody>
            <dl className="divide-line divide-y">
              <Line
                label="Tracker link reported online"
                value={formatCount(coverage?.link_online, locale)}
              />
              <Line
                label="Tracker link reported offline"
                value={formatCount(coverage?.link_offline, locale)}
              />
              <Line
                label="Link state not reported"
                value={formatCount(coverage?.link_unreported, locale)}
                hint="The provider said nothing. Not the same as offline."
              />
              <Line
                label="Devices missing from the provider"
                value={formatCount(coverage?.devices_missing, locale)}
              />
              <Line
                label="Connections answering normally"
                value={
                  coverage
                    ? `${formatCount(coverage.connections_healthy, locale)} of ${formatCount(coverage.connections_total, locale)}`
                    : '—'
                }
              />
              <Line
                label="Last successful synchronisation"
                value={
                  coverage?.last_sync_success_at
                    ? formatDate(new Date(coverage.last_sync_success_at), { locale, timeZone })
                    : 'Never'
                }
              />
            </dl>
          </CardBody>
        </Card>
      </div>

      {coverage ? (
        <p className="text-ink-subtle text-[0.75rem]">
          Snapshot taken {formatDate(new Date(coverage.computed_at), { locale, timeZone })}.
        </p>
      ) : null}
    </div>
  )
}

// =============================================================================
// Compliance — shown inside the Fleet section
// =============================================================================

/**
 * Fleet documents against the agency's own reminder threshold.
 *
 * An unrecorded date is counted apart from an expired one. A vehicle whose
 * insurance expiry nobody has typed in is not a vehicle driving uninsured, and
 * merging the two would turn a filing habit into an alarm.
 */
export function ComplianceCard({
  rows,
  locale,
  isLoading,
}: {
  rows: readonly ReportComplianceRow[]
  locale: string
  isLoading: boolean
}) {
  const attention = complianceNeedingAttention(rows)
  const leadDays = rows[0]?.lead_days ?? 30

  return (
    <Card>
      <CardHeader
        title="Fleet compliance"
        description={`Against the agency's reminder threshold of ${leadDays} days.`}
        actions={
          attention > 0 ? (
            <Badge tone="caution">
              {attention} need{attention === 1 ? 's' : ''} attention
            </Badge>
          ) : (
            <Badge tone="positive">
              <ShieldCheck className="size-3" aria-hidden="true" />
              All current
            </Badge>
          )
        }
      />
      <CardBody className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="bg-surface-inset h-8 animate-pulse rounded-md" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-[0.8125rem]">
              <thead>
                <tr className="border-line text-ink-subtle text-2xs border-b tracking-wide uppercase">
                  <th scope="col" className="px-4 py-2 text-start font-medium">
                    Document
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Expired
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Due soon
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Valid
                  </th>
                  <th scope="col" className="px-4 py-2 text-end font-medium">
                    Not recorded
                  </th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {rows.map((row) => (
                  <tr key={row.document_kind}>
                    <th scope="row" className="px-4 py-2.5 text-start font-medium">
                      {COMPLIANCE_LABELS[row.document_kind]}
                    </th>
                    <td
                      className={cn(
                        'px-4 py-2.5 text-end tabular-nums',
                        Number(row.expired) > 0 && 'text-critical-700 font-medium',
                      )}
                    >
                      {formatCount(row.expired, locale)}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-2.5 text-end tabular-nums',
                        Number(row.due_soon) > 0 && 'text-caution-700 font-medium',
                      )}
                    >
                      {formatCount(row.due_soon, locale)}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums">
                      {formatCount(row.valid, locale)}
                    </td>
                    <td className="text-ink-subtle px-4 py-2.5 text-end tabular-nums">
                      {formatCount(row.unrecorded, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function Line({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <dt className="text-[0.8125rem]">{label}</dt>
        {hint ? <p className="text-ink-subtle text-[0.75rem] leading-4">{hint}</p> : null}
      </div>
      <dd data-numeric="" className="shrink-0 text-[0.8125rem] font-medium tabular-nums">
        {value}
      </dd>
    </div>
  )
}
