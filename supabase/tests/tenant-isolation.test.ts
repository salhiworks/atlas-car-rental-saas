// @vitest-environment node
/**
 * Tenant isolation is the one property this product cannot get wrong. These
 * tests run as the `authenticated` Postgres role — the same role a browser
 * request runs as — so RLS is genuinely in force rather than bypassed by a
 * superuser connection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase

let agencyA: { userId: string; organizationId: string }
let agencyB: { userId: string; organizationId: string }

beforeAll(async () => {
  db = await TestDatabase.create()

  const a = await signUp(db, {
    email: 'owner@northwind-rentals.test',
    fullName: 'Amina Owner',
    organizationName: 'Northwind Rentals',
    currency: 'EUR',
    timeZone: 'Europe/Lisbon',
    countryCode: 'PT',
  })
  const b = await signUp(db, {
    email: 'owner@sunset-fleet.test',
    fullName: 'Beto Owner',
    organizationName: 'Sunset Fleet',
    currency: 'USD',
    timeZone: 'America/Chicago',
    countryCode: 'US',
  })

  if (!a.organizationId || !b.organizationId) throw new Error('Provisioning failed during setup.')
  agencyA = { userId: a.userId, organizationId: a.organizationId }
  agencyB = { userId: b.userId, organizationId: b.organizationId }

  // Seed one vehicle and one customer per agency, bypassing RLS as setup.
  for (const agency of [agencyA, agencyB]) {
    await db.sql(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Toyota', 'Corolla', $2, 'EUR', 45000)`,
      [agency.organizationId, `PLATE-${agency.organizationId.slice(0, 6)}`],
    )
    await db.sql(
      `insert into public.customers (organization_id, first_name, last_name, email)
       values ($1, 'Test', 'Customer', $2)`,
      [agency.organizationId, `c-${agency.organizationId.slice(0, 6)}@example.test`],
    )
  }
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('sign-up provisioning', () => {
  it('creates the agency, its owner membership and its settings row', async () => {
    const [org] = await db.sql<{ name: string; default_currency: string; time_zone: string; slug: string }>(
      `select name, default_currency, time_zone, slug from public.organizations where id = $1`,
      [agencyA.organizationId],
    )
    expect(org).toMatchObject({
      name: 'Northwind Rentals',
      default_currency: 'EUR',
      time_zone: 'Europe/Lisbon',
      slug: 'northwind-rentals',
    })

    const [membership] = await db.sql<{ role: string; status: string }>(
      `select role, status from public.organization_members where organization_id = $1 and user_id = $2`,
      [agencyA.organizationId, agencyA.userId],
    )
    expect(membership).toEqual({ role: 'owner', status: 'active' })

    const settings = await db.sql(
      `select organization_id from public.organization_settings where organization_id = $1`,
      [agencyA.organizationId],
    )
    expect(settings).toHaveLength(1)

    const [profile] = await db.sql<{ full_name: string }>(
      `select full_name from public.profiles where id = $1`,
      [agencyA.userId],
    )
    expect(profile?.full_name).toBe('Amina Owner')
  })

  it('gives two agencies with the same name distinct slugs', async () => {
    await signUp(db, { email: 'dup1@example.test', organizationName: 'City Cars' })
    await signUp(db, { email: 'dup2@example.test', organizationName: 'City Cars' })

    const slugs = await db.sql<{ slug: string }>(
      `select slug from public.organizations where name = 'City Cars' order by slug`,
    )
    expect(slugs).toHaveLength(2)
    expect(new Set(slugs.map((row) => row.slug)).size).toBe(2)
  })

  it('still creates the account when the agency name is unusable', async () => {
    // A single character fails the organizations name check constraint. The
    // account must survive; onboarding then asks for a usable name.
    const result = await signUp(db, { email: 'nameless@example.test', organizationName: 'X' })
    expect(result.organizationId).toBeNull()

    const profiles = await db.sql(`select id from public.profiles where id = $1`, [result.userId])
    expect(profiles).toHaveLength(1)
  })

  it('lets a user with no agency create one through the RPC', async () => {
    const { userId } = await signUp(db, { email: 'solo@example.test', fullName: 'Solo' })

    const created = await db.asUser(userId, (session) =>
      session.sql<{ id: string; default_currency: string }>(
        `select id, default_currency from public.create_organization($1, $2, $3, $4)`,
        ['Solo Rentals', 'MA', 'MAD', 'Africa/Casablanca'],
      ),
    )
    expect(created[0]?.default_currency).toBe('MAD')

    const [membership] = await db.sql<{ role: string }>(
      `select role from public.organization_members where user_id = $1`,
      [userId],
    )
    expect(membership?.role).toBe('owner')
  })

  it('falls back to safe defaults when sign-up metadata is malformed', async () => {
    const { organizationId } = await signUp(db, {
      email: 'garbage@example.test',
      organizationName: 'Garbage In Rentals',
      currency: 'not-a-currency',
      timeZone: 'Mars/Olympus_Mons',
      countryCode: 'XYZ',
    })

    const [org] = await db.sql<{ default_currency: string; time_zone: string; country_code: string | null }>(
      `select default_currency, time_zone, country_code from public.organizations where id = $1`,
      [organizationId],
    )
    expect(org).toEqual({ default_currency: 'USD', time_zone: 'UTC', country_code: null })
  })
})

describe('cross-tenant reads', () => {
  it('shows a member only their own agency', async () => {
    const orgs = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ id: string }>(`select id from public.organizations`),
    )
    expect(orgs.map((row) => row.id)).toEqual([agencyA.organizationId])
  })

  it.each([
    ['vehicles'],
    ['customers'],
    ['organization_members'],
    ['organization_settings'],
  ])('scopes %s to the caller\'s agency', async (table) => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ organization_id: string }>(`select organization_id from public.${table}`),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.organization_id === agencyA.organizationId)).toBe(true)
  })

  it('returns nothing when explicitly querying another agency by id', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from public.vehicles where organization_id = $1`, [
        agencyB.organizationId,
      ]),
    )
    expect(rows).toEqual([])
  })

  it('hides profiles of users in unrelated agencies', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from public.profiles where id = $1`, [agencyB.userId]),
    )
    expect(rows).toEqual([])
  })

  it('shows profiles of colleagues in the same agency', async () => {
    const colleague = await signUp(db, { email: 'colleague@northwind-rentals.test', fullName: 'Colleague' })
    await addMember(db, agencyA.organizationId, colleague.userId, 'staff')

    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from public.profiles where id = $1`, [colleague.userId]),
    )
    expect(rows).toHaveLength(1)
  })
})

describe('cross-tenant writes', () => {
  it('refuses to insert a row into another agency', async () => {
    await db.asUser(agencyA.userId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
             values ($1, 'Injected', 'Row', 'HACK-1', 'EUR')`,
            [agencyB.organizationId],
          ),
        /row-level security/i,
      )
    })
  })

  it('silently affects no rows when updating another agency', async () => {
    await db.asUser(agencyA.userId, (session) =>
      session.sql(`update public.organizations set name = 'Renamed' where id = $1`, [
        agencyB.organizationId,
      ]),
    )

    const [org] = await db.sql<{ name: string }>(
      `select name from public.organizations where id = $1`,
      [agencyB.organizationId],
    )
    expect(org?.name).toBe('Sunset Fleet')
  })

  it('cannot move one of its own rows into another agency', async () => {
    // The freeze trigger restores organization_id, so the row stays put even
    // though the statement itself reports success.
    const [vehicle] = await db.sql<{ id: string }>(
      `select id from public.vehicles where organization_id = $1 limit 1`,
      [agencyA.organizationId],
    )

    await db.asUser(agencyA.userId, (session) =>
      session.sql(`update public.vehicles set organization_id = $1 where id = $2`, [
        agencyB.organizationId,
        vehicle!.id,
      ]),
    )

    const [after] = await db.sql<{ organization_id: string }>(
      `select organization_id from public.vehicles where id = $1`,
      [vehicle!.id],
    )
    expect(after?.organization_id).toBe(agencyA.organizationId)
  })

  it('cannot reference another agency\'s vehicle on a contract', async () => {
    const [foreignVehicle] = await db.sql<{ id: string }>(
      `select id from public.vehicles where organization_id = $1 limit 1`,
      [agencyB.organizationId],
    )
    const [ownCustomer] = await db.sql<{ id: string }>(
      `select id from public.customers where organization_id = $1 limit 1`,
      [agencyA.organizationId],
    )

    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.rentals
             (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency)
           values ($1, $2, $3, now(), now() + interval '2 days', 'EUR')`,
          [agencyA.organizationId, foreignVehicle!.id, ownCustomer!.id],
        ),
      /rentals_vehicle_fkey|foreign key/i,
    )
  })
})

describe('anonymous access', () => {
  it.each([
    ['organizations'],
    ['vehicles'],
    ['customers'],
    ['rentals'],
    ['payments'],
    ['organization_members'],
  ])('denies anon any access to %s', async (table) => {
    await db.asAnon(async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.${table}`),
        /permission denied/i,
      )
    })
  })

  it('denies anon the organization-creation RPC', async () => {
    await db.asAnon(async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.create_organization('Anon Agency')`),
        /permission denied/i,
      )
    })
  })
})
