import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useLocation, useNavigate } from 'react-router-dom'

import {
  Alert,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  PageHeader,
  SaveBar,
  Select,
  useToast,
} from '@/components/ui'
import { ContractTermsSection } from '@/features/rentals/components/ContractTermsSection'
import { NotificationPreferences } from '@/features/notifications/components/NotificationPreferences'
import { AboutSection } from '@/features/settings/components/AboutSection'
import { LogoUploader } from '@/features/settings/components/LogoUploader'
import { SettingsNav } from '@/features/settings/components/SettingsNav'
import { type AgencySettingsInput, agencySettingsSchema } from '@/features/settings/schemas'
import { updateOrganization } from '@/features/workspace/api'
import {
  useOrganization,
  usePermission,
  useWorkspace,
} from '@/features/workspace/workspace-context'
import { ROLE_LABELS } from '@/lib/authz/permissions'
import { listTimeZones } from '@/lib/datetime/timezone'
import { SUPPORTED_LOCALES, listCountries, listCurrencies } from '@/lib/i18n/regions'
import { toErrorMessage } from '@/lib/supabase/errors'
import { getAppName } from '@/lib/config/env'

const SECTION_IDS = [
  'general',
  'regional',
  'branding',
  'contract',
  'notifications',
  'about',
] as const

type SectionId = (typeof SECTION_IDS)[number]

function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value)
}

/** Which section a field belongs to, so the rail can mark what is unsaved. */
const REGIONAL_FIELDS = ['defaultCurrency', 'timeZone', 'locale'] as const

/**
 * Agency settings.
 *
 * Editing is restricted to administrators and owners — the same boundary the
 * `organizations_update` RLS policy enforces. Everyone else sees the values,
 * because knowing the agency's currency and time zone matters to whoever is
 * writing contracts, even if they cannot change them.
 *
 * The page shows one section at a time. Every section is still mounted, hidden
 * rather than unmounted, so a half-finished edit survives a look at another
 * section and the rail can say which sections are holding one.
 */
export function SettingsPage() {
  const organization = useOrganization()
  const { role, refresh } = useWorkspace()
  const canEdit = usePermission('organization.update')
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [formError, setFormError] = useState<string | null>(null)
  const [isTermsDirty, setIsTermsDirty] = useState(false)

  const hash = location.hash.replace('#', '')
  const activeSection: SectionId = isSectionId(hash) ? hash : 'general'

  const selectSection = useCallback(
    (id: string) => {
      void navigate({ hash: `#${id}` }, { replace: true })
      window.scrollTo({ top: 0 })
    },
    [navigate],
  )

  const countries = useMemo(() => listCountries(organization.locale), [organization.locale])
  const currencies = useMemo(() => listCurrencies(organization.locale), [organization.locale])
  const timeZones = useMemo(
    () => listTimeZones().map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') })),
    [],
  )

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty, dirtyFields },
  } = useForm<AgencySettingsInput>({
    resolver: zodResolver(agencySettingsSchema),
    defaultValues: {
      name: organization.name,
      legalName: organization.legal_name ?? '',
      taxIdentifier: organization.tax_identifier ?? '',
      email: organization.email ?? '',
      phone: organization.phone ?? '',
      website: organization.website ?? '',
      addressLine1: organization.address_line1 ?? '',
      addressLine2: organization.address_line2 ?? '',
      city: organization.city ?? '',
      region: organization.region ?? '',
      postalCode: organization.postal_code ?? '',
      countryCode: organization.country_code ?? '',
      defaultCurrency: organization.default_currency,
      timeZone: organization.time_zone,
      locale: organization.locale,
    },
  })

  const mutation = useMutation({
    mutationFn: async (values: AgencySettingsInput) => {
      const parsed = agencySettingsSchema.parse(values)
      return updateOrganization(organization.id, {
        name: parsed.name,
        legal_name: parsed.legalName,
        tax_identifier: parsed.taxIdentifier,
        email: parsed.email,
        phone: parsed.phone,
        website: parsed.website,
        address_line1: parsed.addressLine1,
        address_line2: parsed.addressLine2,
        city: parsed.city,
        region: parsed.region,
        postal_code: parsed.postalCode,
        country_code: parsed.countryCode,
        default_currency: parsed.defaultCurrency,
        time_zone: parsed.timeZone,
        locale: parsed.locale,
      })
    },
    onSuccess: async (updated) => {
      setFormError(null)
      await refresh()
      // Re-baseline the form so `isDirty` reflects the saved state.
      reset({
        name: updated.name,
        legalName: updated.legal_name ?? '',
        taxIdentifier: updated.tax_identifier ?? '',
        email: updated.email ?? '',
        phone: updated.phone ?? '',
        website: updated.website ?? '',
        addressLine1: updated.address_line1 ?? '',
        addressLine2: updated.address_line2 ?? '',
        city: updated.city ?? '',
        region: updated.region ?? '',
        postalCode: updated.postal_code ?? '',
        countryCode: updated.country_code ?? '',
        defaultCurrency: updated.default_currency,
        timeZone: updated.time_zone,
        locale: updated.locale,
      })
      toast.success('Settings saved')
    },
    onError: (error: unknown) => {
      setFormError(toErrorMessage(error))
    },
  })

  const isRegional = (key: string) => (REGIONAL_FIELDS as readonly string[]).includes(key)

  const onSubmit = handleSubmit(
    (values) => {
      setFormError(null)
      mutation.mutate(values)
    },
    (invalid) => {
      /*
       * A rejected field can be in the section the reader is not looking at.
       *
       * The agency form spans General and Regional, so clearing the agency name
       * and then saving from Regional made the Save button do nothing at all:
       * the message was rendered, correctly, inside a section that was hidden.
       * Silence is the one answer a save button must never give — so the page
       * moves to whichever section is holding the problem.
       */
      const firstInvalidKey = Object.keys(invalid)[0]
      if (firstInvalidKey === undefined) return
      const target: SectionId = isRegional(firstInvalidKey) ? 'regional' : 'general'
      if (target !== activeSection) selectSection(target)
    },
  )

  const selectedCurrency = useWatch({ control, name: 'defaultCurrency' })
  const currencyChanged = selectedCurrency !== organization.default_currency
  const isBusy = isSubmitting || mutation.isPending

  // The agency form spans two sections, so "unsaved" has to be attributed to
  // the section the edit was actually made in.
  const dirtyKeys = Object.entries(dirtyFields)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key)
  const isRegionalDirty = dirtyKeys.some(isRegional)
  const isGeneralDirty = dirtyKeys.some((key) => !isRegional(key))

  const sections = [
    { id: 'general', label: 'General', isDirty: isGeneralDirty },
    { id: 'regional', label: 'Regional', isDirty: isRegionalDirty },
    { id: 'branding', label: 'Branding' },
    { id: 'contract', label: 'Contract terms', isDirty: isTermsDirty },
    { id: 'notifications', label: 'Notifications' },
    { id: 'about', label: 'About' },
  ]

  const agencySaveBar = canEdit ? (
    <SaveBar
      isDirty={isDirty}
      isSaving={isBusy}
      onDiscard={() => reset()}
      onSave={() => void onSubmit()}
      message="Unsaved changes to your agency settings."
    />
  ) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        eyebrow="Agency"
        description={`Details, branding, contract wording and preferences for ${organization.name}.`}
      />

      {!canEdit ? (
        <Alert tone="info" title="You have view-only access">
          Your role ({role ? ROLE_LABELS[role] : 'member'}) can see these settings but not change
          them. An owner or administrator can update them.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <SettingsNav sections={sections} activeId={activeSection} onSelect={selectSection} />

        {/* A settings form is read line by line, not scanned across: past about
            720px the label and its control drift apart and the eye loses the
            row it was on. */}
        <div className="min-w-0 max-w-3xl">
          {formError ? (
            <Alert tone="critical" className="mb-6">
              {formError}
            </Alert>
          ) : null}

          {/* One form across General and Regional: they are one row in one
              table, and splitting the save would mean two round trips to change
              a currency and an address. */}
          <form onSubmit={(event) => void onSubmit(event)} noValidate>
            <Section
              id="general"
              isActive={activeSection === 'general'}
              title="General"
              description="Who the agency is on the paperwork it issues."
            >
              <Card>
                <CardHeader
                  title="Agency details"
                  description="Used across the workspace and on the documents you issue."
                />
                <CardBody className="space-y-5">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Agency name" error={errors.name?.message} required>
                      <Input disabled={!canEdit} {...register('name')} />
                    </Field>

                    <Field
                      label="Registered legal name"
                      error={errors.legalName?.message}
                      hint="If it differs from the trading name."
                    >
                      <Input disabled={!canEdit} {...register('legalName')} />
                    </Field>
                  </div>

                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Tax identifier" error={errors.taxIdentifier?.message}>
                      <Input disabled={!canEdit} {...register('taxIdentifier')} />
                    </Field>

                    <Field label="Email" error={errors.email?.message}>
                      <Input type="email" disabled={!canEdit} {...register('email')} />
                    </Field>

                    <Field label="Phone" error={errors.phone?.message}>
                      <Input type="tel" disabled={!canEdit} {...register('phone')} />
                    </Field>
                  </div>

                  <Field
                    label="Website"
                    error={errors.website?.message}
                    hint="For example, agency.com"
                    className="sm:max-w-md"
                  >
                    <Input disabled={!canEdit} {...register('website')} />
                  </Field>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Business address"
                  description="Appears on contracts and receipts."
                />
                <CardBody className="space-y-5">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Address line 1" error={errors.addressLine1?.message}>
                      <Input
                        disabled={!canEdit}
                        autoComplete="address-line1"
                        {...register('addressLine1')}
                      />
                    </Field>

                    <Field label="Address line 2" error={errors.addressLine2?.message}>
                      <Input
                        disabled={!canEdit}
                        autoComplete="address-line2"
                        {...register('addressLine2')}
                      />
                    </Field>
                  </div>

                  <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="City" error={errors.city?.message}>
                      <Input
                        disabled={!canEdit}
                        autoComplete="address-level2"
                        {...register('city')}
                      />
                    </Field>

                    <Field label="Region" error={errors.region?.message}>
                      <Input
                        disabled={!canEdit}
                        autoComplete="address-level1"
                        {...register('region')}
                      />
                    </Field>

                    <Field label="Postal code" error={errors.postalCode?.message}>
                      <Input
                        disabled={!canEdit}
                        autoComplete="postal-code"
                        {...register('postalCode')}
                      />
                    </Field>

                    <Field label="Country" error={errors.countryCode?.message}>
                      <Select
                        disabled={!canEdit}
                        options={countries}
                        placeholder="Choose a country"
                        {...register('countryCode')}
                      />
                    </Field>
                  </div>
                </CardBody>
              </Card>

              {agencySaveBar}
            </Section>

            <Section
              id="regional"
              isActive={activeSection === 'regional'}
              title="Regional"
              description="How money, dates and times are recorded and displayed."
            >
              <Card>
                <CardHeader
                  title="Currency, time and language"
                  description="These apply to this agency, not to your account."
                />
                <CardBody className="divide-line divide-y">
                  <Field
                    layout="row"
                    label="Default currency"
                    error={errors.defaultCurrency?.message}
                    hint="Applies to new records. Existing ones keep the currency they were written in."
                    required
                    className="pb-5"
                  >
                    <Select
                      disabled={!canEdit}
                      options={currencies}
                      {...register('defaultCurrency')}
                    />
                  </Field>

                  <Field
                    layout="row"
                    label="Time zone"
                    error={errors.timeZone?.message}
                    hint="Pick-up and return times, and the agency's own idea of today, use this zone."
                    required
                    className="py-5"
                  >
                    <Select disabled={!canEdit} options={timeZones} {...register('timeZone')} />
                  </Field>

                  <Field
                    layout="row"
                    label="Language"
                    error={errors.locale?.message}
                    hint="Number, date and currency formatting follow it."
                    required
                    className="pt-5"
                  >
                    <Select
                      disabled={!canEdit}
                      options={SUPPORTED_LOCALES.map((locale) => ({ ...locale }))}
                      {...register('locale')}
                    />
                  </Field>
                </CardBody>
              </Card>

              {currencyChanged ? (
                <Alert tone="caution" title="Existing records keep their currency">
                  Contracts, payments and expenses already recorded in{' '}
                  {organization.default_currency} stay in {organization.default_currency}. Only new
                  records will default to the currency you choose here.
                </Alert>
              ) : null}

              {agencySaveBar}
            </Section>
          </form>

          <Section
            id="branding"
            isActive={activeSection === 'branding'}
            title="Branding"
            description="The mark that appears in the workspace and at the head of every document."
          >
            <Card>
              <CardHeader
                title="Agency logo"
                description="Shown in the sidebar, on contracts and on receipts."
              />
              <CardBody>
                <LogoUploader organization={organization} canEdit={canEdit} />
              </CardBody>
            </Card>
          </Section>

          <Section
            id="contract"
            isActive={activeSection === 'contract'}
            title="Contract terms"
            description="Your own wording and tax rate, printed on every contract you issue."
          >
            <ContractTermsSection canEdit={canEdit} onDirtyChange={setIsTermsDirty} />
          </Section>

          {/*
            Personal, and last: everything above this line is the agency's and
            needs an administrator, while this is one person's own choice about
            what they are told.
          */}
          <Section
            id="notifications"
            isActive={activeSection === 'notifications'}
            title="Notifications"
            description={`What ${getAppName()} tells you about in this agency. These preferences are yours alone.`}
          >
            <NotificationPreferences />
          </Section>

          {/*
            Last, and about the software rather than the agency. Everything above
            is the agency's own identity; this is the only section that names who
            wrote the product, which is why it sits at the end of the rail.
          */}
          <Section
            id="about"
            isActive={activeSection === 'about'}
            title={`About ${getAppName()}`}
            description="The software itself: what it is, which build you are running, and who made it."
          >
            <AboutSection />
          </Section>
        </div>
      </div>
    </div>
  )
}

interface SectionProps {
  id: SectionId
  isActive: boolean
  title: string
  description: string
  children: ReactNode
}

/**
 * One settings section.
 *
 * Hidden rather than unmounted: an administrator who edits the address, checks
 * which currency is set and comes back should find their edit where they left
 * it, and unmounting a form is the quickest way to lose it.
 */
function Section({ id, isActive, title, description, children }: SectionProps) {
  return (
    <section
      id={`settings-${id}`}
      aria-label={title}
      hidden={!isActive}
      className={isActive ? 'space-y-5' : undefined}
    >
      <div className="space-y-1">
        <h2 className="text-[1.0625rem] leading-6 font-semibold tracking-tight">{title}</h2>
        <p className="text-ink-muted max-w-2xl text-[0.8125rem] leading-5">{description}</p>
      </div>

      {children}
    </section>
  )
}
