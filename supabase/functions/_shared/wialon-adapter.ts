/**
 * The Wialon adapter.
 *
 * Written against the current official documentation at help.wialon.com/en/api
 * (the older sdk.wialon.com wiki states it is no longer supported and redirects
 * there). The facts this file depends on, all from that source:
 *
 *   Endpoint      {baseUrl}/wialon/ajax.html
 *   Method        POST only, Content-Type: application/x-www-form-urlencoded
 *   Parameters    svc, params (JSON), and sid on everything after login
 *   Login         svc=token/login, params={"token":"…"}; the session id is the
 *                 `eid` field of the response
 *   Session       dies after five minutes without a request
 *   Units         svc=core/search_items with spec.itemsType="avl_unit"
 *   Unit flags    1 general, 1024 last message/location, 2097152 connection
 *                 status (`netconn`), 4194304 location (`pos`)
 *   Position      pos = { t, y, x, z, s, c, sc } — time, lat, lon, altitude,
 *                 speed, course, satellites
 *   History       svc=messages/load_interval { itemId, timeFrom, timeTo, flags,
 *                 flagsMask, loadCount }, released with messages/unload
 *   Message flag  bit 0x01 of `f` means location data is available
 *   Errors        { "error": <code> }
 *
 * Hosts differ per deployment: hst-api.wialon.com for Hosting, regional
 * variants on .eu/.us/.org, and an arbitrary URL for any Wialon Local
 * installation — which is why the base URL is stored per connection rather than
 * compiled in.
 *
 * WHAT THIS ADAPTER DELIBERATELY DOES NOT DO
 *
 * It never reports ignition. Wialon exposes engine state through a configured
 * sensor whose parameter name differs by hardware vendor, and guessing that
 * `io_239` means ignition on somebody's fleet is exactly the invention this
 * module exists to avoid. The capability is not claimed and the value stays
 * unknown.
 *
 * It sends no commands. Wialon supports them; this integration is read-only.
 */

import {
  type GpsCapability,
  type GpsConnectionConfig,
  type GpsProviderAdapter,
  GpsProviderError,
  type NormalizedPosition,
  type NormalizedTrack,
  type NormalizedTrackPoint,
  type NormalizedUnit,
  type ProviderAccount,
  isUsableCoordinate,
  isFiniteNumber,
  normalizeExternalId,
  normalizeHeading,
  normalizeObservedAt,
  normalizeSpeed,
} from './gps-provider.ts'

/** Unit data flags, summed. Documented decimal values, not magic numbers. */
const UNIT_FLAG_GENERAL = 1
const UNIT_FLAG_LAST_MESSAGE = 1024
const UNIT_FLAG_CONNECTION = 2097152
const UNIT_FLAG_POSITION = 4194304

export const UNIT_FLAGS =
  UNIT_FLAG_GENERAL | UNIT_FLAG_LAST_MESSAGE | UNIT_FLAG_CONNECTION | UNIT_FLAG_POSITION

/** Bit 0x01 of a message's `f`: location data is available. */
const MESSAGE_FLAG_HAS_POSITION = 0x01

/**
 * The most devices one synchronisation will take from a provider.
 *
 * Far above any car-rental fleet and far below the point at which one response
 * becomes a memory problem. Anything past it is counted as skipped, which shows
 * up as a partial synchronisation rather than as a silent truncation.
 */
export const MAX_UNITS_PER_SYNC = 10_000

/** Provider strings are stored; a provider that sends a megabyte does not get to. */
function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/**
 * Documented error codes, mapped to what a person can act on.
 *
 * 1 and 1011 mean the session went away — recoverable by logging in again,
 * which the adapter does once rather than looping.
 */
const ERROR_CATEGORIES: Readonly<Record<number, { category: GpsProviderError['category']; message: string; retryable?: boolean }>> = {
  [-100]: { category: 'unreachable', message: 'The tracking provider did not respond in time.', retryable: true },
  [-101]: { category: 'provider_error', message: 'The tracking provider returned something we could not read.', retryable: true },
  1: { category: 'auth_error', message: 'The provider session is no longer valid.', retryable: true },
  2: { category: 'provider_error', message: 'The provider did not recognise that request.' },
  3: { category: 'provider_error', message: 'The provider returned an invalid result.' },
  4: { category: 'malformed_config', message: 'The provider rejected the request as invalid.' },
  5: { category: 'provider_error', message: 'The provider could not carry out the request.', retryable: true },
  6: { category: 'provider_error', message: 'The provider reported an unknown error.', retryable: true },
  7: { category: 'permission_denied', message: 'This provider account is not allowed to do that.' },
  8: { category: 'auth_error', message: 'The access token was rejected.' },
  9: { category: 'unreachable', message: 'The provider authorization server is unavailable.', retryable: true },
  10: { category: 'rate_limited', message: 'The provider is limiting how many requests we may make.', retryable: true },
  1001: { category: 'not_found', message: 'The provider has no messages for that period.' },
  1003: { category: 'rate_limited', message: 'The provider allows only one request of this kind at a time.', retryable: true },
  1004: { category: 'provider_error', message: 'That period holds more history than the provider will return at once.' },
  1005: { category: 'provider_error', message: 'The provider took too long and gave up on that request.', retryable: true },
  1011: { category: 'auth_error', message: 'The provider session expired or the address it was opened from changed.', retryable: true },
}

function toProviderError(code: number): GpsProviderError {
  const known = ERROR_CATEGORIES[code]
  if (known) {
    return new GpsProviderError(known.category, known.message, String(code), known.retryable ?? false)
  }
  return new GpsProviderError(
    'provider_error',
    'The tracking provider reported an error.',
    String(code),
  )
}

export interface WialonAdapterOptions {
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

interface WialonSession {
  readonly sid: string
  readonly host: string
  readonly accountLabel?: string
  openedAt: number
}

/** Wialon kills an idle session after five minutes; re-use inside four. */
const SESSION_REUSE_MS = 4 * 60 * 1000

/**
 * Wialon's `netconn`, which is a number.
 *
 * The field arrives with unit flag 2097152 and is documented as 1 when the unit
 * has a live connection and 0 when it does not — an integer, not a JSON boolean.
 * An earlier version of this adapter accepted only `typeof === 'boolean'`, so
 * every real unit fell through to `undefined` and provider connectivity — one of
 * the three facts this whole module reports separately — read "not reported" for
 * the entire fleet, permanently, with nothing anywhere to say why.
 *
 * Both shapes are accepted now. Anything else stays unknown rather than being
 * coerced: `Boolean(2)` is `true` and would be a guess about a value we do not
 * understand, which is exactly what this module refuses to do everywhere else.
 */
export function normalizeConnectionState(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string' && (value === '0' || value === '1')) return value === '1'
  return undefined
}

export class WialonAdapter implements GpsProviderAdapter {
  readonly provider = 'wialon'

  /**
   * What Wialon can do at all. Ignition is absent on purpose — see the note at
   * the top of this file. Absence means unknown, and the interface says so.
   */
  readonly capabilities: readonly GpsCapability[] = [
    'position',
    'speed',
    'heading',
    'altitude',
    'satellites',
    'connectivity',
    'history',
  ]

  private session: WialonSession | null = null
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly config: GpsConnectionConfig,
    options: WialonAdapterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => Date.now())

    if (!/^https:\/\//i.test(config.baseUrl)) {
      throw new GpsProviderError(
        'malformed_config',
        'The provider address has to be an https:// URL.',
      )
    }
  }

  private get endpoint(): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/wialon/ajax.html`
  }

  /**
   * One provider request.
   *
   * `params` is passed as a pre-built JSON string so an identifier that would
   * lose precision as a JavaScript number can be placed into it verbatim.
   */
  private async call<T>(svc: string, paramsJson: string, sid?: string): Promise<T> {
    const body = new URLSearchParams()
    body.set('svc', svc)
    body.set('params', paramsJson)
    if (sid) body.set('sid', sid)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
        /*
         * THE TOKEN NEVER FOLLOWS A REDIRECT.
         *
         * `fetch` follows redirects by default, and a 307 or 308 preserves both
         * the method and the body — so a provider host answering with one would
         * have this code POST the agency's credential to whatever address it
         * named. A compromised host, a mis-configured reverse proxy in front of
         * a Wialon Local install, or a hijacked route is enough; nothing about
         * the request would look wrong from here.
         *
         * The credential goes to the host the agency configured, or nowhere. A
         * provider that genuinely moves is a change to the configured address,
         * made by an administrator who meant it.
         */
        redirect: 'error',
      })
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError'
      const redirected =
        cause instanceof TypeError && /redirect/i.test(cause.message)

      throw new GpsProviderError(
        redirected ? 'malformed_config' : 'unreachable',
        aborted ? 'The tracking provider did not respond in time.'
        : redirected ?
          'The provider address redirected elsewhere. Set the address it should be, rather than one that forwards.'
        : 'The tracking provider could not be reached.',
        undefined,
        !redirected,
      )
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 429) {
      throw new GpsProviderError(
        'rate_limited',
        'The tracking provider is limiting how many requests we may make.',
        '429',
        true,
      )
    }
    if (!response.ok) {
      throw new GpsProviderError(
        response.status >= 500 ? 'unreachable' : 'provider_error',
        'The tracking provider returned an unexpected response.',
        String(response.status),
        response.status >= 500,
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new GpsProviderError(
        'provider_error',
        'The tracking provider returned something we could not read.',
      )
    }

    // Wialon signals failure in the body, not the status code.
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const code = Number(payload.error)
      if (code !== 0) throw toProviderError(code)
    }

    return payload as T
  }

  /** Logs in, or re-uses a session that is still comfortably inside its life. */
  private async ensureSession(): Promise<WialonSession> {
    if (this.session && this.now() - this.session.openedAt < SESSION_REUSE_MS) {
      return this.session
    }

    const login = await this.call<{
      eid?: string
      user?: { nm?: string }
      host?: string
    }>('token/login', JSON.stringify({ token: this.config.token }))

    if (!login?.eid || typeof login.eid !== 'string') {
      throw new GpsProviderError(
        'auth_error',
        'The provider accepted the request but returned no session.',
      )
    }

    this.session = {
      sid: login.eid,
      host: typeof login.host === 'string' && login.host !== '' ? login.host : this.config.baseUrl,
      // The account's display name. Never the token, and never the whole user.
      ...(typeof login.user?.nm === 'string' ? { accountLabel: login.user.nm } : {}),
      openedAt: this.now(),
    }

    return this.session
  }

  /**
   * Runs a call, and retries exactly once if the session had died.
   *
   * Once, not in a loop: a token that has been revoked would otherwise turn a
   * stale session into an infinite login storm against the provider.
   */
  private async withSession<T>(run: (sid: string) => Promise<T>): Promise<T> {
    const session = await this.ensureSession()
    try {
      return await run(session.sid)
    } catch (error) {
      const expired =
        error instanceof GpsProviderError &&
        error.category === 'auth_error' &&
        (error.providerCode === '1' || error.providerCode === '1011')

      if (!expired) throw error

      this.session = null
      const renewed = await this.ensureSession()
      return run(renewed.sid)
    }
  }

  async testConnection(): Promise<ProviderAccount> {
    const session = await this.ensureSession()
    const result = await this.searchUnits(session.sid)

    return {
      ...(session.accountLabel ? { accountLabel: session.accountLabel } : {}),
      unitCount: result.totalItemsCount ?? result.items?.length ?? 0,
      host: session.host,
      capabilities: this.capabilities,
    }
  }

  private searchUnits(sid: string): Promise<{
    totalItemsCount?: number
    items?: unknown[]
  }> {
    return this.call(
      'core/search_items',
      JSON.stringify({
        spec: {
          itemsType: 'avl_unit',
          propName: 'sys_name',
          propValueMask: '*',
          sortType: 'sys_name',
          propType: 'property',
        },
        force: 1,
        flags: UNIT_FLAGS,
        from: 0,
        to: 0,
      }),
      sid,
    )
  }

  async listUnits(): Promise<{ units: NormalizedUnit[]; skipped: number; account: ProviderAccount }> {
    const session = await this.ensureSession()
    const result = await this.withSession((sid) => this.searchUnits(sid))

    const units: NormalizedUnit[] = []
    let skipped = 0

    /*
     * A ceiling on what one answer may contain.
     *
     * The provider is not adversarial by assumption, but it is not ours either,
     * and a single response is turned into one JSON document and handed to
     * Postgres. Ten thousand devices is far beyond any rental fleet and small
     * enough that a broken or hostile answer cannot exhaust the function's
     * memory. What is dropped is counted and reported as skipped, so the
     * connection reads "partial" rather than "healthy".
     */
    const items = result.items ?? []
    const considered = items.slice(0, MAX_UNITS_PER_SYNC)
    skipped += items.length - considered.length

    for (const raw of considered) {
      /*
       * One malformed device does not cost us the other two hundred. Wialon
       * returns the whole fleet in a single response, and a unit with a
       * corrupt record would otherwise blank the entire map.
       */
      try {
        const unit = this.normalizeUnit(raw)
        if (unit) units.push(unit)
        else skipped += 1
      } catch {
        skipped += 1
      }
    }

    return {
      units,
      skipped,
      account: {
        ...(session.accountLabel ? { accountLabel: session.accountLabel } : {}),
        unitCount: result.totalItemsCount ?? units.length,
        host: session.host,
        capabilities: this.capabilities,
      },
    }
  }

  /** One provider unit, or null when it carries no usable identity. */
  private normalizeUnit(raw: unknown): NormalizedUnit | null {
    if (!raw || typeof raw !== 'object') return null
    const unit = raw as Record<string, unknown>

    const externalId = normalizeExternalId(unit.id)
    if (!externalId) return null

    const name = boundedText(unit.nm, 200) ?? externalId

    const capabilities = new Set<GpsCapability>(['history'])
    const position = this.normalizePosition(unit, capabilities)

    const deviceUid = boundedText(unit.uid, 120)
    // Only a scalar becomes a hardware label. Wialon's `hw` is documented as a
    // hardware type, but an unexpected object here would stringify to
    // "[object Object]" and be stored as if it meant something.
    const hardware =
      typeof unit.hw === 'number' ? String(unit.hw) : boundedText(unit.hw, 120)

    return {
      externalId,
      name,
      ...(deviceUid ? { deviceUid } : {}),
      ...(hardware ? { hardware } : {}),
      capabilities: [...capabilities],
      ...(position ? { position } : {}),
      // Deliberately tiny. Never the provider response, never anything secret.
      metadata: { cls: typeof unit.cls === 'number' ? unit.cls : undefined },
    }
  }

  private normalizePosition(
    unit: Record<string, unknown>,
    capabilities: Set<GpsCapability>,
  ): NormalizedPosition | undefined {
    const netconn = normalizeConnectionState(unit.netconn)
    if (netconn !== undefined) capabilities.add('connectivity')

    const pos = unit.pos
    if (!pos || typeof pos !== 'object') {
      // No fix, but connectivity may still be known — that is a real state and
      // not the same as "no information at all".
      return undefined
    }

    const p = pos as Record<string, unknown>
    const observedAt = normalizeObservedAt(p.t, this.now())
    if (!observedAt) return undefined

    const usable = isUsableCoordinate(p.y, p.x)
    if (usable) capabilities.add('position')

    const speedKph = normalizeSpeed(p.s)
    if (speedKph !== undefined) capabilities.add('speed')

    const headingDeg = normalizeHeading(p.c)
    if (headingDeg !== undefined) capabilities.add('heading')

    const altitudeM = isFiniteNumber(p.z) && p.z >= -1000 && p.z <= 20000 ? p.z : undefined
    if (altitudeM !== undefined) capabilities.add('altitude')

    const satellites = isFiniteNumber(p.sc) && p.sc >= 0 && p.sc <= 64 ? Math.trunc(p.sc) : undefined
    if (satellites !== undefined) capabilities.add('satellites')

    return {
      observedAt,
      ...(usable ? { latitude: p.y as number, longitude: p.x as number } : {}),
      // Wialon gives us a position block or it does not; a coordinate outside
      // the valid range is the provider telling us the fix is unusable.
      positionValid: usable,
      ...(speedKph !== undefined ? { speedKph } : {}),
      ...(headingDeg !== undefined ? { headingDeg } : {}),
      ...(altitudeM !== undefined ? { altitudeM } : {}),
      ...(satellites !== undefined ? { satellites } : {}),
      /*
       * Movement follows directly from a reported speed. It is a reading, not
       * an inference about journeys — and when speed is unknown, so is this.
       */
      ...(speedKph !== undefined
        ? { movement: speedKph > 0 ? ('moving' as const) : ('stopped' as const) }
        : {}),
      ...(netconn !== undefined ? { providerOnline: netconn } : {}),
      // Ignition, odometer and engine hours are sensor-derived and
      // hardware-specific. Not claimed, not guessed.
    }
  }

  async fetchTrack(
    externalId: string,
    from: Date,
    to: Date,
    maxPoints: number,
  ): Promise<NormalizedTrack> {
    const timeFrom = Math.floor(from.getTime() / 1000)
    const timeTo = Math.floor(to.getTime() / 1000)

    if (!(timeTo > timeFrom)) {
      throw new GpsProviderError('malformed_config', 'The period has to end after it starts.')
    }

    /*
     * `itemId` is built into the JSON as a literal so an identifier larger than
     * JavaScript can hold exactly is still sent exactly. Only digits are
     * allowed through, so nothing else can be injected into the document.
     */
    if (!/^\d+$/.test(externalId)) {
      throw new GpsProviderError(
        'malformed_config',
        'That device identifier is not one this provider recognises.',
      )
    }

    const params =
      `{"itemId":${externalId},"timeFrom":${timeFrom},"timeTo":${timeTo},` +
      `"flags":0,"flagsMask":0,"loadCount":${Math.max(1, Math.min(maxPoints, 100000))}}`

    let payload: { count?: number; messages?: unknown[] }
    try {
      payload = await this.withSession((sid) => this.call('messages/load_interval', params, sid))
    } catch (error) {
      // "No messages for this interval" is an answer, not a failure.
      if (error instanceof GpsProviderError && error.category === 'not_found') {
        return {
          points: [],
          totalPoints: 0,
          truncated: false,
          from: from.toISOString(),
          to: to.toISOString(),
        }
      }
      throw error
    } finally {
      // Release the message layer the provider opened for us, whatever
      // happened. A failure here must not mask the real result.
      try {
        await this.withSession((sid) => this.call('messages/unload', '{}', sid))
      } catch {
        /* the session will expire on its own within five minutes */
      }
    }

    const points: NormalizedTrackPoint[] = []
    for (const raw of payload.messages ?? []) {
      const point = this.normalizeTrackPoint(raw)
      if (point) points.push(point)
    }

    points.sort((a, b) => a.observedAt.localeCompare(b.observedAt))

    return {
      points,
      totalPoints: payload.count ?? points.length,
      truncated: (payload.count ?? points.length) > points.length,
      from: from.toISOString(),
      to: to.toISOString(),
    }
  }

  private normalizeTrackPoint(raw: unknown): NormalizedTrackPoint | null {
    if (!raw || typeof raw !== 'object') return null
    const message = raw as Record<string, unknown>

    // Bit 0x01 of `f` is the provider saying this message carries a location.
    const flags = isFiniteNumber(message.f) ? message.f : 0
    if ((flags & MESSAGE_FLAG_HAS_POSITION) === 0) return null

    const pos = message.pos
    if (!pos || typeof pos !== 'object') return null
    const p = pos as Record<string, unknown>

    if (!isUsableCoordinate(p.y, p.x)) return null

    const observedAt = normalizeObservedAt(message.t, this.now())
    if (!observedAt) return null

    const speedKph = normalizeSpeed(p.s)
    const headingDeg = normalizeHeading(p.c)
    const altitudeM = isFiniteNumber(p.z) ? p.z : undefined
    const satellites = isFiniteNumber(p.sc) ? Math.trunc(p.sc) : undefined

    return {
      observedAt,
      latitude: p.y as number,
      longitude: p.x as number,
      ...(speedKph !== undefined ? { speedKph } : {}),
      ...(headingDeg !== undefined ? { headingDeg } : {}),
      ...(altitudeM !== undefined ? { altitudeM } : {}),
      ...(satellites !== undefined ? { satellites } : {}),
    }
  }

  async close(): Promise<void> {
    if (!this.session) return
    const sid = this.session.sid
    this.session = null
    try {
      await this.call('core/logout', '{}', sid)
    } catch {
      /* the provider expires idle sessions by itself */
    }
  }
}
