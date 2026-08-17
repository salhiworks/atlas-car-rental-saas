import { Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Select } from '@/components/ui'
import { getCountryName } from '@/lib/i18n/regions'
import { cn } from '@/lib/utils/cn'

import { CUSTOMER_SORTS, type CustomerSort, type LicenceFilter, type RentalFilter } from '../api'

export interface CustomerFilters {
  search: string
  sort: CustomerSort
  countries: string[]
  licence: LicenceFilter
  rental: RentalFilter
  includeArchived: boolean
}

export interface CustomerToolbarProps {
  filters: CustomerFilters
  onChange: (patch: Partial<CustomerFilters>) => void
  availableCountries: readonly string[]
  locale: string
  activeFilterCount: number
  onClearAll: () => void
}

const LICENCE_OPTIONS: { value: LicenceFilter; label: string }[] = [
  { value: 'any', label: 'Any licence state' },
  { value: 'valid', label: 'Licence valid' },
  { value: 'expired', label: 'Licence expired' },
  { value: 'missing', label: 'No licence on file' },
]

const RENTAL_OPTIONS: { value: RentalFilter; label: string }[] = [
  { value: 'any', label: 'Any rental history' },
  { value: 'active', label: 'Renting now' },
  { value: 'outstanding', label: 'Has an outstanding balance' },
  { value: 'never', label: 'Never rented' },
]

/**
 * Search, filters and sort for customers.
 *
 * Search is debounced rather than submitted: staff look somebody up with that
 * person standing in front of them, and a Return key between typing and seeing
 * the answer is a step nobody needs.
 */
export function CustomerToolbar({
  filters,
  onChange,
  availableCountries,
  locale,
  activeFilterCount,
  onClearAll,
}: CustomerToolbarProps) {
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
            placeholder="Search name, phone, email or document number"
            aria-label="Search customers"
            className="ps-9"
          />
        </div>

        <Button
          variant={showFilters || activeFilterCount > 0 ? 'secondary' : 'ghost'}
          leadingIcon={<SlidersHorizontal />}
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
          aria-controls="customer-filters"
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
            aria-label="Sort customers"
            value={filters.sort}
            onChange={(event) => onChange({ sort: event.target.value as CustomerSort })}
            options={Object.entries(CUSTOMER_SORTS).map(([value, config]) => ({
              value,
              label: config.label,
            }))}
          />
        </div>
      </div>

      {showFilters ? (
        <div
          id="customer-filters"
          className="border-line bg-surface grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Nationality</span>
            <Select
              value={filters.countries[0] ?? ''}
              onChange={(event) =>
                onChange({ countries: event.target.value === '' ? [] : [event.target.value] })
              }
              options={[
                { value: '', label: 'Any nationality' },
                ...availableCountries.map((code) => ({
                  value: code,
                  label: getCountryName(code, locale),
                })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Driving licence</span>
            <Select
              value={filters.licence}
              onChange={(event) => onChange({ licence: event.target.value as LicenceFilter })}
              options={LICENCE_OPTIONS}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Rental history</span>
            <Select
              value={filters.rental}
              onChange={(event) => onChange({ rental: event.target.value as RentalFilter })}
              options={RENTAL_OPTIONS}
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Archived</span>
            <label
              className={cn(
                'border-line-strong bg-surface flex h-9 cursor-pointer items-center gap-2.5 rounded-md border px-3',
                'hover:border-ink-subtle transition-colors',
              )}
            >
              <input
                type="checkbox"
                checked={filters.includeArchived}
                onChange={(event) => onChange({ includeArchived: event.target.checked })}
                className="accent-brand-700 size-3.5"
              />
              <span className="text-[0.8125rem]">Include archived customers</span>
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
