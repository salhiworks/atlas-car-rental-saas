import { useQuery } from '@tanstack/react-query'

import { queryKeys } from '@/lib/query/keys'

import { createLogoSignedUrl } from './api'

/**
 * Resolves a displayable URL for an agency logo.
 *
 * The logo bucket is private, so there is no stable public URL to store on the
 * organization row: a signed URL is minted per session and refreshed before it
 * expires. `staleTime` is kept comfortably under the signature lifetime so the
 * interface never renders a link that has already lapsed.
 */
const SIGNED_URL_TTL_SECONDS = 3600

export function useOrganizationLogo(organizationId: string, logoPath: string | null) {
  return useQuery({
    queryKey: queryKeys.organizationLogo(organizationId, logoPath),
    queryFn: () => createLogoSignedUrl(logoPath!, SIGNED_URL_TTL_SECONDS),
    enabled: logoPath !== null,
    staleTime: (SIGNED_URL_TTL_SECONDS - 300) * 1000,
    gcTime: SIGNED_URL_TTL_SECONDS * 1000,
    retry: 1,
  })
}
