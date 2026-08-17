import { CalendarDays, ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Badge, Button, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { RentalStatus } from '@/types/database'

import { CALENDAR_VIEWS, CALENDAR_VIEW_LABELS, type CalendarView } from '../ranges'
import { SCHEDULE_STATUS_OPTIONS } from '../schedule'

export interface CalendarFilters {
  readonly statuses: readonly RentalStatus[]
  readonly makes: readonly string[]
  readonly includeArchived: boolean
}

export interface CalendarToolbarProps {
  view: CalendarView
  onViewChange: (view: CalendarView) => void
  rangeLabel: string
  anchorIso: string
  onAnchorChange: (isoDate: string) => void
  onStep: (direction: -1 | 1) => void
  onToday: () => void
  isToday: boolean

  filters: CalendarFilters
  onFiltersChange: (patch: Partial<CalendarFilters>) => void
  availableMakes: readonly string[]

  /** Held in component state, never in the URL — see the note below. */
  search: string
  onSearchChange: (value: string) => void
  matchCount: number | null
}

/**
 * The board's controls.
 *
 * The view and the date live in the URL, so a colleague can be sent "the week
 * of the 12th" and get exactly that. The search box does not: staff type
 * customer names into it, and a name in a shareable link is personal data in a
 * place personal data should not be.
 */
export function CalendarToolbar({
  view,
  onViewChange,
  rangeLabel,
  anchorIso,
  onAnchorChange,
  onStep,
  onToday,
  isToday,
  filters,
  onFiltersChange,
  availableMakes,
  search,
  onSearchChange,
  matchCount,
}: CalendarToolbarProps) {
  const [draft, setDraft] = useState(search)
  const [showFilters, setShowFilters] = useState(false)

  useEffect(() => {
    if (draft === search) return
    const timer = setTimeout(() => onSearchChange(draft), 200)
    return () => clearTimeout(timer)
  }, [draft, search, onSearchChange])

  const nonDefaultStatuses =
    filters.statuses.length !== 2 ||
    !filters.statuses.includes('reserved') ||
    !filters.statuses.includes('active')

  const activeFilterCount =
    (nonDefaultStatuses ? 1 : 0) +
    (filters.makes.length > 0 ? 1 : 0) +
    (filters.includeArchived ? 1 : 0)

  const toggleStatus = (status: RentalStatus) => {
    const next = filters.statuses.includes(status)
      ? filters.statuses.filter((entry) => entry !== status)
      : [...filters.statuses, status]
    onFiltersChange({ statuses: next })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="border-line-strong bg-surface shadow-raised flex items-center rounded-md border">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous period"
            className="rounded-e-none"
            onClick={() => onStep(-1)}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="border-line-strong rounded-none border-x px-3"
            onClick={onToday}
            disabled={isToday}
          >
            Today
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next period"
            className="rounded-s-none"
            onClick={() => onStep(1)}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <p className="text-ink min-w-0 text-[0.9375rem] font-semibold">{rangeLabel}</p>

        <label className="relative">
          <span className="sr-only">Jump to date</span>
          <CalendarDays
            className="text-ink-subtle pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="date"
            value={anchorIso}
            onChange={(event) => onAnchorChange(event.target.value)}
            className="h-9 w-[10.5rem] ps-8"
          />
        </label>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search
              className="text-ink-subtle pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Find on this board"
              aria-label="Search the visible schedule"
              className="ps-9"
            />
            {search !== '' && matchCount !== null ? (
              <span className="text-ink-subtle absolute end-3 top-1/2 -translate-y-1/2 text-[0.6875rem]">
                {matchCount}
              </span>
            ) : null}
          </div>

          <div
            className="border-line-strong bg-surface shadow-raised flex items-center rounded-md border p-0.5"
            role="group"
            aria-label="Timeline span"
          >
            {CALENDAR_VIEWS.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => onViewChange(entry)}
                aria-pressed={view === entry}
                className={cn(
                  'rounded px-2.5 py-1 text-[0.75rem] font-medium transition-colors',
                  'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-1',
                  view === entry
                    ? 'bg-brand-700 text-ink-inverse'
                    : 'text-ink-muted hover:bg-surface-inset hover:text-ink',
                )}
              >
                {CALENDAR_VIEW_LABELS[entry]}
              </button>
            ))}
          </div>

          <Button
            variant={showFilters || activeFilterCount > 0 ? 'secondary' : 'ghost'}
            leadingIcon={<SlidersHorizontal />}
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            aria-controls="calendar-filters"
          >
            Filters
            {activeFilterCount > 0 ? (
              <Badge tone="brand" className="ms-1">
                {activeFilterCount}
              </Badge>
            ) : null}
          </Button>
        </div>
      </div>

      {showFilters ? (
        <div
          id="calendar-filters"
          className="border-line bg-surface space-y-4 rounded-lg border p-4"
        >
          <fieldset>
            <legend className="text-ink mb-2 block text-[0.8125rem] font-medium">
              Show on the board
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {SCHEDULE_STATUS_OPTIONS.map((option) => {
                const isOn = filters.statuses.includes(option.value)
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleStatus(option.value)}
                    aria-pressed={isOn}
                    title={option.hint}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[0.75rem] transition-colors',
                      'focus-visible:outline-brand-500 focus-visible:outline-2 focus-visible:outline-offset-1',
                      isOn
                        ? 'border-brand-400 bg-brand-50 text-brand-700 font-medium'
                        : 'border-line text-ink-muted hover:border-line-strong',
                    )}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
            <p className="text-ink-subtle mt-1.5 text-[0.6875rem]">
              Drafts hold no vehicle, so they are off by default and drawn as outlines when shown.
            </p>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-ink block text-[0.8125rem] font-medium">Make</span>
              <Select
                aria-label="Filter by make"
                value={filters.makes[0] ?? ''}
                onChange={(event) =>
                  onFiltersChange({ makes: event.target.value === '' ? [] : [event.target.value] })
                }
                options={[
                  { value: '', label: 'Every make' },
                  ...availableMakes.map((make) => ({ value: make, label: make })),
                ]}
              />
            </label>

            <label className="text-ink flex items-end gap-2 pb-2 text-[0.8125rem]">
              <input
                type="checkbox"
                checked={filters.includeArchived}
                onChange={(event) => onFiltersChange({ includeArchived: event.target.checked })}
                className="accent-brand-600 size-4 rounded"
              />
              Include retired vehicles
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}
