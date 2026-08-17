import { MailCheck } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Alert, Button, useToast } from '@/components/ui'
import { resendConfirmationEmail } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * Shown after sign-up when the deployment requires email confirmation.
 *
 * The account and the agency already exist at this point — the trigger created
 * both — so this is purely a verification gate, and nothing is lost if the
 * person closes the tab and follows the link later.
 */
export function ConfirmEmailPage() {
  const location = useLocation()
  const toast = useToast()
  const [isResending, setIsResending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const state = location.state as { email?: string } | null
  const email = state?.email ?? null

  const handleResend = () => {
    if (!email) return
    setIsResending(true)
    setError(null)

    resendConfirmationEmail(email)
      .then(() => {
        toast.success('Confirmation email sent', `Sent again to ${email}.`)
      })
      .catch((cause: unknown) => {
        setError(toErrorMessage(cause))
      })
      .finally(() => {
        setIsResending(false)
      })
  }

  return (
    <AuthLayout
      title="Confirm your email"
      description={
        email ? (
          <>
            We sent a confirmation link to <span className="text-ink font-medium">{email}</span>.
            Open it to activate your agency.
          </>
        ) : (
          'Open the confirmation link we sent you to activate your agency.'
        )
      }
      footer={
        <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
          Back to sign in
        </Link>
      }
    >
      <div className="space-y-4">
        {error ? <Alert tone="critical">{error}</Alert> : null}

        <div className="border-line flex items-center gap-3 rounded-lg border p-4">
          <MailCheck className="text-brand-600 size-5 shrink-0" aria-hidden="true" />
          <p className="text-ink-muted text-[0.8125rem] leading-5">
            Your agency has been created and is waiting for you. Nothing else is needed until you
            open the link.
          </p>
        </div>

        {email ? (
          <Button variant="secondary" fullWidth isLoading={isResending} onClick={handleResend}>
            Send the email again
          </Button>
        ) : null}
      </div>
    </AuthLayout>
  )
}
