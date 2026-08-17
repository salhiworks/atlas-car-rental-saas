import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type { FinancialSeriesRow, OrganizationOverviewRow } from '@/types/database'

import type { SeriesGranularity } from './period'

/**
 * Dashboard aggregates for one agency.
 *
 * Computed in the database rather than by pulling rows down and summing them in
 * the browser: it is one round trip instead of several, the arithmetic happens
 * where the data is, and the function runs under the caller's own privileges so
 * Row Level Security scopes it exactly as it scopes every other query.
 */
export async function fetchOverview(
  organizationId: string,
  from: Date,
  to: Date,
): Promise<OrganizationOverviewRow> {
  const { data, error } = await getSupabaseClient().rpc('organization_overview', {
    p_organization_id: organizationId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  })

  if (error) throw toAppError(error)

  const row = data?.[0]
  if (!row) throw new Error('The overview could not be calculated.')

  return row
}

export async function fetchFinancialSeries(
  organizationId: string,
  from: string,
  to: string,
  granularity: SeriesGranularity,
): Promise<FinancialSeriesRow[]> {
  const { data, error } = await getSupabaseClient().rpc('organization_financial_series', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
    p_granularity: granularity,
  })

  if (error) throw toAppError(error)
  return data ?? []
}
