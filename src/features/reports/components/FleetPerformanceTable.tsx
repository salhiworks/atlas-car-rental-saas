import { Link } from 'react-router-dom'

import { vehicleDetailPath } from '@/app/routes/paths'
import { Badge, SkeletonTable } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import { cn } from '@/lib/utils/cn'
import type { ReportFleetRow } from '@/types/database'

import { formatBps, formatDays } from '../domain'

/**
 * Vehicle economics, one row per car.
 *
 * The column that is easy to get wrong is CONTRIBUTION. It is the vehicle's own
 * revenue less the costs recorded directly against it and against its hires —
 * no share of the agency's overhead, no financing, no depreciation. Calling it
 * profit would invite a manager to sell the car with the worst number, and the
 * number does not support that decision. Financing sits in its own column
 * beside it, and the after-financing figure is labelled as cash rather than as
 * a result.
 *
 * An archived vehicle stays in the table when it had activity in the period. A
 * car sold in March still earned what it earned in February.
 */

export interface FleetPerformanceTableProps {
  rows: readonly ReportFleetRow[]
  locale: string
  isLoading?: boolean
  showFinancing?: boolean
}

export function FleetPerformanceTable({
  rows,
  locale,
  isLoading = false,
  showFinancing = false,
}: FleetPerformanceTableProps) {
  if (isLoading) {
    return (
      <div className="hidden lg:block">
        <SkeletonTable rows={6} />
      </div>
    )
  }

  return (
    <div className="hidden overflow-x-auto lg:block">
      <table className="w-full min-w-[62rem] text-[0.8125rem]">
        <caption className="sr-only">
          Revenue, direct cost, operating contribution and utilisation per vehicle
        </caption>
        <thead>
          <tr className="border-line text-ink-subtle text-2xs border-b tracking-wide uppercase">
            <th scope="col" className="px-4 py-2 text-start font-medium">
              Vehicle
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Hires
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Days on hire
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Utilisation
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Revenue
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Direct cost
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Contribution
            </th>
            {showFinancing ? (
              <>
                <th scope="col" className="px-4 py-2 text-end font-medium">
                  Financing cash
                </th>
                <th scope="col" className="px-4 py-2 text-end font-medium">
                  After financing
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {rows.map((row) => (
            <tr key={`${row.vehicle_id}-${row.currency}`} className="hover:bg-surface-muted">
              <td className="px-4 py-2.5">
                <Link
                  to={vehicleDetailPath(row.vehicle_id)}
                  className="text-brand-700 identifier font-medium hover:underline"
                >
                  {row.registration_plate}
                </Link>
                <p className="text-ink-subtle flex flex-wrap items-center gap-1.5 text-[0.75rem]">
                  <span>
                    {row.make} {row.model}
                  </span>
                  {row.archived_at ? (
                    <Badge tone="neutral" title="Retired from the fleet. Its history is kept.">
                      Archived
                    </Badge>
                  ) : null}
                </p>
              </td>
              <td className="px-4 py-2.5 text-end tabular-nums">{row.hires_started}</td>
              <td className="px-4 py-2.5 text-end tabular-nums">
                {formatDays(Number(row.rented_days), locale)}
              </td>
              <td className="px-4 py-2.5 text-end tabular-nums">
                {formatBps(row.utilisation_bps, locale)}
              </td>
              <td className="px-4 py-2.5 text-end tabular-nums">
                {formatMoney(row.rental_revenue_minor, row.currency, { locale })}
              </td>
              <td className="px-4 py-2.5 text-end tabular-nums">
                {formatMoney(row.direct_expense_minor, row.currency, { locale })}
              </td>
              <td
                className={cn(
                  'px-4 py-2.5 text-end font-medium tabular-nums',
                  row.operating_contribution_minor < 0 && 'text-critical-700',
                )}
              >
                {formatMoney(row.operating_contribution_minor, row.currency, { locale })}
              </td>
              {showFinancing ? (
                <>
                  <td className="px-4 py-2.5 text-end tabular-nums">
                    {formatMoney(row.financing_cash_minor, row.currency, { locale })}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-2.5 text-end tabular-nums',
                      row.after_financing_minor < 0 && 'text-critical-700',
                    )}
                    title={
                      row.financing_cost_complete
                        ? undefined
                        : 'Some financing payments were recorded without stating how much was interest.'
                    }
                  >
                    {formatMoney(row.after_financing_minor, row.currency, { locale })}
                    {row.financing_cost_complete ? null : (
                      <span
                        className="text-caution-700 ms-1"
                        aria-label="Cost breakdown incomplete"
                      >
                        *
                      </span>
                    )}
                  </td>
                </>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The same rows on a phone, where a nine-column table cannot go. */
export function FleetPerformanceCardList({
  rows,
  locale,
  isLoading = false,
}: FleetPerformanceTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-4 lg:hidden">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="bg-surface-inset h-20 animate-pulse rounded-md" />
        ))}
      </div>
    )
  }

  return (
    <ul className="divide-line divide-y lg:hidden">
      {rows.map((row) => (
        <li key={`${row.vehicle_id}-${row.currency}`} className="space-y-2 px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link
                to={vehicleDetailPath(row.vehicle_id)}
                className="text-brand-700 identifier text-[0.875rem] font-medium hover:underline"
              >
                {row.registration_plate}
              </Link>
              <p className="text-ink-subtle truncate text-[0.75rem]">
                {row.make} {row.model}
              </p>
            </div>
            <span
              data-numeric=""
              className={cn(
                'shrink-0 text-[0.875rem] font-semibold',
                row.operating_contribution_minor < 0 && 'text-critical-700',
              )}
            >
              {formatMoney(row.operating_contribution_minor, row.currency, { locale })}
            </span>
          </div>

          <dl className="text-ink-muted grid grid-cols-2 gap-x-4 gap-y-1 text-[0.75rem]">
            <div className="flex justify-between gap-2">
              <dt>Revenue</dt>
              <dd data-numeric="">
                {formatMoney(row.rental_revenue_minor, row.currency, { locale })}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Direct cost</dt>
              <dd data-numeric="">
                {formatMoney(row.direct_expense_minor, row.currency, { locale })}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Utilisation</dt>
              <dd data-numeric="">{formatBps(row.utilisation_bps, locale)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Hires</dt>
              <dd data-numeric="">{row.hires_started}</dd>
            </div>
          </dl>

          <p className="text-ink-subtle text-[0.6875rem]">
            Contribution excludes agency overhead, financing and depreciation.
          </p>
        </li>
      ))}
    </ul>
  )
}
