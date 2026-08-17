import { Search, SlidersHorizontal, X } from 'lucide-react'
import { useId, useState } from 'react'

import { Badge, Button, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { FinancingAgreementType, Lender } from '@/types/database'

import { AGREEMENT_SORTS, type AgreementSort, type AgreementStatusFilter } from '../api'
import { AGREEMENT_TYPES, AGREEMENT_TYPE_LABELS } from '../domain'

export interface FinancingFilters {
  search: string
  status: AgreementStatusFilter
  lenderId: string
  agreementType: FinancingAgreementType | 'any'
  dueState: 'any' | 'overdue' | 'due_soon'
  currency: string
  sort: AgreementSort
}

export interface FinancingToolbarProps {
  filters: FinancingFilters
  onChange: (patch: Partial<FinancingFilters>) => void
  onClearAll: () => void
  lenders: readonly Lender[]
  currencies: readonly string[]
}

/**
 * Search first, the rest behind a disclosure.
 *
 * Six selects across the top of a workspace is a form, not a toolbar. The one
 * control anybody uses on most visits is the search box; everything else is one
 * press away and stays open once opened.
 */
export function FinancingToolbar({
  filters,
  onChange,
  onClearAll,
  lenders,
  currencies,
}: FinancingToolbarProps) {
  const searchId = useId()
  const [showFilters, setShowFilters] = useState(false)

  const activeCount =
    (filters.status === 'live' ? 0 : 1) +
    (filters.lenderId === '' ? 0 : 1) +
    (filters.agreementType === 'any' ? 0 : 1) +
    (filters.dueState === 'any' ? 0 : 1) +
    (filters.currency === '' ? 0 : 1)

  return (
    <div className="border-line bg-surface rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 p-4">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            className="text-ink-subtle pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            aria-label="Search financing"
            className="ps-9"
            placeholder="Search plate, lender or agreement number"
            value={filters.search}
            onChange={(event) => onChange({ search: event.target.value })}
          />
        </div>

        <Button
          variant={showFilters || activeCount > 0 ? 'secondary' : 'ghost'}
          leadingIcon={<SlidersHorizontal />}
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
        >
          Filters
          {activeCount > 0 ? (
            <Badge tone="brand" className="ms-1">
              {activeCount}
            </Badge>
          ) : null}
        </Button>

        <div className="w-full sm:w-52">
          <Select
            aria-label="Sort"
            value={filters.sort}
            onChange={(event) => onChange({ sort: event.target.value as AgreementSort })}
            options={Object.entries(AGREEMENT_SORTS).map(([value, option]) => ({
              value,
              label: option.label,
            }))}
          />
        </div>
      </div>

      <div className={cn('border-line border-t p-4', showFilters ? 'block' : 'hidden')}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Status</span>
            <Select
              value={filters.status}
              onChange={(event) =>
                onChange({ status: event.target.value as AgreementStatusFilter })
              }
              options={[
                { value: 'live', label: 'Draft and active' },
                { value: 'active', label: 'Active only' },
                { value: 'draft', label: 'Drafts only' },
                { value: 'paid_off', label: 'Paid off' },
                { value: 'closed', label: 'Closed' },
                { value: 'cancelled', label: 'Cancelled' },
                { value: 'all', label: 'Everything' },
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Lender</span>
            <Select
              value={filters.lenderId}
              onChange={(event) => onChange({ lenderId: event.target.value })}
              options={[
                { value: '', label: 'Any lender' },
                ...lenders.map((lender) => ({ value: lender.id, label: lender.name })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Type</span>
            <Select
              value={filters.agreementType}
              onChange={(event) =>
                onChange({ agreementType: event.target.value as FinancingAgreementType | 'any' })
              }
              options={[
                { value: 'any', label: 'Any type' },
                ...AGREEMENT_TYPES.map((type) => ({
                  value: type,
                  label: AGREEMENT_TYPE_LABELS[type],
                })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Payments</span>
            <Select
              value={filters.dueState}
              onChange={(event) =>
                onChange({ dueState: event.target.value as FinancingFilters['dueState'] })
              }
              options={[
                { value: 'any', label: 'Any' },
                { value: 'overdue', label: 'Overdue' },
                { value: 'due_soon', label: 'Due within 30 days' },
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Currency</span>
            <Select
              value={filters.currency}
              onChange={(event) => onChange({ currency: event.target.value })}
              options={[
                { value: '', label: 'Any currency' },
                ...currencies.map((currency) => ({ value: currency, label: currency })),
              ]}
            />
          </label>
        </div>

        {activeCount > 0 ? (
          <div className="mt-4 flex justify-end">
            <Button variant="ghost" size="sm" leadingIcon={<X />} onClick={onClearAll}>
              Clear all filters
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
