import { Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

import {
  RENTAL_SORTS,
  type RentalPaymentFilter,
  type RentalSort,
  type RentalStatusFilter,
} from '../api'

export interface RentalFilters {
  search: string
  sort: RentalSort
  status: RentalStatusFilter
  payment: RentalPaymentFilter
  overdueOnly: boolean
}

export interface RentalToolbarProps {
  filters: RentalFilters
  onChange: (patch: Partial<RentalFilters>) => void
  activeFilterCount: number
  onClearAll: () => void
}

const STATUS_OPTIONS: { value: RentalStatusFilter; label: string }[] = [
  { value: 'live', label: 'Open contracts' },
  { value: 'draft', label: 'Drafts' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'active', label: 'Out with a customer' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'Everything' },
]

const PAYMENT_OPTIONS: { value: RentalPaymentFilter; label: string }[] = [
  { value: 'any', label: 'Any balance' },
  { value: 'outstanding', label: 'Money still owed' },
  { value: 'settled', label: 'Settled' },
]

/**
 * Search, filters and sort for the rentals board.
 *
 * Search is debounced rather than submitted: staff look a contract up with the
 * customer standing in front of them, and a Return key between typing and
 * seeing the answer is a step nobody needs.
 */
export function RentalToolbar({
  filters,
  onChange,
  activeFilterCount,
  onClearAll,
}: RentalToolbarProps) {
  const [searchDraft, setSearchDraft] = useState(filters.search)
  const [lastApplied, setLastApplied] = useState(filters.search)
  const [showFilters, setShowFilters] = useState(false)

  // When the parent changes the term itself — "Clear all", or a back navigation
  // restoring an earlier URL — the field follows. Adjusted during render, which
  // is React's documented way to derive state from a changed prop.
  if (filters.search !== lastApplied) {
    setLastApplied(filters.search)
    setSearchDraft(filters.search)
  }

  useEffect(() => {
    if (searchDraft === filters.search) return
    const timer = setTimeout(() => onChange({ search: searchDraft }), 250)
    return () => clearTimeout(timer)
  }, [searchDraft, filters.search, onChange])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search
            className="text-ink-subtle pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Search contract number, renter or plate"
            aria-label="Search rentals"
            className="ps-9"
          />
        </div>

        <Button
          variant={showFilters || activeFilterCount > 0 ? 'secondary' : 'ghost'}
          leadingIcon={<SlidersHorizontal />}
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
          aria-controls="rental-filters"
        >
          Filters
          {activeFilterCount > 0 ? (
            <Badge tone="brand" className="ms-1">
              {activeFilterCount}
            </Badge>
          ) : null}
        </Button>

        <div className="ms-auto w-full sm:w-52">
          <Select
            aria-label="Sort rentals"
            value={filters.sort}
            onChange={(event) => onChange({ sort: event.target.value as RentalSort })}
            options={Object.entries(RENTAL_SORTS).map(([value, config]) => ({
              value,
              label: config.label,
            }))}
          />
        </div>
      </div>

      {showFilters ? (
        <div
          id="rental-filters"
          className="border-line bg-surface grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Contract status</span>
            <Select
              value={filters.status}
              onChange={(event) => onChange({ status: event.target.value as RentalStatusFilter })}
              options={STATUS_OPTIONS}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Payment state</span>
            <Select
              value={filters.payment}
              onChange={(event) => onChange({ payment: event.target.value as RentalPaymentFilter })}
              options={PAYMENT_OPTIONS}
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Return time</span>
            <label
              className={cn(
                'border-line-strong bg-surface flex h-9 cursor-pointer items-center gap-2.5 rounded-md border px-3',
                'hover:border-ink-subtle transition-colors',
              )}
            >
              <input
                type="checkbox"
                checked={filters.overdueOnly}
                onChange={(event) => onChange({ overdueOnly: event.target.checked })}
                className="accent-brand-700 size-3.5"
              />
              <span className="text-[0.8125rem]">Past its return time only</span>
            </label>
          </div>

          {activeFilterCount > 0 ? (
            <div className="flex justify-end sm:col-span-2 lg:col-span-4">
              <Button variant="ghost" size="sm" leadingIcon={<X />} onClick={onClearAll}>
                Clear all filters
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
