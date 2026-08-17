import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { customerDetailPath, paths } from '@/app/routes/paths'
import { Alert, PageHeader, useToast } from '@/components/ui'
import { CustomerForm } from '@/features/customers/components/CustomerForm'
import { useCreateCustomer } from '@/features/customers/queries'
import type { CustomerFormValues } from '@/features/customers/schemas'
import { toErrorMessage } from '@/lib/supabase/errors'

export function CustomerNewPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const create = useCreateCustomer()
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = (values: CustomerFormValues) => {
    setError(null)
    create.mutate(values, {
      onSuccess: (customer) => {
        toast.success('Customer added', `${customer.display_name} is now on file.`)
        // Straight to the profile, which is where identification is recorded.
        void navigate(customerDetailPath(customer.id), { replace: true })
      },
      onError: (cause) => setError(toErrorMessage(cause)),
    })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          to={paths.customers}
          className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-[0.8125rem]"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Customers
        </Link>
      </div>

      <PageHeader
        title="Add a customer"
        eyebrow="Operations"
        description="A name is all that is needed to start. Identification and licence details are recorded on the profile, where a scan can be attached at the same time."
      />

      {error ? <Alert tone="critical">{error}</Alert> : null}

      <CustomerForm
        submitLabel="Add customer"
        isSubmitting={create.isPending}
        onSubmit={handleSubmit}
        onCancel={() => void navigate(paths.customers)}
      />
    </div>
  )
}
