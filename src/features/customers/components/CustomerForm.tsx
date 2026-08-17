import { zodResolver } from '@hookform/resolvers/zod'
import { useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'

import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui'
import { SUPPORTED_LOCALES, listCountries } from '@/lib/i18n/regions'

import {
  CUSTOMER_TYPE_OPTIONS,
  customerSchema,
  emptyCustomerForm,
  type CustomerFormInput,
  type CustomerFormValues,
} from '../schemas'
import { DuplicateWarning } from './DuplicateWarning'

export interface CustomerFormProps {
  defaultValues?: CustomerFormInput
  submitLabel: string
  isSubmitting?: boolean
  /** Excluded from duplicate checks when editing, so a record cannot match itself. */
  currentCustomerId?: string
  onSubmit: (values: CustomerFormValues) => void
  onCancel: () => void
}

/**
 * The one customer form, used to add and to edit.
 *
 * Grouped the way a person is described rather than in column order, and
 * deliberately short: identification is not collected here. A customer is often
 * created before their passport is in hand — at the phone, taking a booking —
 * and a form that demands documents would make that impossible. Documents are
 * added on the profile, where a scan can be attached at the same time.
 */
export function CustomerForm({
  defaultValues,
  submitLabel,
  isSubmitting = false,
  currentCustomerId,
  onSubmit,
  onCancel,
}: CustomerFormProps) {
  const [formError, setFormError] = useState<string | null>(null)
  const countries = useMemo(() => listCountries(), [])

  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CustomerFormInput, unknown, CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: defaultValues ?? emptyCustomerForm(),
  })

  const customerType = useWatch({ control, name: 'customerType' })
  const email = useWatch({ control, name: 'email' })
  const phone = useWatch({ control, name: 'phone' })
  const isCompany = customerType === 'company'

  const submit = handleSubmit(
    (values) => {
      setFormError(null)
      onSubmit(values)
    },
    () => setFormError('Some fields need attention. Check the highlighted entries below.'),
  )

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-6" noValidate>
      {formError ? <Alert tone="critical">{formError}</Alert> : null}

      {/* Contact details are a hint, never a bar: families and companies
          legitimately share a phone number. */}
      <DuplicateWarning
        email={email ?? ''}
        phone={phone ?? ''}
        excludeCustomerId={currentCustomerId}
      />

      <Card>
        <CardHeader
          title="Personal information"
          description="Who the contract will be in the name of."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Customer type" required>
              <Select options={CUSTOMER_TYPE_OPTIONS} {...register('customerType')} />
            </Field>
          </div>

          {isCompany ? (
            <Field label="Company name" error={errors.companyName?.message} required>
              <Input autoFocus autoComplete="organization" {...register('companyName')} />
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" error={errors.firstName?.message} required>
                <Input autoFocus autoComplete="given-name" {...register('firstName')} />
              </Field>

              <Field label="Last name" error={errors.lastName?.message}>
                <Input autoComplete="family-name" {...register('lastName')} />
              </Field>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date of birth" error={errors.dateOfBirth?.message}>
              <Input type="date" {...register('dateOfBirth')} />
            </Field>

            <Field
              label="Nationality"
              error={errors.nationalityCountryCode?.message}
              hint="Separate from the address country."
            >
              <Select
                options={[{ value: '', label: 'Not recorded' }, ...countries]}
                {...register('nationalityCountryCode')}
              />
            </Field>

            <Field label="Preferred language" error={errors.preferredLocale?.message}>
              <Select
                options={[
                  { value: '', label: 'Not recorded' },
                  ...SUPPORTED_LOCALES.map((locale) => ({ ...locale })),
                ]}
                {...register('preferredLocale')}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Contact" description="How the agency reaches this customer." />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Email" error={errors.email?.message}>
              <Input type="email" autoComplete="email" {...register('email')} />
            </Field>

            <Field label="Phone" error={errors.phone?.message}>
              <Input type="tel" autoComplete="tel" {...register('phone')} />
            </Field>

            <Field
              label="Second phone"
              error={errors.secondaryPhone?.message}
              hint="A hotel, a colleague, next of kin."
            >
              <Input type="tel" {...register('secondaryPhone')} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Address" description="Appears on the rental contract." />
        <CardBody className="space-y-4">
          <Field label="Address" error={errors.addressLine1?.message}>
            <Input autoComplete="address-line1" {...register('addressLine1')} />
          </Field>

          <Field label="Address line 2" error={errors.addressLine2?.message}>
            <Input autoComplete="address-line2" {...register('addressLine2')} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="City" error={errors.city?.message}>
              <Input autoComplete="address-level2" {...register('city')} />
            </Field>

            {/* "Region" rather than "State": most of the world does not have
                states, and a US-shaped form is wrong nearly everywhere. */}
            <Field label="Region" error={errors.region?.message}>
              <Input autoComplete="address-level1" {...register('region')} />
            </Field>

            <Field label="Postal code" error={errors.postalCode?.message}>
              <Input autoComplete="postal-code" {...register('postalCode')} />
            </Field>

            <Field label="Country" error={errors.countryCode?.message}>
              <Select
                options={[{ value: '', label: 'Not recorded' }, ...countries]}
                {...register('countryCode')}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Internal notes"
          description="Visible to your team only. Never shown to the customer or printed on a contract."
        />
        <CardBody>
          <Field label="Notes" hideLabel error={errors.notes?.message}>
            <Textarea
              rows={3}
              placeholder="Prefers automatic vehicles, always returns the car early…"
              {...register('notes')}
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" isLoading={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** Turns a stored customer back into form values. */
export function customerToFormInput(customer: {
  customer_type: 'individual' | 'company'
  first_name: string | null
  last_name: string | null
  company_name: string | null
  email: string | null
  phone: string | null
  secondary_phone: string | null
  date_of_birth: string | null
  nationality_country_code: string | null
  preferred_locale: string | null
  address_line1?: string | null
  address_line2?: string | null
  city: string | null
  region?: string | null
  postal_code?: string | null
  country_code: string | null
  notes?: string | null
}): CustomerFormInput {
  return {
    customerType: customer.customer_type,
    firstName: customer.first_name ?? '',
    lastName: customer.last_name ?? '',
    companyName: customer.company_name ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    secondaryPhone: customer.secondary_phone ?? '',
    dateOfBirth: customer.date_of_birth ?? '',
    nationalityCountryCode: customer.nationality_country_code ?? '',
    preferredLocale: customer.preferred_locale ?? '',
    addressLine1: customer.address_line1 ?? '',
    addressLine2: customer.address_line2 ?? '',
    city: customer.city ?? '',
    region: customer.region ?? '',
    postalCode: customer.postal_code ?? '',
    countryCode: customer.country_code ?? '',
    notes: customer.notes ?? '',
  }
}
