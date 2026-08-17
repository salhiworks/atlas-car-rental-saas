import { getZonedParts, zonedPartsToInstant } from '@/lib/datetime/timezone'
import { cn } from '@/lib/utils/cn'

import { fractionForInstant, type GridDay, type TimeGrid } from '../time-grid'

/**
 * The parts of the board that are made of time rather than of bookings: the
 * date header, the gridlines behind every lane, and the "now" marker.
 *
 * They are kept together because they must agree to the pixel — a header label
 * one column away from the gridline under it makes the whole board untrustworthy
 * — and all three read their positions from the same grid.
 */

/** Width one day gets, per span. A day view has room for hours; a month does not. */
export const DAY_WIDTH: Readonly<Record<number, number>> = {}

export function minDayWidthFor(dayCount: number): number {
  if (dayCount <= 1) return 720
  if (dayCount <= 7) return 168
  if (dayCount <= 14) return 96
  return 56
}

export const LANE_HEIGHT = 56
export const VEHICLE_COLUMN_WIDTH = 236

/**
 * Where each hour mark sits inside its day column, as a fraction.
 *
 * Derived from the instant that local hour actually denotes rather than from
 * `hour / 24`. On the day an hour is lost, 12:00 is 11 elapsed hours after
 * midnight, so a fraction of 12/23 would put the label — and the gridline
 * under it — an hour away from the time it names.
 */
function hourMarks(
  day: GridDay,
  step: number,
  timeZone: string,
): Array<{ hour: number; at: number }> {
  if (step <= 0) return []

  const parts = getZonedParts(day.start, timeZone)
  const span = day.end.getTime() - day.start.getTime()
  const marks: Array<{ hour: number; at: number }> = []

  for (let hour = step; hour < 24; hour += step) {
    const instant = zonedPartsToInstant({ ...parts, hour, minute: 0, second: 0 }, timeZone)
    const at = (instant.getTime() - day.start.getTime()) / span
    if (at > 0 && at < 1) marks.push({ hour, at })
  }

  return marks
}

function weekdayLabel(day: { start: Date }, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone }).format(day.start)
}

function dayNumber(day: { start: Date }, timeZone: string): number {
  return getZonedParts(day.start, timeZone).day
}

function monthLabel(day: { start: Date }, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone }).format(day.start)
}

export interface TimelineHeaderProps {
  grid: TimeGrid
  locale: string
}

export function TimelineHeader({ grid, locale }: TimelineHeaderProps) {
  const width = 100 / grid.days.length
  // A month column is ~56px wide, which fits "SAT 1" and nothing else. The
  // range label above the board already names the month, so the inline one is
  // dropped rather than allowed to collide with the next column.
  const showsMonth = grid.days.length <= 14

  return (
    <div className="relative flex h-11 items-stretch" aria-hidden="true">
      {grid.days.map((day, index) => (
        <div
          key={day.isoDate}
          className={cn(
            'border-line relative flex flex-col justify-center border-s px-2',
            index === 0 && 'border-s-0',
            day.isWeekend && 'bg-surface-inset/50',
            day.isToday && 'bg-brand-50/70',
          )}
          style={{ width: `${width}%` }}
        >
          <div className="flex items-baseline gap-1.5">
            <span
              className={cn(
                'text-[0.6875rem] font-medium tracking-wide uppercase',
                day.isToday ? 'text-brand-700' : 'text-ink-subtle',
              )}
            >
              {weekdayLabel(day, grid.timeZone, locale)}
            </span>
            <span
              data-numeric=""
              className={cn(
                'text-[0.8125rem] leading-4',
                day.isToday ? 'text-brand-700 font-semibold' : 'text-ink font-medium',
              )}
            >
              {dayNumber(day, grid.timeZone)}
            </span>
            {/* The month is named on the first column and wherever it turns
                over, so a window spanning two months never leaves the reader
                guessing which one they are looking at. */}
            {showsMonth && (index === 0 || dayNumber(day, grid.timeZone) === 1) ? (
              <span className="text-ink-subtle text-[0.6875rem]">
                {monthLabel(day, grid.timeZone, locale)}
              </span>
            ) : null}
          </div>

          {grid.hourStep > 0 ? (
            <div className="text-ink-subtle relative mt-0.5 h-3 text-[0.625rem] tabular-nums">
              {hourMarks(day, grid.hourStep, grid.timeZone).map((mark) => (
                <span
                  key={mark.hour}
                  className="absolute top-0"
                  style={{ insetInlineStart: `${mark.at * 100}%` }}
                >
                  {String(mark.hour).padStart(2, '0')}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * The gridlines a lane is drawn on.
 *
 * One absolutely positioned layer per lane rather than a border on each block:
 * borders would shift the blocks by a pixel and make identical hires look
 * different widths.
 */
export function LaneGrid({ grid }: { grid: TimeGrid }) {
  const width = 100 / grid.days.length

  return (
    <div className="pointer-events-none absolute inset-0 flex" aria-hidden="true">
      {grid.days.map((day, index) => (
        <div
          key={day.isoDate}
          className={cn(
            'border-line/70 relative border-s',
            index === 0 && 'border-s-0',
            day.isWeekend && 'bg-surface-inset/40',
            day.isToday && 'bg-brand-50/40',
          )}
          style={{ width: `${width}%` }}
        >
          {hourMarks(day, grid.hourStep, grid.timeZone).map((mark) => (
            <span
              key={mark.hour}
              className="border-line/40 absolute inset-y-0 border-s"
              style={{ insetInlineStart: `${mark.at * 100}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Where the agency is in its own day.
 *
 * Rendered from the agency's clock, not the browser's, so a manager checking
 * the Casablanca board from Lisbon sees the line where the Casablanca desk sees
 * it. Hidden when now is outside the window, because a marker pinned to an edge
 * would suggest a time that is not on screen.
 */
export function NowIndicator({
  grid,
  now,
  withMarker = false,
}: {
  grid: TimeGrid
  now: Date
  /** The dot. Drawn once, in the header — a dot per lane reads as a dotted line. */
  withMarker?: boolean
}) {
  if (now < grid.start || now >= grid.end) return null

  const left = fractionForInstant(grid, now) * 100

  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-20"
      style={{ insetInlineStart: `${left}%` }}
      aria-hidden="true"
    >
      <span className="bg-critical-600/60 absolute inset-y-0 -ms-px w-px" />
      {withMarker ? (
        <span className="bg-critical-600 absolute -bottom-[3px] -ms-[3px] size-1.5 rounded-full" />
      ) : null}
    </div>
  )
}
