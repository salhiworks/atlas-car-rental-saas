import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { RentalScheduleEntry } from '@/types/database'

import { dayOperations } from '../schedule'
import { buildTimeGrid, placeInterval } from '../time-grid'
import { DayOperationsList, DayOperationsStrip } from './DayOperations'
import { RentalBlock } from './RentalBlock'
import { NowIndicator, TimelineHeader } from './TimelineFrame'

const PARIS = 'Europe/Paris'
const at = (iso: string) => new Date(iso)

function makeRental(overrides: Partial<RentalScheduleEntry> = {}): RentalScheduleEntry {
  return {
    id: 'rental-1',
    organization_id: 'org-1',
    reference: 'RNT-2030-00012',
    status: 'reserved',
    starts_at: '2030-06-05T08:00:00Z',
    ends_at: '2030-06-08T08:00:00Z',
    original_ends_at: null,
    pickup_location: 'Airport',
    return_location: null,
    picked_up_at: null,
    returned_at: null,
    extension_count: 0,
    currency: 'EUR',
    total_minor: 24000,
    balance_due_minor: 24000,
    deposit_held_minor: 0,
    payment_status: 'unpaid',
    vehicle_id: 'vehicle-1',
    vehicle_make: 'Peugeot',
    vehicle_model: '208',
    vehicle_plate: '12345-A-6',
    customer_id: 'customer-1',
    customer_name: 'Amina Tazi',
    primary_driver_id: 'customer-1',
    primary_driver_name: 'Amina Tazi',
    renter_is_not_driver: false,
    driver_count: 1,
    is_overdue: false,
    next_rental_id: null,
    next_rental_reference: null,
    next_rental_starts_at: null,
    turnaround_minutes: null,
    contract_version: null,
    contract_status: null,
    has_live_contract: false,
    ...overrides,
  }
}

const grid = buildTimeGrid(at('2030-06-03T00:00:00Z'), 7, PARIS, at('2030-06-05T12:00:00Z'))

function renderBlock(rental: RentalScheduleEntry, { laneWidthPx = 900, onOpen = vi.fn() } = {}) {
  const placement = placeInterval(grid, new Date(rental.starts_at), new Date(rental.ends_at))!

  render(
    <RentalBlock
      rental={rental}
      placement={placement}
      laneWidthPx={laneWidthPx}
      locale="en"
      timeZone={PARIS}
      now={at('2030-06-05T12:00:00Z')}
      isFocused={false}
      isDimmed={false}
      onOpen={onOpen}
      canDrag={false}
    />,
  )

  return { onOpen, placement }
}

describe('a booking block', () => {
  it('is a real button, reachable from the keyboard', async () => {
    const { onOpen } = renderBlock(makeRental())
    const block = screen.getByRole('button')

    await userEvent.tab()
    expect(block).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('states its status in words, never in colour alone', () => {
    renderBlock(makeRental())
    expect(screen.getByRole('button')).toHaveAccessibleName(/^Reserved:/)
  })

  it('says who is driving when that is not the renter', () => {
    renderBlock(
      makeRental({
        renter_is_not_driver: true,
        primary_driver_name: 'Youssef Bennani',
      }),
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(/driven by Youssef Bennani/)
  })

  it('calls a late hire overdue rather than active', () => {
    renderBlock(
      makeRental({
        status: 'active',
        starts_at: '2030-06-03T08:00:00Z',
        ends_at: '2030-06-04T08:00:00Z',
      }),
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(/^Overdue:/)
  })

  it('shows the customer and the times when there is room', () => {
    renderBlock(makeRental(), { laneWidthPx: 2400 })
    const block = screen.getByRole('button')

    expect(within(block).getByText('Amina Tazi')).toBeInTheDocument()
    expect(within(block).getByText(/RNT-2030-00012/)).toBeInTheDocument()
  })

  it('falls back to the plate when the block is narrow', () => {
    // A three-day block across a seven-day window on a 280px lane is ~120px.
    renderBlock(makeRental(), { laneWidthPx: 280 })
    const block = screen.getByRole('button')

    expect(within(block).getByText('12345-A-6')).toBeInTheDocument()
    expect(within(block).queryByText('Amina Tazi')).not.toBeInTheDocument()
  })

  it('says nothing at all rather than clipping when there is no room', () => {
    // A five-hour hire on a month view is a few pixels wide; an ellipsis there
    // would be noise, and the accessible name still carries everything.
    renderBlock(
      makeRental({ starts_at: '2030-06-05T08:00:00Z', ends_at: '2030-06-05T13:00:00Z' }),
      { laneWidthPx: 400 },
    )
    const block = screen.getByRole('button')

    expect(block.textContent).toBe('')
    expect(block).toHaveAccessibleName(/RNT-2030-00012/)
  })

  it('marks a booking clipped by the window edge', () => {
    const rental = makeRental({
      starts_at: '2030-05-01T08:00:00Z',
      ends_at: '2030-06-30T08:00:00Z',
    })
    const { placement } = renderBlock(rental)

    expect(placement.clippedStart).toBe(true)
    expect(placement.clippedEnd).toBe(true)
    expect(screen.getByRole('button').className).toContain('rounded-s-none')
  })
})

describe('the timeline frame', () => {
  it('labels each day in the agency zone', () => {
    render(<TimelineHeader grid={grid} locale="en" />)

    // 3 June 2030 is a Monday in Paris.
    expect(screen.getByText('Mon')).toBeInTheDocument()
    expect(screen.getAllByText('Sun')).toHaveLength(1)
  })

  it('names the month on the first column when there is room for it', () => {
    render(<TimelineHeader grid={grid} locale="en" />)
    expect(screen.getByText('Jun')).toBeInTheDocument()
  })

  it('drops the inline month at month scale, where the column is too narrow', () => {
    // 56px of column fits "SAT 1" and nothing else; the range label above the
    // board names the month instead of letting it collide with the next column.
    const month = buildTimeGrid(at('2030-06-01T00:00:00Z'), 30, PARIS, at('2030-06-05T12:00:00Z'))
    render(<TimelineHeader grid={month} locale="en" />)
    expect(screen.queryByText('Jun')).not.toBeInTheDocument()
  })

  it('draws the now marker only when now is on screen', () => {
    const { container, rerender } = render(
      <NowIndicator grid={grid} now={at('2030-06-05T12:00:00Z')} />,
    )
    expect(container.firstChild).not.toBeNull()

    rerender(<NowIndicator grid={grid} now={at('2031-01-01T12:00:00Z')} />)
    expect(container.firstChild).toBeNull()
  })
})

describe('the day panel', () => {
  const dayStart = at('2030-06-05T00:00:00Z')
  const dayEnd = at('2030-06-06T00:00:00Z')
  const now = at('2030-06-05T12:00:00Z')

  const operations = dayOperations(
    [
      makeRental({ id: 'a', status: 'reserved', starts_at: '2030-06-05T09:00:00Z' }),
      makeRental({
        id: 'b',
        status: 'active',
        starts_at: '2030-06-01T09:00:00Z',
        ends_at: '2030-06-05T17:00:00Z',
        customer_name: 'Youssef Bennani',
      }),
      makeRental({
        id: 'c',
        status: 'active',
        starts_at: '2030-05-20T09:00:00Z',
        ends_at: '2030-06-02T09:00:00Z',
        customer_name: 'Late Customer',
      }),
    ],
    dayStart,
    dayEnd,
    now,
  )

  it('counts the day and offers each count as a filter', async () => {
    const onSelect = vi.fn()

    render(
      <DayOperationsStrip
        operations={operations}
        freeVehicleCount={4}
        active={null}
        onSelect={onSelect}
        onClear={vi.fn()}
        isLoading={false}
      />,
    )

    const overdue = screen.getByRole('button', { name: /Overdue/ })
    expect(within(overdue).getByText('1')).toBeInTheDocument()

    await userEvent.click(overdue)
    expect(onSelect).toHaveBeenCalledWith('overdue')
  })

  it('reports the free count it was given rather than guessing', () => {
    render(
      <DayOperationsStrip
        operations={operations}
        freeVehicleCount={null}
        active={null}
        onSelect={vi.fn()}
        onClear={vi.fn()}
        isLoading={false}
      />,
    )
    // Availability has not answered yet, and an unknown count is stated as
    // unknown rather than shown as zero free vehicles.
    const free = screen.getByRole('button', { name: /Free/ })
    expect(within(free).getByText('—')).toBeInTheDocument()
  })

  it('lists the day as a worklist, overdue first', () => {
    render(
      <DayOperationsList operations={operations} locale="en" timeZone={PARIS} onOpen={vi.fn()} />,
    )

    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)
    expect(headings[0]).toBe('Overdue')
    expect(headings).toContain('Going out')
    expect(headings).toContain('Due back')
  })

  it('says plainly when a day has nothing on it', () => {
    render(
      <DayOperationsList
        operations={{ pickups: [], returns: [], out: [], overdue: [] }}
        locale="en"
        timeZone={PARIS}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByText('Nothing scheduled for this day.')).toBeInTheDocument()
  })

  it('opens a booking from the worklist', async () => {
    const onOpen = vi.fn()
    render(
      <DayOperationsList operations={operations} locale="en" timeZone={PARIS} onOpen={onOpen} />,
    )

    await userEvent.click(screen.getByText('Late Customer'))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
