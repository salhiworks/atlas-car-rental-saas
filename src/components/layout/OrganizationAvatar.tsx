import { useOrganizationLogo } from '@/features/workspace/useOrganizationLogo'
import { cn } from '@/lib/utils/cn'
import { getMonogram } from '@/lib/utils/monogram'
import type { Organization } from '@/types/database'

export interface OrganizationAvatarProps {
  organization: Organization
  size?: 'sm' | 'md'
  className?: string
}

/**
 * The agency's mark. Falls back to a monogram rather than a generic building
 * icon, so an agency that has not uploaded a logo still looks like itself.
 */
export function OrganizationAvatar({
  organization,
  size = 'md',
  className,
}: OrganizationAvatarProps) {
  const { data: logoUrl } = useOrganizationLogo(organization.id, organization.logo_path)

  const dimensions = size === 'md' ? 'size-8 text-[0.6875rem]' : 'size-6 text-[0.625rem]'

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        className={cn('border-line shrink-0 rounded-md border object-cover', dimensions, className)}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        'bg-brand-700 text-ink-inverse flex shrink-0 items-center justify-center rounded-md font-semibold tracking-wide',
        dimensions,
        className,
      )}
    >
      {getMonogram(organization.name)}
    </span>
  )
}
