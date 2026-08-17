import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { Alert, Button, Field, Input, Select } from '@/components/ui'
import { createOrganization } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/AuthLayout'
import { useAuth } from '@/features/auth/auth-context'
import { type CreateOrganizationInput, createOrganizationSchema } from '@/features/auth/schemas'
import { useWorkspace } from '@/features/workspace/workspace-context'
import { listTimeZones } from '@/lib/datetime/timezone'
import { guessRegionalDefaults, listCountries, listCurrencies } from '@/lib/i18n/regions'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * Onboarding for a signed-in user who has no agency.
 *
 * Normally unreachable — sign-up provisions the agency in the same transaction
 * as the account. It exists for the two cases that genuinely occur: provisioning
 * failed at sign-up (the trigger deliberately lets the account survive that),
 * and a user who has been removed from the last agency they belonged to.
 */
export function CreateAgencyPage() {
  const navigate = useNavigate()
  const { refresh } = useWorkspace()
  const { signOut } = useAuth()
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
  } = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: {
      organizationName: '',
      countryCode: defaults.countryCode ?? '',
      defaultCurrency: 'USD',
      timeZone: defaults.timeZone,
    },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await createOrganization(values)
      await refresh()
      void navigate(paths.overview, { replace: true })
    } catch (error) {
      setFormError(toErrorMessage(error))
    }
  })

  return (
    <AuthLayout
      title="Set up your agency"
      description="You are signed in but not part of an agency yet. Create one to get started."
      footer={
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-ink-muted hover:text-ink"
        >
          Sign out
        </button>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" noValidate>
        {formError ? <Alert tone="critical">{formError}</Alert> : null}

        {/*
          Shown to everybody who lands here without a membership, because the
          alternative is asking the database whether this address was invited —
          which would turn onboarding into a way to test whether an arbitrary
          person has been invited to anything. Saying it unconditionally costs a
          sentence and tells nobody anything they did not already know.
        */}
        <Alert tone="info" title="Were you invited to an agency?">
          Open the invitation link from your email instead. Creating an agency here starts a new one
          of your own, which is not what you want if you meant to join a colleague&rsquo;s.
        </Alert>

        <Field label="Agency name" error={errors.organizationName?.message} required>
          <Input autoComplete="organization" autoFocus {...register('organizationName')} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country" error={errors.countryCode?.message} required>
            <Select
              options={countries}
              placeholder="Choose a country"
              {...register('countryCode')}
            />
          </Field>

          <Field label="Currency" error={errors.defaultCurrency?.message} required>
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

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Create agency
        </Button>
      </form>
    </AuthLayout>
  )
}
