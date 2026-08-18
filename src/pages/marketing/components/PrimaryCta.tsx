import { paths } from '@/app/routes/paths'
import { ButtonLink, type ButtonSize, type ButtonVariant } from '@/components/ui'
import { useAuth } from '@/features/auth/auth-context'

export interface PrimaryCtaProps {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
}

/**
 * "Start your agency" everywhere on the public site — except for the one
 * session that should never reach this page: if an authenticated user somehow
 * lands here (routing does not allow it today, but this keeps the promise
 * true if that ever changes), it opens the dashboard instead of running
 * sign-up a second time and provisioning a second agency.
 */
export function PrimaryCta({ variant = 'primary', size = 'lg', className }: PrimaryCtaProps) {
  const { status } = useAuth()
  const isAuthenticated = status === 'authenticated'

  return (
    <ButtonLink
      to={isAuthenticated ? paths.overview : paths.signUp}
      variant={variant}
      size={size}
      className={className}
    >
      {isAuthenticated ? 'Open dashboard' : 'Start your agency'}
    </ButtonLink>
  )
}
