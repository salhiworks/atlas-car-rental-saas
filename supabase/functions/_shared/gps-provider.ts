/**
 * The normalised GPS domain, and the contract every provider adapter meets.
 *
 * This file knows nothing about any particular telematics company. It defines
 * what this product means by a tracking device, a position and a track, and the
 * small set of operations a provider has to be able to perform. Wialon is one
 * implementation; a future Traccar is another, and adding it should mean
 * writing an adapter and nothing else — not touching the map, the assignment
 * screen, the database or the permission model.
 *
 * TWO RULES THE CONTRACT ENFORCES
 *
 *   Unknown is not zero. Every telemetry field is optional, and an adapter that
 *   cannot determine a value leaves it undefined rather than filling in a
 *   confident default. A device that does not report ignition has no ignition,
 *   not `false`.
 *
 *   External identifiers are opaque strings. Wialon returns integers today;
 *   JSON numbers lose precision past 2^53 and a provider does not get to impose
 *   that on our database. Ids cross this boundary as text and stay text.
 */

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Every provider failure normalises into one of these.
 *
 * The interface shows a sentence chosen from the category, never a raw provider
 * payload — partly because raw payloads are unreadable, and mostly because raw
 * payloads are where credentials end up being echoed back.
 */
export type GpsErrorCategory =
  | 'auth_error'
  | 'unreachable'
  | 'rate_limited'
  | 'permission_denied'
  | 'malformed_config'
  | 'not_found'
  | 'provider_error'

export class GpsProviderError extends Error {
  constructor(
    readonly category: GpsErrorCategory,
    message: string,
    /** The provider's own code, for the operational log. Never a payload. */
    readonly providerCode?: string,
    /** Whether trying again shortly could plausibly succeed. */
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'GpsProviderError'
  }
}

// -----------------------------------------------------------------------------
// The normalised domain
// -----------------------------------------------------------------------------

/**
 * What a device is known to report.
 *
 * Presence means observed or declared by the provider. Absence means UNKNOWN —
 * never "does not support it" — so the interface says "not reported by this
 * device" rather than drawing a disabled widget or a confident zero.
 */
export type GpsCapability =
  | 'position'
  | 'speed'
  | 'heading'
  | 'altitude'
  | 'satellites'
  | 'ignition'
  | 'odometer'
  | 'engine_hours'
  | 'connectivity'
  | 'history'

/** Canonical units throughout: km/h, degrees, metres, kilometres. */
export interface NormalizedPosition {
  /** When the device says it was there. Never our clock. */
  readonly observedAt: string
  readonly latitude?: number
  readonly longitude?: number
  /** The provider's verdict on the fix. A 0,0 coordinate is not universally invalid. */
  readonly positionValid: boolean
  readonly speedKph?: number
  readonly headingDeg?: number
  readonly altitudeM?: number
  readonly satellites?: number
  readonly ignition?: boolean
  readonly movement?: 'moving' | 'stopped'
  readonly providerOnline?: boolean
  readonly odometerKm?: number
  readonly engineHours?: number
  readonly metadata?: Record<string, unknown>
}

export interface NormalizedUnit {
  /** Opaque. Always a string, whatever the provider's native type. */
  readonly externalId: string
  readonly name: string
  /** The hardware's own identifier, where the provider exposes one. */
  readonly deviceUid?: string
  readonly hardware?: string
  readonly capabilities: readonly GpsCapability[]
  readonly position?: NormalizedPosition
  /** Small and sanitised. Never a dump of the provider response. */
  readonly metadata?: Record<string, unknown>
}

export interface NormalizedTrackPoint {
  readonly observedAt: string
  readonly latitude: number
  readonly longitude: number
  readonly speedKph?: number
  readonly headingDeg?: number
  readonly altitudeM?: number
  readonly satellites?: number
}

export interface NormalizedTrack {
  readonly points: readonly NormalizedTrackPoint[]
  /** How many the provider held, before any display downsampling. */
  readonly totalPoints: number
  /** True when the provider had more than the requested bound could carry. */
  readonly truncated: boolean
  readonly from: string
  readonly to: string
}

export interface ProviderAccount {
  readonly accountLabel?: string
  readonly unitCount: number
  /** Which host actually answered — Wialon can redirect to a regional server. */
  readonly host: string
  readonly capabilities: readonly GpsCapability[]
}

export interface GpsConnectionConfig {
  readonly baseUrl: string
  readonly token: string
}

/**
 * The operations a provider has to support.
 *
 * Deliberately read-only. This product does not immobilise engines, unlock
 * doors or reconfigure hardware, and the contract gives an adapter no place to
 * put such a thing even if the provider offers it.
 */
export interface GpsProviderAdapter {
  readonly provider: string
  /** What this provider can do at all, before any device is considered. */
  readonly capabilities: readonly GpsCapability[]

  /** Verify a configuration and describe the account it reaches. */
  testConnection(): Promise<ProviderAccount>
  /** Every accessible device, with its current position where there is one. */
  listUnits(): Promise<{ units: NormalizedUnit[]; skipped: number; account: ProviderAccount }>
  /** A bounded historical track for one device. */
  fetchTrack(externalId: string, from: Date, to: Date, maxPoints: number): Promise<NormalizedTrack>
  /** Release the provider session, where the provider has one. */
  close(): Promise<void>
}

// -----------------------------------------------------------------------------
// Validation shared by every adapter
// -----------------------------------------------------------------------------

/** Beyond this much clock skew ahead of now, a timestamp is not believed. */
export const FUTURE_TOLERANCE_MS = 2 * 60 * 1000

/** Nothing older than this is a plausible "current" position. */
export const ANCIENT_TOLERANCE_MS = 400 * 24 * 60 * 60 * 1000

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Whether a coordinate pair is usable.
 *
 * Range only. Whether 0,0 means "the Gulf of Guinea" or "no fix" is the
 * provider's call, carried separately in `positionValid`, because a blanket
 * rule would throw away real positions for anybody operating near the origin.
 */
export function isUsableCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    isFiniteNumber(latitude) &&
    isFiniteNumber(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  )
}

/**
 * Turns a provider timestamp into an ISO instant, or rejects it.
 *
 * A device with a wrong clock reporting next Tuesday would otherwise look
 * permanently fresh, which is worse than looking unknown.
 */
export function normalizeObservedAt(
  seconds: unknown,
  now: number = Date.now(),
): string | undefined {
  if (!isFiniteNumber(seconds) || seconds <= 0) return undefined

  const ms = seconds * 1000
  if (ms > now + FUTURE_TOLERANCE_MS) return undefined
  if (ms < now - ANCIENT_TOLERANCE_MS) return undefined

  return new Date(ms).toISOString()
}

/**
 * A provider id as our domain carries it: text, trimmed, never coerced.
 *
 * The number branch refuses anything outside the safe-integer range, and that
 * refusal is the important part. A provider response is parsed by `JSON.parse`,
 * which has no integer type — an id of 9007199254740993 comes back as
 * 9007199254740992, and storing that would attribute one vehicle's positions to
 * another vehicle's tracker. Silently. Skipping the unit is a visible, countable
 * failure; a rounded identifier is an invisible, permanent one.
 *
 * Providers that issue identifiers this large should send them as strings, which
 * the first branch takes verbatim, at any length.
 */
export function normalizeExternalId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Integers only. A fractional id is a malformed one.
    if (!Number.isInteger(value)) return undefined
    // And only integers a double represents exactly.
    return Number.isSafeInteger(value) ? String(value) : undefined
  }
  if (typeof value === 'bigint') return String(value)
  return undefined
}

/** Clamps a heading into [0, 360). Providers report 360 for due north. */
export function normalizeHeading(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) return undefined
  const wrapped = ((value % 360) + 360) % 360
  return wrapped
}

export function normalizeSpeed(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) return undefined
  if (value < 0 || value > 1000) return undefined
  return value
}

// -----------------------------------------------------------------------------
// The database boundary
// -----------------------------------------------------------------------------

/**
 * The shape `public.gps_apply_sync` reads.
 *
 * Deliberately not the adapter's own shape. TypeScript is camelCase and SQL is
 * snake_case, and a JSON document crossing between them is a contract, not a
 * coincidence — `v_unit ->> 'external_id'` against an object carrying
 * `externalId` yields NULL, silently, on every field. That is a whole
 * integration failing with no error message, so the translation happens once,
 * here, and `supabase/tests/gps-sync-contract.test.ts` runs real adapter output
 * through this function into the real function to prove the two still agree.
 */
export interface SyncUnitPayload {
  external_id: string
  name: string
  device_uid?: string
  hardware?: string
  capabilities: string[]
  metadata?: Record<string, unknown>
  position?: SyncPositionPayload
}

export interface SyncPositionPayload {
  observed_at: string
  latitude?: number
  longitude?: number
  position_valid: boolean
  speed_kph?: number
  heading_deg?: number
  altitude_m?: number
  satellites?: number
  ignition?: boolean
  movement?: 'moving' | 'stopped'
  provider_online?: boolean
  odometer_km?: number
  engine_hours?: number
  metadata?: Record<string, unknown>
}

/**
 * Only the keys the provider actually reported.
 *
 * An explicit `undefined` would serialise to `null` in some JSON encoders and
 * vanish in others; omitting the key means the SQL sees no key at all, which is
 * what "the provider did not report this" is supposed to look like all the way
 * down. Writing `null` for an unreported speed and 0 for a reported stop are
 * different facts, and this is the last place they could be confused.
 */
function put<T>(target: Record<string, unknown>, key: string, value: T | undefined): void {
  if (value !== undefined) target[key] = value
}

export function toSyncPosition(position: NormalizedPosition): SyncPositionPayload {
  const out: Record<string, unknown> = {
    observed_at: position.observedAt,
    position_valid: position.positionValid,
  }
  put(out, 'latitude', position.latitude)
  put(out, 'longitude', position.longitude)
  put(out, 'speed_kph', position.speedKph)
  put(out, 'heading_deg', position.headingDeg)
  put(out, 'altitude_m', position.altitudeM)
  put(out, 'satellites', position.satellites)
  put(out, 'ignition', position.ignition)
  put(out, 'movement', position.movement)
  put(out, 'provider_online', position.providerOnline)
  put(out, 'odometer_km', position.odometerKm)
  put(out, 'engine_hours', position.engineHours)
  put(out, 'metadata', position.metadata)
  return out as unknown as SyncPositionPayload
}

export function toSyncUnit(unit: NormalizedUnit): SyncUnitPayload {
  const out: Record<string, unknown> = {
    external_id: unit.externalId,
    name: unit.name,
    capabilities: [...unit.capabilities],
  }
  put(out, 'device_uid', unit.deviceUid)
  put(out, 'hardware', unit.hardware)
  put(out, 'metadata', unit.metadata)
  if (unit.position) out.position = toSyncPosition(unit.position)
  return out as unknown as SyncUnitPayload
}

export function toSyncPayload(units: readonly NormalizedUnit[]): SyncUnitPayload[] {
  return units.map(toSyncUnit)
}
