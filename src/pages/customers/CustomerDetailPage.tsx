import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  ArrowLeft,
  Building2,
  MoreHorizontal,
  Pencil,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui'
import { CustomerActivityPanel } from '@/features/customers/components/CustomerActivityPanel'
import { ArchivedBadge, DriverLicenceBadge } from '@/features/customers/components/CustomerBadges'
import { CustomerDocumentsPanel } from '@/features/customers/components/CustomerDocumentsPanel'
import { CustomerForm, customerToFormInput } from '@/features/customers/components/CustomerForm'
import {
  useArchiveCustomer,
  useCustomer,
  useCustomerUsage,
  useDeleteCustomer,
  useRestoreCustomer,
  useUpdateCustomer,
  useUpdateCustomerNotes,
} from '@/features/customers/queries'
import type { CustomerFormValues } from '@/features/customers/schemas'
import { useComplianceOptions } from '@/features/workspace/useOrganizationSettings'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatDate } from '@/lib/datetime/format'
import { getCountryName } from '@/lib/i18n/regions'
import { toErrorMessage } from '@/lib/supabase/errors'

/**
 * The customer profile.
 *
 * Ordered by what somebody at the counter needs: who this is and whether they
 * may drive, then identification, then history. No identifier appears in the
 * header — a name and a phone number are what identify a person across a desk,
 * and a passport number on permanent display is a liability with no operational
 * benefit.
 */
export function CustomerDetailPage() {
  const { customerId } = useParams<{ customerId: string }>()
  const organization = useOrganization()
  const compliance = useComplianceOptions()
  const navigate = useNavigate()
  const toast = useToast()

  const canEdit = usePermission('customers.update')
  const canDelete = usePermission('customers.delete')
  const canManageDocuments = usePermission('customerDocuments.create')
  const canDeleteDocuments = usePermission('customerDocuments.delete')

  const [isEditing, setIsEditing] = useState(false)
  const [isArchiving, setIsArchiving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isEditingNotes, setIsEditingNotes] = useState(false)
  const [notesDraft, setNotesDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const customerQuery = useCustomer(customerId)
  const usageQuery = useCustomerUsage(customerId)

  const update = useUpdateCustomer(customerId ?? '')
  const updateNotes = useUpdateCustomerNotes(customerId ?? '')
  const archive = useArchiveCustomer(customerId ?? '')
  const restore = useRestoreCustomer(customerId ?? '')
  const remove = useDeleteCustomer(customerId ?? '')

  if (customerQuery.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    )
  }

  if (customerQuery.isError || !customerQuery.data) {
    // A customer belonging to another agency and one that never existed land
    // here identically. The interface must not confirm that an identifier
    // belongs to somebody, somewhere.
    return (
      <div className="space-y-6">
        <BackLink />
        <Card className="mx-auto max-w-lg">
          <ErrorState
            title="This customer could not be found"
            error={customerQuery.error ?? new Error('Not found')}
          />
          <div className="flex justify-center pb-6">
            <Button variant="secondary" onClick={() => void navigate(paths.customers)}>
              Back to customers
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const customer = customerQuery.data
  const usage = usageQuery.data
  const isArchived = customer.archived_at !== null
  const isCompany = customer.customer_type === 'company'
  const Icon = isCompany ? Building2 : UserRound

  const handleUpdate = (values: CustomerFormValues) => {
    setError(null)
    update.mutate(values, {
      onSuccess: () => {
        setIsEditing(false)
        toast.success('Customer updated')
      },
      onError: (cause) => setError(toErrorMessage(cause)),
    })
  }

  return (
    <div className="space-y-6">
      <BackLink />

      {error ? <Alert tone="critical">{error}</Alert> : null}

      {isArchived ? (
        <Alert
          tone="info"
          title="This customer is archived"
          actions={
            canEdit ? (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<ArchiveRestore />}
                isLoading={restore.isPending}
                onClick={() =>
                  restore.mutate(undefined, {
                    onSuccess: () => toast.success('Customer restored'),
                    onError: (cause) => setError(toErrorMessage(cause)),
                  })
                }
              >
                Restore
              </Button>
            ) : null
          }
        >
          They stay on every contract they appear on, and remain findable when you include archived
          customers in the list. Archived{' '}
          {formatDate(new Date(customer.archived_at!), {
            locale: organization.locale,
            timeZone: compliance.timeZone,
          })}
          .
        </Alert>
      ) : null}

      <PageHeaderRow
        icon={Icon}
        name={customer.display_name}
        isArchived={isArchived}
        customer={customer}
        compliance={compliance}
        actions={
          canEdit ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                leadingIcon={<Pencil />}
                onClick={() => setIsEditing(true)}
              >
                Edit
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger
                  className="border-line-strong bg-surface text-ink-muted hover:bg-surface-muted hover:text-ink flex size-9 items-center justify-center rounded-md border shadow-raised transition-colors"
                  aria-label="More actions"
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </DropdownMenuTrigger>

                <DropdownMenuContent align="end">
                  {!isArchived ? (
                    <DropdownMenuItem onSelect={() => setIsArchiving(true)}>
                      <ArchiveIcon aria-hidden="true" />
                      Archive customer
                    </DropdownMenuItem>
                  ) : null}
                  {canDelete && usage?.can_delete ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem tone="critical" onSelect={() => setIsDeleting(true)}>
                        <Trash2 aria-hidden="true" />
                        Delete permanently
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <CardBody className="p-0">
              <dl className="divide-line grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-x">
                <DetailRow label="Phone">{customer.phone ?? '—'}</DetailRow>
                <DetailRow label="Second phone">{customer.secondary_phone ?? '—'}</DetailRow>
                <DetailRow label="Email">{customer.email ?? '—'}</DetailRow>
                <DetailRow label="Date of birth">
                  {customer.date_of_birth
                    ? formatDate(new Date(`${customer.date_of_birth}T00:00:00Z`), {
                        locale: organization.locale,
                        timeZone: 'UTC',
                      })
                    : '—'}
                </DetailRow>
                <DetailRow label="Nationality">
                  {customer.nationality_country_code
                    ? getCountryName(customer.nationality_country_code, organization.locale)
                    : '—'}
                </DetailRow>
                <DetailRow label="Address country">
                  {customer.country_code
                    ? getCountryName(customer.country_code, organization.locale)
                    : '—'}
                </DetailRow>
                <DetailRow label="City">{customer.city ?? '—'}</DetailRow>
                <DetailRow label="Customer since">
                  {formatDate(new Date(customer.created_at), {
                    locale: organization.locale,
                    timeZone: compliance.timeZone,
                  })}
                </DetailRow>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CustomerDocumentsPanel
              organizationId={organization.id}
              customerId={customer.customer_id}
              compliance={compliance}
              locale={organization.locale}
              canEdit={canManageDocuments && !isArchived}
              canDelete={canDeleteDocuments && !isArchived}
            />
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CustomerActivityPanel
              customer={customer}
              compliance={compliance}
              locale={organization.locale}
            />
          </Card>

          <Card>
            <CardHeader
              title="Internal notes"
              description="Your team only. Never shown to the customer."
              actions={
                canEdit && !isEditingNotes ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setNotesDraft(customerNotes(customer))
                      setIsEditingNotes(true)
                    }}
                  >
                    Edit
                  </Button>
                ) : null
              }
            />
            <CardBody>
              {isEditingNotes ? (
                <div className="space-y-3">
                  <Field label="Notes" hideLabel>
                    <Textarea
                      rows={4}
                      autoFocus
                      value={notesDraft}
                      onChange={(event) => setNotesDraft(event.target.value)}
                    />
                  </Field>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsEditingNotes(false)}
                      disabled={updateNotes.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      isLoading={updateNotes.isPending}
                      onClick={() =>
                        updateNotes.mutate(notesDraft.trim() || null, {
                          onSuccess: () => {
                            setIsEditingNotes(false)
                            toast.success('Notes saved')
                          },
                          onError: (cause) => setError(toErrorMessage(cause)),
                        })
                      }
                    >
                      Save notes
                    </Button>
                  </div>
                </div>
              ) : customerNotes(customer) ? (
                <p className="text-ink-muted text-[0.8125rem] leading-6 whitespace-pre-line">
                  {customerNotes(customer)}
                </p>
              ) : (
                <p className="text-ink-subtle text-[0.8125rem]">No notes recorded.</p>
              )}
            </CardBody>
          </Card>

          {usage ? (
            <Card>
              <CardHeader title="References" description="What this customer is attached to." />
              <CardBody className="p-0">
                <dl className="divide-line divide-y">
                  <UsageRow label="Contracts" value={usage.rentals_count} />
                  <UsageRow label="Named as a driver" value={usage.driver_on_count} />
                  <UsageRow label="Payments" value={usage.payments_count} />
                  <UsageRow label="Documents" value={usage.documents_count} />
                </dl>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <Dialog open={isEditing} onOpenChange={setIsEditing}>
        <DialogContent
          title="Edit customer"
          description="Contracts already signed keep the details they were signed with."
          size="xl"
        >
          <CustomerForm
            defaultValues={customerToFormInput({ ...customer, notes: customerNotes(customer) })}
            submitLabel="Save changes"
            isSubmitting={update.isPending}
            currentCustomerId={customer.customer_id}
            onSubmit={handleUpdate}
            onCancel={() => setIsEditing(false)}
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={isArchiving}
        onOpenChange={setIsArchiving}
        title="Archive this customer?"
        confirmLabel="Archive customer"
        isPending={archive.isPending}
        onConfirm={() =>
          archive.mutate(undefined, {
            onSuccess: () => {
              setIsArchiving(false)
              toast.success('Customer archived')
            },
            onError: (cause) => {
              setIsArchiving(false)
              setError(toErrorMessage(cause))
            },
          })
        }
      >
        <p className="text-ink-muted text-[0.8125rem] leading-6">
          They stop appearing in the customer list and cannot be put on a new contract, but every
          contract, payment and document already attached to them stays exactly as it is. You can
          restore them at any time.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={isDeleting}
        onOpenChange={setIsDeleting}
        title="Delete this customer permanently?"
        confirmLabel="Delete permanently"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              toast.success('Customer deleted')
              void navigate(paths.customers, { replace: true })
            },
            onError: (cause) => {
              setIsDeleting(false)
              setError(toErrorMessage(cause))
            },
          })
        }
      >
        <p className="text-ink-muted text-[0.8125rem] leading-6">
          This customer has no contracts, payments or driver records against them, so no financial
          history is lost. Their identification records and any scans are deleted with them. This
          cannot be undone — archive them instead if you might need the record later.
        </p>
      </ConfirmDialog>
    </div>
  )
}

/** The directory view omits `notes`; the edit dialog reads it from the form values. */
function customerNotes(customer: { notes?: string | null }): string {
  return customer.notes ?? ''
}

function BackLink() {
  return (
    <Link
      to={paths.customers}
      className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem]"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Customers
    </Link>
  )
}

function PageHeaderRow({
  icon: Icon,
  name,
  isArchived,
  customer,
  compliance,
  actions,
}: {
  icon: typeof UserRound
  name: string
  isArchived: boolean
  customer: Parameters<typeof DriverLicenceBadge>[0]['customer'] & {
    phone: string | null
    email: string | null
  }
  compliance: Parameters<typeof DriverLicenceBadge>[0]['compliance']
  actions: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="border-line bg-surface-inset text-ink-subtle flex size-11 shrink-0 items-center justify-center rounded-full border"
        >
          <Icon className="size-5" />
        </span>

        <div className="min-w-0 space-y-1.5">
          <p className="eyebrow">Customer</p>
          <h1 className="text-xl leading-7 font-semibold tracking-tight">{name}</h1>
          <p className="text-ink-muted text-[0.8125rem]">
            {[customer.phone, customer.email].filter(Boolean).join(' · ') || 'No contact details'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <DriverLicenceBadge customer={customer} compliance={compliance} />
            {isArchived ? <ArchivedBadge /> : null}
          </div>
        </div>
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-3">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-ink mt-1 text-[0.8125rem] break-words">{children}</dd>
    </div>
  )
}

function UsageRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <dt className="text-ink-muted text-[0.8125rem]">{label}</dt>
      <dd data-numeric="" className="text-ink text-[0.8125rem] font-medium">
        {value}
      </dd>
    </div>
  )
}
