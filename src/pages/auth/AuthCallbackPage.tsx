import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { FullPageLoader } from '@/components/feedback/FullPageLoader'
import { Alert, Button } from '@/components/ui'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { useAuth } from '@/features/auth/auth-context'

/**
 * Landing point for email confirmation links.
 *
 * The Supabase client exchanges the code in the URL for a session on load, so
 * this route only has to wait for the outcome and route accordingly.
 */
export function AuthCallbackPage() {
  const { status } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (status === 'authenticated') {
      void navigate(paths.overview, { replace: true })
    }
  }, [status, navigate])

  if (status === 'loading' || status === 'authenticated') {
    return <FullPageLoader label="Confirming your account" />
  }

  return (
    <AuthLayout
      title="This link did not work"
      description="Confirmation links expire and can only be used once."
      footer={
        <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
          Back to sign in
        </Link>
      }
    >
      <Alert tone="caution" title="Try signing in">
        If you have already confirmed your address, sign in as normal. Otherwise request a new
        confirmation email from the sign-in screen.
      </Alert>
      <Button
        variant="primary"
        size="lg"
        fullWidth
        className="mt-4"
        onClick={() => void navigate(paths.signIn)}
      >
        Go to sign in
      </Button>
    </AuthLayout>
  )
}
