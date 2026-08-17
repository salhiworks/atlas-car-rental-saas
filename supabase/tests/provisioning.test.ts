// @vitest-environment node
/**
 * Agency provisioning and its recovery path.
 *
 * Sign-up creates the account and the agency in one transaction, but the trigger
 * deliberately lets account creation survive a provisioning failure — otherwise a
 * malformed agency name in the sign-up payload would block registration entirely.
 * That leaves a recovery path: an authenticated user with no membership calls
 * public.create_organization() from the onboarding screen.
 *
 * Onboarding is precisely where a person double-clicks, or a client retries after
 * a timeout, so these tests hold that path to the standard it needs: idempotent,
 * retry-safe, unable to duplicate, and unable to reach anyone else's agency.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, signUp } from './support/harness'

let db: TestDatabase

beforeAll(async () => {
  db = await TestDatabase.create()
}, 120_000)

afterAll(async () => {
  await db?.close()
})

async function organizationsOwnedBy(userId: string): Promise<{ id: string; name: string }[]> {
  return db.sql<{ id: string; name: string }>(
    `select o.id, o.name
     from public.organizations o
     join public.organization_members m on m.organization_id = o.id
     where m.user_id = $1 and m.role = 'owner' and m.status = 'active'
     order by o.created_at`,
    [userId],
  )
}

describe('the recovery path exists when it is needed', () => {
  it('leaves the account intact when sign-up provisioning fails', async () => {
    // A one-character name fails the organizations CHECK constraint.
    const { userId, organizationId } = await signUp(db, {
      email: 'stranded@provisioning.test',
      fullName: 'Stranded User',
      organizationName: 'X',
    })

    expect(organizationId).toBeNull()

    const profiles = await db.sql(`select id from public.profiles where id = $1`, [userId])
    expect(profiles).toHaveLength(1)
  })

  it('lets that user finish setting up, with the owner role', async () => {
    const { userId } = await signUp(db, { email: 'recovering@provisioning.test' })

    const created = await db.asUser(userId, (session) =>
      session.sql<{ id: string; name: string }>(
        `select id, name from public.create_organization($1, $2, $3, $4)`,
        ['Recovered Rentals', 'PT', 'EUR', 'Europe/Lisbon'],
      ),
    )

    expect(created[0]?.name).toBe('Recovered Rentals')

    const [membership] = await db.sql<{ role: string; status: string }>(
      `select role, status from public.organization_members where user_id = $1`,
      [userId],
    )
    expect(membership).toEqual({ role: 'owner', status: 'active' })

    // And the settings row every other module depends on.
    const settings = await db.sql(
      `select organization_id from public.organization_settings where organization_id = $1`,
      [created[0]!.id],
    )
    expect(settings).toHaveLength(1)
  })
})

describe('it cannot create duplicates', () => {
  it('returns the same agency when the call is repeated', async () => {
    const { userId } = await signUp(db, { email: 'retrier@provisioning.test' })

    const call = () =>
      db.asUser(userId, (session) =>
        session.sql<{ id: string }>(`select id from public.create_organization($1, $2, $3, $4)`, [
          'Retry Rentals',
          'FR',
          'EUR',
          'Europe/Paris',
        ]),
      )

    const first = await call()
    const second = await call()
    const third = await call()

    expect(second[0]?.id).toBe(first[0]?.id)
    expect(third[0]?.id).toBe(first[0]?.id)
    expect(await organizationsOwnedBy(userId)).toHaveLength(1)
  })

  it('treats a double submit with different spacing or case as the same agency', async () => {
    const { userId } = await signUp(db, { email: 'sloppy@provisioning.test' })

    await db.asUser(userId, (session) =>
      session.sql(`select id from public.create_organization($1)`, ['Sloppy Fingers Rentals']),
    )
    await db.asUser(userId, (session) =>
      session.sql(`select id from public.create_organization($1)`, ['  sloppy fingers rentals  ']),
    )

    expect(await organizationsOwnedBy(userId)).toHaveLength(1)
  })

  it('survives concurrent calls without minting two agencies', async () => {
    const { userId } = await signUp(db, { email: 'concurrent@provisioning.test' })

    // A single PGlite session serialises statements, so this exercises the
    // repeat-call path rather than true parallelism; the advisory lock in the
    // function is what covers genuine concurrency on a real connection pool.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        db.asUser(userId, (session) =>
          session.sql(`select id from public.create_organization($1)`, ['Concurrent Rentals']),
        ),
      ),
    )

    expect(await organizationsOwnedBy(userId)).toHaveLength(1)
  })

  it('still allows a genuinely different second agency', async () => {
    const { userId } = await signUp(db, { email: 'multi@provisioning.test' })

    await db.asUser(userId, (session) =>
      session.sql(`select id from public.create_organization($1)`, ['First Branch Rentals']),
    )
    await db.asUser(userId, (session) =>
      session.sql(`select id from public.create_organization($1)`, ['Second Branch Rentals']),
    )

    expect(await organizationsOwnedBy(userId)).toHaveLength(2)
  })
})

describe('it cannot reach an agency that is not the caller’s', () => {
  it('does not return another user’s agency of the same name', async () => {
    const incumbent = await signUp(db, {
      email: 'incumbent@provisioning.test',
      organizationName: 'Contested Name Rentals',
    })
    const intruder = await signUp(db, { email: 'intruder@provisioning.test' })

    const created = await db.asUser(intruder.userId, (session) =>
      session.sql<{ id: string }>(`select id from public.create_organization($1)`, [
        'Contested Name Rentals',
      ]),
    )

    // A brand new agency of their own — never the incumbent's.
    expect(created[0]?.id).not.toBe(incumbent.organizationId)

    const intruderMemberships = await db.sql(
      `select 1 from public.organization_members where user_id = $1 and organization_id = $2`,
      [intruder.userId, incumbent.organizationId],
    )
    expect(intruderMemberships).toEqual([])
  })

  it('cannot be used to join an existing agency', async () => {
    const target = await signUp(db, {
      email: 'target-agency@provisioning.test',
      organizationName: 'Target Rentals',
    })
    const outsider = await signUp(db, { email: 'outsider@provisioning.test' })

    /*
     * Three independent layers refuse this now, and the outermost one is the
     * bluntest: since 20260821100000 a signed-in user holds no INSERT privilege
     * on organization_members at all, so the statement is rejected before the
     * RLS policy or the membership guard trigger is consulted. The test asserts
     * the outcome rather than which layer spoke.
     */
    await db.expectRejection(
      () =>
        db.asUser(outsider.userId, (session) =>
          session.sql(
            `insert into public.organization_members (organization_id, user_id, role)
             values ($1, $2, 'owner')`,
            [target.organizationId, outsider.userId],
          ),
        ),
      /permission denied|only an owner can add another owner|row-level security/i,
    )

    // Also refused when they ask for the lowest role rather than owner.
    await db.expectRejection(
      () =>
        db.asUser(outsider.userId, (session) =>
          session.sql(
            `insert into public.organization_members (organization_id, user_id, role)
             values ($1, $2, 'staff')`,
            [target.organizationId, outsider.userId],
          ),
        ),
      /permission denied|row-level security/i,
    )

    const memberships = await db.sql(
      `select 1 from public.organization_members where user_id = $1`,
      [outsider.userId],
    )
    expect(memberships).toEqual([])
  })

  it('requires authentication', async () => {
    await db.asAnon(async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.create_organization('Anonymous Rentals')`),
        /permission denied/i,
      )
    })
  })

  it('rejects a name the schema cannot store', async () => {
    const { userId } = await signUp(db, { email: 'shortname@provisioning.test' })

    await db.expectRejection(
      () =>
        db.asUser(userId, (session) =>
          session.sql(`select public.create_organization($1)`, ['X']),
        ),
      /at least 2 characters/i,
    )

    expect(await organizationsOwnedBy(userId)).toHaveLength(0)
  })

  it('sanitises malformed regional values rather than failing', async () => {
    const { userId } = await signUp(db, { email: 'garbage-region@provisioning.test' })

    const created = await db.asUser(userId, (session) =>
      session.sql<{ default_currency: string; time_zone: string; country_code: string | null }>(
        `select default_currency, time_zone, country_code
         from public.create_organization($1, $2, $3, $4)`,
        ['Garbage Region Rentals', 'NOPE', 'not-a-currency', 'Mars/Olympus_Mons'],
      ),
    )

    expect(created[0]).toEqual({
      default_currency: 'USD',
      time_zone: 'UTC',
      country_code: null,
    })
  })
})
