import { LineChart } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'

import { EmptyState, Skeleton } from '@/components/ui'
import { formatDate, formatMonth, parseIsoDate } from '@/lib/datetime/format'
import { formatMoney } from '@/lib/money/money'
import { useElementWidth } from '@/lib/utils/useElementWidth'
import type { FinancialSeriesRow } from '@/types/database'

import type { SeriesGranularity } from '../period'

const HEIGHT = 224
const PADDING = { top: 12, right: 8, bottom: 28, left: 64 }
const BAR_GAP = 2
const CORNER_RADIUS = 4

export interface RevenueExpensesChartProps {
  series: readonly FinancialSeriesRow[]
  currency: string
  locale: string
  timeZone: string
  granularity: SeriesGranularity
  isLoading?: boolean
  /** Offered when there is nothing to plot, so the empty chart names a next step. */
  emptyAction?: ReactNode
}

/** Rounds an axis maximum up to a readable step (1, 2, 2.5, 5, 10 × 10ⁿ). */
function niceCeiling(value: number): number {
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

/**
 * Revenue against expenses over the selected period.
 *
 * Grouped bars rather than lines: these are discrete settled amounts per
 * bucket, and a line between two buckets would draw money that was never
 * received. Both series are the same measure in the same currency, so they
 * share one axis — a second scale would let the shapes be arranged to say
 * whatever the reader wanted.
 */
export function RevenueExpensesChart({
  series,
  currency,
  locale,
  timeZone,
  granularity,
  isLoading = false,
  emptyAction,
}: RevenueExpensesChartProps) {
  const { ref: containerRef, width } = useElementWidth()
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const buckets = useMemo(
    () =>
      series.map((row) => {
        const date = parseIsoDate(row.bucket_start, timeZone) ?? new Date(row.bucket_start)
        return {
          date,
          revenue: row.revenue_minor,
          expenses: row.expenses_minor,
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

  const maxValue = useMemo(
    () => buckets.reduce((max, bucket) => Math.max(max, bucket.revenue, bucket.expenses), 0),
    [buckets],
  )

  if (isLoading) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-[224px] w-full" />
      </div>
    )
  }

  if (buckets.length === 0 || maxValue === 0) {
    return (
      <EmptyState
        icon={LineChart}
        title="No income or spending recorded yet"
        description="Once contracts are paid and costs are logged, this chart compares what the fleet earns against what it costs to run, period by period."
        action={emptyAction}
      />
    )
  }

  const innerWidth = Math.max(0, width - PADDING.left - PADDING.right)
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom
  const axisMax = niceCeiling(maxValue)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * axisMax)

  const bucketWidth = innerWidth / buckets.length
  const groupWidth = Math.max(4, bucketWidth * 0.7)
  const barWidth = Math.max(2, (groupWidth - BAR_GAP) / 2)

  // Thin out axis labels rather than letting them collide.
  const labelStride = Math.max(
    1,
    Math.ceil(buckets.length / Math.max(1, Math.floor(innerWidth / 42))),
  )

  const scaleY = (value: number) => (axisMax === 0 ? 0 : (value / axisMax) * innerHeight)
  const hovered = hoveredIndex === null ? null : buckets[hoveredIndex]

  return (
    <div className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <LegendSwatch color="var(--color-chart-revenue)" label="Revenue" />
        <LegendSwatch color="var(--color-chart-expenses)" label="Expenses" />
      </div>

      <div ref={containerRef} className="relative">
        {width > 0 ? (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Revenue and expenses per ${granularity}, in ${currency}`}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            {/* Recessive grid */}
            {ticks.map((tick) => {
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
              const revenueHeight = scaleY(bucket.revenue)
              const expensesHeight = scaleY(bucket.expenses)
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
                    d={barPath(groupStart, baseline - revenueHeight, barWidth, revenueHeight)}
                    fill="var(--color-chart-revenue)"
                  />
                  <path
                    d={barPath(
                      groupStart + barWidth + BAR_GAP,
                      baseline - expensesHeight,
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

                  {/* Hit target spans the whole bucket, not just the bars. */}
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
            className="bg-surface border-line pointer-events-none absolute top-2 z-10 w-44 rounded-md border p-2.5 shadow-overlay"
            style={{
              left: Math.min(
                Math.max(PADDING.left + hoveredIndex * bucketWidth + bucketWidth / 2 - 88, 0),
                Math.max(width - 176, 0),
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
                label="Expenses"
                value={formatMoney(hovered.expenses, currency, { locale })}
              />
            </dl>
          </div>
        ) : null}
      </div>

      {/* The same figures, readable by assistive technology and copyable. */}
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
          <caption>Revenue and expenses per period, in {currency}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Revenue</th>
              <th scope="col">Expenses</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.date.toISOString()}>
                <th scope="row">{bucket.fullLabel}</th>
                <td>{formatMoney(bucket.revenue, currency, { locale })}</td>
                <td>{formatMoney(bucket.expenses, currency, { locale })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="size-2 rounded-[2px]"
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
