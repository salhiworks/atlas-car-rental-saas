import { CalendarRange, Download, GitCompareArrows } from 'lucide-react'
import { useId } from 'react'

import { Button, Input, Select } from '@/components/ui'
import { cn } from '@/lib/utils/cn'

import { REPORT_PERIODS, type ReportPeriod, type ReportPeriodKey } from '../period'

/**
 * One control bar for the whole workspace.
 *
 * Period, currency and comparison are set once and every section obeys them.
 * The alternative — each report with its own date picker — produces a screen
 * where two figures on the same page describe different months, and nobody
 * notices until a decision has been made on them.
 *
 * The currency control is a FILTER, never a conversion. Selecting EUR does not
 * restate MAD records in euros; it shows the euro records. The label says so,
 * because a currency dropdown on a financial screen invites exactly the wrong
 * assumption.
 */

export interface ReportToolbarProps {
  period: ReportPeriod
  periodKey: ReportPeriodKey
  onPeriodChange: (key: ReportPeriodKey) => void

  customFrom: string
  customTo: string
  onCustomChange: (patch: { from?: string; to?: string }) => void

  currency: string | null
  currencies: readonly string[]
  onCurrencyChange: (currency: string) => void

  compare: boolean
  onCompareChange: (compare: boolean) => void
  comparisonLabel: string

  onExport?: () => void
  exportLabel?: string
  exportDisabled?: boolean

  className?: string
}

export function ReportToolbar({
  period,
  periodKey,
  onPeriodChange,
  customFrom,
  customTo,
  onCustomChange,
  currency,
  currencies,
  onCurrencyChange,
  compare,
  onCompareChange,
  comparisonLabel,
  onExport,
  exportLabel = 'Export CSV',
  exportDisabled = false,
  className,
}: ReportToolbarProps) {
  const fromId = useId()
  const toId = useId()

  return (
    <div className={cn('border-line bg-surface rounded-lg border', className)}>
      <div className="flex flex-wrap items-end gap-2 p-3">
        <div className="min-w-[10rem]">
          <label
            className="text-ink-muted mb-1 block text-[0.75rem] font-medium"
            htmlFor="report-period"
          >
            Period
          </label>
          <Select
            id="report-period"
            value={periodKey}
            onChange={(event) => onPeriodChange(event.target.value as ReportPeriodKey)}
            options={REPORT_PERIODS.map((option) => ({ ...option }))}
          />
        </div>

        {periodKey === 'custom' ? (
          <>
            <div className="min-w-[9rem]">
              <label
                className="text-ink-muted mb-1 block text-[0.75rem] font-medium"
                htmlFor={fromId}
              >
                From
              </label>
              <Input
                id={fromId}
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(event) => onCustomChange({ from: event.target.value })}
              />
            </div>
            <div className="min-w-[9rem]">
              <label
                className="text-ink-muted mb-1 block text-[0.75rem] font-medium"
                htmlFor={toId}
              >
                To
              </label>
              <Input
                id={toId}
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(event) => onCustomChange({ to: event.target.value })}
              />
            </div>
          </>
        ) : null}

        {currencies.length > 1 ? (
          <div className="min-w-[9rem]">
            <label
              className="text-ink-muted mb-1 block text-[0.75rem] font-medium"
              htmlFor="report-currency"
            >
              Currency
            </label>
            <Select
              id="report-currency"
              value={currency ?? ''}
              onChange={(event) => onCurrencyChange(event.target.value)}
              options={currencies.map((code) => ({ value: code, label: code }))}
            />
          </div>
        ) : null}

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button
            variant={compare ? 'secondary' : 'ghost'}
            leadingIcon={<GitCompareArrows />}
            onClick={() => onCompareChange(!compare)}
            aria-pressed={compare}
            title={`Compare with the ${comparisonLabel.toLowerCase()}`}
          >
            Compare
          </Button>

          {onExport ? (
            <Button
              variant="secondary"
              leadingIcon={<Download />}
              onClick={onExport}
              disabled={exportDisabled}
            >
              {exportLabel}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="border-line text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-[0.75rem]">
        <span className="inline-flex items-center gap-1.5">
          <CalendarRange className="size-3.5" aria-hidden="true" />
          {period.label} · {period.days} {period.days === 1 ? 'day' : 'days'}
        </span>
        {currencies.length > 1 ? (
          <span>
            {currencies.length} currencies in this period. The selector filters records; it does not
            convert them.
          </span>
        ) : null}
        {compare ? <span>Compared with the {comparisonLabel.toLowerCase()}.</span> : null}
      </div>
    </div>
  )
}
