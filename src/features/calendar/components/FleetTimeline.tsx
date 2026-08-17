import { CarFront, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { vehicleDetailPath } from '@/app/routes/paths'
import { Badge } from '@/components/ui'
import { evaluateVehicleCompliance, type ComplianceOptions } from '@/lib/compliance/expiry'
import { formatDateTime } from '@/lib/datetime/format'
import { cn } from '@/lib/utils/cn'
import type { RentalScheduleEntry, VehicleFleetEntry } from '@/types/database'

import {
  fractionForInstant,
  instantForFraction,
  placeInterval,
  shiftInterval,
  snapInstant,
  snapStepForGrid,
  type TimeGrid,
} from '../time-grid'
import { RentalBlock } from './RentalBlock'
import {
  LANE_HEIGHT,
  LaneGrid,
  NowIndicator,
  TimelineHeader,
  VEHICLE_COLUMN_WIDTH,
  minDayWidthFor,
} from './TimelineFrame'

/**
 * The fleet timeline.
 *
 * One scroll container with two sticky axes, rather than two panes kept in step
 * by JavaScript: the vehicle column sticks to the left, the date header to the
 * top, and the browser keeps them aligned for free. Scroll-syncing code is the
 * usual source of a scheduler where the rows drift a few pixels away from their
 * labels under fast scrolling.
 *
 * Nothing here decides whether a vehicle is free. Blocks are drawn from the
 * bookings the database returned, and operational unavailability is drawn from
 * the vehicle's own state — the two are separate facts and are shown as such,
 * because a car in the workshop is unavailable whether or not anything is
 * booked on it.
 */

/** Above this many rows, only the ones near the viewport are mounted. */
const WINDOWING_THRESHOLD = 60
const OVERSCAN_ROWS = 6

export interface DragProposal {
  readonly rental: RentalScheduleEntry
  readonly startsAt: Date
  readonly endsAt: Date
  readonly vehicle: VehicleFleetEntry
  readonly vehicleChanged: boolean
}

export interface FleetTimelineProps {
  grid: TimeGrid
  vehicles: readonly VehicleFleetEntry[]
  /** Signed thumbnail URLs by vehicle id; a vehicle without one gets the icon. */
  thumbnails: ReadonlyMap<string, string>
  rentalsByVehicle: ReadonlyMap<string, readonly RentalScheduleEntry[]>
  locale: string
  now: Date
  compliance: ComplianceOptions
  focusedRentalId: string | null
  /** Blocks that fell out of the current search, dimmed rather than removed. */
  dimmedRentalIds: ReadonlySet<string> | null
  isRefreshing: boolean
  canCreate: boolean
  canReschedule: boolean
  onOpenRental: (rental: RentalScheduleEntry) => void
  onCreateAt: (vehicle: VehicleFleetEntry, startsAt: Date) => void
  onProposeMove: (proposal: DragProposal) => void
}

interface DragState {
  readonly rental: RentalScheduleEntry
  readonly pointerId: number
  readonly originX: number
  readonly originY: number
  readonly laneIndex: number
  startsAt: Date
  endsAt: Date
  targetIndex: number
  moved: boolean
}

export function FleetTimeline({
  grid,
  vehicles,
  thumbnails,
  rentalsByVehicle,
  locale,
  now,
  compliance,
  focusedRentalId,
  dimmedRentalIds,
  isRefreshing,
  canCreate,
  canReschedule,
  onOpenRental,
  onCreateAt,
  onProposeMove,
}: FleetTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [laneWidthPx, setLaneWidthPx] = useState(900)
  const [visibleRange, setVisibleRange] = useState({ from: 0, to: 40 })
  const [drag, setDrag] = useState<DragState | null>(null)
  /**
   * A drag that ends over the block it started on still produces a click, which
   * would open the quick view on top of the move dialog. The flag swallows that
   * one click and nothing else.
   */
  const suppressClickRef = useRef(false)

  const minWidth = VEHICLE_COLUMN_WIDTH + grid.days.length * minDayWidthFor(grid.days.length)
  const isWindowed = vehicles.length > WINDOWING_THRESHOLD

  /**
   * The lane's pixel width decides how much a block can say, so it is measured
   * rather than assumed — the same window is a different number of pixels on a
   * laptop and on a counter monitor.
   *
   * Measured on the header, which is always mounted. Observing a lane instead
   * looked equivalent and was not: once windowing unmounted the observed row,
   * the observer was left watching a detached node reporting zero width, and
   * every block on a large fleet silently dropped its label.
   */
  useEffect(() => {
    const element = measureRef.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      if (width > 0) setLaneWidthPx(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const recomputeWindow = useCallback(() => {
    const element = scrollRef.current
    if (!element) return

    const first = Math.floor(element.scrollTop / LANE_HEIGHT) - OVERSCAN_ROWS
    const count = Math.ceil(element.clientHeight / LANE_HEIGHT) + OVERSCAN_ROWS * 2
    setVisibleRange({ from: Math.max(0, first), to: Math.max(0, first) + count })
  }, [])

  useEffect(() => {
    if (!isWindowed) return
    recomputeWindow()

    const element = scrollRef.current
    if (!element) return

    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        recomputeWindow()
      })
    }

    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [isWindowed, recomputeWindow, vehicles.length])

  const rows = useMemo(
    () =>
      isWindowed
        ? vehicles.slice(visibleRange.from, visibleRange.to).map((vehicle, offset) => ({
            vehicle,
            index: visibleRange.from + offset,
          }))
        : vehicles.map((vehicle, index) => ({ vehicle, index })),
    [isWindowed, vehicles, visibleRange],
  )

  // ---------------------------------------------------------------- dragging

  const snapStep = snapStepForGrid(grid)

  const endDrag = useCallback(() => setDrag(null), [])

  useEffect(() => {
    if (!drag) return

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return

      const deltaX = event.clientX - drag.originX
      const deltaY = event.clientY - drag.originY
      if (!drag.moved && Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4) return

      const originalStart = new Date(drag.rental.starts_at)
      const originalEnd = new Date(drag.rental.ends_at)
      const deltaFraction = deltaX / Math.max(laneWidthPx, 1)

      let startsAt: Date
      let endsAt: Date

      if (snapStep === 0) {
        // A month column is worth a day, so the drag moves whole agency-local
        // days and the booking keeps the collection time it was agreed at, even
        // across a clock change. The day count comes from columns crossed, not
        // from elapsed milliseconds, which a short or long day would distort.
        const deltaDays = Math.round(deltaFraction * grid.days.length)
        const moved = shiftInterval(
          originalStart,
          originalEnd,
          deltaDays * 86_400_000,
          grid.timeZone,
          {
            wholeDays: true,
          },
        )
        startsAt = moved.startsAt
        endsAt = moved.endsAt
      } else {
        // Finer spans are a genuine change of time of day. Positions are read
        // back through the same grid that drew the block, so the pixel the
        // pointer is over denotes exactly the instant the block would be drawn
        // at — the two cannot drift apart on the day an hour goes missing.
        const proposed = instantForFraction(
          grid,
          Math.min(1, Math.max(0, fractionForInstant(grid, originalStart) + deltaFraction)),
        )
        startsAt = snapInstant(proposed, grid.timeZone, snapStep)
        // Elapsed duration is preserved; the dialog states both resulting times.
        endsAt = new Date(startsAt.getTime() + (originalEnd.getTime() - originalStart.getTime()))
      }

      const laneOffset = Math.round(deltaY / LANE_HEIGHT)
      const targetIndex = Math.min(vehicles.length - 1, Math.max(0, drag.laneIndex + laneOffset))

      setDrag((current) =>
        current === null ? null : { ...current, startsAt, endsAt, targetIndex, moved: true },
      )
    }

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return
      if (event.target instanceof Element && event.target.hasPointerCapture?.(event.pointerId)) {
        event.target.releasePointerCapture(event.pointerId)
      }

      const target = vehicles[drag.targetIndex]
      // A click that never moved is a click: it opens the booking instead.
      if (drag.moved) suppressClickRef.current = true
      if (drag.moved && target) {
        onProposeMove({
          rental: drag.rental,
          startsAt: drag.startsAt,
          endsAt: drag.endsAt,
          vehicle: target,
          vehicleChanged: target.vehicle_id !== drag.rental.vehicle_id,
        })
      }
      endDrag()
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') endDrag()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [drag, grid, laneWidthPx, snapStep, vehicles, onProposeMove, endDrag])

  const startDrag = useCallback(
    (rental: RentalScheduleEntry, laneIndex: number, event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      // Capture the pointer so the release is delivered here even if it happens
      // over another element or outside the window. Without it a pointerup the
      // page never receives would leave the board stuck in drag mode.
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Capture is a convenience; the window listeners are the real path.
      }
      setDrag({
        rental,
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        laneIndex,
        startsAt: new Date(rental.starts_at),
        endsAt: new Date(rental.ends_at),
        targetIndex: laneIndex,
        moved: false,
      })
    },
    [],
  )

  const handleLaneClick = useCallback(
    (vehicle: VehicleFleetEntry, event: React.MouseEvent<HTMLDivElement>) => {
      if (!canCreate) return
      // Only the lane's own background starts a booking; a click that landed on
      // a block has already been handled by it.
      if (event.target !== event.currentTarget) return
      // A drag released over empty lane space also produces a click here. Left
      // alone it would navigate to the booking flow and throw away the move the
      // desk had just proposed.
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }

      const rect = event.currentTarget.getBoundingClientRect()
      const fraction = (event.clientX - rect.left) / rect.width
      const instant = instantForFraction(grid, Math.min(1, Math.max(0, fraction)))
      onCreateAt(vehicle, snapInstant(instant, grid.timeZone, snapStep > 0 ? snapStep : 60))
    },
    [canCreate, grid, onCreateAt, snapStep],
  )

  const dragPlacement = drag?.moved ? placeInterval(grid, drag.startsAt, drag.endsAt) : null

  return (
    <div
      ref={scrollRef}
      className={cn(
        'relative max-h-[calc(100dvh-19rem)] min-h-[18rem] overflow-auto overscroll-x-contain',
        isRefreshing && 'opacity-70 transition-opacity',
      )}
    >
      <div style={{ minWidth }}>
        {/* Header. Sticky vertically; its first cell sticky horizontally too,
            so neither axis can slide out from under the other. */}
        <div className="bg-surface sticky top-0 z-30 flex">
          <div
            className="bg-surface border-line sticky start-0 z-40 flex shrink-0 items-end border-b border-e px-4 pb-2"
            style={{ width: VEHICLE_COLUMN_WIDTH }}
          >
            <span className="eyebrow">Fleet</span>
          </div>
          <div ref={measureRef} className="border-line relative flex-1 border-b">
            <TimelineHeader grid={grid} locale={locale} />
            <NowIndicator grid={grid} now={now} withMarker />
          </div>
        </div>

        {isWindowed ? <div style={{ height: visibleRange.from * LANE_HEIGHT }} /> : null}

        {rows.map(({ vehicle, index }) => {
          const rentals = rentalsByVehicle.get(vehicle.vehicle_id) ?? []
          const complianceState = evaluateVehicleCompliance(vehicle, compliance)
          const isOffRoad =
            vehicle.archived_at !== null || vehicle.operational_status !== 'available'
          const isDropTarget = drag?.moved === true && drag.targetIndex === index

          return (
            <div
              key={vehicle.vehicle_id}
              className={cn('border-line flex border-b', isDropTarget && 'bg-brand-50/40')}
              style={{ height: LANE_HEIGHT }}
            >
              <div
                className="bg-surface border-line sticky start-0 z-20 flex shrink-0 items-center gap-2.5 border-e px-3"
                style={{ width: VEHICLE_COLUMN_WIDTH }}
              >
                <span
                  className={cn(
                    'bg-surface-inset text-ink-subtle flex size-8 shrink-0 items-center justify-center overflow-hidden rounded',
                    vehicle.archived_at && 'opacity-50',
                  )}
                  aria-hidden="true"
                >
                  {thumbnails.get(vehicle.vehicle_id) ? (
                    <img
                      src={thumbnails.get(vehicle.vehicle_id)}
                      alt=""
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <CarFront className="size-4" />
                  )}
                </span>

                <span className="min-w-0 flex-1">
                  <Link
                    to={vehicleDetailPath(vehicle.vehicle_id)}
                    className="text-ink block truncate text-[0.8125rem] leading-4 font-medium hover:underline"
                  >
                    {vehicle.make} {vehicle.model}
                  </Link>
                  <span className="identifier text-ink-subtle block truncate text-[0.6875rem]">
                    {vehicle.registration_plate}
                  </span>
                </span>

                {complianceState.needsAttention ? (
                  <TriangleAlert
                    className={cn(
                      'size-3.5 shrink-0',
                      complianceState.overall === 'expired'
                        ? 'text-critical-600'
                        : 'text-caution-600',
                    )}
                    aria-label={
                      complianceState.overall === 'expired'
                        ? 'Compliance expired'
                        : 'Compliance due soon'
                    }
                  />
                ) : null}
              </div>

              <div
                className={cn('relative flex-1', canCreate && !isOffRoad && 'cursor-copy')}
                onClick={(event) => (isOffRoad ? undefined : handleLaneClick(vehicle, event))}
              >
                <LaneGrid grid={grid} />

                {/* Operational unavailability is the vehicle's own state, drawn
                    across the whole lane. It is not derived from bookings, and a
                    lane with no blocks on it is not therefore bookable. */}
                {isOffRoad ? (
                  <div
                    className="pointer-events-none absolute inset-0 flex items-center justify-center"
                    style={{
                      backgroundImage:
                        'repeating-linear-gradient(135deg, rgb(136 142 148 / 0.10) 0 6px, transparent 6px 12px)',
                    }}
                  >
                    <Badge tone="neutral">
                      {vehicle.archived_at
                        ? 'Retired'
                        : vehicle.operational_status === 'maintenance'
                          ? 'In maintenance'
                          : 'Off the road'}
                    </Badge>
                  </div>
                ) : null}

                {rentals.map((rental) => {
                  const placement = placeInterval(
                    grid,
                    new Date(rental.starts_at),
                    new Date(rental.ends_at),
                  )
                  if (!placement) return null

                  return (
                    <RentalBlock
                      key={rental.id}
                      rental={rental}
                      placement={placement}
                      laneWidthPx={laneWidthPx}
                      locale={locale}
                      timeZone={grid.timeZone}
                      now={now}
                      isFocused={focusedRentalId === rental.id}
                      isDimmed={dimmedRentalIds !== null && !dimmedRentalIds.has(rental.id)}
                      isDragging={drag?.rental.id === rental.id && drag.moved}
                      onOpen={(entry) => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false
                          return
                        }
                        onOpenRental(entry)
                      }}
                      canDrag={
                        canReschedule && (rental.status === 'draft' || rental.status === 'reserved')
                      }
                      onDragStart={(entry, event) => startDrag(entry, index, event)}
                    />
                  )
                })}

                {/* The proposal, drawn where the booking would land. The real
                    block never moves until the database has agreed. */}
                {isDropTarget && dragPlacement ? (
                  <div
                    className="border-brand-500 bg-brand-100/70 text-brand-800 pointer-events-none absolute top-1 bottom-1 z-30 flex items-center overflow-hidden rounded-md border-2 border-dashed px-2 text-[0.6875rem] font-medium"
                    style={{
                      insetInlineStart: `${dragPlacement.leftPct}%`,
                      width: `max(${dragPlacement.widthPct}%, 6px)`,
                    }}
                  >
                    <span className="truncate">
                      {formatDateTime(drag.startsAt, { locale, timeZone: grid.timeZone })}
                    </span>
                  </div>
                ) : null}

                <NowIndicator grid={grid} now={now} />
              </div>
            </div>
          )
        })}

        {isWindowed ? (
          <div
            style={{
              height: Math.max(0, (vehicles.length - visibleRange.to) * LANE_HEIGHT),
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
