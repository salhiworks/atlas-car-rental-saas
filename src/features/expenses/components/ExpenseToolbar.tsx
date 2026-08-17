import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Select } from '@/components/ui'
import type { ExpenseAllocation, ExpenseCategoryRecord, ExpenseVendor } from '@/types/database'

import { ALLOCATION_LABELS } from '../allocation'
import { EXPENSE_SORTS, type ExpenseSort, type ExpenseStatusFilter } from '../api'

export interface ExpenseFilters {
  readonly search: string
  readonly sort: ExpenseSort
  readonly categoryId: string
  readonly allocation: ExpenseAllocation | 'any'
  readonly vendorId: string
  readonly currency: string
  readonly status: ExpenseStatusFilter
}

export interface ExpenseToolbarProps {
  filters: ExpenseFilters
  onChange: (patch: Partial<ExpenseFilters>) => void
  onClearAll: () => void
  categories: readonly ExpenseCategoryRecord[]
  vendors: readonly ExpenseVendor[]
  currencies: readonly string[]

  periodLabel: string
  onStepPeriod: (direction: -1 | 1) => void
  onThisMonth: () => void
  isCurrentMonth: boolean
}

const ALLOCATION_OPTIONS: { value: ExpenseAllocation | 'any'; label: string }[] = [
  { value: 'any', label: 'Anything' },
  { value: 'overhead', label: ALLOCATION_LABELS.overhead },
  { value: 'vehicle', label: ALLOCATION_LABELS.vehicle },
  { value: 'rental', label: ALLOCATION_LABELS.rental },
]

const STATUS_OPTIONS: { value: ExpenseStatusFilter; label: string }[] = [
  { value: 'recorded', label: 'Recorded' },
  { value: 'voided', label: 'Voided only' },
  { value: 'all', label: 'Including voided' },
]

/**
 * Period, search and filters.
 *
 * The period is the primary control because almost every question about spend
 * begins with "this month". Search is debounced rather than submitted: a manager
 * looking for a receipt is scanning, not querying.
 */
export function ExpenseToolbar({
  filters,
  onChange,
  onClearAll,
  categories,
  vendors,
  currencies,
  periodLabel,
  onStepPeriod,
  onThisMonth,
  isCurrentMonth,
}: ExpenseToolbarProps) {
  const [draft, setDraft] = useState(filters.search)
  const [lastApplied, setLastApplied] = useState(filters.search)
  const [showFilters, setShowFilters] = useState(false)

  // When the parent changes the term itself — "Clear all", or a back navigation
  // restoring an earlier URL — the field follows. Adjusted during render, which
  // is React's documented way to derive state from a changed prop.
  if (filters.search !== lastApplied) {
    setLastApplied(filters.search)
    setDraft(filters.search)
  }

  useEffect(() => {
    if (draft === filters.search) return
    const timer = setTimeout(() => onChange({ search: draft }), 250)
    return () => clearTimeout(timer)
  }, [draft, filters.search, onChange])

  const activeFilterCount =
    (filters.categoryId !== '' ? 1 : 0) +
    (filters.allocation !== 'any' ? 1 : 0) +
    (filters.vendorId !== '' ? 1 : 0) +
    (filters.currency !== '' ? 1 : 0) +
    (filters.status !== 'recorded' ? 1 : 0)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="border-line-strong bg-surface shadow-raised flex items-center rounded-md border">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous month"
            className="rounded-e-none"
            onClick={() => onStepPeriod(-1)}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="border-line-strong rounded-none border-x px-3"
            onClick={onThisMonth}
            disabled={isCurrentMonth}
          >
            This month
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next month"
            className="rounded-s-none"
            onClick={() => onStepPeriod(1)}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <p className="text-ink text-[0.9375rem] font-semibold">{periodLabel}</p>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <div className="relative w-full min-w-0 flex-1 sm:max-w-sm">
            <Search
              className="text-ink-subtle pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Search description, supplier, invoice or plate"
              aria-label="Search costs"
              className="ps-9"
            />
          </div>

          <Button
            variant={showFilters || activeFilterCount > 0 ? 'secondary' : 'ghost'}
            leadingIcon={<SlidersHorizontal />}
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            aria-controls="expense-filters"
          >
            Filters
            {activeFilterCount > 0 ? (
              <Badge tone="brand" className="ms-1">
                {activeFilterCount}
              </Badge>
            ) : null}
          </Button>

          <div className="w-full sm:w-52">
            <Select
              aria-label="Sort costs"
              value={filters.sort}
              onChange={(event) => onChange({ sort: event.target.value as ExpenseSort })}
              options={Object.entries(EXPENSE_SORTS).map(([value, config]) => ({
                value,
                label: config.label,
              }))}
            />
          </div>
        </div>
      </div>

      {showFilters ? (
        <div
          id="expense-filters"
          className="border-line bg-surface grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-5"
        >
          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Category</span>
            <Select
              aria-label="Filter by category"
              value={filters.categoryId}
              onChange={(event) => onChange({ categoryId: event.target.value })}
              options={[
                { value: '', label: 'Every category' },
                ...categories.map((category) => ({ value: category.id, label: category.name })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Belongs to</span>
            <Select
              aria-label="Filter by allocation"
              value={filters.allocation}
              onChange={(event) =>
                onChange({ allocation: event.target.value as ExpenseAllocation | 'any' })
              }
              options={ALLOCATION_OPTIONS}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Supplier</span>
            <Select
              aria-label="Filter by supplier"
              value={filters.vendorId}
              onChange={(event) => onChange({ vendorId: event.target.value })}
              options={[
                { value: '', label: 'Every supplier' },
                ...vendors.map((vendor) => ({ value: vendor.id, label: vendor.name })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Currency</span>
            <Select
              aria-label="Filter by currency"
              value={filters.currency}
              onChange={(event) => onChange({ currency: event.target.value })}
              options={[
                { value: '', label: 'Every currency' },
                ...currencies.map((currency) => ({ value: currency, label: currency })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Status</span>
            <Select
              aria-label="Filter by status"
              value={filters.status}
              onChange={(event) => onChange({ status: event.target.value as ExpenseStatusFilter })}
              options={STATUS_OPTIONS}
            />
          </label>

          {activeFilterCount > 0 ? (
            <div className="flex justify-end sm:col-span-2 lg:col-span-5">
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
