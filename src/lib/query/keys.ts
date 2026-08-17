/**
 * Centralised React Query keys.
 *
 * Every key is prefixed with the organization id so that switching agency, or
 * being removed from one, cannot leave another tenant's data in the cache under
 * a colliding key.
 */
export const queryKeys = {
  workspace: (userId: string) => ['workspace', userId] as const,
  profile: (userId: string) => ['profile', userId] as const,
  organizationSettings: (organizationId: string) =>
    ['organization', organizationId, 'settings'] as const,
  organizationLogo: (organizationId: string, path: string | null) =>
    ['organization', organizationId, 'logo', path] as const,
  overview: (organizationId: string, from: string, to: string) =>
    ['organization', organizationId, 'overview', from, to] as const,
  financialSeries: (organizationId: string, from: string, to: string, granularity: string) =>
    ['organization', organizationId, 'financial-series', from, to, granularity] as const,
} as const
