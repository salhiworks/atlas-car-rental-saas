import { CalendarSearch, CarFront, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { paths } from '@/app/routes/paths'
import { ErrorState } from '@/components/feedback/ErrorState'
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Skeleton,
} from '@/components/ui'
import { AvailabilitySearch } from '@/features/calendar/components/AvailabilitySearch'
import {
  CalendarToolbar,
  type CalendarFilters,
} from '@/features/calendar/components/CalendarToolbar'
import {
  DayOperationsList,
  DayOperationsStrip,
  type DayGroup,
} from '@/features/calendar/components/DayOperations'
import { FleetTimeline, type DragProposal } from '@/features/calendar/components/FleetTimeline'
import { RentalQuickView } from '@/features/calendar/components/RentalQuickView'
import { RescheduleDialog } from '@/features/calendar/components/RescheduleDialog'
import {
  anchorFromIso,
  buildRange,
  isCalendarView,
  queryWindow,
  stepRange,
  type CalendarView,
} from '@/features/calendar/ranges'
import {
  DEFAULT_SCHEDULE_STATUSES,
  dayOperations,
  matchesSearch,
} from '@/features/calendar/schedule'
import { useAvailability, useFleetRows, useSchedule } from '@/features/calendar/queries'
import { buildTimeGrid } from '@/features/calendar/time-grid'
import { useVehicleThumbnails } from '@/features/vehicles/queries'
import {
  useComplianceOptions,
  useOrganizationSettings,
} from '@/features/workspace/useOrganizationSettings'
import { useOrganization, usePermission } from '@/features/workspace/workspace-context'
import { formatDate } from '@/lib/datetime/format'
import {
  addDaysInTimeZone,
  startOfDayInTimeZone,
  toDateTimeLocalValue,
  toIsoDateInTimeZone,
} from '@/lib/datetime/timezone'
import { cn } from '@/lib/utils/cn'
import type { RentalScheduleEntry, RentalStatus, VehicleFleetEntry } from '@/types/database'

/**
 * The fleet scheduling board.
 *
 * A view over the rentals domain and nothing more. It holds no bookings of its
 * own, keeps no availability state, and every change it starts goes through the
 * same transactional functions the Rentals module uses — so a booking made here
 * is subject to exactly the constraints a booking made there is.
 *
 * The span and the date live in the URL, so a filtered board is something you
 * can bookmark and send to a colleague.
 */

const ALL_STATUSES: readonly RentalStatus[] = [
  'draft',
  'reserved',
  'active',
  'completed',
  'cancelled',
]

function parseStatuses(values: string[]): readonly RentalStatus[] {
  const valid = values.filter((value): value is RentalStatus =>
    (ALL_STATUSES as readonly string[]).includes(value),
  )
  return valid.length > 0 ? valid : DEFAULT_SCHEDULE_STATUSES
}

/** A tick every half minute keeps "now" and lateness honest without polling. */
function useClock(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}

export function CalendarPage() {
  const organization = useOrganization()
  const compliance = useComplianceOptions()
  const settingsQuery = useOrganizationSettings()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const canCreate = usePermission('rentals.create')
  const canReschedule = usePermission('rentals.update')

  const timeZone = organization.time_zone
  const locale = organization.locale
  const now = useClock()

  const firstDayOfWeek = settingsQuery.data?.first_day_of_week ?? 1

  // ------------------------------------------------------------- URL state

  const view: CalendarView = useMemo(() => {
    const value = searchParams.get('view') ?? 'week'
    return isCalendarView(value) ? value : 'week'
  }, [searchParams])

  const anchor = useMemo(
    () => anchorFromIso(searchParams.get('date'), timeZone, now),
    // `now` is deliberately not a dependency: the anchor should not slide while
    // somebody is looking at the board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, timeZone],
  )

  const filters: CalendarFilters = useMemo(
    () => ({
      statuses: parseStatuses(searchParams.getAll('status')),
      makes: searchParams.getAll('make'),
      includeArchived: searchParams.get('archived') === '1',
    }),
    [searchParams],
  )

  const dayGroup = (searchParams.get('focus') ?? '') as DayGroup | ''
  const activeGroup: DayGroup | null =
    dayGroup === 'pickups' ||
    dayGroup === 'returns' ||
    dayGroup === 'out' ||
    dayGroup === 'overdue' ||
    dayGroup === 'free'
      ? dayGroup
      : null

  // Search stays out of the URL: staff type customer names into it.
  const [search, setSearch] = useState('')
  const [quickView, setQuickView] = useState<RentalScheduleEntry | null>(null)
  const [proposal, setProposal] = useState<DragProposal | null>(null)
  const [showAvailability, setShowAvailability] = useState(false)
  const announceRef = useRef<HTMLParagraphElement | null>(null)

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          mutate(next)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // --------------------------------------------------------------- the grid

  const range = useMemo(
    () => buildRange(view, anchor, timeZone, firstDayOfWeek),
    [view, anchor, timeZone, firstDayOfWeek],
  )
  // The clock ticks every half minute so lateness stays honest, but the only
  // thing it can change about the grid is which column is today. Keying the
  // memo on the agency's date rather than the instant stops the whole board
  // being rebuilt a hundred and twenty times an hour.
  const todayIso = toIsoDateInTimeZone(now, timeZone)
  const grid = useMemo(
    () => buildTimeGrid(range.start, range.dayCount, timeZone, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, timeZone, todayIso],
  )

  const window = useMemo(() => queryWindow(range, timeZone), [range, timeZone])

  const scheduleQuery = useSchedule(window.from, window.to, filters.statuses)
  const fleetQuery = useFleetRows(filters.includeArchived, filters.makes)
  /**
   * "What is free from Friday to Monday" is a question about the whole fleet.
   * Answering it through the board's make filter would report the rest of the
   * fleet as committed, which is the opposite of what was asked.
   */
  const wholeFleetQuery = useFleetRows(false, [])

  const rentals = useMemo(() => scheduleQuery.data ?? [], [scheduleQuery.data])
  const vehicles = useMemo(() => fleetQuery.data ?? [], [fleetQuery.data])
  const wholeFleet = useMemo(() => wholeFleetQuery.data ?? [], [wholeFleetQuery.data])

  // ---------------------------------------------------------- the day panel

  const selectedDay = useMemo(() => {
    const today = startOfDayInTimeZone(now, timeZone)
    const withinRange = today >= range.start && today < range.end
    return withinRange ? today : range.start
  }, [now, timeZone, range])

  const selectedDayEnd = useMemo(
    () => addDaysInTimeZone(selectedDay, timeZone, 1),
    [selectedDay, timeZone],
  )

  const operations = useMemo(
    () => dayOperations(rentals, selectedDay, selectedDayEnd, now),
    [rentals, selectedDay, selectedDayEnd, now],
  )

  const freeQuery = useAvailability(selectedDay.toISOString(), selectedDayEnd.toISOString())

  // ------------------------------------------------------------- filtering

  /**
   * The day-panel selection narrows the board rather than replacing it: the
   * bookings that answer the chosen question stay lit and everything else dims,
   * so the schedule around them is still readable.
   */
  const highlightedIds = useMemo(() => {
    if (activeGroup === null || activeGroup === 'free') return null
    return new Set(operations[activeGroup].map((rental) => rental.id))
  }, [activeGroup, operations])

  const searchMatchIds = useMemo(() => {
    if (search.trim() === '') return null
    return new Set(
      rentals.filter((rental) => matchesSearch(rental, search)).map((rental) => rental.id),
    )
  }, [rentals, search])

  const dimmedAgainst = useMemo(() => {
    if (searchMatchIds && highlightedIds) {
      return new Set([...searchMatchIds].filter((id) => highlightedIds.has(id)))
    }
    return searchMatchIds ?? highlightedIds
  }, [searchMatchIds, highlightedIds])

  const visibleVehicles = useMemo(() => {
    // While the availability answer is still in flight the whole fleet stays on
    // screen: filtering against an empty set would announce that nothing is
    // free, which is a different statement from "not known yet".
    if (activeGroup !== 'free' || freeQuery.data === undefined) return vehicles
    const free = new Set(freeQuery.data)
    return vehicles.filter((vehicle) => free.has(vehicle.vehicle_id))
  }, [activeGroup, vehicles, freeQuery.data])

  const rentalsByVehicle = useMemo(() => {
    const grouped = new Map<string, RentalScheduleEntry[]>()
    for (const rental of rentals) {
      const list = grouped.get(rental.vehicle_id)
      if (list) list.push(rental)
      else grouped.set(rental.vehicle_id, [rental])
    }
    return grouped
  }, [rentals])

  // One signed-URL request for every vehicle on the board, reusing the fleet's
  // own thumbnail pipeline rather than fetching full-size photographs per row.
  const thumbnails = useVehicleThumbnails(
    useMemo(() => visibleVehicles.map((vehicle) => vehicle.vehicle_id), [visibleVehicles]),
  )

  const availableMakes = useMemo(
    () => [...new Set(vehicles.map((vehicle) => vehicle.make))].sort(),
    [vehicles],
  )

  // -------------------------------------------------------------- handlers

  const setView = (next: CalendarView) =>
    updateParams((params) => {
      params.set('view', next)
      // The anchor is pinned so switching span keeps the day you were looking at.
      params.set('date', toIsoDateInTimeZone(selectedDay, timeZone))
    })

  const setAnchor = (instant: Date) =>
    updateParams((params) => params.set('date', toIsoDateInTimeZone(instant, timeZone)))

  const step = (direction: -1 | 1) => setAnchor(stepRange(range, timeZone, direction))

  const goToday = () =>
    updateParams((params) => {
      params.delete('date')
      params.delete('focus')
    })

  const changeFilters = (patch: Partial<CalendarFilters>) =>
    updateParams((params) => {
      if (patch.statuses) {
        params.delete('status')
        for (const status of patch.statuses) params.append('status', status)
      }
      if (patch.makes) {
        params.delete('make')
        for (const make of patch.makes) params.append('make', make)
      }
      if (patch.includeArchived !== undefined) {
        if (patch.includeArchived) params.set('archived', '1')
        else params.delete('archived')
      }
    })

  /**
   * Starting a booking from the board.
   *
   * Only the vehicle and the period travel — non-sensitive identifiers and
   * timestamps — and the rental flow validates every one of them again before
   * anything is created. There is no shortcut around the real creation
   * workflow, its availability check or its driver requirement.
   */
  const startRental = useCallback(
    (vehicleId: string, startsAt: Date, endsAt: Date) => {
      const params = new URLSearchParams({
        vehicle: vehicleId,
        from: startsAt.toISOString(),
        to: endsAt.toISOString(),
      })
      void navigate(`${paths.rentalNew}?${params.toString()}`)
    },
    [navigate],
  )

  const createAt = useCallback(
    (vehicle: VehicleFleetEntry, startsAt: Date) => {
      // A day's hire is the sensible opening guess from a single click; the
      // flow lets it be changed before anything is booked.
      startRental(vehicle.vehicle_id, startsAt, addDaysInTimeZone(startsAt, timeZone, 1))
    },
    [startRental, timeZone],
  )

  const proposeMove = useCallback((next: DragProposal) => {
    setProposal(next)
    if (announceRef.current) {
      announceRef.current.textContent = `Move proposed for ${next.rental.reference}. Confirm or cancel in the dialog.`
    }
  }, [])

  const rangeLabel = useMemo(() => {
    const first = formatDate(range.start, { locale, timeZone })
    if (range.dayCount === 1) return first
    const last = formatDate(addDaysInTimeZone(range.start, timeZone, range.dayCount - 1), {
      locale,
      timeZone,
    })
    return `${first} – ${last}`
  }, [range, locale, timeZone])

  const isTodayInRange =
    startOfDayInTimeZone(now, timeZone) >= range.start &&
    startOfDayInTimeZone(now, timeZone) < range.end

  const isLoading = scheduleQuery.isPending || fleetQuery.isPending
  const isRefreshing = scheduleQuery.isFetching && !scheduleQuery.isPending

  const hasError = scheduleQuery.isError || fleetQuery.isError

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        eyebrow="Operations"
        description={`What ${organization.name} has out, what is coming back, and what is free.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              leadingIcon={<CalendarSearch />}
              onClick={() => setShowAvailability((open) => !open)}
              aria-expanded={showAvailability}
            >
              Find a free vehicle
            </Button>
            {canCreate ? (
              <ButtonLink variant="primary" leadingIcon={<Plus />} to={paths.rentalNew}>
                New rental
              </ButtonLink>
            ) : null}
          </div>
        }
      />

      <p ref={announceRef} className="sr-only" role="status" aria-live="polite" />

      <DayOperationsStrip
        operations={operations}
        freeVehicleCount={freeQuery.data?.length ?? null}
        active={activeGroup}
        onSelect={(group) => updateParams((params) => params.set('focus', group))}
        onClear={() => updateParams((params) => params.delete('focus'))}
        isLoading={isLoading}
      />

      <p className="text-ink-subtle -mt-2 text-[0.75rem]">
        {isTodayInRange ? 'Today' : formatDate(selectedDay, { locale, timeZone })} ·{' '}
        {organization.time_zone.replace(/_/g, ' ')}
      </p>

      {showAvailability ? (
        <Card>
          <CardHeader
            title="Find a free vehicle"
            description="Uses the same availability check the booking flow does."
          />
          <CardBody>
            <AvailabilitySearch
              vehicles={wholeFleet}
              locale={locale}
              timeZone={timeZone}
              compliance={compliance}
              canCreate={canCreate}
              onStartRental={startRental}
              initialStartsAt={toDateTimeLocalValue(selectedDay, timeZone).slice(0, 11) + '09:00'}
              initialEndsAt={
                toDateTimeLocalValue(addDaysInTimeZone(selectedDay, timeZone, 3), timeZone).slice(
                  0,
                  11,
                ) + '09:00'
              }
            />
          </CardBody>
        </Card>
      ) : null}

      <CalendarToolbar
        view={view}
        onViewChange={setView}
        rangeLabel={rangeLabel}
        anchorIso={range.anchorIso}
        onAnchorChange={(isoDate) =>
          updateParams((params) => {
            if (isoDate) params.set('date', isoDate)
          })
        }
        onStep={step}
        onToday={goToday}
        isToday={isTodayInRange && searchParams.get('date') === null}
        filters={filters}
        onFiltersChange={changeFilters}
        availableMakes={availableMakes}
        search={search}
        onSearchChange={setSearch}
        matchCount={searchMatchIds?.size ?? null}
      />

      {hasError ? (
        <Card>
          <ErrorState
            error={scheduleQuery.error ?? fleetQuery.error}
            onRetry={() => {
              void scheduleQuery.refetch()
              void fleetQuery.refetch()
            }}
          />
        </Card>
      ) : null}

      {rentals.length >= 2000 ? (
        <Alert tone="caution" title="This window is very full">
          Only the first 2000 bookings are drawn. Narrow the span or filter by make to see the rest.
        </Alert>
      ) : null}

      {/* The timeline. Below the large breakpoint a Gantt chart answers nothing,
          so the same day is served as a worklist instead. */}
      <Card className="hidden overflow-hidden lg:block">
        {isLoading ? (
          <div className="space-y-px p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3 py-2">
                <Skeleton className="h-8 w-52" />
                <Skeleton className="h-6 flex-1" />
              </div>
            ))}
          </div>
        ) : visibleVehicles.length === 0 ? (
          <EmptyState
            icon={CarFront}
            title={
              activeGroup === 'free' ? 'Nothing is free on this day' : 'No vehicles to schedule'
            }
            description={
              activeGroup === 'free'
                ? 'Every vehicle is committed or off the road for this day.'
                : 'Add a vehicle to the fleet and it will appear on the board.'
            }
            action={
              activeGroup === 'free' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => updateParams((params) => params.delete('focus'))}
                >
                  Show the whole fleet
                </Button>
              ) : (
                <ButtonLink variant="primary" to={paths.vehicleNew}>
                  Add a vehicle
                </ButtonLink>
              )
            }
          />
        ) : (
          <FleetTimeline
            grid={grid}
            vehicles={visibleVehicles}
            thumbnails={thumbnails}
            rentalsByVehicle={rentalsByVehicle}
            locale={locale}
            now={now}
            compliance={compliance}
            focusedRentalId={quickView?.id ?? null}
            dimmedRentalIds={dimmedAgainst}
            isRefreshing={isRefreshing}
            canCreate={canCreate}
            canReschedule={canReschedule}
            onOpenRental={setQuickView}
            onCreateAt={createAt}
            onProposeMove={proposeMove}
          />
        )}
      </Card>

      <Card className={cn('overflow-hidden lg:hidden')}>
        <CardHeader
          title={isTodayInRange ? 'Today' : formatDate(selectedDay, { locale, timeZone })}
          description="Pickups, returns and what is out."
        />
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <DayOperationsList
            operations={operations}
            locale={locale}
            timeZone={timeZone}
            onOpen={setQuickView}
          />
        )}
      </Card>

      {quickView ? (
        <RentalQuickView
          rental={quickView}
          open
          onOpenChange={(open) => (open ? undefined : setQuickView(null))}
          locale={locale}
          timeZone={timeZone}
          canReschedule={canReschedule}
          onReschedule={(rental) =>
            setProposal({
              rental,
              startsAt: new Date(rental.starts_at),
              endsAt: new Date(rental.ends_at),
              vehicle: vehicles.find((vehicle) => vehicle.vehicle_id === rental.vehicle_id)!,
              vehicleChanged: false,
            })
          }
        />
      ) : null}

      {proposal ? (
        <RescheduleDialog
          open
          onOpenChange={(open) => (open ? undefined : setProposal(null))}
          rental={proposal.rental}
          proposedStartsAt={proposal.startsAt}
          proposedEndsAt={proposal.endsAt}
          targetVehicle={proposal.vehicleChanged ? proposal.vehicle : null}
          locale={locale}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  )
}
