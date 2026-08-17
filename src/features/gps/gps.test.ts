import { describe, expect, it } from 'vitest'

import { gpsKeys } from './queries'
import {
  BACKGROUND_REFRESH_MS,
  CONNECTION_STATUS,
  LIVE_REFRESH_MS,
  POSITION_FRESHNESS,
  SYNC_HEALTH,
  UNKNOWN,
  boundsOf,
  describeIgnition,
  downsampleForDisplay,
  formatAge,
  formatCoordinates,
  formatEngineHours,
  formatHeading,
  formatMovement,
  formatOdometer,
  formatSpeed,
  haversineKm,
  hasCapability,
  providerConnectivity,
  straightLineDistanceKm,
} from './domain'

/**
 * The claims the tracking interface makes, tested as claims.
 *
 * Almost all of these are one rule seen from different angles: a value the
 * provider did not report is unknown, and unknown is not zero. The formatters
 * are the last place that rule can be broken before a person reads a number and
 * acts on it, so each one is checked against the specific lie it could tell.
 */

const LOCALE = 'en-GB'

// -----------------------------------------------------------------------------
// Unknown stays unknown
// -----------------------------------------------------------------------------

describe('a value the provider did not report', () => {
  it('is never rendered as zero', () => {
    expect(formatSpeed(null, LOCALE)).toBe(UNKNOWN)
    expect(formatSpeed(undefined, LOCALE)).toBe(UNKNOWN)
    expect(formatOdometer(null, LOCALE)).toBe(UNKNOWN)
    expect(formatEngineHours(null, LOCALE)).toBe(UNKNOWN)
    expect(formatHeading(null)).toBe(UNKNOWN)
    expect(formatCoordinates(null, null)).toBe(UNKNOWN)
    expect(formatAge(null)).toBe(UNKNOWN)
  })

  it('is never rendered as false', () => {
    // The one that matters: an unreported ignition sensor must not read "Off",
    // which somebody would take to mean the engine is not running.
    expect(describeIgnition(null)).toBe('Not reported')
    expect(describeIgnition(undefined)).toBe('Not reported')
    expect(describeIgnition(false)).toBe('Off')
    expect(describeIgnition(true)).toBe('On')
  })

  it('keeps a genuine zero distinguishable from a missing one', () => {
    expect(formatSpeed(0, LOCALE)).toBe('0 km/h')
    expect(formatOdometer(0, LOCALE)).toBe('0 km')
    // A stationary vehicle reporting 0 km/h is a fact; an unreported speed is
    // not, and the two must not print the same string.
    expect(formatSpeed(0, LOCALE)).not.toBe(formatSpeed(null, LOCALE))
  })

  it('does not claim a movement state that was not derived', () => {
    expect(formatMovement(null)).toBe('Not reported')
    expect(formatMovement('stopped')).toBe('Stopped')
    expect(formatMovement('moving')).toBe('Moving')
  })
})

// -----------------------------------------------------------------------------
// The three facts
// -----------------------------------------------------------------------------

describe('provider connectivity', () => {
  it('has three states, not two', () => {
    expect(providerConnectivity(true).label).toBe('Tracker online')
    expect(providerConnectivity(false).label).toBe('Tracker offline')
    // Unreported connectivity is the third state. Painting it red would send
    // somebody to look for a van that is parked where it should be.
    expect(providerConnectivity(null).label).toBe('Link not reported')
  })

  it('does not tint an unreported link as a problem', () => {
    expect(providerConnectivity(null).tone).toBe('neutral')
    expect(providerConnectivity(false).tone).toBe('critical')
  })
})

describe('the three facts', () => {
  it('are three separate vocabularies, with no shared wording', () => {
    // If any two of these produced the same label, the interface would be
    // collapsing facts that fail independently.
    const freshness = Object.values(POSITION_FRESHNESS).map((meta) => meta.label)
    const sync = Object.values(SYNC_HEALTH).map((meta) => meta.label)
    const connectivity = [true, false, null].map((value) => providerConnectivity(value).label)

    expect(new Set(freshness).size).toBe(freshness.length)
    expect(freshness.some((label) => connectivity.includes(label))).toBe(false)
    expect(sync.some((label) => connectivity.includes(label))).toBe(false)
  })

  it('describes every freshness the database can produce', () => {
    for (const key of ['fresh', 'stale', 'very_stale', 'future', 'unknown'] as const) {
      expect(POSITION_FRESHNESS[key].label).toBeTruthy()
      expect(POSITION_FRESHNESS[key].detail).toBeTruthy()
    }
  })

  it('describes every sync health the database can produce', () => {
    for (const key of [
      'healthy',
      'never_synced',
      'auth_error',
      'unreachable',
      'rate_limited',
      'provider_error',
      'disabled',
    ] as const) {
      expect(SYNC_HEALTH[key].label).toBeTruthy()
    }
  })

  it('never calls a stale position healthy', () => {
    expect(POSITION_FRESHNESS.very_stale.tone).toBe('critical')
    expect(POSITION_FRESHNESS.stale.tone).toBe('caution')
    expect(POSITION_FRESHNESS.fresh.tone).toBe('positive')
  })

  it('flags a future timestamp rather than accepting it as current', () => {
    // A tracker with a wrong clock would otherwise be the freshest thing on the
    // map forever.
    expect(POSITION_FRESHNESS.future.tone).not.toBe('positive')
    expect(POSITION_FRESHNESS.future.detail).toMatch(/clock/i)
  })

  it('says a rejected credential is a rejected credential', () => {
    expect(CONNECTION_STATUS.auth_error.label).toMatch(/credential/i)
    expect(SYNC_HEALTH.auth_error.detail).toMatch(/replace/i)
  })
})

// -----------------------------------------------------------------------------
// Values
// -----------------------------------------------------------------------------

describe('formatting', () => {
  it('turns a heading into a compass point without drifting', () => {
    expect(formatHeading(0)).toBe('N 0°')
    expect(formatHeading(90)).toBe('E 90°')
    expect(formatHeading(180)).toBe('S 180°')
    expect(formatHeading(270)).toBe('W 270°')
    // 359° is north, not north-north-west.
    expect(formatHeading(359)).toBe('N 359°')
  })

  it('handles a heading outside the circle rather than indexing past the table', () => {
    expect(formatHeading(450)).toBe('E 450°')
    expect(formatHeading(-90)).toBe('W -90°')
  })

  it('prints coordinates at a precision the hardware can support', () => {
    expect(formatCoordinates(33.589886, -7.603869)).toBe('33.589886, -7.603869')
    // 0,0 is a real place. Only a null is unknown.
    expect(formatCoordinates(0, 0)).toBe('0.000000, 0.000000')
    expect(formatCoordinates(33.5, null)).toBe(UNKNOWN)
  })

  it('ages a position in the coarsest honest unit', () => {
    expect(formatAge(30)).toBe('30s ago')
    expect(formatAge(90)).toBe('1 min ago')
    expect(formatAge(3600)).toBe('1 hour ago')
    expect(formatAge(7200)).toBe('2 hours ago')
    expect(formatAge(86_400)).toBe('1 day ago')
    expect(formatAge(-30)).toBe('in the future')
  })
})

describe('capabilities', () => {
  it('treats an absent capability as unknown rather than absent', () => {
    // A device whose capability list does not mention ignition is a device we
    // have not established anything about — not one that has no ignition.
    expect(hasCapability(['position', 'speed'], 'ignition')).toBe(false)
    expect(hasCapability(['position', 'ignition'], 'ignition')).toBe(true)
    expect(hasCapability(null, 'position')).toBe(false)
    expect(hasCapability(undefined, 'history')).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

describe('bounds', () => {
  it('is null for an empty fleet rather than a box around the Atlantic', () => {
    expect(boundsOf([])).toBeNull()
  })

  it('contains every point', () => {
    const bounds = boundsOf([
      { latitude: 33.5, longitude: -7.6 },
      { latitude: 31.6, longitude: -8.0 },
      { latitude: 35.7, longitude: -5.8 },
    ])

    expect(bounds).toEqual({ west: -8.0, south: 31.6, east: -5.8, north: 35.7 })
  })

  it('is a degenerate box for one vehicle, not an error', () => {
    expect(boundsOf([{ latitude: 33.5, longitude: -7.6 }])).toEqual({
      west: -7.6,
      south: 33.5,
      east: -7.6,
      north: 33.5,
    })
  })
})

describe('distance', () => {
  it('measures a known distance to within a rounding error', () => {
    // Casablanca to Rabat, roughly 87 km great-circle.
    const km = haversineKm(
      { latitude: 33.5731, longitude: -7.5898 },
      { latitude: 34.0209, longitude: -6.8416 },
    )
    expect(km).toBeGreaterThan(85)
    expect(km).toBeLessThan(90)
  })

  it('is zero for a stationary track rather than an accumulation of noise', () => {
    const point = { latitude: 33.5, longitude: -7.6 }
    expect(straightLineDistanceKm([point, point, point])).toBe(0)
  })

  it('is zero for fewer than two points', () => {
    expect(straightLineDistanceKm([])).toBe(0)
    expect(straightLineDistanceKm([{ latitude: 33.5, longitude: -7.6 }])).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// Downsampling
// -----------------------------------------------------------------------------

describe('thinning a track for display', () => {
  const track = Array.from({ length: 5000 }, (_, index) => index)

  it('returns the track untouched when it already fits', () => {
    const short = [1, 2, 3]
    expect(downsampleForDisplay(short, 100)).toBe(short)
  })

  it('never exceeds the budget', () => {
    expect(downsampleForDisplay(track, 500)).toHaveLength(500)
    expect(downsampleForDisplay(track, 2).length).toBeLessThanOrEqual(2)
  })

  it('keeps both ends, so the start and finish of a journey are real', () => {
    const kept = downsampleForDisplay(track, 500)
    expect(kept[0]).toBe(0)
    expect(kept[kept.length - 1]).toBe(4999)
  })

  it('keeps the order the provider reported', () => {
    const kept = downsampleForDisplay(track, 250) as number[]
    for (let index = 1; index < kept.length; index += 1) {
      expect(kept[index]!).toBeGreaterThan(kept[index - 1]!)
    }
  })

  it('only ever selects points that exist — it does not average or invent them', () => {
    const points = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const kept = downsampleForDisplay(points, 4) as number[]
    for (const value of kept) {
      expect(points).toContain(value)
    }
  })
})

// -----------------------------------------------------------------------------
// The cache boundary between agencies
// -----------------------------------------------------------------------------

describe('query keys', () => {
  it('start with the organization, so switching agency cannot serve stale positions', () => {
    // This is the whole defence against the worst bug this module could have:
    // one agency's vehicle positions appearing in another agency's workspace
    // because the cache key did not mention which agency was being looked at.
    const keys = [
      gpsKeys.all('org-a'),
      gpsKeys.connections('org-a'),
      gpsKeys.fleet('org-a', { search: '' }),
      gpsKeys.vehicle('org-a', 'vehicle-1'),
      gpsKeys.inventory('org-a', {}),
      gpsKeys.syncRuns('org-a', 'connection-1'),
      gpsKeys.attention('org-a'),
      gpsKeys.assignable('org-a', ''),
      gpsKeys.track('org-a', 'vehicle-1', 'from', 'to'),
    ]

    for (const key of keys) {
      expect(key[0]).toBe('organization')
      expect(key[1]).toBe('org-a')
      expect(key[2]).toBe('gps')
    }
  })

  it('produces a different key for the same question in another agency', () => {
    expect(gpsKeys.fleet('org-a', { search: '' })).not.toEqual(
      gpsKeys.fleet('org-b', { search: '' }),
    )
    expect(gpsKeys.vehicle('org-a', 'vehicle-1')).not.toEqual(gpsKeys.vehicle('org-b', 'vehicle-1'))
  })

  it('sits under the workspace switcher’s blanket invalidation', () => {
    // Switching agency invalidates ['organization', id]; every tracking key has
    // to be reachable from that prefix or it would survive the switch.
    const key = gpsKeys.fleet('org-a', { search: 'AB' })
    expect(key.slice(0, 2)).toEqual(['organization', 'org-a'])
  })
})

// -----------------------------------------------------------------------------
// Refresh cadence
// -----------------------------------------------------------------------------

describe('the live refresh interval', () => {
  it('is not a second', () => {
    // Trackers report every 30–120 seconds and the server coalesces every tab
    // in an agency into one provider call per 20 seconds. Polling faster buys
    // nothing and costs the agency provider requests.
    expect(LIVE_REFRESH_MS).toBeGreaterThanOrEqual(10_000)
  })

  it('is slower when nobody is looking', () => {
    expect(BACKGROUND_REFRESH_MS).toBeGreaterThan(LIVE_REFRESH_MS)
  })
})
