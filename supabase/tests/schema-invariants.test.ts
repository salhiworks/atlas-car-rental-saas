// @vitest-environment node
/**
 * Business invariants that live in the database rather than in application code:
 * availability, contract numbering, settlement arithmetic, role safety and the
 * role-based permission matrix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let vehicleId: string
let customerId: string

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@invariants.test',
    fullName: 'Invariant Owner',
    organizationName: 'Invariant Motors',
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')

  ownerId = owner.userId
  organizationId = owner.organizationId

  const [vehicle] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
     values ($1, 'Renault', 'Clio', 'INV-001', 'EUR', 4500) returning id`,
    [organizationId],
  )
  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Ada', 'Lovelace') returning id`,
    [organizationId],
  )
  vehicleId = vehicle!.id
  customerId = customer!.id
}, 120_000)

afterAll(async () => {
  await db?.close()
})

async function createRental(options: {
  startsAt: string
  endsAt: string
  status?: string
  totalMinor?: number
  currency?: string
}): Promise<{ id: string; reference: string }> {
  const [row] = await db.sql<{ id: string; reference: string }>(
    `insert into public.rentals
       (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::public.rental_status, $8)
     returning id, reference`,
    [
      organizationId,
      vehicleId,
      customerId,
      options.startsAt,
      options.endsAt,
      options.currency ?? 'EUR',
      options.status ?? 'reserved',
      options.totalMinor ?? 0,
    ],
  )
  return row!
}

describe('vehicle availability', () => {
  it('blocks a second commitment overlapping the first', async () => {
    await createRental({ startsAt: '2026-03-01T09:00:00Z', endsAt: '2026-03-05T09:00:00Z' })

    await db.expectRejection(
      () => createRental({ startsAt: '2026-03-04T09:00:00Z', endsAt: '2026-03-08T09:00:00Z' }),
      /rentals_no_vehicle_overlap|conflicting key value/i,
    )
  })

  it('allows a back-to-back booking that starts exactly at the previous return', async () => {
    // The range is half-open, so handover at the boundary is not a conflict.
    const rental = await createRental({
      startsAt: '2026-03-05T09:00:00Z',
      endsAt: '2026-03-07T09:00:00Z',
    })
    expect(rental.id).toBeTruthy()
  })

  it('does not let drafts or cancellations hold a vehicle', async () => {
    const draft = await createRental({
      startsAt: '2026-03-02T09:00:00Z',
      endsAt: '2026-03-04T09:00:00Z',
      status: 'draft',
    })
    expect(draft.id).toBeTruthy()

    const cancelled = await createRental({
      startsAt: '2026-03-02T10:00:00Z',
      endsAt: '2026-03-04T10:00:00Z',
      status: 'cancelled',
    })
    expect(cancelled.id).toBeTruthy()
  })

  it('rejects promoting a draft into a period that is already committed', async () => {
    const draft = await createRental({
      startsAt: '2026-03-03T09:00:00Z',
      endsAt: '2026-03-04T09:00:00Z',
      status: 'draft',
    })

    await db.expectRejection(
      () => db.sql(`update public.rentals set status = 'reserved' where id = $1`, [draft.id]),
      /rentals_no_vehicle_overlap|conflicting key value/i,
    )
  })

  it('rejects a contract that ends before it starts', async () => {
    await db.expectRejection(
      () => createRental({ startsAt: '2026-06-10T09:00:00Z', endsAt: '2026-06-09T09:00:00Z' }),
      /rentals_period_valid/i,
    )
  })
})

describe('contract numbering', () => {
  it('assigns sequential references using the agency prefix', async () => {
    const [settings] = await db.sql<{ rental_reference_prefix: string }>(
      `select rental_reference_prefix from public.organization_settings where organization_id = $1`,
      [organizationId],
    )

    const first = await createRental({
      startsAt: '2027-01-01T09:00:00Z',
      endsAt: '2027-01-02T09:00:00Z',
    })
    const second = await createRental({
      startsAt: '2027-02-01T09:00:00Z',
      endsAt: '2027-02-02T09:00:00Z',
    })

    // PREFIX-YYYY-NNNNN. The year segment is on by default because an agency
    // filing contracts wants the year on the number.
    const pattern = new RegExp(`^${settings!.rental_reference_prefix}-\\d{4}-\\d{5}$`)
    expect(first.reference).toMatch(pattern)
    expect(second.reference).toMatch(pattern)

    const firstNumber = Number(first.reference.split('-')[2])
    const secondNumber = Number(second.reference.split('-')[2])
    expect(secondNumber).toBe(firstNumber + 1)
  })

  it('keeps references unique within an agency', async () => {
    const existing = await createRental({
      startsAt: '2027-03-01T09:00:00Z',
      endsAt: '2027-03-02T09:00:00Z',
    })

    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.rentals
             (organization_id, reference, vehicle_id, customer_id, starts_at, ends_at, currency)
           values ($1, $2, $3, $4, '2028-01-01T09:00:00Z', '2028-01-02T09:00:00Z', 'EUR')`,
          [organizationId, existing.reference, vehicleId, customerId],
        ),
      /rentals_reference_unique|duplicate key/i,
    )
  })
})

describe('settlement', () => {
  it('keeps the contract balance in step with its payments', async () => {
    const rental = await createRental({
      startsAt: '2029-01-01T09:00:00Z',
      endsAt: '2029-01-05T09:00:00Z',
      totalMinor: 20000,
    })

    const read = async () =>
      (
        await db.sql<{ amount_paid_minor: number; balance_due_minor: number; payment_status: string }>(
          `select amount_paid_minor, balance_due_minor, payment_status from public.rentals where id = $1`,
          [rental.id],
        )
      )[0]!

    expect(await read()).toMatchObject({ payment_status: 'unpaid' })

    const [firstPayment] = await db.sql<{ id: string }>(
      `insert into public.payments (organization_id, rental_id, amount_minor, currency)
       values ($1, $2, 5000, 'EUR') returning id`,
      [organizationId, rental.id],
    )
    expect(await read()).toMatchObject({
      amount_paid_minor: 5000,
      balance_due_minor: 15000,
      payment_status: 'partially_paid',
    })

    await db.sql(
      `insert into public.payments (organization_id, rental_id, amount_minor, currency)
       values ($1, $2, 15000, 'EUR')`,
      [organizationId, rental.id],
    )
    expect(await read()).toMatchObject({ balance_due_minor: 0, payment_status: 'paid' })

    // A refund moves the balance back out.
    await db.sql(
      `insert into public.payments (organization_id, rental_id, amount_minor, currency, direction)
       values ($1, $2, 5000, 'EUR', 'outbound')`,
      [organizationId, rental.id],
    )
    expect(await read()).toMatchObject({ amount_paid_minor: 15000, payment_status: 'partially_paid' })

    // Removing a receipt is reflected too — the total is recomputed, not nudged.
    await db.sql(`delete from public.payments where id = $1`, [firstPayment!.id])
    expect(await read()).toMatchObject({ amount_paid_minor: 10000 })
  })

  it('refuses a payment denominated in another currency than the contract', async () => {
    const rental = await createRental({
      startsAt: '2029-02-01T09:00:00Z',
      endsAt: '2029-02-05T09:00:00Z',
      totalMinor: 10000,
      currency: 'EUR',
    })

    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.payments (organization_id, rental_id, amount_minor, currency)
           values ($1, $2, 5000, 'USD')`,
          [organizationId, rental.id],
        ),
      /does not match the contract currency/i,
    )
  })

  it('ignores a direct write to the derived paid amount', async () => {
    const rental = await createRental({
      startsAt: '2029-03-01T09:00:00Z',
      endsAt: '2029-03-05T09:00:00Z',
      totalMinor: 10000,
    })

    await db.sql(`update public.rentals set amount_paid_minor = 999999 where id = $1`, [rental.id])

    const [after] = await db.sql<{ amount_paid_minor: number }>(
      `select amount_paid_minor from public.rentals where id = $1`,
      [rental.id],
    )
    expect(after?.amount_paid_minor).toBe(0)
  })

  it('rejects a non-positive payment', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.payments (organization_id, amount_minor, currency) values ($1, 0, 'EUR')`,
          [organizationId],
        ),
      /payments_amount_minor_check|violates check constraint/i,
    )
  })
})

/**
 * Membership safety.
 *
 * The Team module (20260821100000) took INSERT, UPDATE and DELETE on
 * organization_members away from `authenticated` entirely, so a browser can no
 * longer reach app.guard_membership_changes() to be refused by it — it is
 * refused one layer earlier, by the absence of the privilege. Both layers are
 * asserted here: the grant is gone, and the trigger still refuses the roles that
 * do keep write access.
 *
 * The invariants themselves — who may grant what, the last-owner rule, no
 * self-promotion — are exercised against the domain functions that now own them
 * in supabase/tests/team.test.ts.
 */
describe('membership safety', () => {
  it('gives a signed-in user no way to write membership at all', async () => {
    const staff = await signUp(db, { email: 'selfpromote@invariants.test' })
    await addMember(db, organizationId, staff.userId, 'admin')

    await db.asUser(staff.userId, async (session) => {
      for (const statement of [
        `update public.organization_members set role = 'owner' where user_id = '${staff.userId}'`,
        `delete from public.organization_members where user_id = '${ownerId}'`,
        `insert into public.organization_members (organization_id, user_id, role)
           values ('${organizationId}', '${staff.userId}', 'owner')`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /permission denied/i)
      }
    })

    // And nothing moved.
    const [row] = await db.sql<{ role: string }>(
      `select role from public.organization_members where user_id = $1`,
      [staff.userId],
    )
    expect(row?.role).toBe('admin')
  })

  it('still refuses to remove the last active owner on a path that kept its grants', async () => {
    await db.expectRejection(
      () =>
        db.asServiceRole(ownerId, (session) =>
          session.sql(`delete from public.organization_members where user_id = $1`, [ownerId]),
        ),
      /at least one active owner/i,
    )
  })

  it('still refuses to demote the last active owner', async () => {
    await db.expectRejection(
      () =>
        db.asServiceRole(ownerId, (session) =>
          session.sql(`update public.organization_members set role = 'admin' where user_id = $1`, [
            ownerId,
          ]),
        ),
      /change your own role|at least one active owner/i,
    )
  })

  it('still stops a member from changing their own role', async () => {
    const staff = await signUp(db, { email: 'selfpromote2@invariants.test' })
    await addMember(db, organizationId, staff.userId, 'admin')

    await db.expectRejection(
      () =>
        db.asServiceRole(staff.userId, (session) =>
          session.sql(`update public.organization_members set role = 'owner' where user_id = $1`, [
            staff.userId,
          ]),
        ),
      /change your own role/i,
    )
  })

  it('still stops an admin from minting a new owner', async () => {
    const admin = await signUp(db, { email: 'admin@invariants.test' })
    const target = await signUp(db, { email: 'target@invariants.test' })
    await addMember(db, organizationId, admin.userId, 'admin')

    await db.expectRejection(
      () =>
        db.asServiceRole(admin.userId, (session) =>
          session.sql(
            `insert into public.organization_members (organization_id, user_id, role)
             values ($1, $2, 'owner')`,
            [organizationId, target.userId],
          ),
        ),
      /only an owner can add another owner/i,
    )
  })

  it('lets an owner promote someone else to owner on that same path', async () => {
    const heir = await signUp(db, { email: 'heir@invariants.test' })

    await db.asServiceRole(ownerId, (session) =>
      session.sql(
        `insert into public.organization_members (organization_id, user_id, role)
         values ($1, $2, 'owner')`,
        [organizationId, heir.userId],
      ),
    )

    const owners = await db.sql(
      `select 1 from public.organization_members
       where organization_id = $1 and role = 'owner' and status = 'active'`,
      [organizationId],
    )
    expect(owners.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * Deleting an Auth account.
 *
 * Fifteen columns across eight modules reference auth.users ON DELETE SET NULL
 * and sit in a freeze_columns list. `app.freeze_columns` does not refuse an
 * unexpected update, it RESTORES the old value — so the referential action was
 * silently undone, and because the column then matched its previous value
 * PostgreSQL skipped the constraint re-check and the DELETE committed anyway,
 * leaving rows that violate foreign keys they still declare. Verified before it
 * was fixed; these hold it closed.
 */
describe('account deletion is a referential action, not an edit', () => {
  it('clears provenance across every module and leaves nothing dangling', async () => {
    const leaving = await signUp(db, {
      email: 'erasure@invariants.test',
      organizationName: 'Erasure Probe',
    })
    expect(leaving.organizationId).not.toBeNull()

    await db.sql(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, created_by)
       values ($1, 'Probe', 'One', 'ERASE-1', 'EUR', $2)`,
      [leaving.organizationId, leaving.userId],
    )
    await db.sql(
      `insert into public.customers (organization_id, first_name, last_name, created_by)
       values ($1, 'Erase', 'Probe', $2)`,
      [leaving.organizationId, leaving.userId],
    )
    await db.sql(
      `insert into public.payments (organization_id, amount_minor, currency, paid_at, recorded_by)
       values ($1, 2500, 'EUR', now(), $2)`,
      [leaving.organizationId, leaving.userId],
    )

    await db.sql(`delete from auth.users where id = $1`, [leaving.userId])

    const [row] = await db.sql<{
      org: string | null
      vehicle: string | null
      customer: string | null
      payment: string | null
    }>(
      `select
         (select created_by from public.organizations where id = $1) as org,
         (select created_by from public.vehicles where registration_plate = 'ERASE-1') as vehicle,
         (select created_by from public.customers where last_name = 'Probe' and organization_id = $1) as customer,
         (select recorded_by from public.payments where organization_id = $1) as payment`,
      [leaving.organizationId],
    )
    expect(row).toEqual({ org: null, vehicle: null, customer: null, payment: null })

    /*
     * And nothing ANYWHERE still points at an account that is gone. Every
     * single-column foreign key into auth.users is enumerated from the
     * catalogue and counted, so a column added by a future module is covered
     * without anybody remembering to add it here — and a dump and restore
     * would fail to recreate the constraint if one were left dangling.
     */
    const columns = await db.sql<{ table_name: string; column_name: string }>(`
      select c.relname as table_name, a.attname as column_name
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
      join pg_class f on f.oid = k.confrelid
      join pg_namespace fn on fn.oid = f.relnamespace
      where k.contype = 'f' and n.nspname = 'public'
        and fn.nspname = 'auth' and f.relname = 'users'
        and array_length(k.conkey, 1) = 1
      order by 1, 2
    `)
    expect(columns.length).toBeGreaterThan(10)

    const dangling: string[] = []
    for (const column of columns) {
      const [count] = await db.sql<{ n: string }>(
        `select count(*)::text as n from public."${column.table_name}" t
          where t."${column.column_name}" is not null
            and not exists (select 1 from auth.users u where u.id = t."${column.column_name}")`,
      )
      if (Number(count!.n) > 0) {
        dangling.push(`${column.table_name}.${column.column_name} (${count!.n})`)
      }
    }
    expect(dangling).toEqual([])
  })

  it('still refuses a client clearing the provenance of a live account', async () => {
    const author = await signUp(db, { email: 'liveauthor@invariants.test' })
    await addMember(db, organizationId, author.userId, 'manager')

    await db.sql(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, created_by)
       values ($1, 'Probe', 'Two', 'ERASE-2', 'EUR', $2)`,
      [organizationId, author.userId],
    )

    // The exception is keyed on the account being gone, not on who is asking,
    // so it cannot be used to erase who did what.
    await db.sql(`update public.vehicles set created_by = null where registration_plate = 'ERASE-2'`)

    const [row] = await db.sql<{ created_by: string | null }>(
      `select created_by from public.vehicles where registration_plate = 'ERASE-2'`,
    )
    expect(row?.created_by).toBe(author.userId)
  })

  it('lets an ordinary member edit a row while echoing a frozen column back', async () => {
    /*
     * The freeze is meant to tolerate a client that sends the whole row back,
     * including columns it did not intend to change. When the NULL exception
     * was first added the trigger was still SECURITY INVOKER, so its lookup
     * against auth.users — a table no client role may read — turned that
     * tolerance into "permission denied for table users" and lost the entire
     * update. Verified as a real failure before it was fixed.
     */
    const author = await signUp(db, { email: 'echo@invariants.test' })
    await addMember(db, organizationId, author.userId, 'manager')

    await db.sql(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, created_by)
       values ($1, 'Probe', 'Four', 'ERASE-4', 'EUR', $2)`,
      [organizationId, author.userId],
    )

    await db.asUser(author.userId, (session) =>
      session.sql(
        `update public.vehicles set created_by = null, model = 'Five'
          where registration_plate = 'ERASE-4'`,
      ),
    )

    const [row] = await db.sql<{ created_by: string | null; model: string }>(
      `select created_by, model from public.vehicles where registration_plate = 'ERASE-4'`,
    )
    // The edit landed; the provenance did not move.
    expect(row?.model).toBe('Five')
    expect(row?.created_by).toBe(author.userId)
  })

  it('still refuses a client pointing provenance at somebody else', async () => {
    const author = await signUp(db, { email: 'author3@invariants.test' })
    const other = await signUp(db, { email: 'other3@invariants.test' })

    await db.sql(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, created_by)
       values ($1, 'Probe', 'Three', 'ERASE-3', 'EUR', $2)`,
      [organizationId, author.userId],
    )
    await db.sql(`update public.vehicles set created_by = $1 where registration_plate = 'ERASE-3'`, [
      other.userId,
    ])

    const [row] = await db.sql<{ created_by: string | null }>(
      `select created_by from public.vehicles where registration_plate = 'ERASE-3'`,
    )
    expect(row?.created_by).toBe(author.userId)
  })
})

describe('role-based permissions', () => {
  it('lets staff record a customer but not add a vehicle', async () => {
    const staff = await signUp(db, { email: 'staff@invariants.test' })
    await addMember(db, organizationId, staff.userId, 'staff')

    await db.asUser(staff.userId, async (session) => {
      await session.sql(
        `insert into public.customers (organization_id, first_name, last_name)
         values ($1, 'Walk', 'In')`,
        [organizationId],
      )

      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
             values ($1, 'Ford', 'Focus', 'STAFF-1', 'EUR')`,
            [organizationId],
          ),
        /row-level security/i,
      )
    })
  })

  it('lets a manager add a vehicle', async () => {
    const manager = await signUp(db, { email: 'manager@invariants.test' })
    await addMember(db, organizationId, manager.userId, 'manager')

    await db.asUser(manager.userId, (session) =>
      session.sql(
        `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
         values ($1, 'Ford', 'Focus', 'MGR-1', 'EUR')`,
        [organizationId],
      ),
    )

    const rows = await db.sql(
      `select id from public.vehicles where organization_id = $1 and registration_plate = 'MGR-1'`,
      [organizationId],
    )
    expect(rows).toHaveLength(1)
  })

  it('hides financing terms from staff and shows them to managers', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Iveco', 'Daily', 'FIN-RLS-1', 'EUR', 5000) returning id`,
      [organizationId],
    )
    const [lender] = await db.sql<{ id: string }>(
      `insert into public.lenders (organization_id, name) values ($1, 'Bank of Test') returning id`,
      [organizationId],
    )
    await db.sql(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, currency, financed_amount_minor,
          starts_on, first_payment_on, schedule_anchor_day)
       values ($1, $2, $3, 'EUR', 1500000, current_date, current_date, extract(day from current_date)::smallint)`,
      [organizationId, vehicle!.id, lender!.id],
    )

    const staff = await signUp(db, { email: 'staff2@invariants.test' })
    await addMember(db, organizationId, staff.userId, 'staff')
    const manager = await signUp(db, { email: 'manager2@invariants.test' })
    await addMember(db, organizationId, manager.userId, 'manager')

    const staffView = await db.asUser(staff.userId, (session) =>
      session.sql(`select id from public.financing_agreements`),
    )
    expect(staffView).toEqual([])

    const managerView = await db.asUser(manager.userId, (session) =>
      session.sql(`select id from public.financing_agreements`),
    )
    expect(managerView.length).toBeGreaterThan(0)
  })

  it('lets an admin change agency settings but not a manager', async () => {
    const manager = await signUp(db, { email: 'manager3@invariants.test' })
    await addMember(db, organizationId, manager.userId, 'manager')
    const admin = await signUp(db, { email: 'admin3@invariants.test' })
    await addMember(db, organizationId, admin.userId, 'admin')

    await db.asUser(manager.userId, (session) =>
      session.sql(`update public.organizations set city = 'Blocked' where id = $1`, [organizationId]),
    )
    let [org] = await db.sql<{ city: string | null }>(
      `select city from public.organizations where id = $1`,
      [organizationId],
    )
    expect(org?.city).toBeNull()

    await db.asUser(admin.userId, (session) =>
      session.sql(`update public.organizations set city = 'Paris' where id = $1`, [organizationId]),
    )
    ;[org] = await db.sql<{ city: string | null }>(
      `select city from public.organizations where id = $1`,
      [organizationId],
    )
    expect(org?.city).toBe('Paris')
  })
})

describe('data integrity', () => {
  it('keeps a customer display name in step with its parts', async () => {
    const [individual] = await db.sql<{ display_name: string }>(
      `insert into public.customers (organization_id, first_name, last_name)
       values ($1, 'Grace', 'Hopper') returning display_name`,
      [organizationId],
    )
    expect(individual?.display_name).toBe('Grace Hopper')

    const [company] = await db.sql<{ display_name: string }>(
      `insert into public.customers (organization_id, customer_type, company_name)
       values ($1, 'company', 'Northbound Logistics') returning display_name`,
      [organizationId],
    )
    expect(company?.display_name).toBe('Northbound Logistics')
  })

  it('requires a name appropriate to the customer type', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.customers (organization_id, customer_type) values ($1, 'company')`,
          [organizationId],
        ),
      /customers_name_present/i,
    )
  })

  it('rejects an invalid time zone on an agency', async () => {
    await db.expectRejection(
      () =>
        db.sql(`update public.organizations set time_zone = 'Nowhere/Land' where id = $1`, [
          organizationId,
        ]),
      /organizations_time_zone_check|violates check constraint/i,
    )
  })

  it('rejects a malformed currency code', async () => {
    await db.expectRejection(
      () =>
        db.sql(`update public.organizations set default_currency = 'eur' where id = $1`, [
          organizationId,
        ]),
      /currency_code_format|value for domain/i,
    )
  })

  it('refuses to delete a vehicle that carries contract history', async () => {
    await db.expectRejection(
      () => db.sql(`delete from public.vehicles where id = $1`, [vehicleId]),
      /rentals_vehicle_fkey|still referenced/i,
    )
  })

  it('keeps a plate unique among the live fleet only', async () => {
    await db.sql(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
       values ($1, 'Seat', 'Ibiza', 'DUP-1', 'EUR')`,
      [organizationId],
    )

    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
           values ($1, 'Seat', 'Ibiza', 'dup-1', 'EUR')`,
          [organizationId],
        ),
      /vehicles_plate_unique_idx|duplicate key/i,
    )

    await db.sql(`update public.vehicles set archived_at = now() where registration_plate = 'DUP-1'`)
    await db.sql(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
       values ($1, 'Seat', 'Ibiza', 'DUP-1', 'EUR')`,
      [organizationId],
    )
  })
})
