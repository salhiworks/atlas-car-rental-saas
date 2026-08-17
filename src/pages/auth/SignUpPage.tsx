import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Alert, Button, Field, Input, Select } from '@/components/ui'
import { signUp } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { type SignUpInput, signUpSchema } from '@/features/auth/schemas'
import { listTimeZones } from '@/lib/datetime/timezone'
import { guessRegionalDefaults, listCountries, listCurrencies } from '@/lib/i18n/regions'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * Creates the account and the agency together.
 *
 * Currency, time zone and country are asked for here rather than deferred to
 * settings because every figure and every contract date the agency records from
 * this moment on depends on them. They are pre-filled from the browser, so for
 * most people this is three fields to confirm rather than three to answer.
 */
export function SignUpPage() {
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)

  const defaults = useMemo(() => guessRegionalDefaults(), [])
  const countries = useMemo(() => listCountries(), [])
  const currencies = useMemo(() => listCurrencies(), [])
  const timeZones = useMemo(
    () => listTimeZones().map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') })),
    [],
  )

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      fullName: '',
      email: '',
      password: '',
      confirmPassword: '',
      organizationName: '',
      countryCode: defaults.countryCode ?? '',
      defaultCurrency: 'USD',
      timeZone: defaults.timeZone,
    },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      const result = await signUp(values)
      if (result.hasSession) {
        void navigate(paths.overview, { replace: true })
      } else {
        void navigate(paths.confirmEmail, { replace: true, state: { email: result.email } })
      }
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  return (
    <AuthLayout
      title="Create your agency"
      description="Set up your workspace. You can invite the rest of your team afterwards."
      footer={
        <>
          Already have an account?{' '}
          <Link to={paths.signIn} className="text-brand-700 font-medium hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {formError ? <Alert tone="critical">{formError}</Alert> : null}

        <Field label="Your name" error={errors.fullName?.message} required>
          <Input autoComplete="name" autoFocus {...register('fullName')} />
        </Field>

        <Field label="Work email" error={errors.email?.message} required>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@agency.com"
            {...register('email')}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Password"
            error={errors.password?.message}
            hint="At least 8 characters."
            required
          >
            <Input type="password" autoComplete="new-password" {...register('password')} />
          </Field>

          <Field label="Confirm password" error={errors.confirmPassword?.message} required>
            <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
          </Field>
        </div>

        <div className="border-line space-y-4 border-t pt-4">
          <Field label="Agency name" error={errors.organizationName?.message} required>
            <Input autoComplete="organization" {...register('organizationName')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Country" error={errors.countryCode?.message} required>
              <Select
                options={countries}
                placeholder="Choose a country"
                {...register('countryCode')}
              />
            </Field>

            <Field
              label="Currency"
              error={errors.defaultCurrency?.message}
              hint="Used for new records."
              required
            >
              <Select options={currencies} {...register('defaultCurrency')} />
            </Field>
          </div>

          <Field
            label="Time zone"
            error={errors.timeZone?.message}
            hint="Pick-up and return times are shown in this zone."
            required
          >
            <Select options={timeZones} {...register('timeZone')} />
          </Field>
        </div>

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Create agency
        </Button>
      </form>
    </AuthLayout>
  )
}
