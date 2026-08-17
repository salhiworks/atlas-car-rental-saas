import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Alert, Button, Field, Input } from '@/components/ui'
import { signIn } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { type SignInInput, signInSchema } from '@/features/auth/schemas'
import { toErrorMessage } from '@/lib/supabase/errors'

export function SignInPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await signIn(values)
      // Return the user to wherever they were headed before the redirect.
      const state = location.state as { from?: string } | null
      void navigate(state?.from ?? paths.overview, { replace: true })
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  return (
    <AuthLayout
      title="Sign in"
      description="Access your agency's fleet, contracts and finances."
      footer={
        <>
          New to the platform?{' '}
          <Link to={paths.signUp} className="text-brand-700 font-medium hover:underline">
            Create an agency account
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {formError ? <Alert tone="critical">{formError}</Alert> : null}

        <Field label="Email" error={errors.email?.message} required>
          <Input
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="you@agency.com"
            {...register('email')}
          />
        </Field>

        <Field label="Password" error={errors.password?.message} required>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>

        <div className="flex justify-end">
          <Link
            to={paths.forgotPassword}
            className="text-ink-muted hover:text-ink text-[0.8125rem]"
          >
            Forgot your password?
          </Link>
        </div>

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
