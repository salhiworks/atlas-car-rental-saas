import { Check, Search, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Input, Skeleton } from '@/components/ui'
import { DriverLicenceBadge } from '@/features/customers/components/CustomerBadges'
import { useCustomerList } from '@/features/customers/queries'
import type { ComplianceOptions } from '@/lib/compliance/expiry'
import { cn } from '@/lib/utils/cn'
import type { CustomerDirectoryEntry } from '@/types/database'

export interface CustomerPickerProps {
  /** Ids already chosen, shown as selected. */
  selectedIds: readonly string[]
  onSelect: (customer: CustomerDirectoryEntry) => void
  compliance: ComplianceOptions
  /** Shows each person's licence state — used wherever the choice is a driver. */
  showLicence?: boolean
  emptyHint?: string
}

/**
 * Finding a person by typing their name.
 *
 * The list is the customer directory, which already carries licence validity, so
 * a driver whose licence has expired is visible as such at the moment they are
 * chosen rather than at the moment the contract is refused.
 *
 * The search term is component state and never reaches the URL: a customer's
 * name in a shareable link is personal data in a place it should not be.
 */
export function CustomerPicker({
  selectedIds,
  onSelect,
  compliance,
  showLicence = false,
  emptyHint = 'No customer matches that name.',
}: CustomerPickerProps) {
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft), 250)
    return () => clearTimeout(timer)
  }, [draft])

  const query = useCustomerList({ search, sort: 'name', pageSize: 8 })
  const customers = query.data?.rows ?? []

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="text-ink-subtle pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search by name, phone or email"
          aria-label="Search customers"
          className="ps-9"
        />
      </div>

      <div className="border-line max-h-64 overflow-y-auto rounded-md border">
        {query.isPending ? (
          <ul className="divide-line divide-y">
            {Array.from({ length: 3 }).map((_, index) => (
              <li key={index} className="px-3 py-2.5">
                <Skeleton className="h-4 w-40" />
              </li>
            ))}
          </ul>
        ) : customers.length === 0 ? (
          <p className="text-ink-subtle px-3 py-6 text-center text-[0.8125rem]">{emptyHint}</p>
        ) : (
          <ul className="divide-line divide-y">
            {customers.map((customer) => {
              const isSelected = selectedIds.includes(customer.customer_id)

              return (
                <li key={customer.customer_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(customer)}
                    className={cn(
                      'hover:bg-surface-muted flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors',
                      'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:-outline-offset-2',
                      isSelected && 'bg-brand-50/50',
                    )}
                  >
                    <UserRound className="text-ink-subtle size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block truncate text-[0.8125rem] font-medium">
                        {customer.display_name}
                      </span>
                      <span className="text-ink-subtle block truncate text-[0.75rem]">
                        {[customer.city, customer.country_code].filter(Boolean).join(', ') ||
                          'No address on file'}
                      </span>
                    </span>
                    {showLicence ? (
                      <DriverLicenceBadge customer={customer} compliance={compliance} />
                    ) : null}
                    {isSelected ? (
                      <Check className="text-brand-600 size-4 shrink-0" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
