import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { FinancialSeriesRow } from '@/types/database'

import { FleetStrip } from './FleetStrip'
import { MetricTile } from './MetricTile'
import { RevenueExpensesChart } from './RevenueExpensesChart'

const chartDefaults = {
  currency: 'EUR',
  locale: 'en',
  timeZone: 'Europe/Paris',
  granularity: 'month' as const,
}

describe('FleetStrip', () => {
  it('invites the agency to add a vehicle when the fleet is empty', () => {
    render(<FleetStrip available={0} rented={0} reserved={0} maintenance={0} unavailable={0} />)

    expect(screen.getByText('No vehicles yet')).toBeInTheDocument()
    // No zero-filled bar pretending to be a fleet.
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
  })

  it('names every state alongside its count, never colour alone', () => {
    render(<FleetStrip available={4} rented={3} reserved={1} maintenance={2} unavailable={0} />)

    const expected: [string, string][] = [
      ['Available', '4'],
      ['Rented', '3'],
      ['Reserved', '1'],
      ['Maintenance', '2'],
      // A state with none of the fleet in it still says so, rather than vanishing.
      ['Unavailable', '0'],
    ]

    for (const [label, count] of expected) {
      const term = screen.getByText(label)
      expect(term.tagName).toBe('DT')
      expect(term.nextElementSibling).toHaveTextContent(count)
    }
  })
})

describe('RevenueExpensesChart', () => {
  const emptySeries: FinancialSeriesRow[] = [
    { bucket_start: '2030-01-01', revenue_minor: 0, expenses_minor: 0 },
    { bucket_start: '2030-02-01', revenue_minor: 0, expenses_minor: 0 },
  ]

  const populatedSeries: FinancialSeriesRow[] = [
    { bucket_start: '2030-01-01', revenue_minor: 250_00, expenses_minor: 100_00 },
    { bucket_start: '2030-02-01', revenue_minor: 400_00, expenses_minor: 150_00 },
  ]

  it('shows a real empty state rather than an axis with nothing on it', () => {
    render(<RevenueExpensesChart series={emptySeries} {...chartDefaults} />)

    expect(screen.getByText(/no income or spending recorded yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('treats no buckets at all the same way', () => {
    render(<RevenueExpensesChart series={[]} {...chartDefaults} />)
    expect(screen.getByText(/no income or spending recorded yet/i)).toBeInTheDocument()
  })

  it('draws both series and labels them', () => {
    render(<RevenueExpensesChart series={populatedSeries} {...chartDefaults} />)

    expect(screen.getByRole('img', { name: /revenue and expenses/i })).toBeInTheDocument()

    // Named in the legend and again as a table column header, so identity never
    // rests on colour alone.
    expect(screen.getAllByText('Revenue').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Expenses').length).toBeGreaterThanOrEqual(2)
  })

  it('exposes the same figures as a table for assistive technology', () => {
    render(<RevenueExpensesChart series={populatedSeries} {...chartDefaults} />)

    const table = screen.getByRole('table')
    expect(within(table).getByText('€250.00')).toBeInTheDocument()
    expect(within(table).getByText('€150.00')).toBeInTheDocument()
  })

  it('shows a loading placeholder instead of an empty chart', () => {
    const { container } = render(<RevenueExpensesChart series={[]} {...chartDefaults} isLoading />)

    expect(screen.queryByText(/no income or spending recorded yet/i)).not.toBeInTheDocument()
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
  })
})

describe('MetricTile', () => {
  it('shows the figure and its context', () => {
    render(<MetricTile label="Revenue" value="€1,234.56" caption="This month" />)

    expect(screen.getByText('Revenue')).toBeInTheDocument()
    expect(screen.getByText('€1,234.56')).toBeInTheDocument()
    expect(screen.getByText('This month')).toBeInTheDocument()
  })

  it('hides the figure while loading rather than showing a placeholder number', () => {
    render(<MetricTile label="Revenue" value="€1,234.56" isLoading />)

    expect(screen.getByText('Revenue')).toBeInTheDocument()
    expect(screen.queryByText('€1,234.56')).not.toBeInTheDocument()
  })
})
