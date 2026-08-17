import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { DEFAULT_COMPLIANCE_LEAD_DAYS, type ComplianceOptions } from '@/lib/compliance/expiry'
import { queryKeys } from '@/lib/query/keys'

import { fetchOrganizationSettings } from './api'
import { useOrganization } from './workspace-context'

/** Operational preferences for the active agency. */
export function useOrganizationSettings() {
  const organization = useOrganization()

  return useQuery({
    queryKey: queryKeys.organizationSettings(organization.id),
    queryFn: () => fetchOrganizationSettings(organization.id),
    staleTime: 5 * 60_000,
  })
}

/**
 * The two inputs every expiry calculation needs: the agency's time zone and its
 * chosen warning window.
 *
 * Resolved once here so no component reaches for `new Date()` or hard-codes
 * "30 days" of its own — that is precisely how several slightly different
 * versions of the same rule end up in a codebase.
 */
export function useComplianceOptions(): ComplianceOptions {
  const organization = useOrganization()
  const { data: settings } = useOrganizationSettings()

  const leadDays = settings?.compliance_reminder_lead_days ?? DEFAULT_COMPLIANCE_LEAD_DAYS

  return useMemo(
    () => ({ timeZone: organization.time_zone, leadDays }),
    [organization.time_zone, leadDays],
  )
}

/** Distance unit for odometer display, defaulting to kilometres. */
export function useDistanceUnit(): 'km' | 'mi' {
  const { data: settings } = useOrganizationSettings()
  return settings?.distance_unit === 'mi' ? 'mi' : 'km'
}
