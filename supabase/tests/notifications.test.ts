// @vitest-environment node
/**
 * Notifications & Reminders, against a real PostgreSQL.
 *
 * The failure modes this module has are not "the feature does not work" — they
 * are "the feature says something untrue". A returned car still listed as
 * overdue, a paid instalment still listed as late, a deposit counted as money
 * owed, a financing amount shown to the front desk, one person's dismissal
 * silencing another's alert. Most of what follows asserts that none of those
 * happen, because a notification list nobody believes is worse than no
 * notification list.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase

interface Cast {
  organizationId: string
  owner: string
  manager: string
  staff: string
  rivalOrg: string
  rival: string
  vehicleId: string
  customerId: string
}

let cast: Cast
let seq = 0

async function seedCast(): Promise<Cast> {
  seq += 1
  const owner = await signUp(db, {
    email: `owner${seq}@notify.test`,
    fullName: 'Owner One',
    organizationName: `Notify ${seq}`,
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error('provisioning failed')

  const manager = await signUp(db, { email: `manager${seq}@notify.test`, fullName: 'Manager One' })
  const staff = await signUp(db, { email: `staff${seq}@notify.test`, fullName: 'Staff One' })
  await addMember(db, owner.organizationId, manager.userId, 'manager')
  await addMember(db, owner.organizationId, staff.userId, 'staff')

  const rival = await signUp(db, {
    email: `rival${seq}@notify.test`,
    organizationName: `Rival ${seq}`,
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!rival.organizationId) throw new Error('rival provisioning failed')

  const [vehicle] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
     values ($1, 'Renault', 'Clio', 'NOT-${seq}', 'EUR') returning id`,
    [owner.organizationId],
  )
  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Ada', 'Lovelace') returning id`,
    [owner.organizationId],
  )

  return {
    organizationId: owner.organizationId,
    owner: owner.userId,
    manager: manager.userId,
    staff: staff.userId,
    rivalOrg: rival.organizationId,
    rival: rival.userId,
    vehicleId: vehicle!.id,
    customerId: customer!.id,
  }
}

interface FeedRow {
  fingerprint: string
  kind: string
  category: string
  severity: string
  subject_id: string | null
  subject_label: string | null
  due_on: string | null
  amount_minor: number | null
  currency: string | null
  action_path: string | null
  read_at: string | null
  dismissed_at: string | null
  total_count: string
}

async function feed(actor: string, scope = 'active', organizationId?: string): Promise<FeedRow[]> {
  return db.asUser(actor, (session) =>
    session.sql<FeedRow>(`select * from public.notification_feed($1, $2)`, [
      organizationId ?? cast.organizationId,
      scope,
    ]),
  )
}

async function unread(actor: string): Promise<number> {
  const [row] = await db.asUser(actor, (session) =>
    session.sql<{ n: number }>(`select public.notification_unread_count($1) as n`, [
      cast.organizationId,
    ]),
  )
  return Number(row!.n)
}

const kinds = (rows: FeedRow[]) => rows.map((r) => r.kind).sort()

/** A confirmed booking that starts inside the operational window. */
async function reservedRental(startsInHours: number, endsInHours: number): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `insert into public.rentals
       (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor, confirmed_at)
     values ($1, $2, $3, now() + make_interval(hours => $4), now() + make_interval(hours => $5),
             'EUR', 'reserved', 50000, now())
     returning id`,
    [cast.organizationId, cast.vehicleId, cast.customerId, startsInHours, endsInHours],
  )
  return row!.id
}

beforeAll(async () => {
  db = await TestDatabase.create()
}, 180_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  cast = await seedCast()
})

// -----------------------------------------------------------------------------
describe('the replaced foundational model', () => {
  it('no longer exposes a table any manager could post messages into', async () => {
    const table = await db.sql(`select to_regclass('public.notifications') as t`)
    expect((table[0] as { t: string | null }).t).toBeNull()
  })

  it('exposes no generic notification-creation function to a client', async () => {
    const reachable = await db.sql<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and (p.proname like '%notification%')
      order by p.proname
    `)
    // Only the eight typed operations, and not one of them creates a message.
    expect(reachable.map((r) => r.proname)).toEqual([
      'notification_dismiss',
      'notification_feed',
      'notification_mark_all_read',
      'notification_mark_read',
      'notification_preference_set',
      'notification_preferences_for',
      'notification_snooze',
      'notification_unread_count',
    ])
  })

  it('gives no client role direct access to any notification table', async () => {
    const grants = await db.sql(`
      select table_name from information_schema.role_table_grants
      where table_schema = 'public' and table_name like 'notification%'
        and grantee in ('anon', 'authenticated')
    `)
    expect(grants).toEqual([])
  })

  it('gives anon nothing at all', async () => {
    await db.asAnon(async (session) => {
      for (const statement of [
        `select * from public.notification_feed('00000000-0000-0000-0000-000000000000')`,
        `select public.notification_unread_count('00000000-0000-0000-0000-000000000000')`,
        `select public.notification_mark_read('00000000-0000-0000-0000-000000000000', 'x')`,
        `select * from public.notification_states`,
        `select * from public.notification_events`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /permission denied/i)
      }
    })
  })
})

// -----------------------------------------------------------------------------
describe('rental conditions', () => {
  it('surfaces a confirmed pickup inside the window and nothing outside it', async () => {
    await reservedRental(6, 72)
    await reservedRental(24 * 9, 24 * 10) // far future

    const rows = await feed(cast.owner)
    const pickups = rows.filter((r) => r.kind === 'rental_pickup_due')
    expect(pickups).toHaveLength(1)
    expect(pickups[0]?.action_path).toMatch(/^\/rentals\//)
  })

  it('ignores drafts and cancellations', async () => {
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
       values ($1, $2, $3, now() + interval '3 hours', now() + interval '30 hours', 'EUR', 'draft', 0),
              ($1, $2, $3, now() + interval '4 hours', now() + interval '31 hours', 'EUR', 'cancelled', 0)`,
      [cast.organizationId, cast.vehicleId, cast.customerId],
    )

    const rows = await feed(cast.owner)
    expect(rows.filter((r) => r.kind === 'rental_pickup_due')).toHaveLength(0)
  })

  it('reuses rental_is_overdue rather than a second formula', async () => {
    const [row] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
       values ($1, $2, $3, now() - interval '3 days', now() - interval '2 hours', 'EUR', 'active', 50000)
       returning id`,
      [cast.organizationId, cast.vehicleId, cast.customerId],
    )

    const rows = await feed(cast.owner)
    const overdue = rows.filter((r) => r.kind === 'rental_return_overdue')
    expect(overdue).toHaveLength(1)
    expect(overdue[0]?.severity).toBe('urgent')

    // The database's own definition agrees.
    const [check] = await db.sql<{ overdue: boolean }>(
      `select public.rental_is_overdue(status, ends_at, returned_at) as overdue
       from public.rentals where id = $1`,
      [row!.id],
    )
    expect(check?.overdue).toBe(true)
  })

  it('resolves the overdue alert when the car comes back, with nobody closing it', async () => {
    const [row] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
       values ($1, $2, $3, now() - interval '3 days', now() - interval '2 hours', 'EUR', 'active', 50000)
       returning id`,
      [cast.organizationId, cast.vehicleId, cast.customerId],
    )
    expect(kinds(await feed(cast.owner))).toContain('rental_return_overdue')

    // The domain refuses a completion that skips the return — time AND
    // odometer — so the fixture does what the product does: record the return,
    // then close the contract.
    await db.sql(
      `update public.rentals set returned_at = now(), return_odometer = 12000 where id = $1`,
      [row!.id],
    )
    await db.sql(
      `update public.rentals set status = 'completed', completed_at = now() where id = $1`,
      [row!.id],
    )

    expect(kinds(await feed(cast.owner))).not.toContain('rental_return_overdue')
  })

  it('counts an unpaid completed hire but never the deposit', async () => {
    /*
     * A deposit is the customer's money being held. Treating it as an
     * outstanding balance would invent revenue that nobody is owed.
     */
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          total_minor, deposit_minor, deposit_held_minor, completed_at, returned_at)
       values ($1, $2, $3, now() - interval '10 days', now() - interval '8 days', 'EUR', 'completed',
               40000, 30000, 30000, now(), now())`,
      [cast.organizationId, cast.vehicleId, cast.customerId],
    )

    const rows = await feed(cast.owner)
    const balance = rows.filter((r) => r.kind === 'rental_balance_outstanding')
    expect(balance).toHaveLength(1)
    // The hire total, not the hire total plus the deposit being held.
    expect(Number(balance[0]?.amount_minor)).toBe(40000)
    expect(balance[0]?.currency).toBe('EUR')
  })

  it('says nothing about a deposit on its own', async () => {
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          total_minor, amount_paid_minor, deposit_minor, deposit_held_minor)
       values ($1, $2, $3, now() - interval '1 day', now() + interval '5 days', 'EUR', 'active',
               40000, 40000, 30000, 30000)`,
      [cast.organizationId, cast.vehicleId, cast.customerId],
    )

    const rows = await feed(cast.owner)
    expect(rows.filter((r) => r.category === 'rentals')).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
describe('vehicle compliance conditions', () => {
  it('reads the agency threshold rather than a number of its own', async () => {
    await db.sql(
      `update public.organization_settings set compliance_reminder_lead_days = 10
        where organization_id = $1`,
      [cast.organizationId],
    )
    // Twenty days out: inside a 30-day default, outside this agency's 10.
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date + 20
        where id = $1`,
      [cast.vehicleId],
    )
    expect(kinds(await feed(cast.owner))).not.toContain('vehicle_compliance_due')

    await db.sql(
      `update public.organization_settings set compliance_reminder_lead_days = 30
        where organization_id = $1`,
      [cast.organizationId],
    )
    expect(kinds(await feed(cast.owner))).toContain('vehicle_compliance_due')
  })

  it('escalates from due to expired as a new episode', async () => {
    await db.sql(
      `update public.vehicles set inspection_expires_on = (now() at time zone 'Europe/Paris')::date + 5
        where id = $1`,
      [cast.vehicleId],
    )
    const due = (await feed(cast.owner)).find((r) => r.kind === 'vehicle_compliance_due')
    expect(due).toBeTruthy()

    await db.sql(
      `update public.vehicles set inspection_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )
    const rows = await feed(cast.owner)
    const expired = rows.find((r) => r.kind === 'vehicle_compliance_expired')

    expect(expired).toBeTruthy()
    expect(expired?.severity).toBe('urgent')
    // A different episode, so dismissing the warning cannot silence the expiry.
    expect(expired?.fingerprint).not.toBe(due?.fingerprint)
    expect(rows.find((r) => r.kind === 'vehicle_compliance_due')).toBeUndefined()
  })

  it('resolves when the date is corrected', async () => {
    await db.sql(
      `update public.vehicles set registration_expires_on = (now() at time zone 'Europe/Paris')::date - 3
        where id = $1`,
      [cast.vehicleId],
    )
    expect(kinds(await feed(cast.owner))).toContain('vehicle_compliance_expired')

    await db.sql(
      `update public.vehicles set registration_expires_on = (now() at time zone 'Europe/Paris')::date + 200
        where id = $1`,
      [cast.vehicleId],
    )
    expect(kinds(await feed(cast.owner))).not.toContain('vehicle_compliance_expired')
  })

  it('says nothing about a date nobody has entered', async () => {
    // An unrecorded expiry is a data-entry gap, not a vehicle driving
    // uninsured. Reports counts them apart for the same reason.
    const rows = await feed(cast.owner)
    expect(rows.filter((r) => r.category === 'compliance')).toHaveLength(0)
  })

  it('ignores an archived vehicle', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1,
              archived_at = now()
        where id = $1`,
      [cast.vehicleId],
    )
    expect(kinds(await feed(cast.owner))).not.toContain('vehicle_compliance_expired')
  })
})

// -----------------------------------------------------------------------------
describe('permission-aware generation', () => {
  it('returns no financing notification to staff, not even a redacted one', async () => {
    const [lender] = await db.sql<{ id: string }>(
      `insert into public.lenders (organization_id, name) values ($1, 'Bank') returning id`,
      [cast.organizationId],
    )
    const [agreement] = await db.sql<{ id: string }>(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, agreement_type, mode, currency,
          financed_amount_minor, rate_bps, installment_amount_minor, installments_count,
          payment_frequency, first_payment_on, schedule_anchor_day, starts_on, reference)
       values ($1, $2, $3, 'loan', 'simple', 'EUR', 1200000, 500, 110000, 12, 'monthly',
               (now() at time zone 'Europe/Paris')::date - 40, 1,
               (now() at time zone 'Europe/Paris')::date - 40, 'FIN-1')
       returning id`,
      [cast.organizationId, cast.vehicleId, lender!.id],
    )
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.financing_activate_agreement($1)`, [agreement!.id]),
    )

    const managerRows = await feed(cast.manager)
    expect(kinds(managerRows)).toContain('financing_overdue')

    const staffRows = await feed(cast.staff)
    expect(staffRows.filter((r) => r.category === 'financing')).toHaveLength(0)
    // Not the amount, not the lender, not the agreement id, not a count.
    const serialised = JSON.stringify(staffRows)
    expect(serialised).not.toContain('Bank')
    expect(serialised).not.toContain(agreement!.id)
  })

  it('offers a preference toggle only for categories the person can receive', async () => {
    const staffPrefs = await db.asUser(cast.staff, (session) =>
      session.sql<{ category: string }>(`select * from public.notification_preferences_for($1)`, [
        cast.organizationId,
      ]),
    )
    expect(staffPrefs.map((p) => p.category).sort()).toEqual(['compliance', 'rentals'])

    const ownerPrefs = await db.asUser(cast.owner, (session) =>
      session.sql<{ category: string }>(`select * from public.notification_preferences_for($1)`, [
        cast.organizationId,
      ]),
    )
    // Billing is the sixth, and the only one above admin: it is money, and
    // 'billing.manage' is owner-only in src/lib/authz/permissions.ts.
    expect(ownerPrefs.map((p) => p.category).sort()).toEqual([
      'billing',
      'compliance',
      'financing',
      'gps',
      'rentals',
      'team',
    ])
  })

  it('refuses to let somebody mute a category they never receive', async () => {
    await db.asUser(cast.staff, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.notification_preference_set($1, 'financing', true)`, [
            cast.organizationId,
          ]),
        /do not receive/i,
      )
    })
  })

  it('stops sending a category the moment a role no longer allows it', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )
    const [lender] = await db.sql<{ id: string }>(
      `insert into public.lenders (organization_id, name) values ($1, 'Bank') returning id`,
      [cast.organizationId],
    )
    const [agreement] = await db.sql<{ id: string }>(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, agreement_type, mode, currency,
          financed_amount_minor, rate_bps, installment_amount_minor, installments_count,
          payment_frequency, first_payment_on, schedule_anchor_day, starts_on, reference)
       values ($1, $2, $3, 'loan', 'simple', 'EUR', 1200000, 500, 110000, 12, 'monthly',
               (now() at time zone 'Europe/Paris')::date - 40, 1,
               (now() at time zone 'Europe/Paris')::date - 40, 'FIN-2')
       returning id`,
      [cast.organizationId, cast.vehicleId, lender!.id],
    )
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.financing_activate_agreement($1)`, [agreement!.id]),
    )

    expect(kinds(await feed(cast.manager))).toContain('financing_overdue')

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'staff')`, [
        cast.organizationId,
        cast.manager,
      ]),
    )

    // Same person, same session position, immediately without a category.
    const after = await feed(cast.manager)
    expect(after.filter((r) => r.category === 'financing')).toHaveLength(0)
    // And still receives what staff legitimately gets.
    expect(kinds(after)).toContain('vehicle_compliance_expired')
  })

  it('cuts a removed member off entirely', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )
    expect((await feed(cast.staff)).length).toBeGreaterThan(0)

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.remove_team_member($1, $2)`, [cast.organizationId, cast.staff]),
    )

    await db.asUser(cast.staff, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.notification_feed($1)`, [cast.organizationId]),
        /not a member/i,
      )
      await session.expectRejection(
        () => session.sql(`select public.notification_unread_count($1)`, [cast.organizationId]),
        /not a member/i,
      )
    })
  })
})

// -----------------------------------------------------------------------------
describe('per-user state', () => {
  beforeEach(async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )
  })

  it('keeps one person’s read state out of another’s', async () => {
    const [item] = await feed(cast.owner)
    expect(item).toBeTruthy()

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_mark_read($1, $2)`, [
        cast.organizationId,
        item!.fingerprint,
      ]),
    )

    const ownerRow = (await feed(cast.owner)).find((r) => r.fingerprint === item!.fingerprint)
    const staffRow = (await feed(cast.staff)).find((r) => r.fingerprint === item!.fingerprint)

    expect(ownerRow?.read_at).not.toBeNull()
    expect(staffRow?.read_at).toBeNull()
  })

  it('keeps the same fingerprint across refreshes', async () => {
    const first = await feed(cast.owner)
    const second = await feed(cast.owner)
    expect(first.map((r) => r.fingerprint)).toEqual(second.map((r) => r.fingerprint))
  })

  it('hides a dismissed episode for that person only, and resolves nothing', async () => {
    const [item] = await feed(cast.owner)
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_dismiss($1, $2)`, [
        cast.organizationId,
        item!.fingerprint,
      ]),
    )

    expect((await feed(cast.owner)).find((r) => r.fingerprint === item!.fingerprint)).toBeUndefined()
    expect((await feed(cast.staff)).find((r) => r.fingerprint === item!.fingerprint)).toBeTruthy()
    // Still there when looking back, and the vehicle is still uninsured.
    expect((await feed(cast.owner, 'all')).find((r) => r.fingerprint === item!.fingerprint)).toBeTruthy()
  })

  it('does not let a dismissed warning silence the escalation that follows', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = null,
              inspection_expires_on = (now() at time zone 'Europe/Paris')::date + 3
        where id = $1`,
      [cast.vehicleId],
    )
    const due = (await feed(cast.owner)).find((r) => r.kind === 'vehicle_compliance_due')
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_dismiss($1, $2)`, [
        cast.organizationId,
        due!.fingerprint,
      ]),
    )
    expect(kinds(await feed(cast.owner))).not.toContain('vehicle_compliance_due')

    await db.sql(
      `update public.vehicles set inspection_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )

    const escalated = await feed(cast.owner)
    expect(kinds(escalated)).toContain('vehicle_compliance_expired')
    expect(escalated.find((r) => r.kind === 'vehicle_compliance_expired')?.read_at).toBeNull()
  })

  it('hides a snoozed item until its time and refuses silly values', async () => {
    const [item] = await feed(cast.owner)
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_snooze($1, $2, now() + interval '1 day')`, [
        cast.organizationId,
        item!.fingerprint,
      ]),
    )
    expect((await feed(cast.owner)).find((r) => r.fingerprint === item!.fingerprint)).toBeUndefined()

    await db.sql(
      `update public.notification_states set snoozed_until = now() - interval '1 minute'
        where fingerprint = $1`,
      [item!.fingerprint],
    )
    expect((await feed(cast.owner)).find((r) => r.fingerprint === item!.fingerprint)).toBeTruthy()

    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.notification_snooze($1, $2, now() - interval '1 hour')`, [
            cast.organizationId,
            item!.fingerprint,
          ]),
        /time in the future/i,
      )
      await session.expectRejection(
        () =>
          session.sql(`select public.notification_snooze($1, $2, now() + interval '400 days')`, [
            cast.organizationId,
            item!.fingerprint,
          ]),
        /that far ahead/i,
      )
    })
  })

  it('writes nothing for a notification the caller does not have', async () => {
    /*
     * The fingerprint is a string the client sends, so the three state writes
     * were happy to store a row for anything at all — fifty in a loop, in the
     * probe that found this. Presentation state now belongs to a condition that
     * is genuinely true for this person, which bounds the table by the domain
     * rather than by how many times somebody clicks.
     *
     * Silently, not with an error: dismissing something at the moment a
     * colleague resolves it is not a mistake, and an error toast for a
     * notification that fixed itself would misdescribe what happened.
     */
    await reservedRental(6, 72)
    const invented = 'vehicle_compliance_expired:00000000-0000-0000-0000-000000000000:insurance:2020-01-01'

    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.notification_mark_read($1, $2)`, [
        cast.organizationId,
        invented,
      ])
      await session.sql(`select public.notification_dismiss($1, $2)`, [
        cast.organizationId,
        'junk',
      ])
      await session.sql(`select public.notification_snooze($1, $2, now() + interval '1 day')`, [
        cast.organizationId,
        'junk-2',
      ])
    })

    const [stored] = await db.sql<{ n: number }>(
      `select count(*)::int as n from public.notification_states where organization_id = $1`,
      [cast.organizationId],
    )
    expect(stored!.n).toBe(0)
  })

  it('refuses a fingerprint no notification could ever have', async () => {
    await db.asUser(cast.owner, async (session) => {
      for (const statement of [
        `select public.notification_mark_read($1, $2)`,
        `select public.notification_dismiss($1, $2)`,
      ]) {
        await session.expectRejection(
          () => session.sql(statement, [cast.organizationId, 'x'.repeat(5000)]),
          /a notification is required/i,
        )
      }
      await session.expectRejection(
        () =>
          session.sql(`select public.notification_snooze($1, $2, now() + interval '1 day')`, [
            cast.organizationId,
            'x'.repeat(5000),
          ]),
        /a notification is required/i,
      )
    })
  })

  it('still records state for something the caller really has', async () => {
    await reservedRental(6, 72)
    const [item] = await feed(cast.owner)
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_dismiss($1, $2)`, [
        cast.organizationId,
        item!.fingerprint,
      ]),
    )
    const [stored] = await db.sql<{ n: number }>(
      `select count(*)::int as n from public.notification_states
        where organization_id = $1 and user_id = $2 and dismissed_at is not null`,
      [cast.organizationId, cast.owner],
    )
    expect(stored!.n).toBe(1)
  })

  it('keeps the badge and the drawer telling the same story', async () => {
    await reservedRental(6, 72)
    const active = await feed(cast.owner, 'unread')
    expect(await unread(cast.owner)).toBe(active.length)

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_mark_read($1, $2)`, [
        cast.organizationId,
        active[0]!.fingerprint,
      ]),
    )
    expect(await unread(cast.owner)).toBe(active.length - 1)

    const marked = await db.asUser(cast.owner, (session) =>
      session.sql<{ n: number }>(`select public.notification_mark_all_read($1) as n`, [
        cast.organizationId,
      ]),
    )
    expect(Number(marked[0]!.n)).toBe(active.length - 1)
    expect(await unread(cast.owner)).toBe(0)
    // Read is not dismissed: the items are still on screen.
    expect((await feed(cast.owner)).length).toBe(active.length)
  })

  it('is idempotent about reading twice', async () => {
    const [item] = await feed(cast.owner)

    // Read through the feed, because the state table is deliberately
    // unreachable by any client role — a direct select is refused.
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.notification_states`),
        /permission denied/i,
      )
    })

    const readOnce = async () => {
      await db.asUser(cast.owner, (session) =>
        session.sql(`select public.notification_mark_read($1, $2)`, [
          cast.organizationId,
          item!.fingerprint,
        ]),
      )
      const row = (await feed(cast.owner)).find((r) => r.fingerprint === item!.fingerprint)
      return row!.read_at
    }

    const first = await readOnce()
    const second = await readOnce()
    // The first time it was read is when it was read. Compared by value: the
    // driver hands back Date objects, and two equal instants are not the same
    // object.
    expect(String(second)).toBe(String(first))
  })
})

// -----------------------------------------------------------------------------
describe('event notifications', () => {
  it('reaches the administrators who were there, and not the actor', async () => {
    const admin = await signUp(db, { email: `admin${seq}@notify.test`, fullName: 'Admin One' })
    await addMember(db, cast.organizationId, admin.userId, 'admin')

    const joiner = await signUp(db, { email: `joiner${seq}@notify.test`, fullName: 'Joiner' })
    const invitation = await db.asUser(cast.owner, (session) =>
      session.sql<{ token: string }>(
        `select * from public.create_team_invitation($1, $2, 'staff')`,
        [cast.organizationId, `joiner${seq}@notify.test`],
      ),
    )
    await db.asUser(joiner.userId, (session) =>
      session.sql(`select * from public.accept_team_invitation($1)`, [invitation[0]!.token]),
    )

    // The owner sent the invitation; the acceptance was the joiner's action.
    const ownerRows = await feed(cast.owner)
    const adminRows = await feed(admin.userId)
    expect(kinds(ownerRows)).toContain('team_invitation_accepted')
    expect(kinds(adminRows)).toContain('team_invitation_accepted')
  })

  it('does not tell somebody about their own action', async () => {
    const admin = await signUp(db, { email: `selfact${seq}@notify.test`, fullName: 'Self Actor' })
    await addMember(db, cast.organizationId, admin.userId, 'admin')

    await db.asUser(admin.userId, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'manager')`, [
        cast.organizationId,
        cast.staff,
      ]),
    )

    expect(kinds(await feed(admin.userId))).not.toContain('team_role_changed')
    // The owner, who did not do it, is told.
    expect(kinds(await feed(cast.owner))).toContain('team_role_changed')
  })

  it('names as a recipient only somebody who could read it', async () => {
    /*
     * The audience used to be "the administrators, plus the person it was
     * about". Demote a manager and that person is the subject and no longer an
     * administrator, so the recipient row claimed they had been told about
     * something the permission model would never show them.
     *
     * A promotion is the other direction and still reaches them, because after
     * it they are an administrator.
     */
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'staff')`, [
        cast.organizationId,
        cast.manager,
      ]),
    )

    const [demoted] = await db.sql<{ n: number }>(
      `select count(*)::int as n
         from public.notification_event_recipients r
         join public.notification_events e on e.id = r.event_id
        where e.organization_id = $1 and r.user_id = $2`,
      [cast.organizationId, cast.manager],
    )
    expect(demoted!.n).toBe(0)

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
        cast.organizationId,
        cast.manager,
      ]),
    )
    const promoted = await feed(cast.manager, 'all')
    expect(promoted.filter((r) => r.kind === 'team_role_changed')).toHaveLength(1)
  })

  it('does not deliver history to somebody who joined afterwards', async () => {
    /*
     * The reason the audience is written when the event happens. Recomputing it
     * from today's roles would greet a new administrator with months of other
     * people's history, presented as news.
     */
    const witness = await signUp(db, { email: `witness${seq}@notify.test`, fullName: 'Witness' })
    await addMember(db, cast.organizationId, witness.userId, 'admin')

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'manager')`, [
        cast.organizationId,
        cast.staff,
      ]),
    )
    // Present at the time, and not the actor.
    expect(kinds(await feed(witness.userId))).toContain('team_role_changed')

    const latecomer = await signUp(db, { email: `late${seq}@notify.test`, fullName: 'Latecomer' })
    await addMember(db, cast.organizationId, latecomer.userId, 'admin')

    // Same role, same agency, arrived afterwards: not their news.
    expect(await feed(latecomer.userId)).toHaveLength(0)
  })

  it('produces one notification for one audit row, however often it is retried', async () => {
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'manager')`, [
        cast.organizationId,
        cast.staff,
      ]),
    )

    const [event] = await db.sql<{ id: string; source_id: string }>(
      `select id, source_id from public.notification_events
        where organization_id = $1 and kind = 'team_role_changed'`,
      [cast.organizationId],
    )

    // Replaying the same authoritative row is the same notification.
    await db.sql(
      `insert into public.notification_events
         (organization_id, kind, severity, occurred_at, actor_label, subject_label,
          source_table, source_id)
       values ($1, 'team_role_changed', 'info', now(), 'x', 'y', 'organization_team_events', $2)
       on conflict (organization_id, source_table, source_id) do nothing`,
      [cast.organizationId, event!.source_id],
    )

    const all = await db.sql(
      `select 1 from public.notification_events where organization_id = $1 and kind = 'team_role_changed'`,
      [cast.organizationId],
    )
    expect(all).toHaveLength(1)
  })

  it('cannot be edited or deleted once written', async () => {
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'manager')`, [
        cast.organizationId,
        cast.staff,
      ]),
    )
    await db.expectRejection(
      () => db.sql(`update public.notification_events set actor_label = 'forged'`),
      /written by the domain/i,
    )
    await db.expectRejection(
      () => db.sql(`delete from public.notification_events`),
      /written by the domain/i,
    )
  })

  it('does not make an Auth account undeletable', async () => {
    /*
     * The same regression the Team audit log had, and for the same reason: an
     * event names an actor and a subject with ON DELETE SET NULL, and that
     * referential action is an UPDATE. A guard that refused it would make
     * anybody who had ever appeared in a notification impossible to delete from
     * Auth — a product that cannot honour an erasure request.
     *
     * What the notification SAYS is snapshotted text, so it survives intact.
     */
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.remove_team_member($1, $2)`, [cast.organizationId, cast.staff]),
    )

    const [before] = await db.sql<{ subject_label: string }>(
      `select subject_label from public.notification_events
        where organization_id = $1 and kind = 'team_member_removed'`,
      [cast.organizationId],
    )
    expect(before?.subject_label).toBeTruthy()

    await db.sql(`delete from auth.users where id = $1`, [cast.staff])

    const [after] = await db.sql<{ subject_label: string; subject_user_id: string | null }>(
      `select subject_label, subject_user_id from public.notification_events
        where organization_id = $1 and kind = 'team_member_removed'`,
      [cast.organizationId],
    )
    expect(after?.subject_label).toBe(before?.subject_label)
    expect(after?.subject_user_id).toBeNull()
  })

  it('does not make an agency undeletable', async () => {
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'manager')`, [
        cast.organizationId,
        cast.staff,
      ]),
    )

    // Deleting the agency cascades into its notifications; refusing the cascade
    // would keep the history and lose the ability to close an account.
    await db.sql(`delete from public.organizations where id = $1`, [cast.organizationId])

    const left = await db.sql(`select 1 from public.notification_events where organization_id = $1`, [
      cast.organizationId,
    ])
    expect(left).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
describe('tenant isolation', () => {
  it('refuses another agency’s feed, count and preferences', async () => {
    await db.asUser(cast.rival, async (session) => {
      for (const statement of [
        `select * from public.notification_feed('${cast.organizationId}')`,
        `select public.notification_unread_count('${cast.organizationId}')`,
        `select * from public.notification_preferences_for('${cast.organizationId}')`,
        `select public.notification_mark_all_read('${cast.organizationId}')`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /not a member/i)
      }
    })
  })

  it('will not write state into an agency the caller does not belong to', async () => {
    await db.asUser(cast.rival, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.notification_mark_read($1, 'anything')`, [
            cast.organizationId,
          ]),
        /not a member/i,
      )
    })

    const leaked = await db.sql(
      `select 1 from public.notification_states where organization_id = $1 and user_id = $2`,
      [cast.organizationId, cast.rival],
    )
    expect(leaked).toEqual([])
  })

  it('keeps two agencies’ conditions apart for the same person', async () => {
    // A consultant in both agencies sees each agency's own alerts, in that
    // agency's feed, and never the other's.
    await addMember(db, cast.rivalOrg, cast.owner, 'manager')
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )

    const here = await feed(cast.owner)
    const there = await feed(cast.owner, 'active', cast.rivalOrg)

    expect(kinds(here)).toContain('vehicle_compliance_expired')
    expect(there).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
describe('preferences', () => {
  it('mutes for one person and nobody else', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_preference_set($1, 'compliance', true)`, [
        cast.organizationId,
      ]),
    )

    expect(kinds(await feed(cast.owner))).not.toContain('vehicle_compliance_expired')
    expect(kinds(await feed(cast.staff))).toContain('vehicle_compliance_expired')

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_preference_set($1, 'compliance', false)`, [
        cast.organizationId,
      ]),
    )
    expect(kinds(await feed(cast.owner))).toContain('vehicle_compliance_expired')
  })

  it('works before anybody configures anything', async () => {
    const prefs = await db.asUser(cast.staff, (session) =>
      session.sql<{ muted: boolean }>(`select * from public.notification_preferences_for($1)`, [
        cast.organizationId,
      ]),
    )
    expect(prefs.every((p) => p.muted === false)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
describe('ordering and scopes', () => {
  it('puts urgent before attention before informational', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1,
              inspection_expires_on = (now() at time zone 'Europe/Paris')::date + 3
        where id = $1`,
      [cast.vehicleId],
    )
    await reservedRental(6, 72)

    const rows = await feed(cast.owner)
    const rank = { urgent: 0, attention: 1, info: 2 } as Record<string, number>
    const order = rows.map((r) => rank[r.severity]!)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('separates the attention scope from everything else', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1
        where id = $1`,
      [cast.vehicleId],
    )
    const attention = await feed(cast.owner, 'attention')
    expect(attention.every((r) => r.severity !== 'info')).toBe(true)
  })

  it('refuses an unknown scope rather than quietly showing everything', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.notification_feed($1, 'everything')`, [
          cast.organizationId,
        ]),
        /unknown notification scope/i,
      )
    })
  })

  it('reports a total independent of the page size', async () => {
    await db.sql(
      `update public.vehicles set insurance_expires_on = (now() at time zone 'Europe/Paris')::date - 1,
              inspection_expires_on = (now() at time zone 'Europe/Paris')::date - 2,
              registration_expires_on = (now() at time zone 'Europe/Paris')::date - 3
        where id = $1`,
      [cast.vehicleId],
    )
    const page = await db.asUser(cast.owner, (session) =>
      session.sql<FeedRow>(`select * from public.notification_feed($1, 'active', 2, 0)`, [
        cast.organizationId,
      ]),
    )
    expect(page).toHaveLength(2)
    expect(Number(page[0]!.total_count)).toBe(3)
  })
})

// -----------------------------------------------------------------------------
describe('the agency’s clock', () => {
  it('decides expiry by the agency date, not the server’s', async () => {
    /*
     * The agency is in Europe/Paris. A document expiring "today" there must not
     * read as expired because a UTC server has not reached midnight yet, or the
     * reverse. app.organization_today() is the one definition.
     */
    const [today] = await db.sql<{ agency: string }>(
      `select app.organization_today($1)::text as agency`,
      [cast.organizationId],
    )
    await db.sql(`update public.vehicles set insurance_expires_on = $2::date where id = $1`, [
      cast.vehicleId,
      today!.agency,
    ])

    const rows = await feed(cast.owner)
    // Expiring today is due, not yet expired.
    expect(kinds(rows)).toContain('vehicle_compliance_due')
    expect(kinds(rows)).not.toContain('vehicle_compliance_expired')
  })
})
