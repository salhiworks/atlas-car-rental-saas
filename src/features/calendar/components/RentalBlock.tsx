import { AlertTriangle, ChevronLeft, ChevronRight, FileText } from 'lucide-react'
import { useMemo } from 'react'

import { formatDateTime, formatTime } from '@/lib/datetime/format'
import { cn } from '@/lib/utils/cn'
import type { RentalScheduleEntry } from '@/types/database'

import { TONE_LABELS, densityFor, toneFor, type ScheduleTone } from '../schedule'
import type { Placement } from '../time-grid'

/**
 * One booking on the board.
 *
 * A real button, not a coloured div: the schedule has to be operable from the
 * keyboard, and a member of staff who cannot use a mouse still has to be able
 * to reach every rental on it.
 *
 * Status is never carried by colour alone. Each block states its status in its
 * accessible name, drafts are drawn as outlines rather than fills, and overdue
 * carries an icon — so the board still reads correctly in monochrome, in
 * forced-colours mode, and to somebody who cannot distinguish the tints.
 */

const TONE_STYLES: Readonly<Record<ScheduleTone, string>> = {
  // Tentative: an outline, because a draft holds no vehicle and must never look
  // like a commitment.
  draft:
    'border border-dashed border-line-strong bg-surface text-ink-muted hover:border-ink-subtle',
  reserved: 'border border-info-200 bg-info-50 text-info-700 hover:border-info-600/40',
  active: 'border border-brand-200 bg-brand-100 text-brand-800 hover:border-brand-400',
  overdue:
    'border border-critical-200 bg-critical-50 text-critical-700 hover:border-critical-600/50',
  completed: 'border border-line bg-surface-inset text-ink-muted hover:border-line-strong',
  cancelled:
    'border border-line bg-surface text-ink-subtle line-through decoration-ink-subtle/50 hover:border-line-strong',
}

export interface RentalBlockProps {
  rental: RentalScheduleEntry
  placement: Placement
  /** Width of the lane in pixels, so the block can decide what it has room for. */
  laneWidthPx: number
  locale: string
  timeZone: string
  now: Date
  isFocused: boolean
  isDimmed: boolean
  isDragging?: boolean
  onOpen: (rental: RentalScheduleEntry) => void
  onDragStart?: (rental: RentalScheduleEntry, event: React.PointerEvent<HTMLElement>) => void
  canDrag: boolean
}

export function RentalBlock({
  rental,
  placement,
  laneWidthPx,
  locale,
  timeZone,
  now,
  isFocused,
  isDimmed,
  isDragging = false,
  onOpen,
  onDragStart,
  canDrag,
}: RentalBlockProps) {
  const tone = toneFor(rental, now)
  const widthPx = (placement.widthPct / 100) * laneWidthPx
  const density = densityFor(widthPx)

  const label = useMemo(() => {
    const when = `${formatDateTime(new Date(rental.starts_at), { locale, timeZone })} to ${formatDateTime(
      new Date(rental.ends_at),
      { locale, timeZone },
    )}`
    const driver = rental.renter_is_not_driver
      ? `, driven by ${rental.primary_driver_name ?? 'someone else'}`
      : ''
    return `${TONE_LABELS[tone]}: ${rental.reference}, ${rental.customer_name}${driver}, ${rental.vehicle_make} ${rental.vehicle_model} ${rental.vehicle_plate}, ${when}`
  }, [rental, tone, locale, timeZone])

  return (
    <button
      type="button"
      onClick={() => onOpen(rental)}
      onPointerDown={canDrag && onDragStart ? (event) => onDragStart(rental, event) : undefined}
      aria-label={label}
      data-rental-id={rental.id}
      title={label}
      className={cn(
        'group absolute top-1 bottom-1 flex items-center gap-1.5 overflow-hidden rounded-md px-2',
        'text-start transition-colors',
        'focus-visible:outline-brand-500 focus-visible:z-30 focus-visible:outline-2 focus-visible:outline-offset-1',
        TONE_STYLES[tone],
        canDrag && 'cursor-grab',
        isDragging && 'cursor-grabbing opacity-70',
        isDimmed && 'opacity-30',
        isFocused && 'ring-brand-500 z-20 ring-2 ring-offset-1',
        // A block clipped by the window edge loses that corner's rounding, so
        // it reads as continuing rather than as starting there.
        placement.clippedStart && 'rounded-s-none',
        placement.clippedEnd && 'rounded-e-none',
      )}
      style={{
        insetInlineStart: `${placement.leftPct}%`,
        width: `max(${placement.widthPct}%, 6px)`,
      }}
    >
      {placement.clippedStart ? (
        <ChevronLeft className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      ) : null}

      {tone === 'overdue' ? <AlertTriangle className="size-3 shrink-0" aria-hidden="true" /> : null}

      {density !== 'minimal' ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.75rem] leading-4 font-medium">
            {density === 'full' ? rental.customer_name : rental.vehicle_plate}
          </span>
          {density === 'full' ? (
            <span className="block truncate text-[0.625rem] leading-3 opacity-80">
              {rental.reference} · {formatTime(new Date(rental.starts_at), { locale, timeZone })}
              {' – '}
              {formatTime(new Date(rental.ends_at), { locale, timeZone })}
            </span>
          ) : null}
        </span>
      ) : null}

      {density === 'full' && rental.has_live_contract ? (
        <FileText className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      ) : null}

      {placement.clippedEnd ? (
        <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      ) : null}
    </button>
  )
}
