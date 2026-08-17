import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type {
  ReportBusinessSummaryRow,
  ReportComplianceRow,
  ReportCustomerBalanceRow,
  ReportCustomerCohortRow,
  ReportCustomerRevenueRow,
  ReportExpenseDimension,
  ReportExpenseRow,
  ReportFinancingRow,
  ReportFleetRow,
  ReportGpsCoverageRow,
  ReportPositionSummaryRow,
  ReportRentalOperationsRow,
  ReportRentalValueRow,
  ReportSeriesRow,
  ReportUtilisationRow,
} from '@/types/database'

/**
 * What the Reports workspace asks of the database.
 *
 * Every call is one RPC that returns an aggregate. Nothing here downloads rows
 * and adds them up in the browser: an agency with four years of hires has tens
 * of thousands of payments, and a report built by fetching them would be slow,
 * would run out of memory eventually, and — worse — would be a second
 * implementation of revenue that could drift from the one the rest of the
 * product uses.
 *
 * Authorization is not asserted here. Each function refuses on its own, in the
 * database, under the caller's own row-level security, so a hand-made request
 * to the Data API is refused exactly as this module is.
 */

export interface ReportPeriodArgs {
  readonly organizationId: string
  /** ISO `YYYY-MM-DD`, inclusive. */
  readonly from: string
  /** ISO `YYYY-MM-DD`, exclusive. */
  readonly to: string
}

export async function fetchBusinessSummary(
  args: ReportPeriodArgs,
): Promise<ReportBusinessSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_business_summary', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchPositionSummary(
  organizationId: string,
): Promise<ReportPositionSummaryRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_position_summary', {
    p_organization_id: organizationId,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchFinancialSeries(
  args: ReportPeriodArgs & { granularity: string; currency: string },
): Promise<ReportSeriesRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_financial_series', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
    p_granularity: args.granularity,
    p_currency: args.currency,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchFleetPerformance(args: ReportPeriodArgs): Promise<ReportFleetRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_fleet_performance', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchUtilisationSeries(
  args: ReportPeriodArgs & { granularity: string },
): Promise<ReportUtilisationRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_utilisation_series', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
    p_granularity: args.granularity,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchExpenseBreakdown(
  args: ReportPeriodArgs & { dimension: ReportExpenseDimension },
): Promise<ReportExpenseRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_expense_breakdown', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
    p_dimension: args.dimension,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchRentalOperations(
  args: ReportPeriodArgs,
): Promise<ReportRentalOperationsRow | null> {
  const { data, error } = await getSupabaseClient().rpc('report_rental_operations', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
  })
  if (error) throw toAppError(error)
  return data?.[0] ?? null
}

export async function fetchRentalValues(args: ReportPeriodArgs): Promise<ReportRentalValueRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_rental_values', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchCustomerCohorts(
  args: ReportPeriodArgs,
): Promise<ReportCustomerCohortRow | null> {
  const { data, error } = await getSupabaseClient().rpc('report_customer_cohorts', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
  })
  if (error) throw toAppError(error)
  return data?.[0] ?? null
}

export interface CustomerBalancePage {
  readonly rows: ReportCustomerBalanceRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
  readonly pageCount: number
}

export const BALANCE_PAGE_SIZE = 20

/**
 * Outstanding balances, paginated in the database.
 *
 * An agency with five thousand customers is a realistic agency, and a report
 * that put five thousand rows into the document to show the top twenty would be
 * a page nobody could scroll.
 */
export async function fetchCustomerBalances(
  organizationId: string,
  currency: string | null,
  page = 1,
): Promise<CustomerBalancePage> {
  const request = async (safePage: number) => {
    const { data, error } = await getSupabaseClient().rpc('report_customer_balances', {
      p_organization_id: organizationId,
      p_currency: currency,
      p_limit: BALANCE_PAGE_SIZE,
      p_offset: (safePage - 1) * BALANCE_PAGE_SIZE,
    })
    if (error) throw toAppError(error)
    return data ?? []
  }

  const safePage = Math.max(1, page)
  let rows = await request(safePage)

  /*
   * A page number that has run off the end returns nothing, and nothing looks
   * exactly like "no customer owes anything" — with the pager hidden, because
   * the count comes from the rows. It happens whenever a bookmarked link
   * outlives the balances it pointed at. Falling back to the first page shows
   * the truth instead of an empty screen with no way out.
   */
  let effectivePage = safePage
  if (rows.length === 0 && safePage > 1) {
    rows = await request(1)
    effectivePage = 1
  }

  const total = rows.length > 0 ? Number(rows[0]!.total_rows) : 0
  return {
    rows,
    total,
    page: effectivePage,
    pageSize: BALANCE_PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / BALANCE_PAGE_SIZE)),
  }
}

export async function fetchCustomerRevenue(
  args: ReportPeriodArgs & { limit?: number },
): Promise<ReportCustomerRevenueRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_customer_revenue', {
    p_organization_id: args.organizationId,
    p_from: args.from,
    p_to: args.to,
    p_limit: args.limit ?? 10,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchFinancingPosition(
  organizationId: string,
): Promise<ReportFinancingRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_financing_position', {
    p_organization_id: organizationId,
  })
  if (error) throw toAppError(error)
  return data ?? []
}

export async function fetchGpsCoverage(
  organizationId: string,
): Promise<ReportGpsCoverageRow | null> {
  const { data, error } = await getSupabaseClient().rpc('report_gps_coverage', {
    p_organization_id: organizationId,
  })
  if (error) throw toAppError(error)
  return data?.[0] ?? null
}

export async function fetchComplianceSummary(
  organizationId: string,
): Promise<ReportComplianceRow[]> {
  const { data, error } = await getSupabaseClient().rpc('report_compliance_summary', {
    p_organization_id: organizationId,
    p_lead_days: null,
  })
  if (error) throw toAppError(error)
  return data ?? []
}
