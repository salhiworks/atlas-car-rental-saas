// @vitest-environment node
/**
 * The seam between the adapter and the database.
 *
 * This suite exists because of a defect that both of the other two suites were
 * structurally unable to see. `gps-adapter.test.ts` proved the Wialon adapter
 * normalises a provider payload correctly. `gps.test.ts` proved
 * `public.gps_apply_sync` stores a normalised payload correctly. Each was right
 * about its own half — and they disagreed about the shape in between, because
 * TypeScript writes `externalId` and SQL reads `external_id`.
 *
 * Nothing failed. `v_unit ->> 'external_id'` simply returned NULL for every
 * field, on every device, forever. Live verification against the real project
 * caught it; two green suites did not.
 *
 * So the test here is deliberately end-to-end within the seam: a real Wialon
 * response goes through the real adapter, through the real translation the Edge
 * Function uses, into the real SQL function running on real Postgres, and the
 * assertions are about the rows that come out the other side. Nothing in the
 * middle is stubbed, because the middle is exactly where the bug lived.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { toSyncPayload, toSyncUnit } from '../functions/_shared/gps-provider.ts'
import { WialonAdapter } from '../functions/_shared/wialon-adapter.ts'

import { TestDatabase, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let connectionId: string

const BASE_URL = 'https://hst-api.wialon.com'
const TOKEN = 'c'.repeat(72)
const NOW = Date.parse('2032-06-01T12:00:00Z')

/**
 * Answers by service name, so the order of calls does not matter.
 *
 * Values may be pre-serialised JSON text. A Wialon unit id can exceed
 * `Number.MAX_SAFE_INTEGER`, and a fixture built as a JavaScript object could
 * not express one without rounding it — which would make the test agree with a
 * bug rather than catch it.
 */
function scriptedFetch(byService: Record<string, unknown>): typeof fetch {
  const impl = (_url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
    const service = body.get('svc') ?? ''
    const payload = byService[service] ?? { error: 4 }
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return Promise.resolve(new Response(text, { status: 200 }))
  }
  return impl
}

/** A Wialon `avl_unit`, exactly as the documented flags return one. */
function wialonUnit(overrides: Record<string, unknown> = {}) {
  return {
    id: 400000000000001,
    nm: 'Kangoo — Casablanca',
    cls: 2,
    uid: '861234567890001',
    hw: 'Teltonika FMB920',
    netconn: 1,
    pos: {
      t: Math.floor(NOW / 1000) - 90,
      y: 33.589886,
      x: -7.603869,
      z: 42,
      s: 47,
      c: 275,
      sc: 9,
    },
    ...overrides,
  }
}

async function listUnitsFromProvider(units: unknown[] | string) {
  const search =
    typeof units === 'string' ? units
    : JSON.stringify({ totalItemsCount: units.length, items: units })

  const adapter = new WialonAdapter(
    { baseUrl: BASE_URL, token: TOKEN },
    {
      fetchImpl: scriptedFetch({
        'token/login': { eid: 'session-contract', user: { nm: 'atlas' } },
        'core/search_items': search,
      }),
      now: () => NOW,
    },
  )
  const result = await adapter.listUnits()
  await adapter.close()
  return result
}

/** Runs `gps_apply_sync` exactly as the Edge Function runs it. */
async function applyThroughSql(
  payload: unknown,
  options: { fullInventory?: boolean; generation?: number } = {},
): Promise<Record<string, number | boolean | string>> {
  const [row] = await db.sql<{ result: Record<string, number | boolean | string> }>(
    `select public.gps_apply_sync(
       $1, $2, $3::jsonb, 'success'::public.gps_sync_outcome, now(), $4, null, null, null, null
     ) as result`,
    [
      connectionId,
      options.generation ?? 1,
      JSON.stringify(payload),
      options.fullInventory ?? true,
    ],
  )
  return row!.result
}

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@gps-contract.test',
    fullName: 'Contract Owner',
    organizationName: 'Atlas Contract Motors',
    currency: 'EUR',
    timeZone: 'Europe/Lisbon',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerId = owner.userId
  organizationId = owner.organizationId

  const [connection] = await db.sql<{ id: string }>(
    `insert into public.gps_provider_connections
       (organization_id, provider, label, base_url, created_by)
     values ($1, 'wialon', 'Contract', $2, $3) returning id`,
    [organizationId, BASE_URL, ownerId],
  )
  connectionId = connection!.id
}, 180_000)

afterAll(async () => {
  await db?.close()
})

// -----------------------------------------------------------------------------
// The regression
// -----------------------------------------------------------------------------

describe('a provider response, all the way to a row', () => {
  it('lands a device and a position — the defect that shipped nothing at all', async () => {
    const { units } = await listUnitsFromProvider([wialonUnit()])
    expect(units).toHaveLength(1)

    const result = await applyThroughSql(toSyncPayload(units))

    // Before the fix these were 1 and 0: the device row was attempted with a
    // NULL identifier and every position field arrived empty.
    expect(Number(result.units)).toBe(1)
    expect(Number(result.positions)).toBe(1)
    expect(Number(result.skipped)).toBe(0)

    const [stored] = await db.sql<{
      external_id: string
      name: string
      device_uid: string | null
      hardware: string | null
      capabilities: string[]
    }>(
      `select external_id, name, device_uid, hardware, capabilities
       from public.gps_units where connection_id = $1`,
      [connectionId],
    )

    expect(stored!.external_id).toBe('400000000000001')
    expect(stored!.name).toBe('Kangoo — Casablanca')
    expect(stored!.device_uid).toBe('861234567890001')
    expect(stored!.hardware).toBe('Teltonika FMB920')
    expect(stored!.capabilities).toContain('position')
  })

  it('carries every telemetry field the provider reported', async () => {
    const [position] = await db.sql<{
      latitude: number
      longitude: number
      speed_kph: number | null
      heading_deg: number | null
      altitude_m: number | null
      satellites: number | null
      provider_online: boolean | null
      movement: string | null
      position_valid: boolean
    }>(
      `select p.latitude, p.longitude, p.speed_kph, p.heading_deg, p.altitude_m,
              p.satellites, p.provider_online, p.movement, p.position_valid
       from public.gps_positions p
       join public.gps_units u on u.id = p.unit_id
       where u.connection_id = $1`,
      [connectionId],
    )

    expect(Number(position!.latitude)).toBeCloseTo(33.589886, 5)
    expect(Number(position!.longitude)).toBeCloseTo(-7.603869, 5)
    expect(Number(position!.speed_kph)).toBe(47)
    expect(Number(position!.heading_deg)).toBe(275)
    expect(Number(position!.altitude_m)).toBe(42)
    expect(Number(position!.satellites)).toBe(9)
    expect(position!.provider_online).toBe(true)
    expect(position!.movement).toBe('moving')
    expect(position!.position_valid).toBe(true)
  })

  it('keeps an unreported field unreported all the way into the column', async () => {
    // A device that reports a position and nothing else. Every optional field
    // must be absent from the payload and NULL in the row — not zero, not false.
    const { units } = await listUnitsFromProvider([
      wialonUnit({
        id: 400000000000002,
        nm: 'Bare tracker',
        uid: undefined,
        hw: undefined,
        netconn: undefined,
        pos: { t: Math.floor(NOW / 1000) - 30, y: 33.5, x: -7.6 },
      }),
    ])

    const payload = toSyncPayload(units)
    const document = JSON.parse(JSON.stringify(payload)) as Array<Record<string, unknown>>
    const position = document[0]!.position as Record<string, unknown>

    // The keys are absent, not present-and-null. A null would survive JSON
    // round-trips as a value, and "the provider said nothing" would become
    // "the provider said nothing is known", which is a different sentence.
    expect('speed_kph' in position).toBe(false)
    expect('ignition' in position).toBe(false)
    expect('odometer_km' in position).toBe(false)
    expect('provider_online' in position).toBe(false)

    await applyThroughSql(payload, { fullInventory: false })

    const [stored] = await db.sql<{
      speed_kph: number | null
      ignition: boolean | null
      odometer_km: number | null
      provider_online: boolean | null
      movement: string | null
    }>(
      `select p.speed_kph, p.ignition, p.odometer_km, p.provider_online, p.movement
       from public.gps_positions p
       join public.gps_units u on u.id = p.unit_id
       where u.external_id = '400000000000002' and u.connection_id = $1`,
      [connectionId],
    )

    expect(stored!.speed_kph).toBeNull()
    expect(stored!.ignition).toBeNull()
    expect(stored!.odometer_km).toBeNull()
    expect(stored!.provider_online).toBeNull()
    expect(stored!.movement).toBeNull()
  })

  it('writes a reported stop as zero, which is a different fact', async () => {
    const { units } = await listUnitsFromProvider([
      wialonUnit({
        id: 400000000000003,
        nm: 'Parked',
        pos: { t: Math.floor(NOW / 1000) - 10, y: 33.51, x: -7.61, s: 0, c: 0 },
      }),
    ])
    await applyThroughSql(toSyncPayload(units), { fullInventory: false })

    const [stored] = await db.sql<{ speed_kph: number | null; movement: string | null }>(
      `select p.speed_kph, p.movement from public.gps_positions p
       join public.gps_units u on u.id = p.unit_id
       where u.external_id = '400000000000003' and u.connection_id = $1`,
      [connectionId],
    )

    expect(Number(stored!.speed_kph)).toBe(0)
    expect(stored!.movement).toBe('stopped')
  })

  it('carries a long identifier exactly, when the provider sends it as text', async () => {
    // Written as raw JSON so the fixture can express what an object literal
    // cannot. A provider that issues identifiers beyond a double's exact range
    // has to send them as strings, and then they survive at any length.
    const raw = JSON.stringify({
      totalItemsCount: 1,
      items: [wialonUnit({ id: 'PLACEHOLDER', nm: 'Precision' })],
    }).replace('"PLACEHOLDER"', '"920071992547409931"')

    const { units } = await listUnitsFromProvider(raw)
    await applyThroughSql(toSyncPayload(units), { fullInventory: false })

    const [stored] = await db.sql<{ external_id: string }>(
      `select external_id from public.gps_units
       where connection_id = $1 and name = 'Precision'`,
      [connectionId],
    )
    expect(stored!.external_id).toBe('920071992547409931')
  })

  it('refuses an identifier a JSON parse has already rounded', async () => {
    /*
     * `JSON.parse` has no integer type. An id above 2^53 comes back altered —
     * 9007199254740993 becomes …992 — and a device stored under a rounded
     * identifier would collect another device's positions from then on, with
     * nothing to show for it.
     *
     * So the unit is skipped and counted, which is a failure somebody can see.
     */
    const raw = JSON.stringify({
      totalItemsCount: 1,
      items: [wialonUnit({ id: 1, nm: 'Rounded' })],
    }).replace('"id":1,', '"id":9007199254740993,')

    const { units, skipped } = await listUnitsFromProvider(raw)
    expect(units).toHaveLength(0)
    expect(skipped).toBe(1)

    const [count] = await db.sql<{ n: number }>(
      `select count(*)::int as n from public.gps_units
       where connection_id = $1 and name = 'Rounded'`,
      [connectionId],
    )
    expect(Number(count!.n)).toBe(0)
  })

  it('is idempotent: the same answer twice changes nothing', async () => {
    const { units } = await listUnitsFromProvider([wialonUnit()])
    const payload = toSyncPayload(units)

    await applyThroughSql(payload, { fullInventory: false })
    const second = await applyThroughSql(payload, { fullInventory: false })

    // The device is upserted; the position is refused because it is not newer.
    expect(Number(second.units)).toBe(1)
    expect(Number(second.positions)).toBe(0)

    const [count] = await db.sql<{ n: number }>(
      `select count(*)::int as n from public.gps_units where connection_id = $1`,
      [connectionId],
    )
    expect(Number(count!.n)).toBe(4)
  })
})

// -----------------------------------------------------------------------------
// The shape itself
// -----------------------------------------------------------------------------

describe('the translation', () => {
  it('produces the keys the SQL function reads, and no others', async () => {
    const { units } = await listUnitsFromProvider([wialonUnit()])
    const payload = toSyncUnit(units[0]!)

    // Read straight off the function body: these are the paths gps_apply_sync
    // dereferences. A rename on either side breaks this test rather than the
    // integration.
    expect(Object.keys(payload).sort()).toEqual(
      [
        'capabilities',
        'device_uid',
        'external_id',
        'hardware',
        'metadata',
        'name',
        'position',
      ].sort(),
    )
    expect(Object.keys(payload.position!)).toContain('observed_at')
    expect(Object.keys(payload.position!)).toContain('position_valid')

    // And nothing camelCase survived the crossing.
    const serialised = JSON.stringify(payload)
    for (const leaked of ['externalId', 'deviceUid', 'observedAt', 'speedKph', 'positionValid']) {
      expect(serialised).not.toContain(leaked)
    }
  })

  it('is what the SQL function actually dereferences', async () => {
    // Asserted against the live function definition rather than against memory:
    // if somebody renames a key in the migration, this fails here rather than in
    // production three weeks later.
    const [definition] = await db.sql<{ src: string }>(
      `select pg_get_functiondef(p.oid) as src
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'gps_apply_sync'`,
    )

    for (const key of ['external_id', 'device_uid', 'hardware', 'capabilities']) {
      expect(definition!.src).toContain(`'${key}'`)
    }
    for (const path of ['position,observed_at', 'position,speed_kph', 'position,ignition']) {
      expect(definition!.src).toContain(`{${path}}`)
    }
  })
})


// -----------------------------------------------------------------------------
describe('the seam between the Edge Function and membership', () => {
  const source = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../functions/gps-provider/index.ts',
    ),
    'utf8',
  )

  it('identifies the caller by user, not merely by agency', () => {
    /*
     * The defect this holds closed, found by asking what the Team security
     * review had NOT looked at.
     *
     * roleIn() read `organization_members` filtered by organization and status
     * and called `.maybeSingle()`. The SELECT policy on that table is
     * `app.is_org_member(organization_id)`, so the query returns EVERY active
     * member — and maybeSingle turns more than one row into an error with
     * `data: null`. With one member the query was accidentally right. The first
     * time anybody accepted a Team invitation it started returning null, and
     * every tracking action — connect, sync, history, disconnect — answered
     * "Only an administrator can do that" to the owner of the agency.
     *
     * Team is what made it reachable, so the regression lives here.
     */
    const roleIn = source.slice(source.indexOf('async function roleIn('))
    const body = roleIn.slice(0, roleIn.indexOf('\n}'))

    expect(body).toContain(".eq('organization_id'")
    expect(body, 'roleIn does not filter by the calling user').toContain(".eq('user_id'")
    expect(body).toContain(".eq('status', 'active')")
  })

  it('proves why: a query without the user returns the whole roster', async () => {
    const colleague = await signUp(db, { email: 'gps-colleague@contract.test' })
    await db.sql(
      `insert into public.organization_members (organization_id, user_id, role, status)
       values ($1, $2, 'manager', 'active')`,
      [organizationId, colleague.userId],
    )

    const everyone = await db.asUser(ownerId, (session) =>
      session.sql<{ role: string }>(
        `select role from public.organization_members where organization_id = $1 and status = 'active'`,
        [organizationId],
      ),
    )
    // More than one row is exactly what .maybeSingle() cannot survive.
    expect(everyone.length).toBeGreaterThan(1)

    const justMe = await db.asUser(ownerId, (session) =>
      session.sql<{ role: string }>(
        `select role from public.organization_members
          where organization_id = $1 and user_id = $2 and status = 'active'`,
        [organizationId, ownerId],
      ),
    )
    expect(justMe).toHaveLength(1)
    expect(justMe[0]?.role).toBe('owner')
  })
})
