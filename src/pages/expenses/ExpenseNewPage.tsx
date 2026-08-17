import { Check, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { expenseDetailPath, paths } from '@/app/routes/paths'
import { Button, ButtonLink, PageHeader, useToast } from '@/components/ui'
import { ExpenseForm } from '@/features/expenses/components/ExpenseForm'
import { useCreateExpense, useExpenseCategories } from '@/features/expenses/queries'
import {
  buildExpenseSchema,
  emptyExpenseForm,
  type ExpenseFormInput,
} from '@/features/expenses/schemas'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { toIsoDateInTimeZone } from '@/lib/datetime/timezone'
import { toErrorMessage } from '@/lib/supabase/errors'
import type { ExpenseAllocation } from '@/types/database'

/**
 * Recording a cost.
 *
 * Context may arrive from a vehicle or a rental page — only an id and an
 * allocation, both re-validated here and again by the database. There is no
 * lighter path: a cost created from a vehicle page goes through this same form
 * and the same constraints as one created from scratch.
 */
export function ExpenseNewPage() {
  const organization = useOrganization()
  const navigate = useNavigate()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const createExpense = useCreateExpense()
  const categoriesQuery = useExpenseCategories()

  const canManageVendors = usePermission('expenseVendors.manage')

  const prefill = useMemo(() => {
    const vehicleId = searchParams.get('vehicle')
    const rentalId = searchParams.get('rental')

    if (rentalId) return { allocation: 'rental' as ExpenseAllocation, rentalId, vehicleId: null }
    if (vehicleId) return { allocation: 'vehicle' as ExpenseAllocation, vehicleId, rentalId: null }
    return null
  }, [searchParams])

  const [values, setValues] = useState<ExpenseFormInput>(() => {
    const base = emptyExpenseForm(
      organization.default_currency,
      toIsoDateInTimeZone(new Date(), organization.time_zone),
    )
    if (!prefill) return base
    return {
      ...base,
      allocation: prefill.allocation,
      vehicleId: prefill.vehicleId ?? '',
      rentalId: prefill.rentalId ?? '',
    }
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Deliberately not pre-selected. A category chosen for somebody is a
  // category nobody read, and every cost in the agency would drift towards
  // whichever one happened to sort first.
  const categories = categoriesQuery.data ?? []

  const submit = async () => {
    const schema = buildExpenseSchema(values.currency || organization.default_currency)
    const parsed = schema.safeParse(values)

    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form')
        next[key] ??= issue.message
      }
      setErrors(next)
      return
    }

    setErrors({})

    try {
      const expense = await createExpense.mutateAsync(parsed.data)
      toast.success('Cost recorded', parsed.data.description)
      void navigate(expenseDetailPath(expense.id))
    } catch (failure) {
      setErrors({ form: toErrorMessage(failure) })
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Record a cost"
        eyebrow="Finance"
        description="What the agency spent, and what it belongs to."
        actions={
          <ButtonLink variant="ghost" leadingIcon={<X />} to={paths.expenses}>
            Cancel
          </ButtonLink>
        }
      />

      <div className="max-w-3xl space-y-4">
        <ExpenseForm
          values={values}
          onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
          errors={errors}
          categories={categories}
          canManageVendors={canManageVendors}
          locale={organization.locale}
          {...(prefill ? { lockedRelation: prefill.allocation as 'vehicle' | 'rental' } : {})}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          <ButtonLink variant="ghost" to={paths.expenses}>
            Cancel
          </ButtonLink>
          <Button
            variant="primary"
            leadingIcon={<Check />}
            onClick={() => void submit()}
            isLoading={createExpense.isPending}
          >
            Record cost
          </Button>
        </div>

        <p className="text-ink-subtle text-[0.75rem]">
          Receipts are attached on the next screen, once the cost exists to attach them to.
        </p>
      </div>
    </div>
  )
}
