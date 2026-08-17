import { describe, expect, it } from 'vitest'

import {
  addDaysInTimeZone,
  addMonthsInTimeZone,
  countDaysInTimeZone,
  fromDateTimeLocalValue,
  getTimeZoneOffsetMs,
  getZonedParts,
  isValidTimeZone,
  startOfDayInTimeZone,
  startOfMonthInTimeZone,
  toDateTimeLocalValue,
  toIsoDateInTimeZone,
  zonedPartsToInstant,
} from './timezone'

const HOUR = 3_600_000

describe('time zone validation', () => {
  it.each([['UTC'], ['Europe/Paris'], ['Africa/Casablanca'], ['America/New_York'], ['Asia/Tokyo']])(
    'accepts %s',
    (zone) => {
      expect(isValidTimeZone(zone)).toBe(true)
    },
  )

  it.each([[''], ['Mars/Olympus_Mons'], ['Not A Zone'], ['GMT+25']])('rejects %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false)
  })
})

describe('offsets', () => {
  it('reports zero for UTC', () => {
    expect(getTimeZoneOffsetMs(new Date('2026-06-15T12:00:00Z'), 'UTC')).toBe(0)
  })

  it('follows daylight saving through the year', () => {
    // Paris is UTC+1 in winter and UTC+2 in summer.
    expect(getTimeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Europe/Paris')).toBe(HOUR)
    expect(getTimeZoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'Europe/Paris')).toBe(2 * HOUR)
  })

  it('handles zones behind UTC', () => {
    expect(getTimeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(
      -5 * HOUR,
    )
  })

  it('handles a zone with a non-hour offset', () => {
    expect(getTimeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * HOUR)
  })
})

describe('wall time to instant', () => {
  it('round-trips an ordinary time', () => {
    const instant = zonedPartsToInstant(
      { year: 2026, month: 6, day: 15, hour: 9, minute: 30, second: 0 },
      'Europe/Paris',
    )
    expect(instant.toISOString()).toBe('2026-06-15T07:30:00.000Z')

    const parts = getZonedParts(instant, 'Europe/Paris')
    expect(parts).toMatchObject({ year: 2026, month: 6, day: 15, hour: 9, minute: 30 })
  })

  it('is exact across a spring-forward boundary', () => {
    // In 2026 European clocks jump 02:00 -> 03:00 on 29 March.
    const before = zonedPartsToInstant(
      { year: 2026, month: 3, day: 29, hour: 1, minute: 30, second: 0 },
      'Europe/Paris',
    )
    expect(before.toISOString()).toBe('2026-03-29T00:30:00.000Z')

    const after = zonedPartsToInstant(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30, second: 0 },
      'Europe/Paris',
    )
    expect(after.toISOString()).toBe('2026-03-29T01:30:00.000Z')
  })

  it('resolves a wall time inside the spring-forward gap to a real instant', () => {
    // 02:30 never happens that day. The result must still be a valid instant
    // and must not silently land a day away.
    const inGap = zonedPartsToInstant(
      { year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 },
      'Europe/Paris',
    )
    expect(Number.isNaN(inGap.getTime())).toBe(false)
    expect(toIsoDateInTimeZone(inGap, 'Europe/Paris')).toBe('2026-03-29')
  })

  it('is exact across an autumn fall-back boundary', () => {
    // Clocks go back 03:00 -> 02:00 on 25 October 2026; 02:30 happens twice.
    const ambiguous = zonedPartsToInstant(
      { year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 },
      'Europe/Paris',
    )
    const roundTripped = getZonedParts(ambiguous, 'Europe/Paris')
    expect(roundTripped).toMatchObject({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 })
  })

  it('round-trips every hour of a DST transition day without drifting', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const instant = zonedPartsToInstant(
        { year: 2026, month: 10, day: 25, hour, minute: 0, second: 0 },
        'Europe/Paris',
      )
      expect(toIsoDateInTimeZone(instant, 'Europe/Paris')).toBe('2026-10-25')
    }
  })
})

describe('period boundaries', () => {
  it('finds local midnight, not UTC midnight', () => {
    // 00:30 UTC on 15 June is already 02:30 in Paris, so the Paris day started
    // at 22:00 UTC on the 14th.
    const instant = new Date('2026-06-15T00:30:00Z')
    expect(startOfDayInTimeZone(instant, 'Europe/Paris').toISOString()).toBe(
      '2026-06-14T22:00:00.000Z',
    )
  })

  it('finds the first moment of the month in the agency zone', () => {
    const instant = new Date('2026-06-15T12:00:00Z')
    expect(startOfMonthInTimeZone(instant, 'Europe/Paris').toISOString()).toBe(
      '2026-05-31T22:00:00.000Z',
    )
    expect(startOfMonthInTimeZone(instant, 'UTC').toISOString()).toBe('2026-06-01T00:00:00.000Z')
  })

  it('clamps a month shift onto a shorter month', () => {
    const jan31 = zonedPartsToInstant(
      { year: 2026, month: 1, day: 31, hour: 12, minute: 0, second: 0 },
      'UTC',
    )
    // 2026 is not a leap year, so February ends on the 28th.
    expect(toIsoDateInTimeZone(addMonthsInTimeZone(jan31, 'UTC', 1), 'UTC')).toBe('2026-02-28')
  })

  it('shifts whole days across a DST change', () => {
    const before = zonedPartsToInstant(
      { year: 2026, month: 3, day: 28, hour: 10, minute: 0, second: 0 },
      'Europe/Paris',
    )
    const after = addDaysInTimeZone(before, 'Europe/Paris', 1)

    // The wall-clock time is preserved even though only 23 hours elapsed.
    expect(getZonedParts(after, 'Europe/Paris')).toMatchObject({ day: 29, hour: 10, minute: 0 })
    expect(after.getTime() - before.getTime()).toBe(23 * HOUR)
  })

  it('counts calendar days, not 24-hour blocks', () => {
    const pickup = zonedPartsToInstant(
      { year: 2026, month: 6, day: 1, hour: 23, minute: 0, second: 0 },
      'Europe/Paris',
    )
    const dropOff = zonedPartsToInstant(
      { year: 2026, month: 6, day: 3, hour: 1, minute: 0, second: 0 },
      'Europe/Paris',
    )
    // 26 hours apart, but it spans two calendar boundaries.
    expect(countDaysInTimeZone(pickup, dropOff, 'Europe/Paris')).toBe(2)
  })
})

describe('datetime-local form values', () => {
  it('round-trips through an input value', () => {
    const instant = new Date('2026-06-15T07:30:00Z')
    const value = toDateTimeLocalValue(instant, 'Europe/Paris')
    expect(value).toBe('2026-06-15T09:30')

    const parsed = fromDateTimeLocalValue(value, 'Europe/Paris')
    expect(parsed?.toISOString()).toBe('2026-06-15T07:30:00.000Z')
  })

  it('reads the same wall time differently in different zones', () => {
    const paris = fromDateTimeLocalValue('2026-06-15T09:30', 'Europe/Paris')
    const casablanca = fromDateTimeLocalValue('2026-06-15T09:30', 'Africa/Casablanca')
    expect(paris?.toISOString()).not.toBe(casablanca?.toISOString())
  })

  it.each([[''], ['not-a-date'], ['2026-13-01T10:00'], ['2026-06-15']])(
    'returns null for malformed value %s',
    (value) => {
      expect(fromDateTimeLocalValue(value, 'UTC')).toBeNull()
    },
  )
})

/**
 * The two days a year the clocks move.
 *
 * These were wrong for a year: a wall time that does not exist was resolved
 * *backwards*, which in zones that move their clocks at midnight — Havana,
 * Santiago — put the start of a day at 23:00 on the day before. On a fleet
 * schedule that silently shifts a whole day column and every day-boundary query
 * with it.
 */
describe('clock changes', () => {
  it('resolves a wall time that never happened by moving forward', () => {
    // Europe/Paris jumps 02:00 -> 03:00 on 2028-03-26, so 02:30 does not exist.
    const instant = zonedPartsToInstant(
      { year: 2028, month: 3, day: 26, hour: 2, minute: 30, second: 0 },
      'Europe/Paris',
    )
    const parts = getZonedParts(instant, 'Europe/Paris')

    expect(parts.day).toBe(26)
    expect(parts.hour).toBe(3)
    expect(parts.minute).toBe(30)
  })

  it('keeps the start of the day on the right day where the clocks move at midnight', () => {
    // America/Havana jumps 00:00 -> 01:00 on 2028-03-12: local midnight is
    // missing. Resolving backwards would answer "23:00 on the 11th".
    const noon = new Date('2028-03-12T16:00:00Z')
    const start = startOfDayInTimeZone(noon, 'America/Havana')

    expect(toIsoDateInTimeZone(start, 'America/Havana')).toBe('2028-03-12')
    expect(getZonedParts(start, 'America/Havana').hour).toBe(1)
  })

  it('does the same in the southern hemisphere', () => {
    // America/Santiago jumps 00:00 -> 01:00 on 2028-09-03.
    const noon = new Date('2028-09-03T15:00:00Z')
    const start = startOfDayInTimeZone(noon, 'America/Santiago')

    expect(toIsoDateInTimeZone(start, 'America/Santiago')).toBe('2028-09-03')
  })

  it('takes the first of a wall time that happens twice', () => {
    // Europe/Paris falls back 03:00 -> 02:00 on 2028-10-29, so 02:30 happens
    // once at 00:30Z and again at 01:30Z. A customer collecting at 02:30 means
    // the first one.
    const instant = zonedPartsToInstant(
      { year: 2028, month: 10, day: 29, hour: 2, minute: 30, second: 0 },
      'Europe/Paris',
    )
    expect(instant.toISOString()).toBe('2028-10-29T00:30:00.000Z')

    // And an hour later still reads as the same wall time — which is what makes
    // it the first occurrence rather than the second.
    const anHourLater = new Date(instant.getTime() + 3_600_000)
    expect(getZonedParts(anHourLater, 'Europe/Paris').hour).toBe(2)
  })

  it('starts every day of the year on the right date, in ten zones', () => {
    const zones = [
      'America/Havana',
      'America/Santiago',
      'Europe/Paris',
      'Asia/Beirut',
      'Australia/Lord_Howe',
      'America/Sao_Paulo',
      'Pacific/Auckland',
      'Asia/Kathmandu',
      'America/New_York',
      'Africa/Casablanca',
    ]

    for (const zone of zones) {
      for (let offset = 0; offset < 366; offset += 1) {
        const noon = new Date(Date.UTC(2028, 0, 1 + offset, 12, 0, 0))
        const expected = toIsoDateInTimeZone(noon, zone)
        const start = startOfDayInTimeZone(noon, zone)

        expect(toIsoDateInTimeZone(start, zone)).toBe(expected)

        // And the day that follows is one calendar day long, whatever the
        // clocks did in between.
        const hours = (addDaysInTimeZone(start, zone, 1).getTime() - start.getTime()) / 3_600_000
        expect(hours).toBeGreaterThanOrEqual(22)
        expect(hours).toBeLessThanOrEqual(26)
      }
    }
  })
})
