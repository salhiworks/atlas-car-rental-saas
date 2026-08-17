import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { FullPageLoader } from '@/components/feedback/FullPageLoader'
import { Alert, Button, Field, Input, useToast } from '@/components/ui'
import { updatePassword } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { useAuth } from '@/features/auth/auth-context'
import { type ResetPasswordInput, resetPasswordSchema } from '@/features/auth/schemas'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * Completes a password reset.
 *
 * The recovery link carries a code that the Supabase client exchanges for a
 * session as the page loads. Until that resolves the status is `loading`; if it
 * ends `unauthenticated`, the link was expired, already used, or opened in a
 * different browser from the one that requested it — the PKCE verifier lives in
 * that browser's storage.
 */
export function ResetPasswordPage() {
  const { status } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await updatePassword(values.password)
      toast.success('Password updated', 'Use your new password from now on.')
      void navigate(paths.overview, { replace: true })
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  if (status === 'loading') {
    return <FullPageLoader label="Checking your reset link" />
  }

  if (status === 'unauthenticated') {
    return (
      <AuthLayout
        title="This link is no longer valid"
        description="Reset links expire after an hour and can only be used once."
        footer={
          <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
            Back to sign in
          </Link>
        }
      >
        <Alert tone="caution" title="Request a new link">
          Open the link on the same device and browser you requested it from. If you no longer have
          it, start again from the forgot-password screen.
        </Alert>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          className="mt-4"
          onClick={() => void navigate(paths.forgotPassword)}
        >
          Request a new link
        </Button>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Choose a new password" description="You are signed in while you set it.">
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {formError ? <Alert tone="critical">{formError}</Alert> : null}

        <Field
          label="New password"
          error={errors.password?.message}
          hint="At least 8 characters."
          required
        >
          <Input type="password" autoComplete="new-password" autoFocus {...register('password')} />
        </Field>

        <Field label="Confirm new password" error={errors.confirmPassword?.message} required>
          <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
        </Field>

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Update password
        </Button>
      </form>
    </AuthLayout>
  )
}
