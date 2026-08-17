import { describe, expect, it } from 'vitest'

import type { RentalScheduleEntry } from '@/types/database'

import { anchorFromIso, buildRange, queryWindow, startOfWeekInTimeZone, stepRange } from './ranges'
import {
  dayOperations,
  densityFor,
  formatGap,
  isOverdue,
  matchesSearch,
  occupiesVehicle,
  toneFor,
  turnaroundPressure,
} from './schedule'
import {
  buildTimeGrid,
  fractionForInstant,
  instantForFraction,
  placeInterval,
  shiftInterval,
  snapInstant,
  snapStepForGrid,
} from './time-grid'

/**
 * The Calendar's arithmetic.
 *
 * Heavily weighted towards time zones and range boundaries, because those are
 * the two things a scheduler gets wrong silently: nobody notices an hour of
 * drift until a customer arrives to find their car already gone.
 *
 * Europe/Paris is used for the daylight-saving cases — it springs forward on
 * 2028-03-26 and falls back on 2028-10-29 — and Asia/Kathmandu for the
 * forty-five-minute offset that catches naive rounding.
 */

const PARIS = 'Europe/Paris'
const KATHMANDU = 'Asia/Kathmandu'
const CASABLANCA = 'Africa/Casablanca'

const at = (iso: string) => new Date(iso)

describe('the time grid', () => {
  it('builds one column per agency-local day', () => {
    const grid = buildTimeGrid(at('2028-06-05T00:00:00Z'), 7, PARIS, at('2028-06-07T10:00:00Z'))

    expect(grid.days).toHaveLength(7)
    expect(grid.days[0]?.isoDate).toBe('2028-06-05')
    expect(grid.days[6]?.isoDate).toBe('2028-06-11')
    expect(grid.end.toISOString()).toBe('2028-06-11T22:00:00.000Z')
  })

  it('marks the agency today, not the browser today', () => {
    // 23:30 UTC is already the next day in Paris.
    const grid = buildTimeGrid(at('2028-06-05T00:00:00Z'), 3, PARIS, at('2028-06-05T23:30:00Z'))
    expect(grid.days.find((day) => day.isToday)?.isoDate).toBe('2028-06-06')
  })

  it('knows the day the clocks go forward is 23 hours long', () => {
    const grid = buildTimeGrid(at('2028-03-25T12:00:00Z'), 3, PARIS, at('2028-03-25T12:00:00Z'))
    const springForward = grid.days.find((day) => day.isoDate === '2028-03-26')

    expect(springForward?.hours).toBe(23)
  })

  it('knows the day the clocks go back is 25 hours long', () => {
    const grid = buildTimeGrid(at('2028-10-28T12:00:00Z'), 3, PARIS, at('2028-10-28T12:00:00Z'))
    const fallBack = grid.days.find((day) => day.isoDate === '2028-10-29')

    expect(fallBack?.hours).toBe(25)
  })

  it('keeps every day the same width even when one is shorter', () => {
    const grid = buildTimeGrid(at('2028-03-25T12:00:00Z'), 3, PARIS, at('2028-03-25T12:00:00Z'))

    // Each day boundary sits exactly a third of the way across, so the
    // gridlines line up with the labels above them on the day the hour is lost.
    for (let index = 0; index <= 3; index += 1) {
      const boundary = index === 3 ? grid.end : grid.days[index]!.start
      expect(fractionForInstant(grid, boundary)).toBeCloseTo(index / 3, 10)
    }
  })

  it('interpolates within a shortened day against its real length', () => {
    const grid = buildTimeGrid(
      at('2028-03-26T00:00:00+01:00'),
      1,
      PARIS,
      at('2028-03-26T06:00:00Z'),
    )

    // Local noon is 11 elapsed hours after local midnight on this day, because
    // 02:00 never happened. Positioning it at half way would be an hour wrong.
    const localNoon = at('2028-03-26T10:00:00Z')
    expect(fractionForInstant(grid, localNoon)).toBeCloseTo(11 / 23, 6)
  })

  it('round-trips a fraction back to the instant it denotes', () => {
    const grid = buildTimeGrid(at('2028-06-05T00:00:00Z'), 7, PARIS, at('2028-06-05T00:00:00Z'))
    const instant = at('2028-06-08T14:37:00Z')

    const back = instantForFraction(grid, fractionForInstant(grid, instant))
    expect(Math.abs(back.getTime() - instant.getTime())).toBeLessThan(1000)
  })

  it('re-anchors every column to its own midnight', () => {
    // America/Havana moves its clocks at midnight on 2028-03-12, so that day
    // begins at 01:00. Carrying the boundary forward would have started every
    // later column at 01:00 too and labelled them all a day out.
    const grid = buildTimeGrid(
      at('2028-03-11T16:00:00Z'),
      4,
      'America/Havana',
      at('2028-03-11T16:00:00Z'),
    )

    expect(grid.days.map((day) => day.isoDate)).toEqual([
      '2028-03-11',
      '2028-03-12',
      '2028-03-13',
      '2028-03-14',
    ])
    expect(grid.days[1]?.hours).toBe(23)
    expect(grid.days[2]?.hours).toBe(24)
    expect(grid.days[3]?.hours).toBe(24)
  })

  it('offers finer snapping the closer the span', () => {
    const day = buildTimeGrid(at('2028-06-05T00:00:00Z'), 1, PARIS, at('2028-06-05T00:00:00Z'))
    const week = buildTimeGrid(at('2028-06-05T00:00:00Z'), 7, PARIS, at('2028-06-05T00:00:00Z'))
    const month = buildTimeGrid(at('2028-06-01T00:00:00Z'), 30, PARIS, at('2028-06-01T00:00:00Z'))

    expect(snapStepForGrid(day)).toBe(15)
    expect(snapStepForGrid(week)).toBe(60)
    // Beyond a fortnight a pixel is worth hours, so a drag moves whole days.
    expect(snapStepForGrid(month)).toBe(0)
  })
})

describe('placing a booking on the grid', () => {
  const grid = buildTimeGrid(at('2028-06-05T00:00:00Z'), 7, PARIS, at('2028-06-07T10:00:00Z'))
  const windowStart = grid.start
  const windowEnd = grid.end

  it('places a booking wholly inside the window', () => {
    const placement = placeInterval(grid, at('2028-06-07T08:00:00Z'), at('2028-06-09T08:00:00Z'))

    expect(placement).not.toBeNull()
    expect(placement!.clippedStart).toBe(false)
    expect(placement!.clippedEnd).toBe(false)
    expect(placement!.leftPct).toBeGreaterThan(0)
    expect(placement!.leftPct + placement!.widthPct).toBeLessThan(100)
  })

  it('keeps a booking that started before the window and clips it', () => {
    const placement = placeInterval(grid, at('2028-05-30T08:00:00Z'), at('2028-06-07T08:00:00Z'))

    expect(placement).not.toBeNull()
    expect(placement!.clippedStart).toBe(true)
    expect(placement!.leftPct).toBe(0)
  })

  it('keeps a booking that ends after the window and clips it', () => {
    const placement = placeInterval(grid, at('2028-06-09T08:00:00Z'), at('2028-07-20T08:00:00Z'))

    expect(placement).not.toBeNull()
    expect(placement!.clippedEnd).toBe(true)
    expect(placement!.leftPct + placement!.widthPct).toBeCloseTo(100, 6)
  })

  it('keeps a booking that covers the whole window', () => {
    const placement = placeInterval(grid, at('2028-01-01T00:00:00Z'), at('2029-01-01T00:00:00Z'))

    expect(placement).toEqual({
      leftPct: 0,
      widthPct: 100,
      clippedStart: true,
      clippedEnd: true,
    })
  })

  it('drops a booking that ends exactly as the window opens', () => {
    // Half-open, matching rentals_no_vehicle_overlap: touching is not
    // overlapping, which is how a desk turns a car around at 10:00.
    expect(placeInterval(grid, at('2028-06-01T00:00:00Z'), windowStart)).toBeNull()
  })

  it('keeps a booking that begins one minute before the window closes', () => {
    const nearlyOut = new Date(windowEnd.getTime() - 60_000)
    const placement = placeInterval(grid, nearlyOut, at('2028-06-20T00:00:00Z'))

    expect(placement).not.toBeNull()
    expect(placement!.widthPct).toBeGreaterThan(0)
  })

  it('drops a booking that begins exactly as the window closes', () => {
    expect(placeInterval(grid, windowEnd, at('2028-06-20T00:00:00Z'))).toBeNull()
  })

  it('places a booking that spans a month boundary', () => {
    const june = buildTimeGrid(at('2028-06-01T00:00:00Z'), 30, PARIS, at('2028-06-15T00:00:00Z'))
    const placement = placeInterval(june, at('2028-05-28T09:00:00Z'), at('2028-07-03T09:00:00Z'))

    expect(placement).toEqual({
      leftPct: 0,
      widthPct: 100,
      clippedStart: true,
      clippedEnd: true,
    })
  })

  it('places a booking that spans a year boundary', () => {
    const december = buildTimeGrid(
      at('2028-12-25T00:00:00Z'),
      14,
      PARIS,
      at('2028-12-28T00:00:00Z'),
    )
    const placement = placeInterval(
      december,
      at('2028-12-30T10:00:00Z'),
      at('2029-01-04T10:00:00Z'),
    )

    expect(placement).not.toBeNull()
    expect(placement!.clippedStart).toBe(false)
    expect(placement!.clippedEnd).toBe(false)
  })

  it('places a booking that crosses midnight without spilling into the wrong day', () => {
    const grid1 = buildTimeGrid(at('2028-06-05T00:00:00Z'), 2, PARIS, at('2028-06-05T00:00:00Z'))
    // 23:00 to 01:00 agency-local, straddling the day boundary at 50%.
    const placement = placeInterval(grid1, at('2028-06-05T21:00:00Z'), at('2028-06-05T23:00:00Z'))

    expect(placement).not.toBeNull()
    expect(placement!.leftPct).toBeLessThan(50)
    expect(placement!.leftPct + placement!.widthPct).toBeGreaterThan(50)
  })
})

describe('shifting a booking', () => {
  it('preserves the local time of day across a clock change on a whole-day move', () => {
    // 09:00 on the Saturday, moved one day, must still read 09:00 on the Sunday
    // the hour goes missing.
    const startsAt = at('2028-03-25T08:00:00Z') // 09:00 Paris
    const endsAt = at('2028-03-25T17:00:00Z') // 18:00 Paris

    const moved = shiftInterval(startsAt, endsAt, 86_400_000, PARIS, { wholeDays: true })

    expect(moved.startsAt.toISOString()).toBe('2028-03-26T07:00:00.000Z') // 09:00 CEST
    expect(moved.endsAt.toISOString()).toBe('2028-03-26T16:00:00.000Z') // 18:00 CEST
  })

  it('preserves elapsed duration on a fine-grained move', () => {
    const startsAt = at('2028-06-05T08:00:00Z')
    const endsAt = at('2028-06-08T08:00:00Z')

    const moved = shiftInterval(startsAt, endsAt, 3 * 3_600_000, PARIS, { wholeDays: false })

    expect(moved.endsAt.getTime() - moved.startsAt.getTime()).toBe(
      endsAt.getTime() - startsAt.getTime(),
    )
    expect(moved.startsAt.toISOString()).toBe('2028-06-05T11:00:00.000Z')
  })
})

describe('snapping', () => {
  it('snaps to the agency clock, not to UTC', () => {
    // Kathmandu is +05:45. Rounding a UTC instant to the half hour would land
    // on :15 and :45 locally, which is not what a person dragging expects.
    const snapped = snapInstant(at('2028-06-05T09:07:00Z'), KATHMANDU, 30)
    const localMinutes = new Intl.DateTimeFormat('en-GB', {
      timeZone: KATHMANDU,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(snapped)

    expect(localMinutes.endsWith(':00') || localMinutes.endsWith(':30')).toBe(true)
  })

  it('leaves an instant alone when there is no step', () => {
    const instant = at('2028-06-05T09:07:33Z')
    expect(snapInstant(instant, PARIS, 0).getTime()).toBe(instant.getTime())
  })
})

describe('ranges', () => {
  it('starts a week on the day the agency chose', () => {
    const thursday = at('2028-06-08T12:00:00Z')

    const mondayFirst = startOfWeekInTimeZone(thursday, PARIS, 1)
    const sundayFirst = startOfWeekInTimeZone(thursday, PARIS, 0)

    expect(mondayFirst.toISOString()).toBe('2028-06-04T22:00:00.000Z') // Mon 5 June, 00:00 CEST
    expect(sundayFirst.toISOString()).toBe('2028-06-03T22:00:00.000Z') // Sun 4 June, 00:00 CEST
  })

  it('sizes a month range by its real length', () => {
    const february = buildRange('month', at('2028-02-10T12:00:00Z'), PARIS, 1)
    const april = buildRange('month', at('2028-04-10T12:00:00Z'), PARIS, 1)

    // 2028 is a leap year.
    expect(february.dayCount).toBe(29)
    expect(april.dayCount).toBe(30)
  })

  it('sizes a month containing a clock change by days, not by hours', () => {
    const march = buildRange('month', at('2028-03-10T12:00:00Z'), PARIS, 1)
    expect(march.dayCount).toBe(31)
  })

  it('steps a week by seven days and a month by one month', () => {
    const week = buildRange('week', at('2028-06-08T12:00:00Z'), PARIS, 1)
    const nextWeek = stepRange(week, PARIS, 1)
    expect((nextWeek.getTime() - week.start.getTime()) / 86_400_000).toBeCloseTo(7, 1)

    const month = buildRange('month', at('2028-01-15T12:00:00Z'), PARIS, 1)
    const nextMonth = stepRange(month, PARIS, 1)
    expect(nextMonth.toISOString()).toBe('2028-01-31T23:00:00.000Z') // 1 February, 00:00 CET
  })

  it('reads an anchor date from the URL in the agency zone', () => {
    const fallback = at('2028-01-01T00:00:00Z')
    const anchor = anchorFromIso('2028-06-08', CASABLANCA, fallback)

    expect(anchor.toISOString()).toBe('2028-06-07T23:00:00.000Z') // 00:00 in +01:00
    expect(anchorFromIso('nonsense', CASABLANCA, fallback)).toBe(fallback)
    expect(anchorFromIso(null, CASABLANCA, fallback)).toBe(fallback)
    expect(anchorFromIso('2028-13-01', CASABLANCA, fallback)).toBe(fallback)
  })

  it('asks for a day more than it shows at each end', () => {
    const range = buildRange('week', at('2028-06-08T12:00:00Z'), PARIS, 1)
    const window = queryWindow(range, PARIS)

    expect(Date.parse(window.from)).toBeLessThan(range.start.getTime())
    expect(Date.parse(window.to)).toBeGreaterThan(range.end.getTime())
  })
})

// -----------------------------------------------------------------------------

function makeRental(overrides: Partial<RentalScheduleEntry> = {}): RentalScheduleEntry {
  return {
    id: 'rental-1',
    organization_id: 'org-1',
    reference: 'RNT-2028-00001',
    status: 'reserved',
    starts_at: '2028-06-08T08:00:00Z',
    ends_at: '2028-06-11T08:00:00Z',
    original_ends_at: null,
    pickup_location: null,
    return_location: null,
    picked_up_at: null,
    returned_at: null,
    extension_count: 0,
    currency: 'EUR',
    total_minor: 20000,
    balance_due_minor: 20000,
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

describe('overdue', () => {
  const now = at('2028-06-12T10:00:00Z')

  it('is an active hire past its return with nothing recorded', () => {
    expect(isOverdue(makeRental({ status: 'active' }), now)).toBe(true)
  })

  it('is not overdue once the vehicle has been brought back', () => {
    expect(
      isOverdue(makeRental({ status: 'active', returned_at: '2028-06-11T09:00:00Z' }), now),
    ).toBe(false)
  })

  it('is not overdue before the return time', () => {
    expect(isOverdue(makeRental({ status: 'active' }), at('2028-06-10T10:00:00Z'))).toBe(false)
  })

  it('is never overdue for a reservation or a closed hire', () => {
    expect(isOverdue(makeRental({ status: 'reserved' }), now)).toBe(false)
    expect(isOverdue(makeRental({ status: 'completed' }), now)).toBe(false)
    expect(isOverdue(makeRental({ status: 'cancelled' }), now)).toBe(false)
  })

  it('presents lateness as a tone rather than a status', () => {
    expect(toneFor(makeRental({ status: 'active' }), now)).toBe('overdue')
    expect(toneFor(makeRental({ status: 'active' }), at('2028-06-10T10:00:00Z'))).toBe('active')
    expect(toneFor(makeRental({ status: 'draft' }), now)).toBe('draft')
  })
})

describe('what occupies a vehicle', () => {
  it('agrees with the exclusion constraint', () => {
    expect(occupiesVehicle('reserved')).toBe(true)
    expect(occupiesVehicle('active')).toBe(true)
    expect(occupiesVehicle('draft')).toBe(false)
    expect(occupiesVehicle('completed')).toBe(false)
    expect(occupiesVehicle('cancelled')).toBe(false)
  })
})

describe('turnaround pressure', () => {
  it('says nothing when there is no next booking', () => {
    expect(turnaroundPressure(null, false)).toBe('none')
  })

  it('calls a comfortable gap comfortable', () => {
    expect(turnaroundPressure(600, false)).toBe('comfortable')
  })

  it('flags a short gap without inventing a required buffer', () => {
    expect(turnaroundPressure(90, false)).toBe('tight')
  })

  it('calls it a collision only when the next hire has already started', () => {
    expect(turnaroundPressure(0, true)).toBe('collision')
    expect(turnaroundPressure(0, false)).toBe('tight')
  })

  it('writes a gap the way a person would say it', () => {
    expect(formatGap(0)).toBe('no gap')
    expect(formatGap(45)).toBe('45 min')
    expect(formatGap(60)).toBe('1 h')
    expect(formatGap(150)).toBe('2 h 30 min')
    expect(formatGap(2880)).toBe('2 d')
  })
})

describe('the day panel', () => {
  const dayStart = at('2028-06-08T00:00:00Z')
  const dayEnd = at('2028-06-09T00:00:00Z')
  const now = at('2028-06-08T12:00:00Z')

  it('lists a reservation collecting today as a pickup', () => {
    const operations = dayOperations(
      [makeRental({ status: 'reserved', starts_at: '2028-06-08T09:00:00Z' })],
      dayStart,
      dayEnd,
      now,
    )
    expect(operations.pickups).toHaveLength(1)
  })

  it('does not list a hire already handed over as still to collect', () => {
    const operations = dayOperations(
      [
        makeRental({
          status: 'active',
          starts_at: '2028-06-08T09:00:00Z',
          picked_up_at: '2028-06-08T09:05:00Z',
        }),
      ],
      dayStart,
      dayEnd,
      now,
    )
    expect(operations.pickups).toHaveLength(0)
    expect(operations.out).toHaveLength(1)
  })

  it('lists a same-day hire as both a pickup and a return', () => {
    const morning = makeRental({
      id: 'morning',
      status: 'reserved',
      starts_at: '2028-06-08T08:00:00Z',
      ends_at: '2028-06-08T16:00:00Z',
    })
    const out = makeRental({
      id: 'out',
      status: 'active',
      starts_at: '2028-06-08T08:00:00Z',
      ends_at: '2028-06-08T16:00:00Z',
    })

    const operations = dayOperations([morning, out], dayStart, dayEnd, now)
    expect(operations.pickups.map((entry) => entry.id)).toEqual(['morning'])
    expect(operations.returns.map((entry) => entry.id)).toEqual(['out'])
  })

  it('does not count a returned hire as still due back', () => {
    const operations = dayOperations(
      [
        makeRental({
          status: 'active',
          ends_at: '2028-06-08T16:00:00Z',
          returned_at: '2028-06-08T15:30:00Z',
        }),
      ],
      dayStart,
      dayEnd,
      now,
    )
    expect(operations.returns).toHaveLength(0)
  })

  it('lists a hire running through the day even though it starts elsewhere', () => {
    const operations = dayOperations(
      [
        makeRental({
          status: 'active',
          starts_at: '2028-06-01T08:00:00Z',
          ends_at: '2028-06-20T08:00:00Z',
        }),
      ],
      dayStart,
      dayEnd,
      now,
    )
    expect(operations.out).toHaveLength(1)
    expect(operations.pickups).toHaveLength(0)
    expect(operations.returns).toHaveLength(0)
  })

  it('collects overdue hires whatever day they were due', () => {
    const operations = dayOperations(
      [makeRental({ status: 'active', ends_at: '2028-06-01T08:00:00Z' })],
      dayStart,
      dayEnd,
      now,
    )
    expect(operations.overdue).toHaveLength(1)
  })

  it('sorts pickups by the time they are due out', () => {
    const late = makeRental({ id: 'late', status: 'reserved', starts_at: '2028-06-08T17:00:00Z' })
    const early = makeRental({ id: 'early', status: 'reserved', starts_at: '2028-06-08T08:00:00Z' })

    const operations = dayOperations([late, early], dayStart, dayEnd, now)
    expect(operations.pickups.map((entry) => entry.id)).toEqual(['early', 'late'])
  })
})

describe('search on the board', () => {
  const rental = makeRental()

  it('matches a contract number, a customer, a plate and a model', () => {
    expect(matchesSearch(rental, 'RNT-2028')).toBe(true)
    expect(matchesSearch(rental, 'amina')).toBe(true)
    expect(matchesSearch(rental, '12345-a')).toBe(true)
    expect(matchesSearch(rental, '208')).toBe(true)
  })

  it('matches everything on an empty term', () => {
    expect(matchesSearch(rental, '   ')).toBe(true)
  })

  it('does not match something absent', () => {
    expect(matchesSearch(rental, 'renault')).toBe(false)
  })
})

describe('block density', () => {
  it('shows everything only when there is room for it', () => {
    expect(densityFor(240)).toBe('full')
    expect(densityFor(100)).toBe('compact')
    // Rather than clipping a label into ellipsis soup, a sliver says nothing.
    expect(densityFor(12)).toBe('minimal')
  })
})
