/**
 * How tracking facts are put into words.
 *
 * The whole module rests on one rule: a value the provider did not report is
 * unknown, and unknown is not zero, not false, and not "offline". A tracker that
 * has said nothing for six hours is not parked — nobody knows where it is. The
 * formatters below therefore return an em dash and a reason rather than a
 * confident number, and every badge that could be mistaken for a fact carries
 * the word the data actually supports.
 *
 * Three separate facts are kept separate everywhere they appear:
 *
 *   - PROVIDER CONNECTIVITY — is the tracker itself talking to the provider?
 *   - POSITION FRESHNESS    — how old is the newest position we hold?
 *   - SYNC HEALTH           — is this product managing to reach the provider?
 *
 * Collapsing them into one green dot is the classic telematics lie: it shows
 * "online" when the integration is broken, or "offline" when only the last hop
 * failed. Each has its own vocabulary here and its own badge on screen.
 */

import type { BadgeTone } from '@/components/ui'
import type {
  GpsCapability,
  GpsConnectionStatus,
  GpsMovementState,
  GpsPositionFreshness,
  GpsSyncHealth,
  GpsTrackPoint,
  GpsUnitAvailability,
} from '@/types/database'

// -----------------------------------------------------------------------------
// Position freshness — what we know, and how long ago we knew it
// -----------------------------------------------------------------------------

export interface StatusMeta {
  readonly label: string
  readonly tone: BadgeTone
  /** One sentence, written for the person running the agency. */
  readonly detail: string
}

export const POSITION_FRESHNESS: Readonly<Record<GpsPositionFreshness, StatusMeta>> = {
  fresh: {
    label: 'Live',
    tone: 'positive',
    detail: 'The provider reported this position within your live window.',
  },
  stale: {
    label: 'Delayed',
    tone: 'caution',
    detail: 'Older than your live window. The vehicle may have moved since.',
  },
  very_stale: {
    label: 'Last known',
    tone: 'critical',
    detail: 'Well outside your stale window. Treat this as a last known position, not a location.',
  },
  future: {
    label: 'Clock ahead',
    tone: 'caution',
    detail:
      'The provider timestamped this position in the future. Usually a tracker clock that is set wrong.',
  },
  unknown: {
    label: 'No position',
    tone: 'neutral',
    detail: 'This device has never reported a usable position.',
  },
}

export const SYNC_HEALTH: Readonly<Record<GpsSyncHealth, StatusMeta>> = {
  never_synced: {
    label: 'Never synchronised',
    tone: 'neutral',
    detail: 'This connection has not been synchronised yet.',
  },
  healthy: {
    label: 'Synchronising',
    tone: 'positive',
    detail: 'The last synchronisation reached the provider and succeeded.',
  },
  auth_error: {
    label: 'Credential rejected',
    tone: 'critical',
    detail:
      'The provider refused the stored token, so nothing on this map is being updated. Replace the credential.',
  },
  unreachable: {
    label: 'Provider unreachable',
    tone: 'critical',
    detail: 'The provider could not be reached, so positions here are as old as the last success.',
  },
  rate_limited: {
    label: 'Rate limited',
    tone: 'caution',
    detail: 'The provider asked us to slow down. Updates are arriving less often than usual.',
  },
  provider_error: {
    label: 'Not synchronising',
    tone: 'critical',
    detail: 'The last attempt failed with a provider error. Positions on screen may be stale.',
  },
  disabled: {
    label: 'Switched off',
    tone: 'neutral',
    detail: 'This connection is switched off. Nothing is being synchronised.',
  },
}

export const CONNECTION_STATUS: Readonly<Record<GpsConnectionStatus, StatusMeta>> = {
  never_connected: {
    label: 'Not verified',
    tone: 'neutral',
    detail: 'This connection has not reached the provider yet.',
  },
  healthy: { label: 'Connected', tone: 'positive', detail: 'The provider is answering normally.' },
  auth_error: {
    label: 'Credential rejected',
    tone: 'critical',
    detail: 'The provider refused the stored token. Replace it to resume synchronising.',
  },
  unreachable: {
    label: 'Unreachable',
    tone: 'critical',
    detail: 'The provider could not be reached. This is usually temporary.',
  },
  rate_limited: {
    label: 'Rate limited',
    tone: 'caution',
    detail: 'The provider is asking us to slow down. Synchronising will resume shortly.',
  },
  provider_error: {
    label: 'Provider error',
    tone: 'critical',
    detail: 'The provider returned an error we could not act on.',
  },
  disabled: {
    label: 'Switched off',
    tone: 'neutral',
    detail: 'Synchronising is stopped. Devices, assignments and history are kept.',
  },
}

export const UNIT_AVAILABILITY: Readonly<Record<GpsUnitAvailability, StatusMeta>> = {
  present: { label: 'Present', tone: 'positive', detail: 'Seen in the provider account.' },
  missing: {
    label: 'Missing',
    tone: 'critical',
    detail: 'This device was not in the provider account at the last full synchronisation.',
  },
  archived: {
    label: 'Archived',
    tone: 'neutral',
    detail: 'Kept for history. No longer synchronised.',
  },
}

/**
 * Provider connectivity, as three states and never two.
 *
 * `null` means the provider did not tell us. A tracker whose connection state is
 * unreported is not offline, and painting it red would send somebody out to look
 * for a van that is parked exactly where it should be.
 */
export function providerConnectivity(online: boolean | null): StatusMeta {
  if (online === true) {
    return { label: 'Tracker online', tone: 'positive', detail: 'The provider has a live link.' }
  }
  if (online === false) {
    return {
      label: 'Tracker offline',
      tone: 'critical',
      detail: 'The provider reports no link to this device.',
    }
  }
  return {
    label: 'Link not reported',
    tone: 'neutral',
    detail: 'This provider does not report a connection state for this device.',
  }
}

// -----------------------------------------------------------------------------
// Values
// -----------------------------------------------------------------------------

/** What every unknown reads as. One character, used everywhere, never a zero. */
export const UNKNOWN = '—'

export function formatSpeed(kph: number | null | undefined, locale: string): string {
  if (kph === null || kph === undefined) return UNKNOWN
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(kph)} km/h`
}

const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const

export function formatHeading(deg: number | null | undefined): string {
  if (deg === null || deg === undefined) return UNKNOWN
  const index = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16
  return `${COMPASS[index]} ${Math.round(deg)}°`
}

/**
 * Six decimals, which is roughly 0.1 m — more precision than any consumer
 * tracker delivers, and enough that copying a pair into a maps app lands on the
 * right side of the street.
 */
export function formatCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string {
  if (latitude === null || latitude === undefined) return UNKNOWN
  if (longitude === null || longitude === undefined) return UNKNOWN
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
}

export function describeIgnition(ignition: boolean | null | undefined): string {
  if (ignition === true) return 'On'
  if (ignition === false) return 'Off'
  return 'Not reported'
}

export const MOVEMENT_LABELS: Readonly<Record<GpsMovementState, string>> = {
  moving: 'Moving',
  stopped: 'Stopped',
}

export function formatMovement(movement: GpsMovementState | null | undefined): string {
  if (!movement) return 'Not reported'
  return MOVEMENT_LABELS[movement]
}

/**
 * A position's age, in the coarsest unit that is still honest.
 *
 * Seconds below a minute, then minutes, then hours, then days. Nobody needs
 * "4 hours 17 minutes ago" to decide whether to trust a dot on a map.
 */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return UNKNOWN
  if (seconds < 0) return 'in the future'
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  const days = Math.floor(seconds / 86_400)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

export function formatOdometer(km: number | null | undefined, locale: string): string {
  if (km === null || km === undefined) return UNKNOWN
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(km)} km`
}

export function formatEngineHours(hours: number | null | undefined, locale: string): string {
  if (hours === null || hours === undefined) return UNKNOWN
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(hours)} h`
}

export const CAPABILITY_LABELS: Readonly<Record<GpsCapability, string>> = {
  position: 'Position',
  speed: 'Speed',
  heading: 'Heading',
  altitude: 'Altitude',
  satellites: 'Satellites',
  ignition: 'Ignition',
  odometer: 'Odometer',
  engine_hours: 'Engine hours',
  connectivity: 'Connection state',
  history: 'History',
}

export function hasCapability(
  capabilities: readonly GpsCapability[] | null | undefined,
  capability: GpsCapability,
): boolean {
  return Boolean(capabilities?.includes(capability))
}

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

export interface MapPoint {
  readonly latitude: number
  readonly longitude: number
}

export interface Bounds {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

/** The smallest box containing every point, or null when there are none. */
export function boundsOf(points: readonly MapPoint[]): Bounds | null {
  if (points.length === 0) return null

  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity

  for (const point of points) {
    if (point.longitude < west) west = point.longitude
    if (point.longitude > east) east = point.longitude
    if (point.latitude < south) south = point.latitude
    if (point.latitude > north) north = point.latitude
  }

  return { west, south, east, north }
}

const EARTH_RADIUS_KM = 6371.0088

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Great-circle distance between two reported positions. */
export function haversineKm(a: MapPoint, b: MapPoint): number {
  const dLat = toRadians(b.latitude - a.latitude)
  const dLon = toRadians(b.longitude - a.longitude)
  const lat1 = toRadians(a.latitude)
  const lat2 = toRadians(b.latitude)

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Straight-line distance along the reported positions.
 *
 * NOT distance driven. The provider reports points, not roads: the sum of the
 * chords between them is shorter than the route through every bend, and gets
 * shorter still as reporting intervals lengthen. The interface says
 * "straight-line distance between reported positions" for exactly this reason,
 * and the odometer — when the device reports one — is shown separately as the
 * thing that actually answers "how far did it go".
 */
export function straightLineDistanceKm(points: readonly MapPoint[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    if (previous && current) total += haversineKm(previous, current)
  }
  return total
}

/**
 * Thins a track for drawing, without inventing anything.
 *
 * Twenty thousand points is a legitimate answer from the provider and an
 * illegitimate thing to hand a browser: it is a slow first paint and a line that
 * looks identical to a tenth of it. This keeps every Nth point plus both ends,
 * so the shape survives and no coordinate is moved, averaged, smoothed or
 * snapped to a road. The reported count stays the real one, and the interface
 * says how many of them are being drawn.
 */
export function downsampleForDisplay<T>(points: readonly T[], maximum: number): readonly T[] {
  if (maximum < 2) return points.length > 0 ? points.slice(0, 1) : []
  if (points.length <= maximum) return points

  const stride = (points.length - 1) / (maximum - 1)
  const kept: T[] = []
  for (let index = 0; index < maximum - 1; index += 1) {
    const point = points[Math.round(index * stride)]
    if (point !== undefined) kept.push(point)
  }
  const last = points[points.length - 1]
  if (last !== undefined) kept.push(last)
  return kept
}

/** The provider's points, kept in the order it reported them. */
export function trackPointsForMap(points: readonly GpsTrackPoint[]): MapPoint[] {
  return points.map((point) => ({ latitude: point.latitude, longitude: point.longitude }))
}

// -----------------------------------------------------------------------------
// Refresh cadence
// -----------------------------------------------------------------------------

/**
 * How often the map may ask the server while somebody is watching it.
 *
 * Deliberately not a second. The Edge Function coalesces every agency's tabs
 * into one provider call per twenty-second window, so polling faster buys no
 * fresher data and only costs requests. Trackers themselves typically report on
 * a 30–120 second interval; asking ten times between two reports produces ten
 * identical answers.
 */
export const LIVE_REFRESH_MS = 30_000

/** Slower when the tab is in the background: nobody is looking. */
export const BACKGROUND_REFRESH_MS = 120_000
