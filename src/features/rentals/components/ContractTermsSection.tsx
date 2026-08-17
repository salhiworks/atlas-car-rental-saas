import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import {
  Alert,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  SaveBar,
  Textarea,
  useToast,
} from '@/components/ui'
import { updateOrganizationSettings } from '@/features/workspace/api'
import { useOrganizationSettings } from '@/features/workspace/useOrganizationSettings'
import { useOrganization } from '@/features/workspace/workspace-context'
import { queryKeys } from '@/lib/query/keys'
import { toErrorMessage } from '@/lib/supabase/errors'

import { formatTaxRate, parseTaxRatePercent } from '../pricing'

export interface ContractTermsSectionProps {
  canEdit: boolean
  /** Lets Settings mark the section as holding unsaved edits. */
  onDirtyChange?: (isDirty: boolean) => void
}

/**
 * The five clauses that are printed as their own headed paragraphs.
 *
 * Each gets the full width of the card. Two columns of short textareas fitted
 * more onto the screen and made every one of them harder to write in, which is
 * the wrong trade for a field that holds a paragraph somebody's lawyer wrote.
 */
const POLICIES = [
  {
    key: 'fuel_policy',
    label: 'Fuel',
    hint: 'What state the tank must come back in, and what is charged if it does not.',
    placeholder: 'Return with the same fuel level as at collection.',
  },
  {
    key: 'mileage_policy',
    label: 'Mileage',
    hint: 'Any distance included, and the rate beyond it.',
    placeholder: '',
  },
  {
    key: 'late_return_policy',
    label: 'Late return',
    hint: 'What happens when a vehicle comes back after its return time.',
    placeholder: '',
  },
  {
    key: 'damage_policy',
    label: 'Damage',
    hint: 'Who bears what, and the excess the renter is liable for.',
    placeholder: '',
  },
  {
    key: 'deposit_policy',
    label: 'Deposit',
    hint: 'When it is taken, what it covers and when it is returned.',
    placeholder: '',
  },
] as const

/**
 * The agency's contract wording and its tax rate.
 *
 * Every clause here is the agency's own text. The product ships no legal
 * wording, because a sentence that is standard in one country is unenforceable
 * in the next, and generated boilerplate presented as valid terms would be
 * worse than presenting none at all.
 *
 * Changing any of it moves the terms to a new version. Contracts already issued
 * keep the wording they were issued under, so amending these fields cannot
 * retroactively change what somebody signed.
 */
export function ContractTermsSection({ canEdit, onDirtyChange }: ContractTermsSectionProps) {
  const organization = useOrganization()
  const settingsQuery = useOrganizationSettings()
  const client = useQueryClient()
  const toast = useToast()

  const settings = settingsQuery.data

  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [taxPercent, setTaxPercent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const values = draft ?? {
    contract_terms: settings?.contract_terms ?? '',
    fuel_policy: settings?.fuel_policy ?? '',
    mileage_policy: settings?.mileage_policy ?? '',
    late_return_policy: settings?.late_return_policy ?? '',
    damage_policy: settings?.damage_policy ?? '',
    deposit_policy: settings?.deposit_policy ?? '',
    contract_footer: settings?.contract_footer ?? '',
    tax_label: settings?.tax_label ?? '',
  }

  const rate = taxPercent ?? (settings ? String(settings.tax_rate_bps / 100) : '0')

  const save = useMutation({
    mutationFn: async () => {
      const bps = parseTaxRatePercent(rate)
      if (bps === null) throw new Error('Enter the tax rate as a percentage, such as 20.')

      return updateOrganizationSettings(organization.id, {
        contract_terms: values.contract_terms?.trim() || null,
        fuel_policy: values.fuel_policy?.trim() || null,
        mileage_policy: values.mileage_policy?.trim() || null,
        late_return_policy: values.late_return_policy?.trim() || null,
        damage_policy: values.damage_policy?.trim() || null,
        deposit_policy: values.deposit_policy?.trim() || null,
        contract_footer: values.contract_footer?.trim() || null,
        tax_label: values.tax_label?.trim() || null,
        tax_rate_bps: bps,
      })
    },
    onSuccess: async () => {
      setDraft(null)
      setTaxPercent(null)
      setError(null)
      await client.invalidateQueries({ queryKey: queryKeys.organizationSettings(organization.id) })
      toast.success('Contract terms saved', 'New contracts will carry this wording.')
    },
    onError: (failure) => {
      const message = toErrorMessage(failure)
      setError(message)
      toast.error('Could not save the terms', message)
    },
  })

  const set = (key: string, value: string) =>
    setDraft((current) => ({ ...(current ?? values), [key]: value }))

  const isDirty = draft !== null || taxPercent !== null

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  return (
    <div className="space-y-5">
      <Alert tone="info" title="Contracts already issued do not change">
        Each contract records the version of these terms it was issued under. Editing here affects
        contracts issued from now on.
        {settings ? ` Currently on version ${settings.terms_version}.` : ''}
      </Alert>

      <Card>
        <CardHeader title="Tax" description="Applied to the contracts you write from now on." />
        <CardBody className="divide-line divide-y">
          <Field
            layout="row"
            label="Tax rate"
            hint={`Entered as a percentage. Applied to new contracts as ${formatTaxRate(parseTaxRatePercent(rate) ?? 0)}.`}
            className="pb-5"
          >
            <Input
              value={rate}
              inputMode="decimal"
              disabled={!canEdit}
              onChange={(event) => setTaxPercent(event.target.value)}
            />
          </Field>

          <Field
            layout="row"
            label="What the tax is called"
            hint="Printed beside the figure, for example VAT or TVA."
            className="pt-5"
          >
            <Input
              value={values.tax_label}
              maxLength={40}
              disabled={!canEdit}
              onChange={(event) => set('tax_label', event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Policies"
          description="Each is printed as its own clause, in this order. Leave one empty and it is left out."
        />
        <CardBody className="divide-line divide-y">
          {POLICIES.map((policy, index) => (
            <Field
              key={policy.key}
              label={policy.label}
              hint={policy.hint}
              className={index === 0 ? 'pb-5' : index === POLICIES.length - 1 ? 'pt-5' : 'py-5'}
            >
              <Textarea
                value={values[policy.key]}
                rows={3}
                maxLength={2000}
                disabled={!canEdit}
                placeholder={policy.placeholder || undefined}
                onChange={(event) => set(policy.key, event.target.value)}
              />
            </Field>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Full terms and conditions"
          description="Printed after the policies above. Written by you or your lawyer — this product supplies no legal text."
        />
        <CardBody className="space-y-5">
          <Field label="Terms and conditions" hideLabel>
            <Textarea
              value={values.contract_terms}
              rows={12}
              maxLength={20000}
              disabled={!canEdit}
              aria-label="Full terms and conditions"
              onChange={(event) => set('contract_terms', event.target.value)}
            />
          </Field>

          <Field label="Contract footer" hint="One line at the foot of every page.">
            <Textarea
              value={values.contract_footer}
              rows={2}
              maxLength={1000}
              disabled={!canEdit}
              onChange={(event) => set('contract_footer', event.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      {error ? <Alert tone="critical">{error}</Alert> : null}

      {canEdit ? (
        <SaveBar
          isDirty={isDirty}
          isSaving={save.isPending}
          onDiscard={() => {
            setDraft(null)
            setTaxPercent(null)
            setError(null)
          }}
          onSave={() => save.mutate()}
          saveLabel="Save terms"
          message="Unsaved changes to your contract terms."
        />
      ) : null}
    </div>
  )
}
