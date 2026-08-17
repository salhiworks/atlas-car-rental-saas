import { Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

import { VEHICLE_SORTS, type ComplianceFilter, type VehicleSort } from '../api'

export interface FleetFilters {
  search: string
  sort: VehicleSort
  makes: string[]
  modelYear: number | null
  compliance: ComplianceFilter
  includeArchived: boolean
}

export interface FleetToolbarProps {
  filters: FleetFilters
  onChange: (patch: Partial<FleetFilters>) => void
  availableMakes: readonly string[]
  availableYears: readonly number[]
  activeFilterCount: number
  onClearAll: () => void
}

const COMPLIANCE_OPTIONS: { value: ComplianceFilter; label: string }[] = [
  { value: 'any', label: 'Any compliance state' },
  { value: 'expired', label: 'Has an expired document' },
  { value: 'unrecorded', label: 'Missing a compliance date' },
]

/**
 * Search, filters and sort for the fleet.
 *
 * Search is debounced rather than submitted: staff are looking for one car in
 * front of a customer, and a Return key between typing and seeing the answer is
 * a step nobody needs. The debounce keeps that from meaning a request per
 * keystroke.
 */
export function FleetToolbar({
  filters,
  onChange,
  availableMakes,
  availableYears,
  activeFilterCount,
  onClearAll,
}: FleetToolbarProps) {
  const [searchDraft, setSearchDraft] = useState(filters.search)
  const [lastAppliedSearch, setLastAppliedSearch] = useState(filters.search)
  const [showFilters, setShowFilters] = useState(false)

  // When the parent changes the search term itself — "Clear all filters", or a
  // back navigation restoring an earlier URL — the field has to follow. Adjusted
  // during render rather than in an effect, which is React's documented way to
  // derive state from a changed prop and avoids the extra render an effect costs.
  if (filters.search !== lastAppliedSearch) {
    setLastAppliedSearch(filters.search)
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
            placeholder="Search make, model, plate or VIN"
            aria-label="Search the fleet"
            className="ps-9"
          />
        </div>

        <Button
          variant={showFilters || activeFilterCount > 0 ? 'secondary' : 'ghost'}
          leadingIcon={<SlidersHorizontal />}
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
          aria-controls="fleet-filters"
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
            aria-label="Sort vehicles"
            value={filters.sort}
            onChange={(event) => onChange({ sort: event.target.value as VehicleSort })}
            options={Object.entries(VEHICLE_SORTS).map(([value, config]) => ({
              value,
              label: config.label,
            }))}
          />
        </div>
      </div>

      {showFilters ? (
        <div
          id="fleet-filters"
          className="border-line bg-surface grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Make</span>
            <Select
              value={filters.makes[0] ?? ''}
              onChange={(event) =>
                onChange({ makes: event.target.value === '' ? [] : [event.target.value] })
              }
              options={[
                { value: '', label: 'All makes' },
                ...availableMakes.map((make) => ({ value: make, label: make })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Model year</span>
            <Select
              value={filters.modelYear === null ? '' : String(filters.modelYear)}
              onChange={(event) =>
                onChange({
                  modelYear: event.target.value === '' ? null : Number(event.target.value),
                })
              }
              options={[
                { value: '', label: 'Any year' },
                ...availableYears.map((year) => ({ value: String(year), label: String(year) })),
              ]}
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-ink block text-[0.8125rem] font-medium">Compliance</span>
            <Select
              value={filters.compliance}
              onChange={(event) => onChange({ compliance: event.target.value as ComplianceFilter })}
              options={COMPLIANCE_OPTIONS}
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
              <span className="text-[0.8125rem]">Include retired vehicles</span>
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
