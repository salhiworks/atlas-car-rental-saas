import { describe, expect, it } from 'vitest'

import {
  DEFAULT_COMPLIANCE_LEAD_DAYS,
  describeCompliance,
  evaluateCompliance,
  evaluateVehicleCompliance,
  worstCompliance,
} from './expiry'

const PARIS = { timeZone: 'Europe/Paris', leadDays: 30 }
const NOW = new Date('2026-06-15T12:00:00Z')

describe('evaluateCompliance', () => {
  it('treats a missing date as unrecorded, not as expired', () => {
    // The difference matters: "we never wrote it down" is a records gap;
    // "expired" means the vehicle is not legal to hire out.
    for (const value of [null, undefined, '']) {
      expect(evaluateCompliance(value, { ...PARIS, now: NOW })).toMatchObject({
        state: 'unrecorded',
        daysRemaining: null,
      })
    }
  })

  it('treats an unparseable value as unrecorded rather than guessing', () => {
    expect(evaluateCompliance('31/12/2026', { ...PARIS, now: NOW }).state).toBe('unrecorded')
    expect(evaluateCompliance('nonsense', { ...PARIS, now: NOW }).state).toBe('unrecorded')
  })

  it('counts a certificate valid through its expiry day', () => {
    // A document that says "until 15 June" is valid for all of 15 June.
    expect(evaluateCompliance('2026-06-15', { ...PARIS, now: NOW })).toMatchObject({
      state: 'due-soon',
      daysRemaining: 0,
    })
    expect(evaluateCompliance('2026-06-14', { ...PARIS, now: NOW })).toMatchObject({
      state: 'expired',
      daysRemaining: -1,
    })
  })

  it('warns exactly within the agency’s configured window', () => {
    expect(evaluateCompliance('2026-07-15', { ...PARIS, now: NOW }).state).toBe('due-soon')
    expect(evaluateCompliance('2026-07-16', { ...PARIS, now: NOW }).state).toBe('valid')
  })

  it('respects an agency that wants a longer window', () => {
    const longer = { timeZone: 'Europe/Paris', leadDays: 90, now: NOW }
    expect(evaluateCompliance('2026-08-01', longer).state).toBe('due-soon')
    expect(evaluateCompliance('2026-08-01', { ...PARIS, now: NOW }).state).toBe('valid')
  })

  it('handles a zero-day window as "warn only on the day"', () => {
    const strict = { timeZone: 'Europe/Paris', leadDays: 0, now: NOW }
    expect(evaluateCompliance('2026-06-15', strict).state).toBe('due-soon')
    expect(evaluateCompliance('2026-06-16', strict).state).toBe('valid')
  })

  it('uses the agency’s calendar day, not the browser’s', () => {
    // 23:30 UTC on 14 June is already 15 June in Paris and still 14 June in
    // Los Angeles. A certificate expiring on the 14th is expired for one and
    // valid for the other.
    const lateEvening = new Date('2026-06-14T23:30:00Z')

    expect(
      evaluateCompliance('2026-06-14', { timeZone: 'Europe/Paris', leadDays: 30, now: lateEvening })
        .state,
    ).toBe('expired')

    expect(
      evaluateCompliance('2026-06-14', {
        timeZone: 'America/Los_Angeles',
        leadDays: 30,
        now: lateEvening,
      }).state,
    ).toBe('due-soon')
  })

  it('is stable across a daylight-saving boundary', () => {
    // Clocks go forward in Paris on 29 March 2026; day counting must not slip.
    const beforeDst = new Date('2026-03-28T12:00:00Z')
    expect(
      evaluateCompliance('2026-04-04', { timeZone: 'Europe/Paris', leadDays: 30, now: beforeDst })
        .daysRemaining,
    ).toBe(7)
  })

  it('exposes a sensible default window', () => {
    expect(DEFAULT_COMPLIANCE_LEAD_DAYS).toBe(30)
  })
})

describe('worstCompliance', () => {
  const status = (state: 'valid' | 'due-soon' | 'expired' | 'unrecorded') => ({
    state,
    daysRemaining: null,
    expiresOn: null,
  })

  it('ranks expired above due-soon above unrecorded above valid', () => {
    expect(worstCompliance([status('valid'), status('unrecorded')])).toBe('unrecorded')
    expect(worstCompliance([status('unrecorded'), status('due-soon')])).toBe('due-soon')
    expect(worstCompliance([status('due-soon'), status('expired')])).toBe('expired')
    expect(worstCompliance([status('valid'), status('valid')])).toBe('valid')
  })

  it('is valid for an empty set', () => {
    expect(worstCompliance([])).toBe('valid')
  })
})

describe('evaluateVehicleCompliance', () => {
  const options = { ...PARIS, now: NOW }

  it('flags a vehicle for attention when any document has expired', () => {
    const result = evaluateVehicleCompliance(
      {
        insurance_expires_on: '2027-01-01',
        inspection_expires_on: '2026-01-01',
        registration_expires_on: '2027-01-01',
      },
      options,
    )

    expect(result.inspection.state).toBe('expired')
    expect(result.overall).toBe('expired')
    expect(result.needsAttention).toBe(true)
  })

  it('does not flag a vehicle whose records are merely incomplete', () => {
    // Missing paperwork is worth surfacing, but it is not an alarm.
    const result = evaluateVehicleCompliance(
      {
        insurance_expires_on: '2027-01-01',
        inspection_expires_on: null,
        registration_expires_on: '2027-01-01',
      },
      options,
    )

    expect(result.overall).toBe('unrecorded')
    expect(result.needsAttention).toBe(false)
  })

  it('leaves a fully valid vehicle alone', () => {
    const result = evaluateVehicleCompliance(
      {
        insurance_expires_on: '2027-01-01',
        inspection_expires_on: '2027-02-01',
        registration_expires_on: '2027-03-01',
      },
      options,
    )

    expect(result.overall).toBe('valid')
    expect(result.needsAttention).toBe(false)
  })
})

describe('describeCompliance', () => {
  const options = { ...PARIS, now: NOW }

  it.each([
    ['2026-06-15', 'Expires today'],
    ['2026-06-16', 'Expires tomorrow'],
    ['2026-06-25', 'Expires in 10 days'],
    ['2026-06-14', 'Expired yesterday'],
    ['2026-06-05', 'Expired 10 days ago'],
    ['2030-01-01', 'Valid'],
  ])('describes %s as "%s"', (date, expected) => {
    expect(describeCompliance(evaluateCompliance(date, options))).toBe(expected)
  })

  it('describes a missing record plainly', () => {
    expect(describeCompliance(evaluateCompliance(null, options))).toBe('Not recorded')
  })
})
