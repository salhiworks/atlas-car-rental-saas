import { getSupabaseClient } from '@/lib/supabase/client'
import { toAppError } from '@/lib/supabase/errors'
import type { Organization, OrganizationSettings, TablesUpdate } from '@/types/database'

import type { WorkspaceMembership } from './workspace-context'

/**
 * Loads every agency the signed-in user belongs to.
 *
 * Two plain queries rather than one embedded select. Row Level Security already
 * restricts `organizations` to the caller's agencies, so the scoping is enforced
 * server-side either way — and keeping the queries flat means the tenant filter
 * lives in one place (the policy) instead of being restated in a join.
 */
export async function fetchWorkspaces(userId: string): Promise<WorkspaceMembership[]> {
  const supabase = getSupabaseClient()

  const [organizationsResult, membershipsResult] = await Promise.all([
    supabase.from('organizations').select('*'),
    supabase.from('organization_members').select('*').eq('user_id', userId).eq('status', 'active'),
  ])

  if (organizationsResult.error) throw toAppError(organizationsResult.error)
  if (membershipsResult.error) throw toAppError(membershipsResult.error)

  const organizationsById = new Map<string, Organization>(
    (organizationsResult.data ?? []).map((organization) => [organization.id, organization]),
  )

  return (membershipsResult.data ?? [])
    .flatMap((membership) => {
      const organization = organizationsById.get(membership.organization_id)
      // A membership without a readable organization means the row was removed
      // between the two queries. Drop it rather than rendering a broken entry.
      return organization ? [{ organization, membership }] : []
    })
    .sort((a, b) => a.organization.name.localeCompare(b.organization.name))
}

export async function fetchOrganizationSettings(
  organizationId: string,
): Promise<OrganizationSettings | null> {
  const { data, error } = await getSupabaseClient()
    .from('organization_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) throw toAppError(error)
  return data
}

export async function updateOrganization(
  organizationId: string,
  changes: TablesUpdate<'organizations'>,
): Promise<Organization> {
  const { data, error } = await getSupabaseClient()
    .from('organizations')
    .update(changes)
    .eq('id', organizationId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export async function updateOrganizationSettings(
  organizationId: string,
  changes: TablesUpdate<'organization_settings'>,
): Promise<OrganizationSettings> {
  const { data, error } = await getSupabaseClient()
    .from('organization_settings')
    .update(changes)
    .eq('organization_id', organizationId)
    .select('*')
    .single()

  if (error) throw toAppError(error)
  return data
}

export const LOGO_BUCKET = 'organization-logos'
export const LOGO_MAX_BYTES = 2 * 1024 * 1024
export const LOGO_ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/**
 * Uploads an agency logo.
 *
 * The object key must begin with the organization id — the storage policies
 * read that first path segment to decide who may read and write the object, so
 * the key is part of the security model rather than a naming convention.
 *
 * SVG is refused: it is an executable document format, and accepting arbitrary
 * SVG would place script content on the storage origin.
 */
export async function uploadOrganizationLogo(organizationId: string, file: File): Promise<string> {
  if (!(LOGO_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image.')
  }
  if (file.size > LOGO_MAX_BYTES) {
    throw new Error('Choose an image smaller than 2 MB.')
  }

  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
  // A new key per upload so caches and signed URLs cannot serve the old image.
  const path = `${organizationId}/logo-${Date.now()}.${extension}`

  const { error } = await getSupabaseClient()
    .storage.from(LOGO_BUCKET)
    .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })

  if (error) throw toAppError(error)
  return path
}

export async function removeOrganizationLogo(path: string): Promise<void> {
  const { error } = await getSupabaseClient().storage.from(LOGO_BUCKET).remove([path])
  if (error) throw toAppError(error)
}

/**
 * A short-lived URL for a logo in the private bucket.
 *
 * The bucket is not public, so there is no permanent URL to store: access is
 * granted per request, to a member of the agency, for a bounded window.
 */
export async function createLogoSignedUrl(path: string, expiresInSeconds = 3600): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .storage.from(LOGO_BUCKET)
    .createSignedUrl(path, expiresInSeconds)

  if (error) throw toAppError(error)
  return data.signedUrl
}
