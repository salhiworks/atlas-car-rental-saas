import { CarFront } from 'lucide-react'
import { useMemo } from 'react'

import { Card, CardBody, CardHeader, EmptyState, Select } from '@/components/ui'
import { formatMoney } from '@/lib/money/money'
import type { ReportFleetRow, ReportUtilisationRow } from '@/types/database'

import { FLEET_SORTS, type FleetSort, formatBps, formatDays } from '../domain'
import type { ReportGranularity } from '../period'

import { FleetPerformanceCardList, FleetPerformanceTable } from './FleetPerformanceTable'
import { RankedBars } from './RankedBars'
import { ReportMetric } from './ReportMetric'
import { UtilisationChart } from './UtilisationChart'

/**
 * Which cars earn, which cars cost, and which sit still.
 *
 * Financial rankings run inside ONE currency. A fleet with euro and dirham
 * contracts cannot be ordered by "revenue" across both without an exchange rate
 * this product does not have, so the currency filter above governs the table and
 * the ranking together.
 *
 * Utilisation here is CALENDAR AVAILABILITY: days committed to hires against
 * days the vehicle existed in the window, bounded by acquisition and archiving.
 * It is not reduced by maintenance or off-road time, because the schema keeps no
 * history of vehicle status — subtracting downtime would mean inventing it. The
 * caption says so on screen rather than in a comment nobody reads.
 */

export interface FleetSectionProps {
  rows: readonly ReportFleetRow[]
  utilisation: readonly ReportUtilisationRow[]
  currency: string | null
  locale: string
  timeZone: string
  granularity: ReportGranularity
  sort: FleetSort
  onSortChange: (sort: FleetSort) => void
  isLoading: boolean
  utilisationLoading: boolean
}

export function FleetSection({
  rows,
  utilisation,
  currency,
  locale,
  timeZone,
  granularity,
  sort,
  onSortChange,
  isLoading,
  utilisationLoading,
}: FleetSectionProps) {
  const scoped = useMemo(
    () => (currency ? rows.filter((row) => row.currency === currency) : rows),
    [rows, currency],
  )

  const sorted = useMemo(() => {
    const copy = [...scoped]
    switch (sort) {
      case 'revenue':
        return copy.sort((a, b) => b.rental_revenue_minor - a.rental_revenue_minor)
      case 'contribution':
        return copy.sort((a, b) => b.operating_contribution_minor - a.operating_contribution_minor)
      case 'cost':
        return copy.sort((a, b) => b.direct_expense_minor - a.direct_expense_minor)
      case 'hires':
        return copy.sort((a, b) => b.hires_started - a.hires_started)
      case 'utilisation':
        // A vehicle that was not in service has no utilisation, and belongs at
        // the bottom of a "highest" ranking rather than at the top of it.
        return copy.sort((a, b) => (b.utilisation_bps ?? -1) - (a.utilisation_bps ?? -1))
      case 'idle':
        return copy.sort((a, b) => (a.utilisation_bps ?? 100_001) - (b.utilisation_bps ?? 100_001))
    }
  }, [scoped, sort])

  /*
   * Occupancy, hires and the idle count belong to the VEHICLE, not to a
   * currency: the read model repeats them on every row a vehicle has, one per
   * currency it traded in. Deriving them from the currency-filtered set made a
   * car whose only payment was in euros disappear from a dirham report — the
   * tile read "0% utilised" while the chart directly beneath it, which has no
   * currency at all, read 48%.
   *
   * A vehicle that did not exist during the window (sold years ago) is excluded
   * from the fleet-level view: it is not an idle car on the lot, and letting it
   * into "least used" filled that card with vehicles the agency no longer owns.
   */
  const perVehicle = useMemo(() => {
    const seen = new Map<string, ReportFleetRow>()
    for (const row of rows) if (!seen.has(row.vehicle_id)) seen.set(row.vehicle_id, row)
    return [...seen.values()]
  }, [rows])

  /*
   * Vehicles that existed during the window. A car sold two years ago has no
   * time in this period, so it is neither idle nor least-used — letting it into
   * either would fill both with vehicles the agency no longer owns. It stays in
   * the totals above, because whatever it earned it earned.
   */
  const inService = useMemo(
    () => perVehicle.filter((row) => Number(row.in_service_days) > 0),
    [perVehicle],
  )

  const totals = useMemo(() => {
    let revenue = 0
    let cost = 0
    let contribution = 0
    for (const row of scoped) {
      revenue += Number(row.rental_revenue_minor)
      cost += Number(row.direct_expense_minor)
      contribution += Number(row.operating_contribution_minor)
    }

    let rented = 0
    let available = 0
    let hires = 0
    for (const row of perVehicle) {
      rented += Number(row.rented_days)
      available += Number(row.in_service_days)
      hires += Number(row.hires_started)
    }

    return {
      revenue,
      cost,
      contribution,
      hires,
      // Clamped, as the SQL clamps every utilisation it emits. Occupancy is
      // bounded by a hire's agreed period while availability is bounded by
      // archiving, so a car sold mid-hire can otherwise exceed its own
      // in-service time.
      utilisationBps:
        available > 0 ? Math.min(10_000, Math.round((rented / available) * 10_000)) : null,
      idle: inService.filter((row) => Number(row.rented_days) === 0).length,
    }
  }, [scoped, perVehicle, inService])

  const financed = scoped.some((row) => row.financing_cash_minor > 0)

  if (!isLoading && rows.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={CarFront}
            title="No vehicles in the fleet yet"
            description="Add the cars you rent out and this becomes a per-vehicle picture of what each one earns and costs."
          />
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <ReportMetric
          label="Fleet utilisation"
          value={formatBps(totals.utilisationBps, locale)}
          caption="Days on hire against days the fleet existed."
          isLoading={isLoading}
          emphasis="strong"
        />
        <ReportMetric
          label="Hires started"
          value={String(totals.hires)}
          caption={`${totals.idle} vehicle${totals.idle === 1 ? '' : 's'} had no hire in this period.`}
          isLoading={isLoading}
        />
        <ReportMetric
          label="Fleet revenue"
          value={currency ? formatMoney(totals.revenue, currency, { locale }) : '—'}
          caption="Payments attributed to a vehicle through its hires."
          isLoading={isLoading}
        />
        <ReportMetric
          label="Operating contribution"
          value={currency ? formatMoney(totals.contribution, currency, { locale }) : '—'}
          caption="Fleet revenue less direct costs. Excludes agency overhead."
          isLoading={isLoading}
          emphasis="strong"
        />
      </div>

      <Card>
        <CardHeader
          title="Utilisation over the period"
          description="Vehicle-days committed to hires against vehicle-days available. Calendar availability — maintenance downtime is not recorded historically, so it is not subtracted."
        />
        <CardBody className="p-0">
          <UtilisationChart
            series={utilisation}
            locale={locale}
            timeZone={timeZone}
            granularity={granularity}
            isLoading={utilisationLoading}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Vehicle performance"
          description={
            currency
              ? `Ranked within ${currency}. Contribution excludes agency overhead, financing and depreciation.`
              : 'Contribution excludes agency overhead, financing and depreciation.'
          }
          actions={
            <Select
              aria-label="Rank vehicles by"
              className="h-8 w-52 text-[0.8125rem]"
              value={sort}
              onChange={(event) => onSortChange(event.target.value as FleetSort)}
              options={Object.entries(FLEET_SORTS).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
            />
          }
        />
        <CardBody className="p-0">
          <FleetPerformanceTable
            rows={sorted}
            locale={locale}
            isLoading={isLoading}
            showFinancing={financed}
          />
          <FleetPerformanceCardList rows={sorted} locale={locale} isLoading={isLoading} />
        </CardBody>
      </Card>

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Highest direct cost" description="Where the fleet's money goes." />
          <CardBody className="p-0">
            <RankedBars
              isLoading={isLoading}
              emptyLabel="No vehicle costs were recorded in this period."
              items={[...scoped]
                .filter((row) => row.direct_expense_minor > 0)
                .sort((a, b) => b.direct_expense_minor - a.direct_expense_minor)
                .slice(0, 8)
                .map((row) => ({
                  id: `${row.vehicle_id}-${row.currency}`,
                  label: row.registration_plate,
                  value: row.direct_expense_minor,
                  display: formatMoney(row.direct_expense_minor, row.currency, { locale }),
                  caption: `${row.make} ${row.model} · ${row.expense_count} cost${row.expense_count === 1 ? '' : 's'}`,
                }))}
            />
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title="Least used"
            description="Vehicles with the fewest days on hire in this period."
          />
          <CardBody className="p-0">
            <RankedBars
              isLoading={isLoading}
              emptyLabel="No vehicles to compare."
              items={[...inService]
                .sort((a, b) => Number(a.rented_days) - Number(b.rented_days))
                .slice(0, 8)
                .map((row) => ({
                  id: `${row.vehicle_id}-idle-${row.currency}`,
                  label: row.registration_plate,
                  // A short bar for an idle car reads correctly: the bar is
                  // days on hire, so idle vehicles are visibly empty.
                  value: Number(row.rented_days),
                  display: `${formatDays(Number(row.rented_days), locale)} days`,
                  caption: `${row.make} ${row.model} · ${formatBps(row.utilisation_bps, locale)} utilised`,
                }))}
            />
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
