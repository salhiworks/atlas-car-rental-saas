// @vitest-environment node
/**
 * The provider contract, and the Wialon adapter that first implements it.
 *
 * No Wialon credential was available while this was written, so these are
 * deterministic tests against fixtures built from the documented response
 * shapes at help.wialon.com/en/api — the request the adapter constructs, the
 * fields it reads, the error codes it maps. They prove the adapter matches the
 * documentation; they do not prove the documentation matches the running
 * service, and the report says so.
 *
 * The contract half matters more than the Wialon half. Everything asserted in
 * "the contract every adapter meets" is what a future Traccar adapter will be
 * held to, and the reason a second provider should be an afternoon rather than
 * a rewrite.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  GpsProviderError,
  isUsableCoordinate,
  normalizeExternalId,
  normalizeHeading,
  normalizeObservedAt,
  normalizeSpeed,
} from '../functions/_shared/gps-provider.ts'
import {
  MAX_UNITS_PER_SYNC,
  UNIT_FLAGS,
  WialonAdapter,
  normalizeConnectionState,
} from '../functions/_shared/wialon-adapter.ts'

const BASE_URL = 'https://hst-api.wialon.com'
const TOKEN = 'a'.repeat(72)
const NOW = Date.parse('2032-06-01T12:00:00Z')

/** Either a literal payload or a thunk producing one, per call. */
type Scripted = unknown

function bodyOf(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
}

function urlOf(url: string | URL | Request): string {
  if (typeof url === 'string') return url
  if (url instanceof URL) return url.href
  return url.url
}

/** A fetch double that records what was asked and answers from a script. */
function stubFetch(responses: Scripted[]) {
  const calls: Array<{
    url: string
    body: URLSearchParams
    headers: Record<string, string> | undefined
  }> = []
  let index = 0

  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: urlOf(url),
      body: bodyOf(init),
      headers: init?.headers as Record<string, string> | undefined,
    })

    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    const value = typeof next === 'function' ? (next as () => unknown)() : next

    if (value instanceof Error) return Promise.reject(value)
    if (value instanceof Response) return Promise.resolve(value)

    return Promise.resolve(
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  return { impl: impl as unknown as typeof fetch, calls }
}

/** The documented shape of a `core/search_items` request. */
interface SearchItemsParams {
  spec: {
    itemsType: string
    propName: string
    propValueMask: string
    sortType: string
    propType: string
  }
  force: number
  flags: number
  from: number
  to: number
}

/** The documented shape of a `messages/load_interval` request. */
interface LoadIntervalParams {
  itemId: number
  timeFrom: number
  timeTo: number
  flags: number
  flagsMask: number
  loadCount: number
}

function paramsOf<T>(call: { body: URLSearchParams }): T {
  return JSON.parse(call.body.get('params') ?? '{}') as T
}

function adapterWith(responses: Scripted[], token = TOKEN) {
  const { impl, calls } = stubFetch(responses)
  const adapter = new WialonAdapter(
    { baseUrl: BASE_URL, token },
    { fetchImpl: impl, now: () => NOW, timeoutMs: 50 },
  )
  return { adapter, calls, impl }
}

const LOGIN_OK = { eid: 'session-abc123', user: { nm: 'atlas-rental' }, host: 'hst-api.wialon.com' }

/** One unit, shaped exactly as the documentation describes. */
function unitFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 400000000000001,
    nm: 'Dacia Duster 11-A-11111',
    cls: 2,
    uid: '861234567890123',
    hw: 'Teltonika FMB920',
    netconn: true,
    pos: {
      t: Math.floor((NOW - 60_000) / 1000),
      y: 33.5731,
      x: -7.5898,
      z: 45,
      s: 62,
      c: 187,
      sc: 11,
    },
    ...overrides,
  }
}

// -----------------------------------------------------------------------------
// The contract every adapter meets
// -----------------------------------------------------------------------------

describe('the contract every adapter meets', () => {
  it('keeps an external identifier losslessly, as text', () => {
    // Wialon's documented ids sit around 4×10^14, comfortably inside the range a
    // double represents exactly, and are carried verbatim.
    expect(normalizeExternalId('400000000000001')).toBe('400000000000001')
    expect(normalizeExternalId(400000000000001)).toBe('400000000000001')
    expect(normalizeExternalId('  42  ')).toBe('42')
    // A provider that issues something longer has to send it as text, and then
    // there is no upper bound at all.
    expect(normalizeExternalId('920071992547409931')).toBe('920071992547409931')
    expect(normalizeExternalId(9007199254740993n)).toBe('9007199254740993')

    expect(normalizeExternalId('')).toBeUndefined()
    expect(normalizeExternalId(null)).toBeUndefined()
    expect(normalizeExternalId(1.5)).toBeUndefined()
  })

  it('refuses a numeric identifier that a JSON parse has already rounded', () => {
    /*
     * `JSON.parse` has no integer type, so a provider id above 2^53 arrives
     * ALREADY altered: 9007199254740993 is 9007199254740992 by the time any code
     * here sees it. Accepting it would store a device under an identifier that
     * belongs to a different device, and from then on one vehicle would quietly
     * collect another's positions.
     *
     * Refusing is the only honest answer: the unit is skipped and counted, which
     * somebody can see, rather than mis-attributed, which nobody can.
     */
    // Written as an expression rather than a literal: the literal itself would
    // be rounded by the compiler, which is the very thing being tested.
    expect(normalizeExternalId(2 ** 53 + 2)).toBeUndefined()
    expect(normalizeExternalId(2 ** 53)).toBeUndefined()
    expect(normalizeExternalId(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991')
  })

  it('reads Wialon connection state, which is a number and not a boolean', () => {
    /*
     * Regression. `netconn` arrives with unit flag 2097152 as 1 or 0. An earlier
     * version accepted only `typeof === 'boolean'`, so provider connectivity —
     * one of the three facts this module keeps separate — read "not reported"
     * for every unit in every fleet, permanently and silently.
     */
    expect(normalizeConnectionState(1)).toBe(true)
    expect(normalizeConnectionState(0)).toBe(false)
    expect(normalizeConnectionState('1')).toBe(true)
    expect(normalizeConnectionState('0')).toBe(false)
    expect(normalizeConnectionState(true)).toBe(true)
    expect(normalizeConnectionState(false)).toBe(false)

    // And a value we do not understand stays unknown rather than being coerced:
    // Boolean(2) is true, and that would be a guess.
    expect(normalizeConnectionState(2)).toBeUndefined()
    expect(normalizeConnectionState(null)).toBeUndefined()
    expect(normalizeConnectionState(undefined)).toBeUndefined()
    expect(normalizeConnectionState('yes')).toBeUndefined()
  })

  it('accepts every coordinate the world has and rejects the rest', () => {
    expect(isUsableCoordinate(33.5731, -7.5898)).toBe(true)
    expect(isUsableCoordinate(-90, 180)).toBe(true)
    expect(isUsableCoordinate(90, -180)).toBe(true)
    // Null Island is a real place. Whether a fix there is valid is the
    // provider's call, carried separately — not a blanket rule that would throw
    // away real positions off the coast of Ghana.
    expect(isUsableCoordinate(0, 0)).toBe(true)

    expect(isUsableCoordinate(91, 0)).toBe(false)
    expect(isUsableCoordinate(0, 181)).toBe(false)
    expect(isUsableCoordinate(Number.NaN, 0)).toBe(false)
    expect(isUsableCoordinate('33.5', -7.5)).toBe(false)
    expect(isUsableCoordinate(undefined, undefined)).toBe(false)
  })

  it('refuses a timestamp from the future beyond ordinary clock skew', () => {
    // A device whose clock is wrong would otherwise look fresh forever.
    expect(normalizeObservedAt(NOW / 1000 - 60, NOW)).toBe('2032-06-01T11:59:00.000Z')
    expect(normalizeObservedAt(NOW / 1000 + 60, NOW)).toBe('2032-06-01T12:01:00.000Z')
    expect(normalizeObservedAt(NOW / 1000 + 3600, NOW)).toBeUndefined()
  })

  it('refuses a timestamp so old it cannot be a current position', () => {
    expect(normalizeObservedAt(NOW / 1000 - 500 * 86400, NOW)).toBeUndefined()
    expect(normalizeObservedAt(0, NOW)).toBeUndefined()
    expect(normalizeObservedAt(-1, NOW)).toBeUndefined()
    expect(normalizeObservedAt('yesterday', NOW)).toBeUndefined()
  })

  it('leaves unknown telemetry undefined rather than zero', () => {
    expect(normalizeSpeed(undefined)).toBeUndefined()
    expect(normalizeSpeed(null)).toBeUndefined()
    expect(normalizeSpeed(Number.NaN)).toBeUndefined()
    // A genuine zero survives as a zero: the car is stopped, which is a fact.
    expect(normalizeSpeed(0)).toBe(0)
    expect(normalizeSpeed(-5)).toBeUndefined()
    expect(normalizeSpeed(5000)).toBeUndefined()
  })

  it('wraps a heading into the compass rather than discarding it', () => {
    expect(normalizeHeading(0)).toBe(0)
    expect(normalizeHeading(359)).toBe(359)
    // Providers report due north as 360.
    expect(normalizeHeading(360)).toBe(0)
    expect(normalizeHeading(-90)).toBe(270)
    expect(normalizeHeading(undefined)).toBeUndefined()
  })
})

// -----------------------------------------------------------------------------
// The request Wialon actually receives
// -----------------------------------------------------------------------------

describe('the request the Wialon adapter constructs', () => {
  it('posts form-encoded to the documented endpoint', async () => {
    const { adapter, calls } = adapterWith([LOGIN_OK, { totalItemsCount: 0, items: [] }])
    await adapter.testConnection()

    expect(calls[0]!.url).toBe('https://hst-api.wialon.com/wialon/ajax.html')
    expect(calls[0]!.body.get('svc')).toBe('token/login')
    expect(JSON.parse(calls[0]!.body.get('params')!)).toEqual({ token: TOKEN })
    // The documentation is explicit: POST only, form-encoded.
    expect(calls[0]!.headers?.['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
  })

  it('uses the account’s own server rather than a compiled-in one', async () => {
    const { impl, calls } = stubFetch([LOGIN_OK, { totalItemsCount: 0, items: [] }])
    const local = new WialonAdapter(
      { baseUrl: 'https://gps.agency.example.com/wialon-local', token: TOKEN },
      { fetchImpl: impl, now: () => NOW },
    )
    await local.testConnection()

    // Wialon Local installations and the regional hosting servers are all
    // different addresses; hard-coding hst-api would lock most of them out.
    expect(calls[0]!.url).toBe('https://gps.agency.example.com/wialon-local/wialon/ajax.html')
  })

  it('refuses a configuration that is not https', () => {
    expect(
      () => new WialonAdapter({ baseUrl: 'http://hst-api.wialon.com', token: TOKEN }),
    ).toThrowError(/https/i)
  })

  it('carries the session id on every request after login', async () => {
    const { adapter, calls } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [unitFixture()] }])
    await adapter.listUnits()

    expect(calls[0]!.body.get('sid')).toBeNull()
    expect(calls[1]!.body.get('sid')).toBe('session-abc123')
    expect(calls[1]!.body.get('svc')).toBe('core/search_items')
  })

  it('asks for the whole fleet in one request, with the documented flags', async () => {
    const { adapter, calls } = adapterWith([LOGIN_OK, { totalItemsCount: 3, items: [] }])
    await adapter.listUnits()

    const params = paramsOf<SearchItemsParams>(calls[1]!)
    expect(params.spec.itemsType).toBe('avl_unit')
    expect(params.spec.propName).toBe('sys_name')
    expect(params.spec.propValueMask).toBe('*')
    expect(params.from).toBe(0)
    expect(params.to).toBe(0)
    // 1 general + 1024 last message + 2097152 connection + 4194304 location.
    // One call returns every device with its position; no request per marker.
    expect(params.flags).toBe(UNIT_FLAGS)
    expect(UNIT_FLAGS).toBe(1 + 1024 + 2097152 + 4194304)
  })

  it('never puts the token anywhere but the login body', async () => {
    const { adapter, calls } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [unitFixture()] }])
    const result = await adapter.listUnits()

    for (const call of calls.slice(1)) {
      expect(call.url).not.toContain(TOKEN)
      expect(call.body.toString()).not.toContain(TOKEN)
    }
    // And nothing the adapter returns carries it either.
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('logs in once and re-uses the session', async () => {
    const { adapter, calls } = adapterWith([
      LOGIN_OK,
      { totalItemsCount: 1, items: [unitFixture()] },
      { totalItemsCount: 1, items: [unitFixture()] },
    ])

    await adapter.listUnits()
    await adapter.listUnits()

    // Wialon kills an idle session after five minutes; re-authenticating for
    // every refresh would be pointless churn against the provider.
    expect(calls.filter((call) => call.body.get('svc') === 'token/login')).toHaveLength(1)
  })
})

// -----------------------------------------------------------------------------
// Normalisation
// -----------------------------------------------------------------------------

describe('normalising a Wialon unit', () => {
  it('reads the documented position fields into canonical units', async () => {
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [unitFixture()] }])
    const { units } = await adapter.listUnits()

    expect(units).toHaveLength(1)
    const unit = units[0]!

    expect(unit.externalId).toBe('400000000000001')
    expect(unit.name).toBe('Dacia Duster 11-A-11111')
    expect(unit.deviceUid).toBe('861234567890123')

    const position = unit.position!
    expect(position.observedAt).toBe('2032-06-01T11:59:00.000Z')
    expect(position.latitude).toBeCloseTo(33.5731)
    expect(position.longitude).toBeCloseTo(-7.5898)
    expect(position.speedKph).toBe(62)
    expect(position.headingDeg).toBe(187)
    expect(position.altitudeM).toBe(45)
    expect(position.satellites).toBe(11)
    expect(position.providerOnline).toBe(true)
    expect(position.movement).toBe('moving')
  })

  it('claims only the capabilities the device actually demonstrated', async () => {
    const sparse = unitFixture({
      netconn: undefined,
      pos: { t: Math.floor((NOW - 60_000) / 1000), y: 33.5, x: -7.5 },
    })
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [sparse] }])
    const { units } = await adapter.listUnits()

    const unit = units[0]!
    expect(unit.capabilities).toContain('position')
    expect(unit.capabilities).toContain('history')
    // No speed reported, so no speed capability — and the value is absent
    // rather than zero.
    expect(unit.capabilities).not.toContain('speed')
    expect(unit.capabilities).not.toContain('connectivity')
    expect(unit.position!.speedKph).toBeUndefined()
    expect(unit.position!.providerOnline).toBeUndefined()
    expect(unit.position!.movement).toBeUndefined()
  })

  it('never claims to know the ignition state', async () => {
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [unitFixture()] }])
    const { units } = await adapter.listUnits()

    /*
     * Wialon exposes engine state through a configured sensor whose parameter
     * name differs by hardware vendor. Guessing that some `io_239` means
     * ignition on somebody's fleet is exactly the invention this module exists
     * to avoid, so the capability is not claimed and the value stays unknown.
     */
    expect(units[0]!.capabilities).not.toContain('ignition')
    expect(units[0]!.position!.ignition).toBeUndefined()
  })

  it('reads a stopped vehicle as stopped, not as unknown', async () => {
    const stopped = unitFixture({ pos: { ...unitFixture().pos, s: 0 } })
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [stopped] }])
    const { units } = await adapter.listUnits()

    expect(units[0]!.position!.speedKph).toBe(0)
    expect(units[0]!.position!.movement).toBe('stopped')
  })

  it('marks an out-of-range coordinate as an unusable fix, keeping the device', async () => {
    const broken = unitFixture({ pos: { ...unitFixture().pos, y: 199.5, x: 400 } })
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [broken] }])
    const { units } = await adapter.listUnits()

    expect(units).toHaveLength(1)
    expect(units[0]!.position!.positionValid).toBe(false)
    expect(units[0]!.position!.latitude).toBeUndefined()
    expect(units[0]!.capabilities).not.toContain('position')
  })

  it('reports a device with no fix at all rather than dropping it', async () => {
    const noFix = unitFixture({ pos: undefined })
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: 1, items: [noFix] }])
    const { units } = await adapter.listUnits()

    expect(units).toHaveLength(1)
    expect(units[0]!.position).toBeUndefined()
  })

  it('does not let one malformed device cost us the rest of the fleet', async () => {
    const { adapter } = adapterWith([
      LOGIN_OK,
      {
        totalItemsCount: 4,
        items: [
          unitFixture(),
          null,
          { nm: 'no id at all' },
          unitFixture({ id: 400000000000002, nm: 'Second' }),
        ],
      },
    ])

    const { units, skipped } = await adapter.listUnits()

    // Two hundred cars must not vanish from the map because one record is
    // corrupt at the provider.
    expect(units).toHaveLength(2)
    expect(skipped).toBe(2)
    expect(units.map((unit) => unit.externalId)).toEqual([
      '400000000000001',
      '400000000000002',
    ])
  })

  it('falls back to the identifier when a device has no name', async () => {
    const { adapter } = adapterWith([
      LOGIN_OK,
      { totalItemsCount: 1, items: [unitFixture({ nm: '   ' })] },
    ])
    const { units } = await adapter.listUnits()
    expect(units[0]!.name).toBe('400000000000001')
  })

  it('handles a duplicate device without producing two', async () => {
    const { adapter } = adapterWith([
      LOGIN_OK,
      { totalItemsCount: 2, items: [unitFixture(), unitFixture()] },
    ])
    const { units } = await adapter.listUnits()

    // The adapter reports what the provider said; the database's uniqueness on
    // (connection, external_id) is what makes a repeat harmless.
    expect(units).toHaveLength(2)
    expect(new Set(units.map((unit) => unit.externalId)).size).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// History
// -----------------------------------------------------------------------------

describe('fetching a track', () => {
  const message = (offsetSeconds: number, overrides: Record<string, unknown> = {}) => ({
    t: Math.floor(NOW / 1000) - offsetSeconds,
    f: 1,
    pos: { y: 33.5 + offsetSeconds / 100000, x: -7.5, z: 40, s: 50, c: 90, sc: 9 },
    ...overrides,
  })

  it('asks for the documented bounded interval and releases the layer', async () => {
    const { adapter, calls } = adapterWith([
      LOGIN_OK,
      { count: 2, messages: [message(600), message(300)] },
      {},
    ])

    const from = new Date(NOW - 3600_000)
    const to = new Date(NOW)
    await adapter.fetchTrack('400000000000001', from, to, 5000)

    const load = calls.find((call) => call.body.get('svc') === 'messages/load_interval')!
    const params = paramsOf<LoadIntervalParams>(load)
    expect(params.itemId).toBe(400000000000001)
    expect(params.timeFrom).toBe(Math.floor(from.getTime() / 1000))
    expect(params.timeTo).toBe(Math.floor(to.getTime() / 1000))
    expect(params.loadCount).toBe(5000)

    // The provider opened a message layer for us; it gets released.
    expect(calls.some((call) => call.body.get('svc') === 'messages/unload')).toBe(true)
  })

  it('sends a large identifier exactly, without going through a JS number', async () => {
    const huge = '9007199254740993'
    const { adapter, calls } = adapterWith([LOGIN_OK, { count: 0, messages: [] }, {}])
    await adapter.fetchTrack(huge, new Date(NOW - 3600_000), new Date(NOW), 100)

    const load = calls.find((call) => call.body.get('svc') === 'messages/load_interval')!
    // 2^53 + 1. Round-tripping it through Number would have sent 9007199254740992.
    expect(load.body.get('params')).toContain(`"itemId":${huge}`)
  })

  it('refuses an identifier that is not one this provider issues', async () => {
    const { adapter } = adapterWith([LOGIN_OK])
    await expect(
      adapter.fetchTrack("1 or 1=1", new Date(NOW - 1000), new Date(NOW), 100),
    ).rejects.toThrow(/identifier/i)
  })

  it('keeps only the messages that carry a location, in order', async () => {
    const { adapter } = adapterWith([
      LOGIN_OK,
      {
        count: 4,
        messages: [
          message(300),
          // Bit 0x01 clear: the provider is saying this message has no location.
          message(600, { f: 0 }),
          message(900),
          { t: Math.floor(NOW / 1000) - 100, f: 1, pos: { y: 999, x: 0 } },
        ],
      },
      {},
    ])

    const track = await adapter.fetchTrack('1', new Date(NOW - 3600_000), new Date(NOW), 1000)

    expect(track.points).toHaveLength(2)
    expect(track.points[0]!.observedAt < track.points[1]!.observedAt).toBe(true)
    expect(track.totalPoints).toBe(4)
    expect(track.truncated).toBe(true)
  })

  it('treats an empty period as an answer, not a failure', async () => {
    const { adapter } = adapterWith([LOGIN_OK, { error: 1001 }, {}])
    const track = await adapter.fetchTrack('1', new Date(NOW - 3600_000), new Date(NOW), 1000)

    expect(track.points).toEqual([])
    expect(track.totalPoints).toBe(0)
    expect(track.truncated).toBe(false)
  })

  it('refuses a period that ends before it starts', async () => {
    const { adapter } = adapterWith([LOGIN_OK])
    await expect(
      adapter.fetchTrack('1', new Date(NOW), new Date(NOW - 1000), 100),
    ).rejects.toThrow(/end after it starts/i)
  })
})

// -----------------------------------------------------------------------------
// Failure
// -----------------------------------------------------------------------------

describe('when the provider says no', () => {
  const cases: ReadonlyArray<[number, string]> = [
    [8, 'auth_error'],
    [7, 'permission_denied'],
    [10, 'rate_limited'],
    [1003, 'rate_limited'],
    [4, 'malformed_config'],
    [1001, 'not_found'],
    [-100, 'unreachable'],
    [9, 'unreachable'],
    [1005, 'provider_error'],
  ]

  it.each(cases)('maps documented error %i to %s', async (code, category) => {
    const { adapter } = adapterWith([{ error: code }])
    await expect(adapter.testConnection()).rejects.toMatchObject({ category })
  })

  it('maps an unknown code to a provider error rather than crashing', async () => {
    const { adapter } = adapterWith([{ error: 4242 }])
    await expect(adapter.testConnection()).rejects.toMatchObject({
      category: 'provider_error',
      providerCode: '4242',
    })
  })

  it('never puts the provider payload or the token in the message', async () => {
    const { adapter } = adapterWith([{ error: 8, reason: `token ${TOKEN} rejected` }])

    try {
      await adapter.testConnection()
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(GpsProviderError)
      const message = (error as GpsProviderError).message
      expect(message).not.toContain(TOKEN)
      expect(message).not.toContain('reason')
      // A sentence a person can act on, not an opaque payload.
      expect(message).toBe('The access token was rejected.')
    }
  })

  it('renews a dead session exactly once, and does not loop', async () => {
    // Answers by service rather than by turn, so a renewal gets a login reply
    // and not whatever happened to be next in a list.
    let searches = 0
    const logins: string[] = []
    const impl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const svc = bodyOf(init).get('svc')
      if (svc === 'token/login') {
        logins.push('login')
        return Promise.resolve(new Response(JSON.stringify(LOGIN_OK), { status: 200 }))
      }
      searches += 1
      // The first search finds the session already dead.
      const payload = searches === 1 ? { error: 1 } : { totalItemsCount: 1, items: [unitFixture()] }
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    })

    const adapter = new WialonAdapter(
      { baseUrl: BASE_URL, token: TOKEN },
      { fetchImpl: impl as unknown as typeof fetch, now: () => NOW },
    )

    const { units } = await adapter.listUnits()
    expect(units).toHaveLength(1)
    // Two logins: the original, and one renewal after the session expired.
    expect(logins).toHaveLength(2)
  })

  it('gives up rather than storming the provider when the token is revoked', async () => {
    const { adapter, calls } = adapterWith([LOGIN_OK, { error: 1 }, LOGIN_OK, { error: 1 }])
    await expect(adapter.listUnits()).rejects.toMatchObject({ category: 'auth_error' })

    // A revoked token must not turn into an infinite login loop.
    expect(calls.filter((call) => call.body.get('svc') === 'token/login').length).toBeLessThanOrEqual(2)
  })

  it('reports a timeout as unreachable and retryable', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const { adapter } = adapterWith([abort])

    await expect(adapter.testConnection()).rejects.toMatchObject({
      category: 'unreachable',
      retryable: true,
    })
  })

  it('reports an HTTP 429 as rate limited', async () => {
    const { adapter } = adapterWith([new Response('', { status: 429 })])
    await expect(adapter.testConnection()).rejects.toMatchObject({ category: 'rate_limited' })
  })

  it('reports a body it cannot read as a provider error', async () => {
    const { adapter } = adapterWith([
      new Response('<html>gateway</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    ])
    await expect(adapter.testConnection()).rejects.toMatchObject({ category: 'provider_error' })
  })

  it('reports a login that returns no session as an auth failure', async () => {
    const { adapter } = adapterWith([{ user: { nm: 'someone' } }])
    await expect(adapter.testConnection()).rejects.toMatchObject({ category: 'auth_error' })
  })
})

describe('a successful connection test', () => {
  it('returns what is safe to show and nothing else', async () => {
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: 17, items: [] }])
    const account = await adapter.testConnection()

    expect(account.accountLabel).toBe('atlas-rental')
    expect(account.unitCount).toBe(17)
    expect(account.host).toBe('hst-api.wialon.com')
    expect(account.capabilities).toContain('position')
    // Never claimed, so a screen cannot draw a confident ignition widget.
    expect(account.capabilities).not.toContain('ignition')
    expect(JSON.stringify(account)).not.toContain(TOKEN)
  })
})
describe('a provider that misbehaves', () => {
  it('never follows a redirect, so a token cannot be forwarded elsewhere', async () => {
    /*
     * The path this closes: a provider host — compromised, hijacked, or sitting
     * behind somebody's mis-configured reverse proxy — answers the login POST
     * with a 307. `fetch` follows it by default, and a 307 preserves the method
     * AND the body, so the agency's credential would be POSTed to whatever
     * address the redirect named. Nothing about the request would look wrong.
     */
    const seen: Array<RequestInit | undefined> = []
    const impl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init)
      // What Deno/undici raise when redirect: 'error' meets a 3xx.
      return Promise.reject(new TypeError('fetch failed: redirect mode is set to error'))
    })

    const adapter = new WialonAdapter(
      { baseUrl: BASE_URL, token: TOKEN },
      { fetchImpl: impl as unknown as typeof fetch, now: () => NOW },
    )

    await expect(adapter.listUnits()).rejects.toThrow(/redirect/i)
    expect(seen[0]?.redirect).toBe('error')

    // And the failure is a configuration problem, not a transient one: retrying
    // would just offer the token again.
    try {
      await adapter.listUnits()
    } catch (error) {
      expect((error as GpsProviderError).category).toBe('malformed_config')
      expect((error as GpsProviderError).retryable).toBe(false)
      expect((error as GpsProviderError).message).not.toContain(TOKEN)
    }
  })

  it('caps how many devices one answer may contain', async () => {
    // A response is turned into one JSON document and handed to Postgres. A
    // provider returning a million units must not be able to exhaust the
    // function; what is dropped is counted, so the sync reads partial.
    const items = Array.from({ length: MAX_UNITS_PER_SYNC + 25 }, (_, index) =>
      unitFixture({ id: 400000000000000 + index }),
    )
    const { adapter } = adapterWith([LOGIN_OK, { totalItemsCount: items.length, items }])
    const result = await adapter.listUnits()

    expect(result.units.length).toBeLessThanOrEqual(MAX_UNITS_PER_SYNC)
    expect(result.skipped).toBeGreaterThanOrEqual(25)
  })

  it('bounds the strings a provider can put in our tables', async () => {
    const { adapter } = adapterWith([
      LOGIN_OK,
      {
        totalItemsCount: 1,
        items: [
          unitFixture({
            nm: 'N'.repeat(50_000),
            uid: 'U'.repeat(50_000),
            hw: 'H'.repeat(50_000),
          }),
        ],
      },
    ])
    const { units } = await adapter.listUnits()

    expect(units[0]!.name.length).toBeLessThanOrEqual(200)
    expect(units[0]!.deviceUid!.length).toBeLessThanOrEqual(120)
    expect(units[0]!.hardware!.length).toBeLessThanOrEqual(120)
  })

  it('does not accept an object where a hardware label belongs', () => {
    // `String({})` is "[object Object]", which would be stored and displayed as
    // if it meant something.
    const { adapter } = adapterWith([
      LOGIN_OK,
      { totalItemsCount: 1, items: [unitFixture({ hw: { model: 'x' } })] },
    ])
    return adapter.listUnits().then(({ units }) => {
      expect(units[0]!.hardware).toBeUndefined()
    })
  })
})

