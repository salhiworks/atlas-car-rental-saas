import { useQuery } from '@tanstack/react-query'

import { useOrganization } from '@/features/workspace/workspace-context'
import type { ReportExpenseDimension } from '@/types/database'

import {
  fetchBusinessSummary,
  fetchComplianceSummary,
  fetchCustomerBalances,
  fetchCustomerCohorts,
  fetchCustomerRevenue,
  fetchExpenseBreakdown,
  fetchFinancialSeries,
  fetchFinancingPosition,
  fetchFleetPerformance,
  fetchGpsCoverage,
  fetchPositionSummary,
  fetchRentalOperations,
  fetchRentalValues,
  fetchUtilisationSeries,
} from './api'

/**
 * Query keys for Reports.
 *
 * EVERY KEY BEGINS WITH THE ORGANIZATION. This is not a naming convention: the
 * workspace switcher invalidates exactly `['organization']`, so a key shaped
 * `['reports', orgId, …]` would survive a switch and render one agency's
 * revenue, customer names and vehicle economics under another agency's name.
 * That failure has happened in this product before, in the Calendar, and the
 * data here is considerably more sensitive.
 *
 * Reports are also heavier than an entity read and change far more slowly, so
 * they hold longer than the client default and are re-fetched when a domain
 * that feeds them is written to, rather than on a timer.
 */
export const reportKeys = {
  all: (organizationId: string) => ['organization', organizationId, 'reports'] as const,
  business: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'reports', 'business', from, to] as const,
  positions: (organizationId: string) =>
    ['organization', organizationId, 'reports', 'positions'] as const,
  series: (
    organizationId: string,
    from: string,
    to: string,
    granularity: string,
    currency: string,
  ) =>
    ['organization', organizationId, 'reports', 'series', from, to, granularity, currency] as const,
  fleet: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'reports', 'fleet', from, to] as const,
  utilisation: (organizationId: string, from: string, to: string, granularity: string) =>
    ['organization', organizationId, 'reports', 'utilisation', from, to, granularity] as const,
  expenses: (organizationId: string, from: string, to: string, dimension: string) =>
    ['organization', organizationId, 'reports', 'expenses', from, to, dimension] as const,
  rentalOperations: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'reports', 'rental-operations', from, to] as const,
  rentalValues: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'reports', 'rental-values', from, to] as const,
  cohorts: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'reports', 'cohorts', from, to] as const,
  balances: (organizationId: string, currency: string | null, page: number) =>
    ['organization', organizationId, 'reports', 'balances', currency ?? 'all', page] as const,
  customerRevenue: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'reports', 'customer-revenue', from, to] as const,
  financing: (organizationId: string) =>
    ['organization', organizationId, 'reports', 'financing'] as const,
  gps: (organizationId: string) => ['organization', organizationId, 'reports', 'gps'] as const,
  compliance: (organizationId: string) =>
    ['organization', organizationId, 'reports', 'compliance'] as const,
}

/**
 * An analytics answer is expensive to compute and changes when somebody records
 * a payment, not every thirty seconds. Two minutes is long enough that moving
 * between sections costs nothing and short enough that a report opened after a
 * morning's takings is right.
 */
const REPORT_STALE_MS = 120_000

interface Window {
  readonly from: string
  readonly to: string
}

export function useBusinessSummary(window: Window, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.business(organization.id, window.from, window.to),
    queryFn: () =>
      fetchBusinessSummary({ organizationId: organization.id, from: window.from, to: window.to }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function usePositionSummary(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.positions(organization.id),
    queryFn: () => fetchPositionSummary(organization.id),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useFinancialSeries(
  window: Window,
  granularity: string,
  currency: string | null,
  enabled = true,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.series(
      organization.id,
      window.from,
      window.to,
      granularity,
      currency ?? 'none',
    ),
    queryFn: () =>
      fetchFinancialSeries({
        organizationId: organization.id,
        from: window.from,
        to: window.to,
        granularity,
        currency: currency as string,
      }),
    // The trend is drawn in one currency. Without one there is nothing to ask
    // for — the server refuses rather than guessing, so the query does not run.
    enabled: enabled && currency !== null,
    staleTime: REPORT_STALE_MS,
  })
}

export function useFleetPerformance(window: Window, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.fleet(organization.id, window.from, window.to),
    queryFn: () =>
      fetchFleetPerformance({ organizationId: organization.id, from: window.from, to: window.to }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useUtilisationSeries(window: Window, granularity: string, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.utilisation(organization.id, window.from, window.to, granularity),
    queryFn: () =>
      fetchUtilisationSeries({
        organizationId: organization.id,
        from: window.from,
        to: window.to,
        granularity,
      }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useExpenseBreakdown(
  window: Window,
  dimension: ReportExpenseDimension,
  enabled = true,
) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.expenses(organization.id, window.from, window.to, dimension),
    queryFn: () =>
      fetchExpenseBreakdown({
        organizationId: organization.id,
        from: window.from,
        to: window.to,
        dimension,
      }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useRentalOperations(window: Window, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.rentalOperations(organization.id, window.from, window.to),
    queryFn: () =>
      fetchRentalOperations({ organizationId: organization.id, from: window.from, to: window.to }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useRentalValues(window: Window, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.rentalValues(organization.id, window.from, window.to),
    queryFn: () =>
      fetchRentalValues({ organizationId: organization.id, from: window.from, to: window.to }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useCustomerCohorts(window: Window, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.cohorts(organization.id, window.from, window.to),
    queryFn: () =>
      fetchCustomerCohorts({ organizationId: organization.id, from: window.from, to: window.to }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useCustomerBalances(currency: string | null, page: number, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.balances(organization.id, currency, page),
    queryFn: () => fetchCustomerBalances(organization.id, currency, page),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useCustomerRevenue(window: Window, enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.customerRevenue(organization.id, window.from, window.to),
    queryFn: () =>
      fetchCustomerRevenue({ organizationId: organization.id, from: window.from, to: window.to }),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useFinancingPosition(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.financing(organization.id),
    queryFn: () => fetchFinancingPosition(organization.id),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}

export function useGpsCoverage(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.gps(organization.id),
    queryFn: () => fetchGpsCoverage(organization.id),
    enabled,
    // A tracking snapshot is stamped with the moment it was taken, so it goes
    // stale quickly by nature.
    staleTime: 30_000,
  })
}

export function useComplianceSummary(enabled = true) {
  const organization = useOrganization()

  return useQuery({
    queryKey: reportKeys.compliance(organization.id),
    queryFn: () => fetchComplianceSummary(organization.id),
    enabled,
    staleTime: REPORT_STALE_MS,
  })
}
