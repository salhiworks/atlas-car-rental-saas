import { zodResolver } from '@hookform/resolvers/zod'
import { MailCheck } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Alert, Button, Field, Input } from '@/components/ui'
import { requestPasswordReset } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { type ForgotPasswordInput, forgotPasswordSchema } from '@/features/auth/schemas'
import { toErrorMessage } from '@/lib/supabase/errors'

export function ForgotPasswordPage() {
  const [formError, setFormError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await requestPasswordReset(values.email)
      setSentTo(values.email)
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  if (sentTo) {
    return (
      <AuthLayout
        title="Check your email"
        description={
          <>
            If an account exists for <span className="text-ink font-medium">{sentTo}</span>, a reset
            link is on its way. The link is valid for one hour.
          </>
        }
        footer={
          <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="border-line flex items-center gap-3 rounded-lg border p-4">
          <MailCheck className="text-brand-600 size-5 shrink-0" aria-hidden="true" />
          <p className="text-ink-muted text-[0.8125rem] leading-5">
            Open the link on this device so the reset can complete. Nothing in your inbox after a
            few minutes? Check the spam folder.
          </p>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter the email you sign in with and we'll send you a reset link."
      footer={
        <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {formError ? <Alert tone="critical">{formError}</Alert> : null}

        <Field label="Email" error={errors.email?.message} required>
          <Input type="email" autoComplete="email" autoFocus {...register('email')} />
        </Field>

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  )
}
