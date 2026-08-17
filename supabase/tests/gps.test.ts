// @vitest-environment node
/**
 * GPS tracking: the security boundary and the invariants.
 *
 * Five questions, in order of what a wrong answer costs:
 *
 *   - can anything reachable from a browser obtain a provider token?
 *   - can one agency see, or influence, another agency's fleet?
 *   - can an older observation overwrite a newer one?
 *   - can a credential that has been replaced still report the connection well?
 *   - does "unknown" survive all the way from the provider to the column?
 *
 * The secret tests are written against the effective privilege boundary rather
 * than against the fact that a schema is called "vault". A table whose name
 * suggests encryption is not evidence of anything; a role that cannot select
 * from it is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let adminId: string
let managerId: string
let staffId: string
let connectionId: string
let vehicleA: string
let vehicleB: string
let customerId: string

const TOKEN = 'wialon-test-token-0123456789abcdef0123456789abcdef0123456789ab'

let plateCounter = 0
async function freshVehicle(prefix = 'GPS'): Promise<string> {
  plateCounter += 1
  const [row] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
     values ($1, 'Renault', 'Kangoo', $2, 'EUR', 5000) returning id`,
    [organizationId, `${prefix}-${String(plateCounter).padStart(3, '0')}`],
  )
  return row!.id
}

/** A device, written the way the trusted server-side path writes one. */
async function seedUnit(
  externalId: string,
  overrides: {
    name?: string
    connection?: string
    capabilities?: string[]
    deviceUid?: string
  } = {},
): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `insert into public.gps_units
       (organization_id, connection_id, external_id, name, device_uid, capabilities)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      organizationId,
      overrides.connection ?? connectionId,
      externalId,
      overrides.name ?? `Unit ${externalId}`,
      overrides.deviceUid ?? null,
      overrides.capabilities ?? ['position', 'speed', 'history'],
    ],
  )
  return row!.id
}

/** Runs a synchronisation the way the Edge Function does. */
async function applySync(
  units: unknown[],
  options: {
    generation?: number
    outcome?: string
    fullInventory?: boolean
    connection?: string
  } = {},
): Promise<Record<string, number | boolean | string>> {
  const [row] = await db.sql<{ result: Record<string, number | boolean | string> }>(
    `select public.gps_apply_sync(
       $1, $2, $3::jsonb, $4::public.gps_sync_outcome, now(), $5, null, null, null, null
     ) as result`,
    [
      options.connection ?? connectionId,
      options.generation ?? 1,
      JSON.stringify(units),
      options.outcome ?? 'success',
      options.fullInventory ?? true,
    ],
  )
  return row!.result
}

async function fleetRow(vehicleId: string, asUser = managerId) {
  const [row] = await db.asUser(asUser, (session) =>
    session.sql<Record<string, string | number | boolean | null>>(
      `select * from public.gps_fleet where vehicle_id = $1`,
      [vehicleId],
    ),
  )
  return row
}

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@gps.test',
    fullName: 'Fleet Owner',
    organizationName: 'Atlas Tracked Motors',
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerId = owner.userId
  organizationId = owner.organizationId

  const admin = await signUp(db, { email: 'admin@gps.test', fullName: 'Fleet Admin' })
  adminId = admin.userId
  await addMember(db, organizationId, adminId, 'admin')

  const manager = await signUp(db, { email: 'manager@gps.test', fullName: 'Ops Manager' })
  managerId = manager.userId
  await addMember(db, organizationId, managerId, 'manager')

  const staff = await signUp(db, { email: 'staff@gps.test', fullName: 'Desk Staff' })
  staffId = staff.userId
  await addMember(db, organizationId, staffId, 'staff')

  vehicleA = await freshVehicle('TRK')
  vehicleB = await freshVehicle('TRK')

  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Yasmine', 'Cherkaoui') returning id`,
    [organizationId],
  )
  customerId = customer!.id

  const [connection] = await db.sql<{ id: string }>(
    `insert into public.gps_provider_connections
       (organization_id, provider, label, base_url, created_by)
     values ($1, 'wialon', 'Wialon Hosting', 'https://hst-api.wialon.com', $2)
     returning id`,
    [organizationId, ownerId],
  )
  connectionId = connection!.id

  await db.sql(`select public.gps_store_credential($1, $2, null, null, $3)`, [
    connectionId,
    TOKEN,
    ownerId,
  ])
}, 180_000)

afterAll(async () => {
  await db?.close()
})

// -----------------------------------------------------------------------------
// The secret
// -----------------------------------------------------------------------------

describe('the provider credential', () => {
  it('is not in the connection row', async () => {
    const [row] = await db.sql<Record<string, unknown>>(
      `select * from public.gps_provider_connections where id = $1`,
      [connectionId],
    )
    const serialised = JSON.stringify(row)
    expect(serialised).not.toContain(TOKEN)
    // Not even a column that could hold one.
    expect(Object.keys(row!)).not.toContain('token')
    expect(Object.keys(row!)).not.toContain('access_token')
    expect(Object.keys(row!)).not.toContain('secret')
  })

  it('cannot be reached by any role the application uses', async () => {
    for (const userId of [ownerId, adminId, managerId, staffId]) {
      await db.asUser(userId, async (session) => {
        // The pointer table has no grant at all.
        await session.expectRejection(
          () => session.sql(`select * from public.gps_provider_credentials`),
          /permission denied/i,
        )
        // Vault is granted to postgres and service_role only.
        await session.expectRejection(
          () => session.sql(`select * from vault.decrypted_secrets`),
          /permission denied/i,
        )
        await session.expectRejection(
          () => session.sql(`select * from vault.secrets`),
          /permission denied/i,
        )
      })
    }
  })

  it('cannot be read through the function that reads it', async () => {
    // The one path to a plaintext token is granted to service_role alone. An
    // owner is the most privileged person in the agency and still cannot.
    for (const userId of [ownerId, adminId, managerId, staffId]) {
      await db.asUser(userId, async (session) => {
        await session.expectRejection(
          () => session.sql(`select public.gps_read_credential($1)`, [connectionId]),
          /permission denied/i,
        )
        await session.expectRejection(
          () => session.sql(`select public.gps_store_credential($1, 'stolen')`, [connectionId]),
          /permission denied/i,
        )
        await session.expectRejection(
          () => session.sql(`select public.gps_disconnect_connection($1)`, [connectionId]),
          /permission denied/i,
        )
        await session.expectRejection(
          () => session.sql(`select public.gps_claim_sync($1, 0)`, [connectionId]),
          /permission denied/i,
        )
      })
    }
  })

  it('is retrievable by trusted server-side code, which is the point', async () => {
    const [row] = await db.sql<{ token: string }>(
      `select public.gps_read_credential($1) as token`,
      [connectionId],
    )
    expect(row!.token).toBe(TOKEN)
  })

  it('is refused once the connection is switched off', async () => {
    const [connection] = await db.sql<{ id: string }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Temporary', 'https://hst-api.wialon.com') returning id`,
      [organizationId],
    )
    await db.sql(`select public.gps_store_credential($1, 'temp-token')`, [connection!.id])
    expect(
      (await db.sql<{ token: string | null }>(`select public.gps_read_credential($1) as token`, [connection!.id]))[0]!
        .token,
    ).toBe('temp-token')

    await db.sql(`select public.gps_disconnect_connection($1, $2)`, [connection!.id, ownerId])

    const [after] = await db.sql<{ token: string | null }>(
      `select public.gps_read_credential($1) as token`,
      [connection!.id],
    )
    expect(after!.token).toBeNull()

    // And the secret itself is gone, not merely unreferenced.
    const [remaining] = await db.sql<{ count: number }>(
      `select count(*)::int as count from public.gps_provider_credentials where connection_id = $1`,
      [connection!.id],
    )
    expect(Number(remaining!.count)).toBe(0)
  })

  it('is replaced rather than accumulated when it is rotated', async () => {
    const before = await db.sql<{ count: number }>(`select count(*)::int as count from vault.secrets`)

    await db.sql(`select public.gps_store_credential($1, 'rotated-token', null, null, $2)`, [
      connectionId,
      adminId,
    ])

    const after = await db.sql<{ count: number }>(`select count(*)::int as count from vault.secrets`)
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count))

    const [token] = await db.sql<{ token: string }>(
      `select public.gps_read_credential($1) as token`,
      [connectionId],
    )
    expect(token!.token).toBe('rotated-token')

    // Rotating puts the connection back to unverified: nobody has asked the
    // provider anything since the token changed.
    const [connection] = await db.sql<{ status: string; generation: number }>(
      `select status, generation from public.gps_provider_connections where id = $1`,
      [connectionId],
    )
    expect(connection!.status).toBe('never_connected')
    expect(Number(connection!.generation)).toBeGreaterThan(1)

    await db.sql(`select public.gps_store_credential($1, $2, null, null, $3)`, [
      connectionId,
      TOKEN,
      ownerId,
    ])
  })
})

// -----------------------------------------------------------------------------
// Synchronisation
// -----------------------------------------------------------------------------

describe('applying a synchronisation', () => {
  it('cannot be done from a browser at all', async () => {
    await db.asUser(adminId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `select public.gps_apply_sync($1, 1, '[]'::jsonb, 'success', now(), true, null, null, null, null)`,
            [connectionId],
          ),
        /permission denied/i,
      )
      // Nor by writing a position directly.
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.gps_positions (unit_id, organization_id, observed_at)
             values (gen_random_uuid(), $1, now())`,
            [organizationId],
          ),
        /permission denied/i,
      )
    })
  })

  it('records units and their positions', async () => {
    const generation = (
      await db.sql<{ generation: number }>(
        `select generation from public.gps_provider_connections where id = $1`,
        [connectionId],
      )
    )[0]!.generation

    const result = await applySync(
      [
        {
          external_id: '400000000000001',
          name: 'Kangoo tracker',
          device_uid: '861234567890123',
          capabilities: ['position', 'speed', 'heading', 'history'],
          position: {
            observed_at: new Date().toISOString(),
            latitude: 48.8566,
            longitude: 2.3522,
            position_valid: true,
            speed_kph: 42,
            heading_deg: 90,
            movement: 'moving',
            provider_online: true,
          },
        },
      ],
      { generation: Number(generation) },
    )

    expect(result.applied).toBe(true)
    expect(Number(result.units)).toBe(1)
    expect(Number(result.positions)).toBe(1)

    const [unit] = await db.sql<{ id: string; external_id: string; capabilities: string[] }>(
      `select id, external_id, capabilities from public.gps_units where connection_id = $1`,
      [connectionId],
    )
    // The identifier survived as text, digit for digit.
    expect(unit!.external_id).toBe('400000000000001')
    expect(unit!.capabilities).toContain('heading')
  })

  it('never lets an older observation replace a newer one', async () => {
    const generation = (
      await db.sql<{ generation: number }>(
        `select generation from public.gps_provider_connections where id = $1`,
        [connectionId],
      )
    )[0]!.generation

    const newer = new Date('2032-06-01T12:00:00Z').toISOString()
    const older = new Date('2032-06-01T11:00:00Z').toISOString()

    const unit = (position: string, lat: number) => [
      {
        external_id: '400000000000002',
        name: 'Out of order',
        capabilities: ['position'],
        position: { observed_at: position, latitude: lat, longitude: 2.0, position_valid: true },
      },
    ]

    await db.sql(`select public.gps_apply_sync($1, $2, $3::jsonb, 'success', now(), false, null, null, null, null)`, [
      connectionId,
      Number(generation),
      JSON.stringify(unit(newer, 48.9)),
    ])

    // The delayed response arrives second carrying the earlier fix.
    const [late] = await db.sql<{ result: Record<string, number> }>(
      `select public.gps_apply_sync($1, $2, $3::jsonb, 'success', now(), false, null, null, null, null) as result`,
      [connectionId, Number(generation), JSON.stringify(unit(older, 40.0))],
    )
    expect(Number(late!.result.skipped)).toBe(1)
    expect(Number(late!.result.positions)).toBe(0)

    const [position] = await db.sql<{ observed_at: string; latitude: number }>(
      `select p.observed_at, p.latitude
         from public.gps_positions p
         join public.gps_units u on u.id = p.unit_id
        where u.external_id = '400000000000002'`,
    )
    expect(new Date(position!.observed_at).toISOString()).toBe(newer)
    expect(Number(position!.latitude)).toBeCloseTo(48.9)
  })

  it('refuses a result produced under a superseded credential', async () => {
    const generation = (
      await db.sql<{ generation: number }>(
        `select generation from public.gps_provider_connections where id = $1`,
        [connectionId],
      )
    )[0]!.generation

    // A synchronisation that started before the token was replaced.
    const result = await applySync([], { generation: Number(generation) - 1 })

    expect(result.applied).toBe(false)
    expect(result.reason).toBe('superseded')

    const [run] = await db.sql<{ outcome: string; error_category: string }>(
      `select outcome, error_category from public.gps_sync_runs
        where connection_id = $1 order by started_at desc limit 1`,
      [connectionId],
    )
    expect(run!.outcome).toBe('aborted')
    expect(run!.error_category).toBe('superseded')
  })

  /*
   * Regression. The retention trigger was statement-level while its function
   * read `new.connection_id`, which is unassigned in a statement-level trigger.
   * The DELETE therefore compared against NULL, matched nothing, and the log
   * grew without bound — silently, with no error anywhere. Verified against the
   * live project before the fix: seventy inserted runs left seventy rows.
   *
   * Both shapes are checked, because the bug only showed up in one of them: a
   * bulk insert (which is how a backfill or a test writes) and a single insert
   * (which is how production writes).
   */
  it('keeps the synchronisation log bounded, however the rows arrive', async () => {
    const [connection] = await db.sql<{ id: string }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Retention', 'https://hst-api.wialon.com') returning id`,
      [organizationId],
    )
    const retentionId = connection!.id

    const countRuns = async (): Promise<number> => {
      const [row] = await db.sql<{ n: number }>(
        `select count(*)::int as n from public.gps_sync_runs where connection_id = $1`,
        [retentionId],
      )
      return Number(row!.n)
    }

    await db.sql(
      `insert into public.gps_sync_runs (organization_id, connection_id, started_at, outcome)
       select $1, $2, now() - make_interval(mins => n), 'success'
       from generate_series(1, 70) as n`,
      [organizationId, retentionId],
    )
    expect(await countRuns()).toBe(50)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.sql(
        `insert into public.gps_sync_runs (organization_id, connection_id, started_at, outcome)
         values ($1, $2, now(), 'success')`,
        [organizationId, retentionId],
      )
    }
    expect(await countRuns()).toBe(50)

    // And it keeps the NEWEST fifty, not the first fifty it happened to see.
    const [oldest] = await db.sql<{ age_minutes: number }>(
      `select extract(epoch from (now() - min(started_at))) / 60 as age_minutes
       from public.gps_sync_runs where connection_id = $1`,
      [retentionId],
    )
    expect(Number(oldest!.age_minutes)).toBeLessThan(50)
  })

  it('trims each connection independently', async () => {
    // One busy agency must not evict a quiet one's diagnostics.
    const [other] = await db.sql<{ id: string }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Quiet', 'https://hst-api.wialon.com') returning id`,
      [organizationId],
    )
    await db.sql(
      `insert into public.gps_sync_runs (organization_id, connection_id, started_at, outcome)
       values ($1, $2, now(), 'success')`,
      [organizationId, other!.id],
    )
    await db.sql(
      `insert into public.gps_sync_runs (organization_id, connection_id, started_at, outcome)
       select $1, $2, now() - make_interval(mins => n), 'success'
       from generate_series(1, 80) as n`,
      [organizationId, connectionId],
    )

    const [quiet] = await db.sql<{ n: number }>(
      `select count(*)::int as n from public.gps_sync_runs where connection_id = $1`,
      [other!.id],
    )
    expect(Number(quiet!.n)).toBe(1)
  })

  /*
   * The other two paths that reach the provider.
   *
   * Refreshing positions was already coalesced. Testing a credential sends a
   * candidate token upstream, and history is a real provider request per click.
   * Both now sit behind the same atomic claim, because a throttle that lives in
   * a browser throttles nothing and a throttle that lives in one server isolate
   * throttles one isolate.
   */
  it('lets exactly one caller through a rate-limited window', async () => {
    const claims: boolean[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [row] = await db.sql<{ claimed: boolean }>(
        `select public.gps_claim_action($1, 'history', 30) as claimed`,
        [connectionId],
      )
      claims.push(row!.claimed)
    }
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('counts the attempts it let through, for support', async () => {
    const [row] = await db.sql<{ hit_count: number }>(
      `select hit_count from public.gps_rate_limits
       where connection_id = $1 and action = 'history'`,
      [connectionId],
    )
    expect(Number(row!.hit_count)).toBeGreaterThanOrEqual(1)
  })

  it('keeps each action and each connection on its own clock', async () => {
    // Testing a credential must not lock out the map, and one agency's activity
    // must not throttle another's.
    const [other] = await db.sql<{ id: string }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Second provider', 'https://hst-api.wialon.eu') returning id`,
      [organizationId],
    )

    const [differentAction] = await db.sql<{ claimed: boolean }>(
      `select public.gps_claim_action($1, 'test', 30) as claimed`,
      [connectionId],
    )
    expect(differentAction!.claimed).toBe(true)

    const [differentConnection] = await db.sql<{ claimed: boolean }>(
      `select public.gps_claim_action($1, 'history', 30) as claimed`,
      [other!.id],
    )
    expect(differentConnection!.claimed).toBe(true)
  })

  it('opens again once the window has passed', async () => {
    await db.sql(
      `update public.gps_rate_limits set last_at = now() - interval '1 hour'
       where connection_id = $1 and action = 'history'`,
      [connectionId],
    )
    const [row] = await db.sql<{ claimed: boolean }>(
      `select public.gps_claim_action($1, 'history', 30) as claimed`,
      [connectionId],
    )
    expect(row!.claimed).toBe(true)
  })

  it('is unreachable from a browser at every role', async () => {
    for (const userId of [ownerId, adminId, managerId, staffId]) {
      await db.asUser(userId, async (session) => {
        await session.expectRejection(
          () => session.sql(`select public.gps_claim_action($1, 'history', 1)`, [connectionId]),
          /permission denied/i,
        )
        await session.expectRejection(
          () => session.sql(`select * from public.gps_rate_limits`),
          /permission denied/i,
        )
      })
    }
  })

  it('refuses to write anything to a connection that was switched off', async () => {
    const [connection] = await db.sql<{ id: string; generation: number }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Switched off', 'https://hst-api.wialon.com') returning id, generation`,
      [organizationId],
    )
    await db.sql(`select public.gps_disconnect_connection($1, $2)`, [connection!.id, ownerId])

    const [after] = await db.sql<{ generation: number }>(
      `select generation from public.gps_provider_connections where id = $1`,
      [connection!.id],
    )

    const result = await applySync([], {
      connection: connection!.id,
      generation: Number(after!.generation),
    })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('disabled')
  })

  it('marks a vanished device rather than deleting it', async () => {
    const generation = (
      await db.sql<{ generation: number }>(
        `select generation from public.gps_provider_connections where id = $1`,
        [connectionId],
      )
    )[0]!.generation

    const present = (id: string) => ({
      external_id: id,
      name: `Unit ${id}`,
      capabilities: ['position'],
    })

    await applySync([present('900001'), present('900002')], { generation: Number(generation) })

    // The next full inventory no longer lists 900002.
    await applySync([present('900001')], { generation: Number(generation) })

    const [gone] = await db.sql<{ availability: string; missing_since: string }>(
      `select availability, missing_since from public.gps_units where external_id = '900002'`,
    )
    expect(gone!.availability).toBe('missing')
    expect(gone!.missing_since).not.toBeNull()

    // And it comes back when the provider lists it again.
    await applySync([present('900001'), present('900002')], { generation: Number(generation) })
    const [back] = await db.sql<{ availability: string; missing_since: string | null }>(
      `select availability, missing_since from public.gps_units where external_id = '900002'`,
    )
    expect(back!.availability).toBe('present')
    expect(back!.missing_since).toBeNull()
  })

  it('does not treat a partial answer as evidence a device is gone', async () => {
    const generation = (
      await db.sql<{ generation: number }>(
        `select generation from public.gps_provider_connections where id = $1`,
        [connectionId],
      )
    )[0]!.generation

    // A refresh that only carried some of the fleet.
    await applySync([{ external_id: '900001', name: 'Unit 900001', capabilities: [] }], {
      generation: Number(generation),
      fullInventory: false,
    })

    const [other] = await db.sql<{ availability: string }>(
      `select availability from public.gps_units where external_id = '900002'`,
    )
    expect(other!.availability).toBe('present')
  })

  it('keeps unknown telemetry unknown', async () => {
    const generation = (
      await db.sql<{ generation: number }>(
        `select generation from public.gps_provider_connections where id = $1`,
        [connectionId],
      )
    )[0]!.generation

    await applySync(
      [
        {
          external_id: '900003',
          name: 'Sparse device',
          capabilities: ['position'],
          position: {
            observed_at: new Date().toISOString(),
            latitude: 33.5731,
            longitude: -7.5898,
            position_valid: true,
          },
        },
      ],
      { generation: Number(generation), fullInventory: false },
    )

    const [position] = await db.sql<Record<string, number | boolean | null>>(
      `select p.speed_kph, p.ignition, p.heading_deg, p.provider_online, p.odometer_km, p.movement
         from public.gps_positions p join public.gps_units u on u.id = p.unit_id
        where u.external_id = '900003'`,
    )

    // Every one of these would be a lie as a zero or a false.
    expect(position!.speed_kph).toBeNull()
    expect(position!.ignition).toBeNull()
    expect(position!.heading_deg).toBeNull()
    expect(position!.provider_online).toBeNull()
    expect(position!.odometer_km).toBeNull()
    expect(position!.movement).toBeNull()
  })

  it('refuses a coordinate outside the possible range', async () => {
    const generation = (
      await db.sql<{ generation: number }>(
        `select generation from public.gps_provider_connections where id = $1`,
        [connectionId],
      )
    )[0]!.generation

    await db.expectRejection(
      () =>
        applySync(
          [
            {
              external_id: '900004',
              name: 'Impossible',
              capabilities: [],
              position: {
                observed_at: new Date().toISOString(),
                latitude: 191.4,
                longitude: 2.0,
                position_valid: true,
              },
            },
          ],
          { generation: Number(generation), fullInventory: false },
        ),
      /gps_positions_latitude_check|violates check constraint/i,
    )
  })
})

describe('claiming a refresh', () => {
  it('coalesces concurrent refreshes into one provider call', async () => {
    const [connection] = await db.sql<{ id: string }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Coalesce', 'https://hst-api.wialon.com') returning id`,
      [organizationId],
    )

    const first = await db.sql<{ claimed: boolean }>(
      `select public.gps_claim_sync($1, 20) as claimed`,
      [connection!.id],
    )
    const second = await db.sql<{ claimed: boolean }>(
      `select public.gps_claim_sync($1, 20) as claimed`,
      [connection!.id],
    )

    expect(first[0]!.claimed).toBe(true)
    // The second tab is told somebody is already asking, and reads the snapshot.
    expect(second[0]!.claimed).toBe(false)

    // A deliberate synchronisation is not coalesced.
    const forced = await db.sql<{ claimed: boolean }>(
      `select public.gps_claim_sync($1, 0) as claimed`,
      [connection!.id],
    )
    expect(forced[0]!.claimed).toBe(true)
  })

  it('cannot be claimed on a switched-off connection', async () => {
    const [connection] = await db.sql<{ id: string }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Off', 'https://hst-api.wialon.com') returning id`,
      [organizationId],
    )
    await db.sql(`select public.gps_disconnect_connection($1, $2)`, [connection!.id, ownerId])

    const [claim] = await db.sql<{ claimed: boolean }>(
      `select public.gps_claim_sync($1, 0) as claimed`,
      [connection!.id],
    )
    expect(claim!.claimed).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Assignments
// -----------------------------------------------------------------------------

describe('assigning a device to a vehicle', () => {
  it('refuses two vehicles for one device', async () => {
    const unit = await seedUnit('assign-1')
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicleA, unit]),
    )

    const other = await freshVehicle('DUP')
    await db.sql(
      `insert into public.gps_unit_assignments (organization_id, vehicle_id, unit_id)
       values ($1, $2, $3)`,
      [organizationId, other, unit],
    ).then(
      () => {
        throw new Error('a device was assigned to two vehicles')
      },
      (error: Error) => {
        expect(error.message).toMatch(/duplicate key|gps_unit_assignments_one_active_unit/i)
      },
    )
  })

  it('refuses two devices for one vehicle', async () => {
    const second = await seedUnit('assign-2')
    await db.sql(
      `insert into public.gps_unit_assignments (organization_id, vehicle_id, unit_id)
       values ($1, $2, $3)`,
      [organizationId, vehicleA, second],
    ).then(
      () => {
        throw new Error('a vehicle was given two primary trackers')
      },
      (error: Error) => {
        expect(error.message).toMatch(/duplicate key|gps_unit_assignments_one_active_vehicle/i)
      },
    )
  })

  it('replaces a tracker without erasing where the old one was', async () => {
    const vehicle = await freshVehicle('SWAP')
    const first = await seedUnit('swap-old')
    const second = await seedUnit('swap-new')

    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicle, first]),
    )
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, 'Tracker replaced')`, [vehicle, second]),
    )

    const history = await db.sql<{ unit_id: string; unassigned_at: string | null }>(
      `select unit_id, unassigned_at from public.gps_unit_assignments
        where vehicle_id = $1 order by assigned_at`,
      [vehicle],
    )

    expect(history).toHaveLength(2)
    // The old assignment is closed, not deleted: which tracker was on this car
    // in March is still answerable.
    expect(history[0]!.unit_id).toBe(first)
    expect(history[0]!.unassigned_at).not.toBeNull()
    expect(history[1]!.unit_id).toBe(second)
    expect(history[1]!.unassigned_at).toBeNull()
  })

  it('moves a device between vehicles, closing what it left', async () => {
    const unit = await seedUnit('move-1')
    const from = await freshVehicle('FROM')
    const to = await freshVehicle('TO')

    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [from, unit]),
    )
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [to, unit]),
    )

    const open = await db.sql<{ vehicle_id: string }>(
      `select vehicle_id from public.gps_unit_assignments
        where unit_id = $1 and unassigned_at is null`,
      [unit],
    )
    expect(open).toHaveLength(1)
    expect(open[0]!.vehicle_id).toBe(to)
  })

  it('will not reopen or rewrite a closed assignment', async () => {
    const [closed] = await db.sql<{ id: string }>(
      `select id from public.gps_unit_assignments where unassigned_at is not null limit 1`,
    )

    await db.expectRejection(
      () =>
        db.sql(`update public.gps_unit_assignments set unassigned_at = null where id = $1`, [
          closed!.id,
        ]),
      /cannot be reopened/i,
    )
    await db.expectRejection(
      () =>
        db.sql(`update public.gps_unit_assignments set unassigned_at = now() where id = $1`, [
          closed!.id,
        ]),
      /already ended/i,
    )
  })

  it('will not move an assignment to a different vehicle in place', async () => {
    const [open] = await db.sql<{ id: string }>(
      `select id from public.gps_unit_assignments where unassigned_at is null limit 1`,
    )
    await db.expectRejection(
      () =>
        db.sql(`update public.gps_unit_assignments set vehicle_id = $2 where id = $1`, [
          open!.id,
          vehicleB,
        ]),
      /ending this assignment/i,
    )
  })

  it('refuses a device from another agency', async () => {
    const rival = await signUp(db, {
      email: 'rival-assign@gps.test',
      fullName: 'Rival',
      organizationName: 'Rival Tracking',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    })
    if (!rival.organizationId) throw new Error('Provisioning failed.')

    const [connection] = await db.sql<{ id: string }>(
      `insert into public.gps_provider_connections (organization_id, label, base_url)
       values ($1, 'Rival Wialon', 'https://hst-api.wialon.com') returning id`,
      [rival.organizationId],
    )
    const [unit] = await db.sql<{ id: string }>(
      `insert into public.gps_units (organization_id, connection_id, external_id, name)
       values ($1, $2, 'rival-1', 'Rival unit') returning id`,
      [rival.organizationId, connection!.id],
    )

    // Our admin naming their device gets the same answer as naming nothing.
    await db.asUser(adminId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicleB, unit!.id]),
        /not found/i,
      )
    })

    // And the composite key makes the direct write impossible too.
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.gps_unit_assignments (organization_id, vehicle_id, unit_id)
           values ($1, $2, $3)`,
          [organizationId, vehicleB, unit!.id],
        ),
      /violates foreign key/i,
    )
  })
})

// -----------------------------------------------------------------------------
// The three facts
// -----------------------------------------------------------------------------

describe('connectivity, freshness and sync health', () => {
  let trackedVehicle: string
  let trackedUnit: string

  beforeAll(async () => {
    trackedVehicle = await freshVehicle('FRESH')
    trackedUnit = await seedUnit('fresh-1')
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [trackedVehicle, trackedUnit]),
    )
  })

  const setPosition = async (observedAt: string, extra: Record<string, unknown> = {}) => {
    await db.sql(`delete from public.gps_positions where unit_id = $1`, [trackedUnit])
    await db.sql(
      `insert into public.gps_positions
         (unit_id, organization_id, observed_at, latitude, longitude, provider_online, speed_kph)
       values ($1, $2, $3::timestamptz, 48.85, 2.35, $4, $5)`,
      [
        trackedUnit,
        organizationId,
        observedAt,
        extra.providerOnline ?? null,
        extra.speedKph ?? null,
      ],
    )
  }

  it('reports a recent fix as fresh', async () => {
    await setPosition(new Date().toISOString())
    const row = await fleetRow(trackedVehicle)
    expect(row!.position_freshness).toBe('fresh')
  })

  it('reports an ageing fix as stale, then as very stale', async () => {
    await setPosition(new Date(Date.now() - 30 * 60_000).toISOString())
    expect((await fleetRow(trackedVehicle))!.position_freshness).toBe('stale')

    await setPosition(new Date(Date.now() - 5 * 60 * 60_000).toISOString())
    expect((await fleetRow(trackedVehicle))!.position_freshness).toBe('very_stale')
  })

  it('refuses to call a future-dated fix fresh', async () => {
    // A device with a wrong clock would otherwise look current forever.
    await setPosition(new Date(Date.now() + 6 * 60 * 60_000).toISOString())
    expect((await fleetRow(trackedVehicle))!.position_freshness).toBe('future')
  })

  it('honours the agency’s own thresholds', async () => {
    await db.sql(
      `update public.organization_settings
          set gps_fresh_minutes = 60, gps_stale_minutes = 240
        where organization_id = $1`,
      [organizationId],
    )
    await setPosition(new Date(Date.now() - 30 * 60_000).toISOString())
    // The same thirty-minute-old fix that was stale above is fresh for an
    // agency that says an hour is fine.
    expect((await fleetRow(trackedVehicle))!.position_freshness).toBe('fresh')

    await db.sql(
      `update public.organization_settings
          set gps_fresh_minutes = 10, gps_stale_minutes = 120
        where organization_id = $1`,
      [organizationId],
    )
  })

  it('keeps provider connectivity separate from position age', async () => {
    // Online, and yet the last fix is hours old. Both true, both shown.
    await setPosition(new Date(Date.now() - 5 * 60 * 60_000).toISOString(), { providerOnline: true })
    const online = await fleetRow(trackedVehicle)
    expect(online!.provider_online).toBe(true)
    expect(online!.position_freshness).toBe('very_stale')

    // And a provider that says nothing about connectivity leaves it unknown
    // rather than offline.
    await setPosition(new Date().toISOString())
    const silent = await fleetRow(trackedVehicle)
    expect(silent!.provider_online).toBeNull()
    expect(silent!.position_freshness).toBe('fresh')
  })

  it('keeps our own synchronisation health separate from both', async () => {
    await db.sql(
      `update public.gps_provider_connections set status = 'auth_error' where id = $1`,
      [connectionId],
    )
    const row = await fleetRow(trackedVehicle)

    // The tracker is fine; our integration is not. The last known position is
    // still there, and the map does not blank because a refresh failed.
    expect(row!.sync_health).toBe('auth_error')
    expect(row!.position_freshness).toBe('fresh')
    expect(row!.latitude).not.toBeNull()

    await db.sql(
      `update public.gps_provider_connections set status = 'healthy' where id = $1`,
      [connectionId],
    )
  })

  it('says unknown when there has never been a fix', async () => {
    const vehicle = await freshVehicle('NOFIX')
    const unit = await seedUnit('nofix-1')
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicle, unit]),
    )

    const row = await fleetRow(vehicle)
    expect(row!.position_freshness).toBe('unknown')
    expect(row!.latitude).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// The domain boundaries
// -----------------------------------------------------------------------------

describe('what GPS is not allowed to touch', () => {
  it('never writes the vehicle odometer', async () => {
    const vehicle = await freshVehicle('ODO')
    const unit = await seedUnit('odo-1')
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicle, unit]),
    )
    await db.sql(`update public.vehicles set odometer = 42000 where id = $1`, [vehicle])

    await db.sql(
      `insert into public.gps_positions
         (unit_id, organization_id, observed_at, latitude, longitude, odometer_km)
       values ($1, $2, now(), 48.85, 2.35, 187654)`,
      [unit, organizationId],
    )

    const [after] = await db.sql<{ odometer: number }>(
      `select odometer from public.vehicles where id = $1`,
      [vehicle],
    )
    // A tracker's odometer has its own calibration, its own unit and its own
    // resets. It is telemetry, shown as telemetry, and never the fleet figure
    // every rental contract is written against.
    expect(Number(after!.odometer)).toBe(42000)

    const row = await fleetRow(vehicle)
    expect(Number(row!.odometer_km)).toBe(187654)
  })

  it('never infers that a vehicle is rented because it is moving', async () => {
    const vehicle = await freshVehicle('RENT')
    const unit = await seedUnit('rent-1')
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicle, unit]),
    )
    await db.sql(
      `insert into public.gps_positions
         (unit_id, organization_id, observed_at, latitude, longitude, speed_kph, movement)
       values ($1, $2, now(), 48.85, 2.35, 90, 'moving')`,
      [unit, organizationId],
    )

    const row = await fleetRow(vehicle)
    expect(row!.movement).toBe('moving')
    // Occupancy comes from Rentals and from nowhere else.
    expect(row!.current_rental_id).toBeNull()
    expect(row!.vehicle_status).toBe('available')

    const [rentals] = await db.sql<{ count: number }>(
      `select count(*)::int as count from public.rentals where vehicle_id = $1`,
      [vehicle],
    )
    expect(Number(rentals!.count)).toBe(0)
  })

  it('shows the rental the Rentals domain already knows about', async () => {
    const vehicle = await freshVehicle('ACTIVE')
    const unit = await seedUnit('active-1')
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicle, unit]),
    )

    const [rental] = await db.sql<{ id: string; reference: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, daily_rate_minor, status)
       values ($1, $2, $3, now() - interval '1 day', now() + interval '2 days', 'EUR', 5000, 'active')
       returning id, reference`,
      [organizationId, vehicle, customerId],
    )

    const row = await fleetRow(vehicle)
    expect(row!.current_rental_id).toBe(rental!.id)
    expect(row!.current_rental_reference).toBe(rental!.reference)
    // And no customer identity reaches the map read model at all.
    expect(Object.keys(row!)).not.toContain('customer_id')
    expect(Object.keys(row!)).not.toContain('customer_name')
  })

  it('changes no financial figure', async () => {
    const before = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number; profit_minor: number }>(
        `select expenses_minor, profit_minor
           from public.organization_overview($1, now() - interval '30 days', now() + interval '1 day')`,
        [organizationId],
      ),
    )

    const vehicle = await freshVehicle('FIN')
    const unit = await seedUnit('fin-1')
    await db.asUser(adminId, (session) =>
      session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicle, unit]),
    )
    await db.sql(
      `insert into public.gps_positions
         (unit_id, organization_id, observed_at, latitude, longitude, odometer_km, engine_hours)
       values ($1, $2, now(), 48.85, 2.35, 250000, 9000)`,
      [unit, organizationId],
    )

    const after = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number; profit_minor: number }>(
        `select expenses_minor, profit_minor
           from public.organization_overview($1, now() - interval '30 days', now() + interval '1 day')`,
        [organizationId],
      ),
    )

    // Telemetry has no financial meaning. No expense, no mileage charge, no
    // fuel cost is created by a device reporting a number.
    expect(Number(after[0]!.expenses_minor)).toBe(Number(before[0]!.expenses_minor))
    expect(Number(after[0]!.profit_minor)).toBe(Number(before[0]!.profit_minor))

    const [expenses] = await db.sql<{ count: number }>(
      `select count(*)::int as count from public.expenses where vehicle_id = $1`,
      [vehicle],
    )
    expect(Number(expenses!.count)).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// Access
// -----------------------------------------------------------------------------

describe('who may see what', () => {
  it('shows a manager the fleet and nothing about the connection log', async () => {
    await db.asUser(managerId, async (session) => {
      expect((await session.sql(`select * from public.gps_fleet`)).length).toBeGreaterThan(0)
      expect((await session.sql(`select * from public.gps_unit_inventory`)).length).toBeGreaterThan(0)
      expect(
        (await session.sql(`select * from public.gps_provider_connections`)).length,
      ).toBeGreaterThan(0)
      // The synchronisation log is an administrator's diagnostic.
      expect(await session.sql(`select * from public.gps_sync_runs`)).toHaveLength(0)
    })
  })

  it('shows a staff member nothing at all', async () => {
    await db.asUser(staffId, async (session) => {
      for (const relation of [
        'gps_provider_connections',
        'gps_units',
        'gps_unit_assignments',
        'gps_positions',
        'gps_sync_runs',
        'gps_fleet',
        'gps_unit_inventory',
      ]) {
        expect(
          await session.sql(`select * from public.${relation} limit 1`),
          `${relation} leaked to staff`,
        ).toHaveLength(0)
      }

      await session.expectRejection(
        () => session.sql(`select * from public.gps_attention_signals($1)`, [organizationId]),
        /not permitted/i,
      )
    })
  })

  it('refuses a manager the assignment operations', async () => {
    const unit = await seedUnit('role-1')
    await db.asUser(managerId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.gps_assign_unit($1, $2, null)`, [vehicleB, unit]),
        /row-level security|permission denied/i,
      )
    })
  })

  it('gives the anonymous role nothing', async () => {
    await db.asAnon(async (session) => {
      for (const relation of [
        'gps_provider_connections',
        'gps_provider_credentials',
        'gps_units',
        'gps_unit_assignments',
        'gps_positions',
        'gps_sync_runs',
        'gps_fleet',
        'gps_unit_inventory',
      ]) {
        await session.expectRejection(() => session.sql(`select * from public.${relation} limit 1`))
      }
      for (const call of [
        `select public.gps_read_credential(gen_random_uuid())`,
        `select public.gps_attention_signals(gen_random_uuid())`,
        `select public.gps_resolve_tracked_vehicle(gen_random_uuid())`,
        `select public.gps_assign_unit(gen_random_uuid(), gen_random_uuid(), null)`,
      ]) {
        await session.expectRejection(() => session.sql(call))
      }
    })
  })
})

describe('another agency', () => {
  let rivalUserId: string
  let rivalOrganizationId: string

  beforeAll(async () => {
    const rival = await signUp(db, {
      email: 'rival@gps.test',
      fullName: 'Rival Owner',
      organizationName: 'Rival Fleet',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    })
    if (!rival.organizationId) throw new Error('Provisioning failed.')
    rivalUserId = rival.userId
    rivalOrganizationId = rival.organizationId
  })

  it('sees none of our tracking, on any relation', async () => {
    await db.asUser(rivalUserId, async (session) => {
      for (const relation of [
        'gps_provider_connections',
        'gps_units',
        'gps_unit_assignments',
        'gps_positions',
        'gps_sync_runs',
      ]) {
        const rows = await session.sql(
          `select * from public.${relation} where organization_id = $1`,
          [organizationId],
        )
        expect(rows, `${relation} leaked`).toHaveLength(0)
      }

      expect(
        await session.sql(`select * from public.gps_fleet where organization_id = $1`, [
          organizationId,
        ]),
      ).toHaveLength(0)
      expect(
        await session.sql(`select * from public.gps_unit_inventory where organization_id = $1`, [
          organizationId,
        ]),
      ).toHaveLength(0)
    })
  })

  it('cannot even tell whether we have a provider connected', async () => {
    await db.asUser(rivalUserId, async (session) => {
      const [row] = await session.sql<{ count: number }>(
        `select count(*)::int as count from public.gps_provider_connections`,
      )
      // Their own agency has none; ours is invisible rather than counted.
      expect(Number(row!.count)).toBe(0)
    })
  })

  it('cannot resolve one of our vehicles to a device', async () => {
    await db.asUser(rivalUserId, async (session) => {
      const rows = await session.sql(`select * from public.gps_resolve_tracked_vehicle($1)`, [
        vehicleA,
      ])
      // The same empty answer a vehicle that never existed would give, which is
      // what stops the history endpoint being an oracle.
      expect(rows).toHaveLength(0)
    })
  })

  it('cannot ask for our attention signals', async () => {
    await db.asUser(rivalUserId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.gps_attention_signals($1)`, [organizationId]),
        /not permitted/i,
      )
    })
  })

  it('cannot assign our device even to their own vehicle', async () => {
    const [theirVehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Kia', 'Picanto', 'RIVAL-1', 'EUR', 3000) returning id`,
      [rivalOrganizationId],
    )
    const [ourUnit] = await db.sql<{ id: string }>(
      `select id from public.gps_units where organization_id = $1 limit 1`,
      [organizationId],
    )

    await db.asUser(rivalUserId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.gps_assign_unit($1, $2, null)`, [
            theirVehicle!.id,
            ourUnit!.id,
          ]),
        /not found/i,
      )
    })
  })
})

// -----------------------------------------------------------------------------
// Signals for a later Notifications module
// -----------------------------------------------------------------------------

describe('the attention signals', () => {
  it('name a stale tracker, a missing device and an unhealthy connection', async () => {
    await db.sql(
      `update public.gps_provider_connections
          set status = 'auth_error', last_error_message = 'The access token was rejected.',
              last_error_at = now()
        where id = $1`,
      [connectionId],
    )

    const signals = await db.asUser(managerId, (session) =>
      session.sql<{ signal: string; severity: string }>(
        `select signal, severity from public.gps_attention_signals($1)`,
        [organizationId],
      ),
    )

    const kinds = new Set(signals.map((row) => row.signal))
    expect(kinds).toContain('connection_unhealthy')
    expect(kinds).toContain('device_missing')
    expect(
      [...kinds].some((kind) => kind === 'position_stale' || kind === 'no_position'),
    ).toBe(true)

    await db.sql(
      `update public.gps_provider_connections set status = 'healthy' where id = $1`,
      [connectionId],
    )
  })
})
