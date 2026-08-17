import { ArrowLeft, Ban, Check, Pencil, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Field,
  Input,
  PageHeader,
  Skeleton,
  useToast,
} from '@/components/ui'
import { ChangeHistory } from '@/features/expenses/components/ChangeHistory'
import { AllocationCell, ExpenseStatusBadge } from '@/features/expenses/components/ExpenseBadges'
import { ExpenseForm } from '@/features/expenses/components/ExpenseForm'
import { ReceiptPanel } from '@/features/expenses/components/ReceiptPanel'
import { canEdit, canVoid, editBlockedReason } from '@/features/expenses/allocation'
import {
  useExpense,
  useExpenseCategories,
  useExpenseChanges,
  useUpdateExpense,
  useVoidExpense,
} from '@/features/expenses/queries'
import {
  buildExpenseSchema,
  PAYMENT_METHOD_LABELS,
  type ExpenseFormInput,
} from '@/features/expenses/schemas'
import { formatTaxRate } from '@/features/expenses/money'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatDate, formatDateTime } from '@/lib/datetime/format'
import { formatMoney, minorToDecimalString } from '@/lib/money/money'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * One cost, in full.
 *
 * The actions offered are the ones the record's state actually allows; the rest
 * are absent with the reason stated, because "why can't I edit this?" is the
 * question a manager actually has.
 */
export function ExpenseDetailPage() {
  const { expenseId } = useParams<{ expenseId: string }>()
  const organization = useOrganization()
  const toast = useToast()

  const canUpdate = usePermission('expenses.update')
  const canVoidExpense = usePermission('expenses.void')
  const canManageAttachments = usePermission('expenses.update')
  const canManageVendors = usePermission('expenseVendors.manage')

  const expenseQuery = useExpense(expenseId)
  const categoriesQuery = useExpenseCategories(true)
  const changesQuery = useExpenseChanges(expenseId)
  const updateExpense = useUpdateExpense(expenseId ?? '')
  const voidExpense = useVoidExpense(expenseId ?? '')

  const [isEditing, setIsEditing] = useState(false)
  const [isVoiding, setIsVoiding] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [draft, setDraft] = useState<ExpenseFormInput | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const expense = expenseQuery.data
  const locale = organization.locale
  const timeZone = organization.time_zone

  const asFormValues = useMemo((): ExpenseFormInput | null => {
    if (!expense) return null
    return {
      incurredOn: expense.incurred_on,
      description: expense.description ?? '',
      amount: minorToDecimalString(expense.amount_minor, expense.currency),
      taxAmount:
        expense.tax_amount_minor > 0
          ? minorToDecimalString(expense.tax_amount_minor, expense.currency)
          : '',
      taxRateBps: expense.tax_rate_bps,
      taxLabel: expense.tax_label ?? '',
      currency: expense.currency,
      categoryId: expense.category_id,
      allocation: expense.allocation,
      vehicleId: expense.allocation === 'vehicle' ? (expense.effective_vehicle_id ?? '') : '',
      rentalId: expense.rental_id ?? '',
      vendorId: expense.vendor_id ?? '',
      paymentMethod: expense.payment_method ?? '',
      reference: expense.reference ?? '',
      notes: expense.notes ?? '',
      odometer: expense.odometer === null ? '' : String(expense.odometer),
    }
  }, [expense])

  if (expenseQuery.isError) {
    return (
      <Card>
        <ErrorState error={expenseQuery.error} onRetry={() => void expenseQuery.refetch()} />
      </Card>
    )
  }

  if (!expense || !expenseId) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Card>
          <CardBody className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardBody>
        </Card>
      </div>
    )
  }

  const editable = canUpdate && canEdit(expense)
  const voidable = canVoidExpense && canVoid(expense)
  const blockedReason = editBlockedReason(expense)

  const startEditing = () => {
    setDraft(asFormValues)
    setErrors({})
    setIsEditing(true)
  }

  const save = async () => {
    if (!draft) return
    const schema = buildExpenseSchema(draft.currency || expense.currency)
    const parsed = schema.safeParse(draft)

    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form')
        next[key] ??= issue.message
      }
      setErrors(next)
      return
    }

    try {
      await updateExpense.mutateAsync(parsed.data)
      toast.success('Cost updated', 'The change is recorded in its history.')
      setIsEditing(false)
      setDraft(null)
    } catch (failure) {
      setErrors({ form: toErrorMessage(failure) })
    }
  }

  const money = (minor: number) => formatMoney(minor, expense.currency, { locale })

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={paths.expenses}
          className="text-ink-subtle hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem] transition-colors"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All costs
        </Link>
      </div>

      <PageHeader
        title={expense.description ?? 'Untitled cost'}
        eyebrow="Cost"
        description={`${money(expense.amount_minor)} · ${formatDate(
          new Date(`${expense.incurred_on}T00:00:00Z`),
          { locale, timeZone: 'UTC' },
        )} · ${expense.category_name}`}
        actions={
          isEditing ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                leadingIcon={<X />}
                onClick={() => {
                  setIsEditing(false)
                  setDraft(null)
                  setErrors({})
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                leadingIcon={<Check />}
                onClick={() => void save()}
                isLoading={updateExpense.isPending}
              >
                Save changes
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {editable ? (
                <Button variant="secondary" leadingIcon={<Pencil />} onClick={startEditing}>
                  Edit
                </Button>
              ) : null}
              {voidable ? (
                <Button variant="ghost" leadingIcon={<Ban />} onClick={() => setIsVoiding(true)}>
                  Void
                </Button>
              ) : null}
            </div>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <ExpenseStatusBadge status={expense.status} />
        {expense.source === 'financing' ? (
          <Badge tone="info">From a financing agreement</Badge>
        ) : null}
        {expense.source === 'import' ? <Badge tone="neutral">Imported</Badge> : null}
        {expense.category_archived ? <Badge tone="neutral">Category retired</Badge> : null}
      </div>

      {expense.status === 'voided' ? (
        <Alert tone="critical" title="This cost has been voided">
          It counts towards nothing — not the period total, not the vehicle's costs, not the
          operating result. The record is kept so the correction is visible.
          {expense.void_reason ? ` Reason given: ${expense.void_reason}` : ''}
        </Alert>
      ) : null}

      {blockedReason && expense.status !== 'voided' ? (
        <Alert tone="info" title="This cost cannot be edited here">
          {blockedReason}
        </Alert>
      ) : null}

      {isEditing && draft ? (
        <div className="max-w-3xl">
          <ExpenseForm
            values={draft}
            onChange={(patch) =>
              setDraft((current) => (current ? { ...current, ...patch } : current))
            }
            errors={errors}
            categories={categoriesQuery.data ?? []}
            canManageVendors={canManageVendors}
            locale={locale}
            editingExpenseId={expense.id}
          />
          <Alert tone="caution" title="This changes financial reporting" className="mt-4">
            Editing the amount, the date or what this cost belongs to moves the figures on the
            dashboard and on the vehicle. The previous values are kept in the history below.
          </Alert>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-5">
            <Card>
              <CardHeader title="The cost" />
              <CardBody>
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Detail label="Amount paid">
                    <span data-numeric="" className="text-[0.9375rem] font-semibold">
                      {money(expense.amount_minor)}
                    </span>
                  </Detail>
                  <Detail label="Date incurred">
                    {formatDate(new Date(`${expense.incurred_on}T00:00:00Z`), {
                      locale,
                      timeZone: 'UTC',
                    })}
                  </Detail>
                  {expense.tax_amount_minor > 0 ? (
                    <>
                      <Detail label={expense.tax_label ?? 'Tax included'}>
                        {money(expense.tax_amount_minor)}
                        {expense.tax_rate_bps ? ` · ${formatTaxRate(expense.tax_rate_bps)}` : ''}
                      </Detail>
                      <Detail label="Before tax">{money(expense.net_amount_minor)}</Detail>
                    </>
                  ) : null}
                  <Detail label="Category">
                    {expense.category_name}
                    {expense.category_archived ? ' (retired)' : ''}
                  </Detail>
                  <Detail label="Belongs to">
                    <AllocationCell expense={expense} />
                  </Detail>
                  <Detail label="Supplier">
                    {expense.vendor_name ?? 'Not recorded'}
                    {expense.vendor_archived ? ' (retired)' : ''}
                  </Detail>
                  <Detail label="Paid by">
                    {expense.payment_method
                      ? PAYMENT_METHOD_LABELS[expense.payment_method]
                      : 'Not recorded'}
                  </Detail>
                  <Detail label="Reference">{expense.reference ?? '—'}</Detail>
                  {expense.odometer !== null ? (
                    <Detail label="Odometer">{expense.odometer.toLocaleString(locale)}</Detail>
                  ) : null}
                </dl>

                {expense.notes ? (
                  <div className="border-line mt-4 border-t pt-3">
                    <p className="text-ink-subtle text-[0.75rem]">Notes</p>
                    <p className="text-ink mt-1 text-[0.8125rem] whitespace-pre-wrap">
                      {expense.notes}
                    </p>
                  </div>
                ) : null}
              </CardBody>
            </Card>

            <ReceiptPanel
              expenseId={expense.id}
              canManage={canManageAttachments && expense.status === 'recorded'}
              locale={locale}
              timeZone={timeZone}
            />
          </div>

          <aside className="space-y-5">
            <Card>
              <CardHeader title="History" description="What has been corrected, and by whom." />
              <CardBody>
                <ChangeHistory
                  events={changesQuery.data ?? []}
                  currency={expense.currency}
                  locale={locale}
                  timeZone={timeZone}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Provenance" />
              <CardBody>
                <dl className="space-y-3">
                  <Detail label="Recorded">
                    {formatDateTime(new Date(expense.created_at), { locale, timeZone })}
                  </Detail>
                  {expense.updated_at !== expense.created_at ? (
                    <Detail label="Last changed">
                      {formatDateTime(new Date(expense.updated_at), { locale, timeZone })}
                    </Detail>
                  ) : null}
                  {expense.voided_at ? (
                    <Detail label="Voided">
                      {formatDateTime(new Date(expense.voided_at), { locale, timeZone })}
                    </Detail>
                  ) : null}
                </dl>
                <p className="text-ink-subtle mt-3 text-[0.75rem]">
                  The date above is when the record was created. What the period reports on is the
                  date the cost was incurred.
                </p>
              </CardBody>
            </Card>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={isVoiding}
        onOpenChange={(open) => {
          setIsVoiding(open)
          if (!open) setVoidReason('')
        }}
        title="Void this cost"
        description="It stops counting everywhere and stays on the record with your reason. Nothing is deleted."
        confirmLabel="Void cost"
        isPending={voidExpense.isPending}
        onConfirm={() => {
          void voidExpense
            .mutateAsync(voidReason.trim() || null)
            .then(() => {
              toast.success('Cost voided', 'It no longer counts towards any total.')
              setIsVoiding(false)
              setVoidReason('')
            })
            .catch((failure: unknown) => {
              toast.error('Could not void this cost', toErrorMessage(failure))
            })
        }}
      >
        <Field label="Why" hint="Kept with the record so the correction explains itself.">
          <Input
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
            maxLength={500}
            placeholder="Entered twice"
          />
        </Field>
      </ConfirmDialog>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-ink-subtle text-[0.75rem]">{label}</dt>
      <dd className="text-ink mt-0.5 text-[0.8125rem]">{children}</dd>
    </div>
  )
}
