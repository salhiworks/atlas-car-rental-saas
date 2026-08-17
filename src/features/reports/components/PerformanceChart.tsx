import { LineChart } from 'lucide-react'
import { useMemo, useState } from 'react'

import { EmptyState, Skeleton } from '@/components/ui'
import { formatDate, formatMonth, parseIsoDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { useElementWidth } from '@/lib/utils/useElementWidth'
import type { ReportSeriesRow } from '@/types/database'

import type { ReportGranularity } from '../period'

/**
 * Revenue against operating cost, with the operating result drawn on the same
 * scale.
 *
 * ONE AXIS. Revenue and cost are the same measure in the same currency and share
 * one scale; a second axis would let the two shapes be arranged to say whatever
 * the reader wanted, which is the single most common way a business chart
 * misleads.
 *
 * Bars for the two flows, because each bucket is a discrete settled amount and a
 * line between two buckets would draw money that was never received. The
 * operating result is a line, because it is a level rather than an amount that
 * arrived, and it is the one series that can go below the baseline.
 *
 * The same figures appear in a visually hidden table beneath, so the chart is
 * never the only representation.
 */

const HEIGHT = 240
const PADDING = { top: 12, right: 8, bottom: 28, left: 68 }
const BAR_GAP = 2
const CORNER_RADIUS = 4

export interface PerformanceChartProps {
  series: readonly ReportSeriesRow[]
  currency: string
  locale: string
  timeZone: string
  granularity: ReportGranularity
  isLoading?: boolean
}

/** Rounds an axis bound to a readable step (1, 2, 2.5, 5, 10 × 10ⁿ). */
function niceBound(value: number): number {
  if (value <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalised = value / magnitude
  const step =
    normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10
  return step * magnitude
}

/** A bar with only its data-end rounded, anchored flat to the baseline. */
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

export function PerformanceChart({
  series,
  currency,
  locale,
  timeZone,
  granularity,
  isLoading = false,
}: PerformanceChartProps) {
  const { ref: containerRef, width } = useElementWidth()
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const buckets = useMemo(
    () =>
      series.map((row) => {
        const date = parseIsoDate(row.bucket_start, timeZone) ?? new Date(row.bucket_start)
        return {
          date,
          revenue: Number(row.rental_revenue_minor),
          expenses: Number(row.operating_expense_minor),
          result: Number(row.operating_result_minor),
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

  const bounds = useMemo(() => {
    let high = 0
    let low = 0
    for (const bucket of buckets) {
      high = Math.max(high, bucket.revenue, bucket.expenses, bucket.result)
      // Revenue is signed: a bucket whose refunds exceed its charges is
      // legitimately negative, and leaving it out of the lower bound drew no
      // bar at all for a day on which money left the business.
      low = Math.min(low, bucket.result, bucket.revenue, bucket.expenses)
    }
    return { high, low }
  }, [buckets])

  if (isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-[240px] w-full" />
      </div>
    )
  }

  if (buckets.length === 0 || (bounds.high === 0 && bounds.low === 0)) {
    return (
      <EmptyState
        icon={LineChart}
        title="Nothing was recorded in this period"
        description="Once contracts are paid and costs are logged, this compares what the fleet earned against what it cost to run."
      />
    )
  }

  const innerWidth = Math.max(0, width - PADDING.left - PADDING.right)
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom

  const axisMax = niceBound(bounds.high)
  const axisMin = bounds.low < 0 ? -niceBound(Math.abs(bounds.low)) : 0
  const span = axisMax - axisMin || 1

  const scaleY = (value: number) =>
    PADDING.top + innerHeight - ((value - axisMin) / span) * innerHeight
  const baselineY = scaleY(0)

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => axisMin + fraction * span)

  const bucketWidth = innerWidth / buckets.length
  const groupWidth = Math.max(4, bucketWidth * 0.7)
  const barWidth = Math.max(2, (groupWidth - BAR_GAP) / 2)

  // Thin out axis labels rather than letting them collide.
  const labelStride = Math.max(
    1,
    Math.ceil(buckets.length / Math.max(1, Math.floor(innerWidth / 42))),
  )

  const resultLine = buckets
    .map((bucket, index) => {
      const x = PADDING.left + index * bucketWidth + bucketWidth / 2
      return `${index === 0 ? 'M' : 'L'} ${x} ${scaleY(bucket.result)}`
    })
    .join(' ')

  const hovered = hoveredIndex === null ? null : buckets[hoveredIndex]

  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <LegendSwatch color="var(--color-chart-revenue)" label="Revenue" />
        <LegendSwatch color="var(--color-chart-expenses)" label="Operating cost" />
        <LegendSwatch color="var(--color-ink-muted)" label="Operating result" shape="line" />
        <span className="text-ink-subtle ms-auto text-[0.75rem]">In {currency}</span>
      </div>

      <div ref={containerRef} className="relative">
        {width > 0 ? (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Revenue, operating cost and operating result per ${granularity}, in ${currency}`}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            {ticks.map((tick) => {
              const y = scaleY(tick)
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
                    x={PADDING.left - 10}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-[var(--color-ink-subtle)] text-[0.6875rem] tabular-nums"
                  >
                    {formatMoney(tick, currency, { locale, withoutSymbol: true, compact: true })}
                  </text>
                </g>
              )
            })}

            {buckets.map((bucket, index) => {
              const groupStart = PADDING.left + index * bucketWidth + (bucketWidth - groupWidth) / 2
              // A negative value hangs below the baseline rather than vanishing.
              const revenueTop = Math.min(scaleY(bucket.revenue), baselineY)
              const revenueHeight = Math.abs(baselineY - scaleY(bucket.revenue))
              const expensesTop = Math.min(scaleY(bucket.expenses), baselineY)
              const expensesHeight = Math.abs(baselineY - scaleY(bucket.expenses))

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
                    d={barPath(groupStart, revenueTop, barWidth, revenueHeight)}
                    fill="var(--color-chart-revenue)"
                  />
                  <path
                    d={barPath(
                      groupStart + barWidth + BAR_GAP,
                      expensesTop,
                      barWidth,
                      expensesHeight,
                    )}
                    fill="var(--color-chart-expenses)"
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

            {/* The result rides above the bars, thin, so it reads as a level. */}
            <path
              d={resultLine}
              fill="none"
              stroke="var(--color-ink-muted)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            <line
              x1={PADDING.left}
              x2={PADDING.left + innerWidth}
              y1={baselineY}
              y2={baselineY}
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
            className="bg-surface border-line pointer-events-none absolute top-2 z-10 w-52 rounded-md border p-2.5 shadow-overlay"
            style={{
              left: Math.min(
                Math.max(PADDING.left + hoveredIndex * bucketWidth + bucketWidth / 2 - 104, 0),
                Math.max(width - 208, 0),
              ),
            }}
          >
            <p className="text-ink text-[0.75rem] font-semibold">{hovered.fullLabel}</p>
            <dl className="mt-1.5 space-y-1">
              <TooltipRow
                color="var(--color-chart-revenue)"
                label="Revenue"
                value={formatMoney(hovered.revenue, currency, { locale })}
              />
              <TooltipRow
                color="var(--color-chart-expenses)"
                label="Operating cost"
                value={formatMoney(hovered.expenses, currency, { locale })}
              />
              <TooltipRow
                color="var(--color-ink-muted)"
                label="Operating result"
                value={formatMoney(hovered.result, currency, { locale })}
              />
            </dl>
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
          <caption>Revenue, operating cost and operating result per period, in {currency}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Revenue</th>
              <th scope="col">Operating cost</th>
              <th scope="col">Operating result</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.date.toISOString()}>
                <th scope="row">{bucket.fullLabel}</th>
                <td>{formatMoney(bucket.revenue, currency, { locale })}</td>
                <td>{formatMoney(bucket.expenses, currency, { locale })}</td>
                <td>{formatMoney(bucket.result, currency, { locale })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LegendSwatch({
  color,
  label,
  shape = 'block',
}: {
  color: string
  label: string
  shape?: 'block' | 'line'
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={shape === 'line' ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-[2px]'}
        style={{ backgroundColor: color }}
      />
      <span className="text-ink-muted text-[0.75rem]">{label}</span>
    </span>
  )
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="size-2 rounded-[2px]"
        style={{ backgroundColor: color }}
      />
      <dt className="text-ink-muted flex-1 text-[0.75rem]">{label}</dt>
      <dd data-numeric="" className="text-ink text-[0.75rem] font-medium">
        {value}
      </dd>
    </div>
  )
}
