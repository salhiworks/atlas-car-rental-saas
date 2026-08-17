import { CalendarRange } from 'lucide-react'
import { useMemo, useState } from 'react'

import { EmptyState, Skeleton } from '@/components/ui'
import { formatDate, formatMonth, parseIsoDate } from '@/lib/datetime/format'
import { useElementWidth } from '@/lib/utils/useElementWidth'
import type { ReportUtilisationRow } from '@/types/database'

import { formatBps, formatDays } from '../domain'
import type { ReportGranularity } from '../period'

/**
 * Occupancy over time, as a proportion.
 *
 * One series, so the axis is a percentage and reads without a legend. The bars
 * are days-on-hire scaled by days-available in the same bucket, which is what
 * makes a month where two cars were sold comparable with the month before it —
 * an absolute day count would fall and look like a downturn.
 *
 * The figures are repeated in a hidden table, because a proportion nobody can
 * read out loud is not information.
 */

const HEIGHT = 180
const PADDING = { top: 12, right: 8, bottom: 26, left: 44 }
const CORNER_RADIUS = 3

function barPath(x: number, y: number, width: number, height: number): string {
  if (height <= 0) return ''
  const radius = Math.min(CORNER_RADIUS, width / 2, height)
  return [
    `M ${x} ${y + height}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${x + width - radius} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + radius}`,
    `L ${x + width} ${y + height}`,
    'Z',
  ].join(' ')
}

export interface UtilisationChartProps {
  series: readonly ReportUtilisationRow[]
  locale: string
  timeZone: string
  granularity: ReportGranularity
  isLoading?: boolean
}

export function UtilisationChart({
  series,
  locale,
  timeZone,
  granularity,
  isLoading = false,
}: UtilisationChartProps) {
  const { ref: containerRef, width } = useElementWidth()
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const buckets = useMemo(
    () =>
      series.map((row) => {
        const date = parseIsoDate(row.bucket_start, timeZone) ?? new Date(row.bucket_start)
        return {
          date,
          bps: row.utilisation_bps,
          rented: Number(row.vehicle_days_rented),
          available: Number(row.vehicle_days_available),
          hires: Number(row.hires_started),
          fullLabel:
            granularity === 'month'
              ? formatMonth(date, { locale, timeZone })
              : formatDate(date, { locale, timeZone }),
          axisLabel:
            granularity === 'month'
              ? new Intl.DateTimeFormat(locale, { month: 'short', timeZone }).format(date)
              : new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone }).format(date),
        }
      }),
    [series, granularity, locale, timeZone],
  )

  if (isLoading) {
    return (
      <div className="p-5">
        <Skeleton className="h-[180px] w-full" />
      </div>
    )
  }

  if (buckets.length === 0 || buckets.every((bucket) => bucket.available === 0)) {
    return (
      <EmptyState
        icon={CalendarRange}
        size="sm"
        title="No fleet time to measure"
        description="Utilisation needs vehicles that existed during the period."
      />
    )
  }

  const innerWidth = Math.max(0, width - PADDING.left - PADDING.right)
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom
  const bucketWidth = innerWidth / buckets.length
  const barWidth = Math.max(2, bucketWidth * 0.62)

  const scaleY = (bps: number) => (bps / 10_000) * innerHeight
  const labelStride = Math.max(
    1,
    Math.ceil(buckets.length / Math.max(1, Math.floor(innerWidth / 42))),
  )
  const hovered = hoveredIndex === null ? null : buckets[hoveredIndex]

  return (
    <div className="p-5">
      <div ref={containerRef} className="relative">
        {width > 0 ? (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Fleet utilisation per ${granularity}`}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            {[0, 2500, 5000, 7500, 10000].map((tick) => {
              const y = PADDING.top + innerHeight - scaleY(tick)
              return (
                <g key={tick}>
                  <line
                    x1={PADDING.left}
                    x2={PADDING.left + innerWidth}
                    y1={y}
                    y2={y}
                    stroke="var(--color-chart-grid)"
                    strokeWidth={1}
                  />
                  <text
                    x={PADDING.left - 8}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-[var(--color-ink-subtle)] text-[0.6875rem] tabular-nums"
                  >
                    {tick / 100}%
                  </text>
                </g>
              )
            })}

            {buckets.map((bucket, index) => {
              const height = scaleY(bucket.bps ?? 0)
              const x = PADDING.left + index * bucketWidth + (bucketWidth - barWidth) / 2
              const baseline = PADDING.top + innerHeight

              return (
                <g key={bucket.date.toISOString()}>
                  {hoveredIndex === index ? (
                    <rect
                      x={PADDING.left + index * bucketWidth}
                      y={PADDING.top}
                      width={bucketWidth}
                      height={innerHeight}
                      fill="var(--color-surface-inset)"
                    />
                  ) : null}

                  <path
                    d={barPath(x, baseline - height, barWidth, height)}
                    fill="var(--color-chart-revenue)"
                  />

                  {index % labelStride === 0 ? (
                    <text
                      x={PADDING.left + index * bucketWidth + bucketWidth / 2}
                      y={HEIGHT - 8}
                      textAnchor="middle"
                      className="fill-[var(--color-ink-subtle)] text-[0.6875rem]"
                    >
                      {bucket.axisLabel}
                    </text>
                  ) : null}

                  <rect
                    x={PADDING.left + index * bucketWidth}
                    y={PADDING.top}
                    width={bucketWidth}
                    height={innerHeight}
                    fill="transparent"
                    onMouseEnter={() => setHoveredIndex(index)}
                  />
                </g>
              )
            })}

            <line
              x1={PADDING.left}
              x2={PADDING.left + innerWidth}
              y1={PADDING.top + innerHeight}
              y2={PADDING.top + innerHeight}
              stroke="var(--color-line-strong)"
              strokeWidth={1}
            />
          </svg>
        ) : (
          <div style={{ height: HEIGHT }} />
        )}

        {hovered && hoveredIndex !== null ? (
          <div
            role="status"
            className="bg-surface border-line pointer-events-none absolute top-2 z-10 w-48 rounded-md border p-2.5 shadow-overlay"
            style={{
              left: Math.min(
                Math.max(PADDING.left + hoveredIndex * bucketWidth + bucketWidth / 2 - 96, 0),
                Math.max(width - 192, 0),
              ),
            }}
          >
            <p className="text-ink text-[0.75rem] font-semibold">{hovered.fullLabel}</p>
            <p data-numeric="" className="text-ink mt-1 text-[0.8125rem] font-medium">
              {formatBps(hovered.bps, locale)}
            </p>
            <p className="text-ink-muted text-[0.75rem]">
              {formatDays(hovered.rented, locale)} of {formatDays(hovered.available, locale)}{' '}
              vehicle-days
            </p>
          </div>
        ) : null}
      </div>

      {/*
        Wrapped rather than classed directly.
        `sr-only` sets `width: 1px; overflow: hidden`, which a block honours and a
        table does not: CSS table layout treats a specified width as a minimum
        and grows to fit its content, so a visually-hidden table is a full-width
        element clipped by nothing. On a 390px screen it pushed the whole page
        sideways by sixty pixels. The wrapper is a block, so it clips.
      */}
      <div className="sr-only">
        <table>
          <caption>Fleet utilisation per period</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Utilisation</th>
              <th scope="col">Days on hire</th>
              <th scope="col">Days available</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.date.toISOString()}>
                <th scope="row">{bucket.fullLabel}</th>
                <td>{formatBps(bucket.bps, locale)}</td>
                <td>{formatDays(bucket.rented, locale)}</td>
                <td>{formatDays(bucket.available, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
