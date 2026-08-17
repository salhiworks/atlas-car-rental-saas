// @vitest-environment node
/**
 * The money rules.
 *
 * This module changes what the dashboard says an agency earned, so the tests
 * are weighted towards the arithmetic rather than the plumbing: what counts,
 * what counts once, what never counts, and what must not move when something
 * unrelated happens.
 *
 * The four questions each of these is really asking:
 *   - does a cost land in the right period, when the receipt arrived later?
 *   - does a cost land against the right vehicle, exactly once?
 *   - does a correction actually stop counting?
 *   - can two currencies ever be added together by accident?
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let managerId: string
let staffId: string
let vehicleA: string
let vehicleB: string
let customerId: string
let categoryFuel: string
let categoryOffice: string
let categoryCleaning: string
let vendorId: string

const DAY = 24 * 60 * 60 * 1000

async function categoryKey(key: string): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `select id from public.expense_categories where organization_id = $1 and system_key = $2`,
    [organizationId, key],
  )
  if (!row) throw new Error(`Category ${key} was not seeded.`)
  return row.id
}

interface ExpenseOptions {
  allocation?: 'overhead' | 'vehicle' | 'rental'
  categoryId?: string
  vehicleId?: string | null
  rentalId?: string | null
  vendorId?: string | null
  amountMinor?: number
  taxMinor?: number
  currency?: string
  incurredOn?: string
  reference?: string | null
  description?: string
}

async function recordExpense(options: ExpenseOptions = {}): Promise<string> {
  const allocation = options.allocation ?? 'overhead'
  const [row] = await db.sql<{ id: string }>(
    `insert into public.expenses
       (organization_id, category_id, allocation, vehicle_id, rental_id, vendor_id,
        amount_minor, tax_amount_minor, currency, incurred_on, reference, description)
     values ($1, $2, $3::public.expense_allocation, $4, $5, $6, $7, $8, $9, $10::date, $11, $12)
     returning id`,
    [
      organizationId,
      options.categoryId ?? (allocation === 'overhead' ? categoryOffice : categoryFuel),
      allocation,
      // `??` would fill in a default for an explicit null, which is exactly
      // the shape several of these tests need to be able to send.
      'vehicleId' in options ? options.vehicleId : allocation === 'vehicle' ? vehicleA : null,
      'rentalId' in options ? options.rentalId : null,
      options.vendorId ?? null,
      options.amountMinor ?? 10000,
      options.taxMinor ?? 0,
      options.currency ?? 'EUR',
      options.incurredOn ?? '2032-06-15',
      options.reference ?? null,
      options.description ?? 'Test cost',
    ],
  )
  return row!.id
}

async function summary(from = '2032-01-01', to = '2033-01-01') {
  // These read models assert membership, so they run as a signed-in member —
  // the harness superuser has no auth.uid() for app.is_org_member to find.
  return db.asUser(ownerId, (session) =>
    session.sql<{
    currency: string
    total_minor: number
    overhead_minor: number
    vehicle_minor: number
    rental_minor: number
    tax_minor: number
    expense_count: number
    voided_count: number
    }>(`select * from public.organization_expense_summary($1, $2::date, $3::date)`, [
      organizationId,
      from,
      to,
    ]),
  )
}

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@expenses.test',
    fullName: 'Expense Owner',
    organizationName: 'Cost Control Motors',
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerId = owner.userId
  organizationId = owner.organizationId

  const manager = await signUp(db, { email: 'manager@expenses.test', fullName: 'Cost Manager' })
  managerId = manager.userId
  await addMember(db, organizationId, managerId, 'manager')

  const staff = await signUp(db, { email: 'staff@expenses.test', fullName: 'Desk Staff' })
  staffId = staff.userId
  await addMember(db, organizationId, staffId, 'staff')

  const [first] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
     values ($1, 'Peugeot', '208', 'EXP-001', 'EUR', 5000) returning id`,
    [organizationId],
  )
  const [second] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
     values ($1, 'Dacia', 'Sandero', 'EXP-002', 'EUR', 4000) returning id`,
    [organizationId],
  )
  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Hind', 'Bennis') returning id`,
    [organizationId],
  )

  vehicleA = first!.id
  vehicleB = second!.id
  customerId = customer!.id

  categoryFuel = await categoryKey('fuel')
  categoryOffice = await categoryKey('office')
  categoryCleaning = await categoryKey('cleaning')

  const [vendor] = await db.sql<{ id: string }>(
    `insert into public.expense_vendors (organization_id, name) values ($1, 'Garage Atlas') returning id`,
    [organizationId],
  )
  vendorId = vendor!.id
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** A confirmed hire on a vehicle, so rental-linked costs have something to attach to. */
async function createRental(vehicleId = vehicleA, offsetDays = 0): Promise<string> {
  const start = new Date(Date.UTC(2032, 5, 1 + offsetDays, 9, 0, 0))
  const [row] = await db.sql<{ id: string }>(
    `insert into public.rentals
       (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, daily_rate_minor)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'EUR', 5000)
     returning id`,
    [
      organizationId,
      vehicleId,
      customerId,
      start.toISOString(),
      new Date(start.getTime() + 3 * DAY).toISOString(),
    ],
  )
  await db.sql(
    `insert into public.rental_drivers (organization_id, rental_id, customer_id, driver_role)
     values ($1, $2, $3, 'primary')`,
    [organizationId, row!.id, customerId],
  )
  await db.sql(`select public.rental_confirm($1)`, [row!.id])
  return row!.id
}

// -----------------------------------------------------------------------------

describe('categories', () => {
  it('seeds a new agency with a usable set', async () => {
    const rows = await db.sql<{ name: string; system_key: string }>(
      `select name, system_key from public.expense_categories
        where organization_id = $1 order by sort_order`,
      [organizationId],
    )
    expect(rows.length).toBeGreaterThan(10)
    expect(rows.map((row) => row.system_key)).toContain('fuel')
    expect(rows.map((row) => row.system_key)).toContain('office')
  })

  it('offers nothing for loan or lease payments', async () => {
    // A financing instalment is principal plus interest plus fees. Recording it
    // as an operating cost would double count the moment Financing derives cost
    // from the agreement, so there is deliberately nowhere obvious to put one.
    const rows = await db.sql<{ name: string }>(
      `select name from public.expense_categories
        where organization_id = $1 and archived_at is null
          and (name ilike '%financ%' or name ilike '%loan%' or name ilike '%lease%'
               or name ilike '%instal%')`,
      [organizationId],
    )
    expect(rows).toHaveLength(0)
  })

  it('renames without touching any expense relationship', async () => {
    const id = await recordExpense({ categoryId: categoryFuel, allocation: 'vehicle' })
    await db.sql(`update public.expense_categories set name = 'Petrol' where id = $1`, [
      categoryFuel,
    ])

    const [row] = await db.sql<{ category_name: string; category_id: string }>(
      `select category_name, category_id from public.expense_ledger where id = $1`,
      [id],
    )
    expect(row?.category_name).toBe('Petrol')
    expect(row?.category_id).toBe(categoryFuel)

    await db.sql(`update public.expense_categories set name = 'Fuel' where id = $1`, [categoryFuel])
  })

  it('refuses to delete a category that history depends on', async () => {
    await recordExpense({ categoryId: categoryOffice })

    await db.expectRejection(
      () => db.sql(`delete from public.expense_categories where id = $1`, [categoryOffice]),
      /still referenced|violates foreign key|RESTRICT/i,
    )

    const [usage] = await db.asUser(ownerId, (session) =>
      session.sql<{ expense_count: number; can_delete: boolean }>(
        `select * from public.expense_category_usage($1)`,
        [categoryOffice],
      ),
    )
    expect(Number(usage?.expense_count)).toBeGreaterThan(0)
    expect(usage?.can_delete).toBe(false)
  })

  it('keeps an archived category readable on the costs that used it', async () => {
    const id = await recordExpense({ categoryId: categoryCleaning, allocation: 'overhead' })
    await db.sql(`update public.expense_categories set archived_at = now() where id = $1`, [
      categoryCleaning,
    ])

    const [row] = await db.sql<{ category_name: string; category_archived: boolean }>(
      `select category_name, category_archived from public.expense_ledger where id = $1`,
      [id],
    )
    // Never "Unknown": the row still names the category, and says it is retired.
    expect(row?.category_name).toBe('Cleaning')
    expect(row?.category_archived).toBe(true)

    await db.sql(`update public.expense_categories set archived_at = null where id = $1`, [
      categoryCleaning,
    ])
  })
})

describe('vendors', () => {
  it('allows two suppliers to share a name, because a name identifies nothing', async () => {
    // A chain has branches: "Total" on the ring road and "Total" at the airport
    // are two accounts with two sets of invoices. Refusing the second teaches
    // staff to type "Total 2", which is worse than the duplicate it prevented.
    const [second] = await db.sql<{ id: string }>(
      `insert into public.expense_vendors (organization_id, name) values ($1, $2) returning id`,
      [organizationId, '  garage   atlas '],
    )
    expect(second?.id).toBeTruthy()

    await db.sql(`delete from public.expense_vendors where id = $1`, [second!.id])
  })

  it('warns about a supplier that looks the same, without refusing it', async () => {
    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ vendor_id: string; match_strength: string; match_reason: string }>(
        `select * from public.find_duplicate_vendors($1, 'GARAGE ATLAS')`,
        [organizationId],
      ),
    )
    expect(rows.map((row) => row.vendor_id)).toContain(vendorId)
    expect(rows[0]?.match_strength).toBe('weak')
  })

  it('refuses two suppliers sharing a tax identifier, because that names one entity', async () => {
    await db.sql(
      `update public.expense_vendors set tax_identifier = 'MA-778899' where id = $1`,
      [vendorId],
    )

    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.expense_vendors (organization_id, name, tax_identifier)
           values ($1, 'Somebody Else Entirely', ' ma-778899 ')`,
          [organizationId],
        ),
      /duplicate key|tax_identifier/i,
    )
  })

  it('flags a tax-identifier match as the strong signal it is', async () => {
    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ match_strength: string; match_reason: string }>(
        `select * from public.find_duplicate_vendors($1, 'Nothing Like It', 'MA-778899')`,
        [organizationId],
      ),
    )
    expect(rows[0]?.match_strength).toBe('strong')
    expect(rows[0]?.match_reason).toMatch(/tax or business ID/i)
  })

  it('surfaces a retired supplier so it can be restored instead of duplicated', async () => {
    const [retired] = await db.sql<{ id: string }>(
      `insert into public.expense_vendors (organization_id, name, archived_at)
       values ($1, 'Old Tyre Depot', now()) returning id`,
      [organizationId],
    )

    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ vendor_id: string; archived_at: string; match_reason: string }>(
        `select * from public.find_duplicate_vendors($1, 'old tyre depot')`,
        [organizationId],
      ),
    )
    const match = rows.find((row) => row.vendor_id === retired!.id)
    expect(match).toBeDefined()
    expect(match?.archived_at).not.toBeNull()
    expect(match?.match_reason).toMatch(/retired/i)

    await db.sql(`delete from public.expense_vendors where id = $1`, [retired!.id])
  })

  it('refuses to delete a supplier that history depends on', async () => {
    await recordExpense({ vendorId })

    await db.expectRejection(
      () => db.sql(`delete from public.expense_vendors where id = $1`, [vendorId]),
      /still referenced|violates foreign key|RESTRICT/i,
    )
  })

  it('keeps an archived supplier readable on old costs', async () => {
    const id = await recordExpense({ vendorId })
    await db.sql(`update public.expense_vendors set archived_at = now() where id = $1`, [vendorId])

    const [row] = await db.sql<{ vendor_name: string; vendor_archived: boolean }>(
      `select vendor_name, vendor_archived from public.expense_ledger where id = $1`,
      [id],
    )
    expect(row?.vendor_name).toBe('Garage Atlas')
    expect(row?.vendor_archived).toBe(true)

    await db.sql(`update public.expense_vendors set archived_at = null where id = $1`, [vendorId])
  })
})

// -----------------------------------------------------------------------------

describe('allocation', () => {
  it('accepts the three coherent shapes', async () => {
    const rentalId = await createRental(vehicleB, 40)

    await expect(recordExpense({ allocation: 'overhead' })).resolves.toBeTruthy()
    await expect(
      recordExpense({ allocation: 'vehicle', vehicleId: vehicleA }),
    ).resolves.toBeTruthy()
    await expect(recordExpense({ allocation: 'rental', rentalId })).resolves.toBeTruthy()
  })

  it('refuses overhead that names a vehicle', async () => {
    await db.expectRejection(
      () => recordExpense({ allocation: 'overhead', vehicleId: vehicleA }),
      /expenses_allocation_consistent/i,
    )
  })

  it('refuses overhead that names a rental', async () => {
    const rentalId = await createRental(vehicleB, 60)
    await db.expectRejection(
      () => recordExpense({ allocation: 'overhead', rentalId }),
      /expenses_allocation_consistent/i,
    )
  })

  it('refuses a vehicle cost with no vehicle', async () => {
    await db.expectRejection(
      () => recordExpense({ allocation: 'vehicle', vehicleId: null }),
      /expenses_allocation_consistent/i,
    )
  })

  it('refuses a rental cost with no rental', async () => {
    await db.expectRejection(
      () => recordExpense({ allocation: 'rental', rentalId: null }),
      /expenses_allocation_consistent/i,
    )
  })

  it('refuses a rental cost that also names a vehicle', async () => {
    // Two sources of truth for the same fact is exactly the contradiction the
    // schema exists to prevent: the car is whichever one the contract is for.
    const rentalId = await createRental(vehicleB, 80)
    await db.expectRejection(
      () => recordExpense({ allocation: 'rental', rentalId, vehicleId: vehicleA }),
      /expenses_allocation_consistent/i,
    )
  })

  it('reads a rental cost\'s vehicle through the contract', async () => {
    const rentalId = await createRental(vehicleB, 100)
    const id = await recordExpense({ allocation: 'rental', rentalId })

    const [row] = await db.sql<{ effective_vehicle_id: string; vehicle_plate: string }>(
      `select effective_vehicle_id, vehicle_plate from public.expense_ledger where id = $1`,
      [id],
    )
    expect(row?.effective_vehicle_id).toBe(vehicleB)
    expect(row?.vehicle_plate).toBe('EXP-002')
  })
})

// -----------------------------------------------------------------------------

describe('the business date', () => {
  it('reports a cost in the month it was incurred, not the month it was typed', async () => {
    // The receipt arrives on 2 August for a cost incurred on 31 July.
    const [row] = await db.sql<{ id: string }>(
      `insert into public.expenses
         (organization_id, category_id, allocation, amount_minor, currency, incurred_on, created_at)
       values ($1, $2, 'overhead', 55500, 'EUR', '2032-07-31'::date, '2032-08-02T10:00:00Z')
       returning id`,
      [organizationId, categoryOffice],
    )

    const july = await summary('2032-07-01', '2032-08-01')
    const august = await summary('2032-08-01', '2032-09-01')

    expect(july.find((entry) => entry.currency === 'EUR')?.total_minor).toBeGreaterThanOrEqual(
      55500,
    )
    expect(Number(august.find((entry) => entry.currency === 'EUR')?.total_minor ?? 0)).toBe(0)

    await db.sql(`delete from public.expenses where id = $1`, [row!.id])
  })

  it('puts a cost on the last day of a period inside it, and the first day of the next outside', async () => {
    const [last] = await db.sql<{ id: string }>(
      `insert into public.expenses (organization_id, category_id, allocation, amount_minor, currency, incurred_on)
       values ($1, $2, 'overhead', 100, 'EUR', '2032-09-30'::date) returning id`,
      [organizationId, categoryOffice],
    )
    const [next] = await db.sql<{ id: string }>(
      `insert into public.expenses (organization_id, category_id, allocation, amount_minor, currency, incurred_on)
       values ($1, $2, 'overhead', 200, 'EUR', '2032-10-01'::date) returning id`,
      [organizationId, categoryOffice],
    )

    const september = await summary('2032-09-01', '2032-10-01')
    expect(Number(september.find((entry) => entry.currency === 'EUR')?.total_minor)).toBe(100)

    await db.sql(`delete from public.expenses where id = any($1::uuid[])`, [
      `{${last!.id},${next!.id}}`,
    ])
  })

  it('spans a year boundary correctly', async () => {
    const [december] = await db.sql<{ id: string }>(
      `insert into public.expenses (organization_id, category_id, allocation, amount_minor, currency, incurred_on)
       values ($1, $2, 'overhead', 700, 'EUR', '2032-12-28'::date) returning id`,
      [organizationId, categoryOffice],
    )
    const [january] = await db.sql<{ id: string }>(
      `insert into public.expenses (organization_id, category_id, allocation, amount_minor, currency, incurred_on)
       values ($1, $2, 'overhead', 300, 'EUR', '2033-01-03'::date) returning id`,
      [organizationId, categoryOffice],
    )

    const crossYear = await summary('2032-12-01', '2033-02-01')
    expect(Number(crossYear.find((entry) => entry.currency === 'EUR')?.total_minor)).toBe(1000)

    await db.sql(`delete from public.expenses where id = any($1::uuid[])`, [
      `{${december!.id},${january!.id}}`,
    ])
  })
})

// -----------------------------------------------------------------------------

describe('voiding', () => {
  it('stops the cost counting while keeping the record', async () => {
    const id = await recordExpense({ amountMinor: 44400, incurredOn: '2032-03-05' })

    const before = await summary('2032-03-01', '2032-04-01')
    expect(Number(before.find((entry) => entry.currency === 'EUR')?.total_minor)).toBe(44400)

    await db.sql(`select public.expense_void($1, 'Entered twice')`, [id])

    const after = await summary('2032-03-01', '2032-04-01')
    expect(Number(after.find((entry) => entry.currency === 'EUR')?.total_minor ?? 0)).toBe(0)
    expect(Number(after.find((entry) => entry.currency === 'EUR')?.voided_count)).toBe(1)

    // Still there, still readable, still explained.
    const [row] = await db.sql<{ status: string; void_reason: string; amount_minor: number }>(
      `select status, void_reason, amount_minor from public.expense_ledger where id = $1`,
      [id],
    )
    expect(row?.status).toBe('voided')
    expect(row?.void_reason).toBe('Entered twice')
    expect(Number(row?.amount_minor)).toBe(44400)
  })

  it('refuses to void the same cost twice', async () => {
    const id = await recordExpense({ incurredOn: '2032-03-06' })
    await db.sql(`select public.expense_void($1)`, [id])

    await db.expectRejection(
      () => db.sql(`select public.expense_void($1)`, [id]),
      /already been voided/i,
    )
  })

  it('refuses to reinstate a voided cost', async () => {
    const id = await recordExpense({ incurredOn: '2032-03-07' })
    await db.sql(`select public.expense_void($1)`, [id])

    await db.expectRejection(
      () => db.sql(`update public.expenses set status = 'recorded' where id = $1`, [id]),
      /cannot be reinstated/i,
    )
  })

  it('refuses to rewrite the money on a voided cost', async () => {
    const id = await recordExpense({ amountMinor: 5000, incurredOn: '2032-03-08' })
    await db.sql(`select public.expense_void($1, 'wrong')`, [id])

    // Refused outright, not silently reverted. An UPDATE that reports success
    // while changing nothing tells the desk a figure was corrected when it was
    // not, which is worse than an error on a financial record.
    await db.expectRejection(
      () => db.sql(`update public.expenses set amount_minor = 999999 where id = $1`, [id]),
      /kept exactly as it was/i,
    )

    const [row] = await db.sql<{ amount_minor: number }>(
      `select amount_minor from public.expenses where id = $1`,
      [id],
    )
    expect(Number(row?.amount_minor)).toBe(5000)
  })

  it('refuses an edit that only touches a harmless column', async () => {
    const id = await recordExpense({ amountMinor: 5000, incurredOn: '2032-03-11' })
    await db.sql(`select public.expense_void($1, 'wrong')`, [id])

    await db.expectRejection(
      () => db.sql(`update public.expenses set notes = 'tidying up' where id = $1`, [id]),
      /kept exactly as it was/i,
    )
  })

  it('does not make the person who voided it undeletable', async () => {
    /*
     * `voided_by` references auth.users ON DELETE SET NULL, and that referential
     * action arrives as an ordinary UPDATE — so a guard that refused every
     * update to a voided cost made anybody who had ever voided one impossible to
     * delete from Auth. Found when the live smoke suite could not remove its own
     * fixtures; fixed in 20260821100100.
     */
    const voider = await signUp(db, { email: 'voider@expenses.test' })
    await addMember(db, organizationId, voider.userId, 'manager')

    const id = await recordExpense({ amountMinor: 7500, incurredOn: '2032-03-14' })
    await db.asUser(voider.userId, (session) =>
      session.sql(`select public.expense_void($1, 'a mistake')`, [id]),
    )

    await db.sql(`delete from auth.users where id = $1`, [voider.userId])

    const [row] = await db.sql<{
      status: string
      voided_by: string | null
      void_reason: string
      amount_minor: string
    }>(
      `select status, voided_by, void_reason, amount_minor::text as amount_minor
       from public.expenses where id = $1`,
      [id],
    )
    // The correction survives intact; only the reference to a gone account moved.
    expect(row?.status).toBe('voided')
    expect(row?.voided_by).toBeNull()
    expect(row?.void_reason).toBe('a mistake')
    expect(row?.amount_minor).toBe('7500')
  })

  it('refuses to delete a voided cost, because it is the record of the correction', async () => {
    const id = await recordExpense({ incurredOn: '2032-03-09' })
    await db.sql(`select public.expense_void($1, 'mistake')`, [id])

    await db.expectRejection(
      () => db.sql(`delete from public.expenses where id = $1`, [id]),
      /record of a correction/i,
    )
  })

  it('keeps a voided cost out of the category breakdown', async () => {
    const id = await recordExpense({
      categoryId: categoryFuel,
      allocation: 'vehicle',
      amountMinor: 8800,
      incurredOn: '2032-04-04',
    })

    const before = await db.asUser(ownerId, (session) =>
      session.sql<{ total_minor: number }>(
        `select total_minor from public.expense_category_breakdown($1, '2032-04-01'::date, '2032-05-01'::date)
          where category_id = $2`,
        [organizationId, categoryFuel],
      ),
    )
    expect(Number(before[0]?.total_minor)).toBe(8800)

    await db.sql(`select public.expense_void($1)`, [id])

    const after = await db.asUser(ownerId, (session) =>
      session.sql(
        `select total_minor from public.expense_category_breakdown($1, '2032-04-01'::date, '2032-05-01'::date)
          where category_id = $2`,
        [organizationId, categoryFuel],
      ),
    )
    expect(after).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------

describe('tax', () => {
  it('treats the amount as gross with the tax inside it', async () => {
    const id = await recordExpense({
      amountMinor: 12000,
      taxMinor: 2000,
      incurredOn: '2032-05-05',
    })

    const [row] = await db.sql<{
      amount_minor: number
      tax_amount_minor: number
      net_amount_minor: number
    }>(
      `select amount_minor, tax_amount_minor, net_amount_minor from public.expense_ledger where id = $1`,
      [id],
    )
    expect(Number(row?.amount_minor)).toBe(12000)
    expect(Number(row?.tax_amount_minor)).toBe(2000)
    expect(Number(row?.net_amount_minor)).toBe(10000)
  })

  it('counts the tax exactly once, inside the total and not beside it', async () => {
    const rows = await summary('2032-05-01', '2032-06-01')
    const eur = rows.find((entry) => entry.currency === 'EUR')

    // Gross is the money that left the agency. The tax is reported so it can be
    // seen, never added on top of the figure it is already part of.
    expect(Number(eur?.total_minor)).toBe(12000)
    expect(Number(eur?.tax_minor)).toBe(2000)
  })

  it('refuses tax larger than the amount it is part of', async () => {
    await db.expectRejection(
      () => recordExpense({ amountMinor: 1000, taxMinor: 1500 }),
      /expenses_tax_within_amount/i,
    )
  })

  it('refuses a zero or negative cost', async () => {
    await db.expectRejection(() => recordExpense({ amountMinor: 0 }), /amount_minor/i)
    await db.expectRejection(() => recordExpense({ amountMinor: -500 }), /amount_minor/i)
  })
})

// -----------------------------------------------------------------------------

describe('currencies', () => {
  it('never adds two currencies together', async () => {
    await recordExpense({ amountMinor: 10000, currency: 'EUR', incurredOn: '2032-08-10' })
    await recordExpense({ amountMinor: 90000, currency: 'MAD', incurredOn: '2032-08-11' })

    const rows = await summary('2032-08-01', '2032-09-01')
    expect(rows).toHaveLength(2)
    expect(rows.map((entry) => entry.currency).sort()).toEqual(['EUR', 'MAD'])
    expect(Number(rows.find((entry) => entry.currency === 'EUR')?.total_minor)).toBe(10000)
    expect(Number(rows.find((entry) => entry.currency === 'MAD')?.total_minor)).toBe(90000)
    // 10000 + 90000 is not a number this product will ever produce.
    expect(rows.some((entry) => Number(entry.total_minor) === 100000)).toBe(false)
  })

  it('reports the agency currency on the dashboard and counts what it left out', async () => {
    const [row] = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number; excluded_currency_records: number }>(
        `select expenses_minor, excluded_currency_records
           from public.organization_overview($1, '2032-08-01'::timestamptz, '2032-09-01'::timestamptz)`,
        [organizationId],
      ),
    )
    expect(Number(row?.expenses_minor)).toBe(10000)
    expect(Number(row?.excluded_currency_records)).toBeGreaterThanOrEqual(1)
  })
})

// -----------------------------------------------------------------------------

describe('the vehicle operating contribution', () => {
  let rentalId: string
  /** Its own car, so nothing recorded by an earlier test lands in these sums. */
  let subject: string

  beforeAll(async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Toyota', 'Yaris', 'EXP-OPS', 'EUR', 5000) returning id`,
      [organizationId],
    )
    subject = vehicle!.id

    rentalId = await createRental(subject, 200)
    await db.sql(
      `select public.rental_record_payment($1, 60000, 'inbound', 'rental_charge', 'cash', '2032-06-20T10:00:00Z')`,
      [rentalId],
    )
    // A deposit taken on the same hire. It is the customer's money.
    await db.sql(
      `select public.rental_record_payment($1, 30000, 'inbound', 'deposit', 'card', '2032-06-20T10:05:00Z')`,
      [rentalId],
    )
  })

  const forVehicle = (vehicleId: string) =>
    db.asUser(ownerId, (session) =>
      session.sql<{
      currency: string
      rental_revenue_minor: number
      direct_expense_minor: number
      vehicle_expense_minor: number
      rental_expense_minor: number
      operating_contribution_minor: number
      }>(
        `select * from public.vehicle_operating_summary($1, '2032-06-01'::date, '2032-07-01'::date)`,
        [vehicleId],
      ),
    )

  it('counts rental charges as revenue and leaves the deposit out', async () => {
    const [row] = await forVehicle(subject)
    expect(Number(row?.rental_revenue_minor)).toBe(60000)
  })

  it('subtracts a cost booked directly against the vehicle', async () => {
    await recordExpense({
      allocation: 'vehicle',
      vehicleId: subject,
      categoryId: categoryFuel,
      amountMinor: 7000,
      incurredOn: '2032-06-21',
    })

    const [row] = await forVehicle(subject)
    expect(Number(row?.vehicle_expense_minor)).toBe(7000)
    expect(Number(row?.operating_contribution_minor)).toBe(60000 - 7000)
  })

  it('subtracts a cost booked against one of its hires, exactly once', async () => {
    await recordExpense({
      allocation: 'rental',
      rentalId,
      categoryId: categoryCleaning,
      amountMinor: 4000,
      incurredOn: '2032-06-22',
    })

    const [row] = await forVehicle(subject)
    expect(Number(row?.rental_expense_minor)).toBe(4000)
    expect(Number(row?.vehicle_expense_minor)).toBe(7000)
    // Once through the hire, never again as a vehicle cost.
    expect(Number(row?.direct_expense_minor)).toBe(11000)
    expect(Number(row?.operating_contribution_minor)).toBe(60000 - 11000)
  })

  it('leaves agency overhead out of a vehicle entirely', async () => {
    const before = await forVehicle(subject)

    await recordExpense({
      allocation: 'overhead',
      categoryId: categoryOffice,
      amountMinor: 500000,
      incurredOn: '2032-06-23',
    })

    const after = await forVehicle(subject)
    // Half a million of office rent must not make a car look unprofitable.
    expect(Number(after[0]?.direct_expense_minor)).toBe(Number(before[0]?.direct_expense_minor))
  })

  it('leaves a voided cost out', async () => {
    const id = await recordExpense({
      allocation: 'vehicle',
      vehicleId: subject,
      amountMinor: 25000,
      incurredOn: '2032-06-24',
    })
    const withCost = await forVehicle(subject)
    expect(Number(withCost[0]?.vehicle_expense_minor)).toBe(32000)

    await db.sql(`select public.expense_void($1, 'wrong car')`, [id])

    const without = await forVehicle(subject)
    expect(Number(without[0]?.vehicle_expense_minor)).toBe(7000)
  })

  it('leaves a cost belonging to the Financing module out', async () => {
    const [lender] = await db.sql<{ id: string }>(
      `insert into public.lenders (organization_id, name) values ($1, 'Bank') returning id`,
      [organizationId],
    )
    const [plan] = await db.sql<{ id: string }>(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, currency, financed_amount_minor,
          starts_on, first_payment_on, schedule_anchor_day)
       values ($1, $2, $3, 'EUR', 1000000, '2032-01-01'::date, '2032-01-01'::date, 1)
       returning id`,
      [organizationId, subject, lender!.id],
    )

    const [expense] = await db.sql<{ id: string }>(
      `insert into public.expenses
         (organization_id, category_id, allocation, vehicle_id, amount_minor, currency,
          incurred_on, source, financing_plan_id)
       values ($1, $2, 'vehicle', $3, 300000, 'EUR', '2032-06-25'::date, 'financing', $4)
       returning id`,
      [organizationId, categoryOffice, subject, plan!.id],
    )

    const [row] = await forVehicle(subject)
    // Excluded by construction: the row names a financing plan, so operating
    // analytics skip it and the Financing module can own it without the cost
    // being counted twice.
    expect(Number(row?.vehicle_expense_minor)).toBe(7000)

    await db.sql(`delete from public.expenses where id = $1`, [expense!.id])
    await db.sql(`delete from public.financing_agreements where id = $1`, [plan!.id])
  })

  it('reports a vehicle with no activity as zero rather than nothing', async () => {
    const rows = await db.asUser(ownerId, (session) =>
      session.sql(
        `select * from public.vehicle_operating_summary($1, '2031-01-01'::date, '2031-02-01'::date)`,
        [vehicleB],
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it('still reports the costs of a vehicle that has left the fleet', async () => {
    const [retired] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, archived_at)
       values ($1, 'Fiat', 'Panda', 'EXP-OLD', 'EUR', now()) returning id`,
      [organizationId],
    )
    await recordExpense({
      allocation: 'vehicle',
      vehicleId: retired!.id,
      amountMinor: 3300,
      incurredOn: '2032-06-26',
    })

    const [row] = await db.asUser(ownerId, (session) =>
      session.sql<{ vehicle_expense_minor: number }>(
        `select * from public.vehicle_operating_summary($1, '2032-06-01'::date, '2032-07-01'::date)`,
        [retired!.id],
      ),
    )
    expect(Number(row?.vehicle_expense_minor)).toBe(3300)

    const [ledger] = await db.sql<{ vehicle_archived: boolean; vehicle_plate: string }>(
      `select vehicle_archived, vehicle_plate from public.expense_ledger
        where effective_vehicle_id = $1 limit 1`,
      [retired!.id],
    )
    expect(ledger?.vehicle_archived).toBe(true)
    expect(ledger?.vehicle_plate).toBe('EXP-OLD')
  })
})

// -----------------------------------------------------------------------------

describe('financial boundaries that must not move', () => {
  let rentalId: string

  beforeAll(async () => {
    rentalId = await createRental(vehicleB, 300)
    await db.sql(
      `insert into public.rental_line_items
         (organization_id, rental_id, kind, description, amount_minor, currency)
       values ($1, $2, 'base_rental', '3 days', 15000, 'EUR')`,
      [organizationId, rentalId],
    )
    await db.sql(
      `select public.rental_record_payment($1, 15000, 'inbound', 'rental_charge', 'cash', '2032-10-05T10:00:00Z')`,
      [rentalId],
    )
  })

  const revenue = async () => {
    const [row] = await db.asUser(ownerId, (session) =>
      session.sql<{ revenue_minor: number }>(
        `select revenue_minor from public.organization_overview($1, '2032-10-01'::timestamptz, '2032-11-01'::timestamptz)`,
        [organizationId],
      ),
    )
    return Number(row?.revenue_minor)
  }

  const expenses = async () => {
    const rows = await summary('2032-10-01', '2032-11-01')
    return Number(rows.find((entry) => entry.currency === 'EUR')?.total_minor ?? 0)
  }

  it('does not change expense totals when a deposit is taken or returned', async () => {
    const before = await expenses()

    await db.sql(
      `select public.rental_record_payment($1, 20000, 'inbound', 'deposit', 'card', '2032-10-06T10:00:00Z')`,
      [rentalId],
    )
    await db.sql(
      `select public.rental_record_payment($1, 20000, 'outbound', 'deposit', 'card', '2032-10-07T10:00:00Z')`,
      [rentalId],
    )

    expect(await expenses()).toBe(before)
  })

  it('does not change rental revenue when a cost is recorded', async () => {
    const before = await revenue()

    await recordExpense({
      allocation: 'rental',
      rentalId,
      amountMinor: 6000,
      incurredOn: '2032-10-08',
    })

    expect(await revenue()).toBe(before)
  })

  it('reduces the operating result without touching revenue when a cost is recorded', async () => {
    const [before] = await db.asUser(ownerId, (session) =>
      session.sql<{ revenue_minor: number; expenses_minor: number; profit_minor: number }>(
        `select revenue_minor, expenses_minor, profit_minor
           from public.organization_overview($1, '2032-10-01'::timestamptz, '2032-11-01'::timestamptz)`,
        [organizationId],
      ),
    )

    const id = await recordExpense({ amountMinor: 2500, incurredOn: '2032-10-09' })

    const [after] = await db.asUser(ownerId, (session) =>
      session.sql<{ revenue_minor: number; expenses_minor: number; profit_minor: number }>(
        `select revenue_minor, expenses_minor, profit_minor
           from public.organization_overview($1, '2032-10-01'::timestamptz, '2032-11-01'::timestamptz)`,
        [organizationId],
      ),
    )

    expect(Number(after?.revenue_minor)).toBe(Number(before?.revenue_minor))
    expect(Number(after?.expenses_minor) - Number(before?.expenses_minor)).toBe(2500)
    expect(Number(before?.profit_minor) - Number(after?.profit_minor)).toBe(2500)

    // And voiding it puts the operating result back exactly where it was.
    await db.sql(`select public.expense_void($1, 'duplicate')`, [id])
    const [restored] = await db.asUser(ownerId, (session) =>
      session.sql<{ profit_minor: number }>(
        `select profit_minor from public.organization_overview($1, '2032-10-01'::timestamptz, '2032-11-01'::timestamptz)`,
        [organizationId],
      ),
    )
    expect(Number(restored?.profit_minor)).toBe(Number(before?.profit_minor))
  })

  it('moves the operating result down when recorded and back up when voided', async () => {
    // The direction matters and is easy to state backwards, so it is asserted
    // explicitly in both directions rather than inferred from a difference.
    const read = async () => {
      const [row] = await db.asUser(ownerId, (session) =>
        session.sql<{
          revenue_minor: number
          expenses_minor: number
          profit_minor: number
          deposits_held_minor: number
        }>(
          `select revenue_minor, expenses_minor, profit_minor, deposits_held_minor
             from public.organization_overview($1, '2032-10-01'::timestamptz, '2032-11-01'::timestamptz)`,
          [organizationId],
        ),
      )
      return {
        revenue: Number(row?.revenue_minor),
        expenses: Number(row?.expenses_minor),
        result: Number(row?.profit_minor),
        deposits: Number(row?.deposits_held_minor),
      }
    }

    const [charges] = await db.sql<{ total_minor: number }>(
      `select total_minor from public.rentals where id = $1`,
      [rentalId],
    )

    const before = await read()
    const id = await recordExpense({ amountMinor: 9900, incurredOn: '2032-10-15' })
    const recorded = await read()

    // Recording: expenses up by exactly the amount, operating result down by it.
    expect(recorded.expenses).toBe(before.expenses + 9900)
    expect(recorded.result).toBe(before.result - 9900)
    expect(recorded.result).toBeLessThan(before.result)

    await db.sql(`select public.expense_void($1, 'entered against the wrong month')`, [id])
    const voided = await read()

    // Voiding: expenses back down, operating result back UP by exactly the same.
    expect(voided.expenses).toBe(before.expenses)
    expect(voided.result).toBe(before.result)
    expect(voided.result).toBeGreaterThan(recorded.result)
    expect(voided.result - recorded.result).toBe(9900)

    // And nothing else moved at any point.
    expect(recorded.revenue).toBe(before.revenue)
    expect(voided.revenue).toBe(before.revenue)
    expect(recorded.deposits).toBe(before.deposits)
    expect(voided.deposits).toBe(before.deposits)

    const [chargesAfter] = await db.sql<{ total_minor: number }>(
      `select total_minor from public.rentals where id = $1`,
      [rentalId],
    )
    expect(Number(chargesAfter?.total_minor)).toBe(Number(charges?.total_minor))
  })

  it('never turns an agency cost into a customer charge', async () => {
    // A cost the agency paid and a charge the renter owes are different facts
    // living in different tables. Recording one must not create the other.
    const [chargesBefore] = await db.sql<{ total_minor: number; lines: number }>(
      `select r.total_minor,
              (select count(*) from public.rental_line_items l where l.rental_id = r.id) as lines
         from public.rentals r where r.id = $1`,
      [rentalId],
    )

    await recordExpense({
      allocation: 'rental',
      rentalId,
      categoryId: categoryCleaning,
      amountMinor: 4000,
      incurredOn: '2032-10-10',
    })

    const [chargesAfter] = await db.sql<{ total_minor: number; lines: number }>(
      `select r.total_minor,
              (select count(*) from public.rental_line_items l where l.rental_id = r.id) as lines
         from public.rentals r where r.id = $1`,
      [rentalId],
    )

    expect(Number(chargesAfter?.total_minor)).toBe(Number(chargesBefore?.total_minor))
    expect(Number(chargesAfter?.lines)).toBe(Number(chargesBefore?.lines))

    // The cost is visible against the hire — as a cost.
    const [cost] = await db.asUser(ownerId, (session) =>
      session.sql<{ total_minor: number }>(
        `select total_minor from public.rental_expense_summary($1)`,
        [rentalId],
      ),
    )
    expect(Number(cost?.total_minor)).toBeGreaterThan(0)
  })

  it('leaves the expenses series on the business date', async () => {
    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ bucket_start: string; expenses_minor: number }>(
        `select bucket_start, expenses_minor
           from public.organization_financial_series($1, '2032-07-01'::date, '2032-09-01'::date, 'month')`,
        [organizationId],
      ),
    )
    // The driver hands `date` back as a Date, so compare on the calendar month
    // rather than on however it happens to stringify.
    const july = rows.find((row) => {
      const bucket = new Date(row.bucket_start)
      return bucket.getUTCFullYear() === 2032 && bucket.getUTCMonth() === 6
    })
    expect(july).toBeDefined()
    expect(rows).toHaveLength(2)
  })
})

// -----------------------------------------------------------------------------

describe('duplicate warnings', () => {
  it('flags the same invoice from the same supplier strongly', async () => {
    await recordExpense({
      vendorId,
      reference: 'INV-9910',
      amountMinor: 15000,
      incurredOn: '2032-11-01',
    })

    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ match_strength: string; match_reason: string }>(
        `select * from public.find_duplicate_expenses($1, $2, 'inv-9910', 15000, 'EUR', '2032-11-01'::date)`,
        [organizationId, vendorId],
      ),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.match_strength).toBe('strong')
  })

  it('flags the same supplier, day and amount weakly rather than refusing it', async () => {
    await recordExpense({ vendorId, amountMinor: 7700, incurredOn: '2032-11-02' })

    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ match_strength: string }>(
        `select * from public.find_duplicate_expenses($1, $2, null, 7700, 'EUR', '2032-11-02'::date)`,
        [organizationId, vendorId],
      ),
    )
    expect(rows[0]?.match_strength).toBe('weak')

    // And the legitimate second purchase still goes through.
    await expect(
      recordExpense({ vendorId, amountMinor: 7700, incurredOn: '2032-11-02' }),
    ).resolves.toBeTruthy()
  })

  it('says nothing about a cost that resembles nothing', async () => {
    const rows = await db.asUser(ownerId, (session) =>
      session.sql(
        `select * from public.find_duplicate_expenses($1, null, 'NOTHING-LIKE-IT', 1, 'EUR', '2032-11-03'::date)`,
        [organizationId],
      ),
    )
    expect(rows).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------

describe('permissions and isolation', () => {
  let rival: { userId: string; organizationId: string }
  let sharedExpenseId: string
  let rivalVehicleId: string

  beforeAll(async () => {
    const other = await signUp(db, {
      email: 'rival@expenses.test',
      organizationName: 'Rival Costs',
      currency: 'EUR',
    })
    if (!other.organizationId) throw new Error('Provisioning failed for the second agency.')
    rival = { userId: other.userId, organizationId: other.organizationId }

    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
       values ($1, 'Kia', 'Rio', 'RIV-900', 'EUR') returning id`,
      [rival.organizationId],
    )
    rivalVehicleId = vehicle!.id

    sharedExpenseId = await recordExpense({
      vendorId,
      amountMinor: 33300,
      incurredOn: '2032-12-01',
      description: 'Confidential repair',
    })
  })

  it('shows another agency nothing at all', async () => {
    await db.asUser(rival.userId, async (session) => {
      expect(
        await session.sql(`select id from public.expenses where id = $1`, [sharedExpenseId]),
      ).toHaveLength(0)
      expect(
        await session.sql(`select id from public.expense_ledger where id = $1`, [sharedExpenseId]),
      ).toHaveLength(0)
      expect(
        await session.sql(`select id from public.expense_vendors where organization_id = $1`, [
          organizationId,
        ]),
      ).toHaveLength(0)
      expect(
        await session.sql(`select id from public.expense_categories where organization_id = $1`, [
          organizationId,
        ]),
      ).toHaveLength(0)
    })
  })

  it('does not let another agency search for a cost by its description', async () => {
    await db.asUser(rival.userId, async (session) => {
      const rows = await session.sql(
        `select id from public.expense_ledger where description ilike '%Confidential%'`,
      )
      expect(rows).toHaveLength(0)
    })
  })

  it('refuses to summarise another agency\'s spend', async () => {
    await db.asUser(rival.userId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `select * from public.organization_expense_summary($1, '2032-01-01'::date, '2033-01-01'::date)`,
            [organizationId],
          ),
        /not a member/i,
      )
      await session.expectRejection(
        () =>
          session.sql(
            `select * from public.vehicle_operating_summary($1, '2032-01-01'::date, '2033-01-01'::date)`,
            [vehicleA],
          ),
        /not found/i,
      )
    })
  })

  it('refuses to void another agency\'s cost, indistinguishably from a missing one', async () => {
    await db.asUser(rival.userId, async (session) => {
      const foreign = await session.expectRejection(
        () => session.sql(`select public.expense_void($1)`, [sharedExpenseId]),
        /not found/i,
      )
      const missing = await session.expectRejection(
        () =>
          session.sql(
            `select public.expense_void('00000000-0000-0000-0000-000000000000'::uuid)`,
          ),
        /not found/i,
      )
      expect(foreign).toBe(missing)
    })
  })

  it('will not let a cost be booked against another agency\'s vehicle', async () => {
    await db.expectRejection(
      () => recordExpense({ allocation: 'vehicle', vehicleId: rivalVehicleId }),
      /expenses_vehicle_fkey|violates foreign key/i,
    )
  })

  it('will not let a cost use another agency\'s category or vendor', async () => {
    const [rivalCategory] = await db.sql<{ id: string }>(
      `select id from public.expense_categories where organization_id = $1 limit 1`,
      [rival.organizationId],
    )

    await db.expectRejection(
      () => recordExpense({ categoryId: rivalCategory!.id }),
      /expenses_category_fkey|violates foreign key/i,
    )
  })

  it('lets a manager record and void, and staff neither', async () => {
    await db.asUser(managerId, async (session) => {
      const [row] = await session.sql<{ id: string }>(
        `insert into public.expenses
           (organization_id, category_id, allocation, amount_minor, currency, incurred_on)
         values ($1, $2, 'overhead', 1200, 'EUR', '2032-12-05'::date) returning id`,
        [organizationId, categoryOffice],
      )
      expect(row?.id).toBeTruthy()
      await session.sql(`select public.expense_void($1, 'manager correction')`, [row!.id])
    })

    await db.asUser(staffId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.expenses (organization_id, category_id, allocation, amount_minor, currency, incurred_on)
             values ($1, $2, 'overhead', 100, 'EUR', '2032-12-06'::date)`,
            [organizationId, categoryOffice],
          ),
        /row-level security/i,
      )

      // Staff may see what the agency spent; that is what the view is for.
      const rows = await session.sql(
        `select id from public.expense_ledger where organization_id = $1 limit 1`,
        [organizationId],
      )
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  it('lets only an administrator change the category structure', async () => {
    await db.asUser(managerId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.expense_categories (organization_id, name) values ($1, 'Manager Made')`,
            [organizationId],
          ),
        /row-level security/i,
      )
    })

    await db.asUser(ownerId, async (session) => {
      await session.sql(
        `insert into public.expense_categories (organization_id, name) values ($1, 'Owner Made')`,
        [organizationId],
      )
    })
  })

  it('lets a manager add the garage they have just used', async () => {
    await db.asUser(managerId, async (session) => {
      const [row] = await session.sql<{ id: string }>(
        `insert into public.expense_vendors (organization_id, name) values ($1, 'Quick Tyres') returning id`,
        [organizationId],
      )
      expect(row?.id).toBeTruthy()
    })
  })

  it('gives the anonymous role nothing', async () => {
    await db.asAnon(async (session) => {
      for (const relation of [
        'expenses',
        'expense_categories',
        'expense_vendors',
        'expense_attachments',
        'expense_ledger',
      ]) {
        await session.expectRejection(
          () => session.sql(`select * from public.${relation} limit 1`),
          /permission denied/i,
        )
      }

      await session.expectRejection(
        () => session.sql(`select public.expense_void($1)`, [sharedExpenseId]),
        /permission denied/i,
      )
      await session.expectRejection(
        () =>
          session.sql(
            `select * from public.organization_expense_summary($1, '2032-01-01'::date, '2033-01-01'::date)`,
            [organizationId],
          ),
        /permission denied/i,
      )
    })
  })

  it('keeps every expense function out of anon\'s reach', async () => {
    const rows = await db.sql<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.proname like 'expense%' or p.proname like '%_expense%'
               or p.proname = 'vehicle_operating_summary')
          and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    )
    expect(rows).toHaveLength(0)
  })

  it('keeps the ledger under security_invoker', async () => {
    const [row] = await db.sql<{ options: string[] | null }>(
      `select c.reloptions as options from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'expense_ledger'`,
    )
    expect(row?.options?.join(',')).toMatch(/security_invoker=(true|on)/)
  })
})

// -----------------------------------------------------------------------------

describe('attachments', () => {
  it('records what a receipt is without holding its bytes', async () => {
    const expenseId = await recordExpense({ incurredOn: '2032-12-10' })

    await db.sql(
      `insert into public.expense_attachments
         (organization_id, expense_id, kind, storage_path, file_name, content_type, byte_size, sha256)
       values ($1, $2, 'receipt', $3, 'receipt.pdf', 'application/pdf', 51234, repeat('a', 64))`,
      [organizationId, expenseId, `${organizationId}/${expenseId}/receipt.pdf`],
    )

    const [row] = await db.sql<{ attachment_count: number }>(
      `select attachment_count from public.expense_ledger where id = $1`,
      [expenseId],
    )
    expect(Number(row?.attachment_count)).toBe(1)
  })

  it('refuses a file type that could carry script', async () => {
    const expenseId = await recordExpense({ incurredOn: '2032-12-11' })

    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.expense_attachments
             (organization_id, expense_id, storage_path, file_name, content_type, byte_size)
           values ($1, $2, $3, 'evil.svg', 'image/svg+xml', 100)`,
          [organizationId, expenseId, `${organizationId}/${expenseId}/evil.svg`],
        ),
      /content_type/i,
    )
  })

  it('follows its expense when the expense is removed', async () => {
    const expenseId = await recordExpense({ incurredOn: '2032-12-12' })
    await db.sql(
      `insert into public.expense_attachments
         (organization_id, expense_id, storage_path, file_name, content_type, byte_size)
       values ($1, $2, $3, 'r.pdf', 'application/pdf', 10)`,
      [organizationId, expenseId, `${organizationId}/${expenseId}/r.pdf`],
    )

    await db.sql(`delete from public.expenses where id = $1`, [expenseId])
    const rows = await db.sql(`select id from public.expense_attachments where expense_id = $1`, [
      expenseId,
    ])
    expect(rows).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------

describe('the change history', () => {
  it('records what a correction changed, from what, to what and by whom', async () => {
    const id = await recordExpense({ amountMinor: 120000, incurredOn: '2033-02-01' })

    await db.asUser(managerId, (session) =>
      session.sql(
        `update public.expenses
            set amount_minor = 12000, updated_by = $2
          where id = $1`,
        [id, managerId],
      ),
    )

    const [event] = await db.sql<{
      kind: string
      changes: Record<string, { from: number; to: number }>
      changed_by: string
    }>(
      `select kind, changes, changed_by from public.expense_change_events
        where expense_id = $1 order by changed_at desc limit 1`,
      [id],
    )

    expect(event?.kind).toBe('correction')
    expect(event?.changes.amount_minor).toEqual({ from: 120000, to: 12000 })
    expect(event?.changed_by).toBe(managerId)
  })

  it('records every material field in one event', async () => {
    const id = await recordExpense({ amountMinor: 5000, incurredOn: '2033-02-02' })

    await db.sql(
      `update public.expenses
          set amount_minor = 6000, incurred_on = '2033-02-05'::date,
              allocation = 'vehicle', vehicle_id = $2, category_id = $3
        where id = $1`,
      [id, vehicleA, categoryFuel],
    )

    const [event] = await db.sql<{ changes: Record<string, unknown> }>(
      `select changes from public.expense_change_events where expense_id = $1
        order by changed_at desc limit 1`,
      [id],
    )

    expect(Object.keys(event!.changes).sort()).toEqual([
      'allocation',
      'amount_minor',
      'category_id',
      'incurred_on',
      'vehicle_id',
    ])
  })

  it('says nothing when only a description is corrected', async () => {
    const id = await recordExpense({ incurredOn: '2033-02-03' })
    await db.sql(`update public.expenses set description = 'Better wording' where id = $1`, [id])

    const rows = await db.sql(`select id from public.expense_change_events where expense_id = $1`, [
      id,
    ])
    // A typo in a description is not a financial event; logging it would bury
    // the edits that are.
    expect(rows).toHaveLength(0)
  })

  it('keeps a void distinguishable from a correction', async () => {
    const id = await recordExpense({ incurredOn: '2033-02-04' })
    await db.sql(`update public.expenses set amount_minor = 4321 where id = $1`, [id])
    await db.sql(`select public.expense_void($1, 'Supplier refunded it')`, [id])

    const rows = await db.sql<{ kind: string; reason: string | null }>(
      `select kind, reason from public.expense_change_events where expense_id = $1
        order by changed_at`,
      [id],
    )

    expect(rows.map((row) => row.kind)).toEqual(['correction', 'void'])
    expect(rows[1]?.reason).toBe('Supplier refunded it')
  })

  it('cannot be written, edited or erased by the application', async () => {
    const id = await recordExpense({ incurredOn: '2033-02-05' })
    await db.sql(`update public.expenses set amount_minor = 111 where id = $1`, [id])

    await db.asUser(ownerId, async (session) => {
      // Even an owner may only read it. The history of a change is not the
      // property of whoever made the change.
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.expense_change_events (organization_id, expense_id, changes)
             values ($1, $2, '{}'::jsonb)`,
            [organizationId, id],
          ),
        /permission denied/i,
      )
      await session.expectRejection(
        () => session.sql(`update public.expense_change_events set changes = '{}'::jsonb`),
        /permission denied/i,
      )
      await session.expectRejection(
        () => session.sql(`delete from public.expense_change_events`),
        /permission denied/i,
      )

      const rows = await session.sql(
        `select id from public.expense_change_events where expense_id = $1`,
        [id],
      )
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  it('shows another agency nothing of it', async () => {
    const id = await recordExpense({ incurredOn: '2033-02-06' })
    await db.sql(`update public.expenses set amount_minor = 222 where id = $1`, [id])

    const [rival] = await db.sql<{ user_id: string }>(
      `select m.user_id from public.organization_members m
        where m.organization_id <> $1 limit 1`,
      [organizationId],
    )

    await db.asUser(rival!.user_id, async (session) => {
      const rows = await session.sql(
        `select id from public.expense_change_events where expense_id = $1`,
        [id],
      )
      expect(rows).toHaveLength(0)
    })
  })

  it('follows its expense when the expense is removed', async () => {
    const id = await recordExpense({ incurredOn: '2033-02-07' })
    await db.sql(`update public.expenses set amount_minor = 333 where id = $1`, [id])
    await db.sql(`delete from public.expenses where id = $1`, [id])

    const rows = await db.sql(`select id from public.expense_change_events where expense_id = $1`, [
      id,
    ])
    expect(rows).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// Four corrections, kept honest
// -----------------------------------------------------------------------------

describe('a voided cost and the agency it belongs to', () => {
  it('cannot be deleted while its agency exists', async () => {
    const id = await recordExpense({ incurredOn: '2032-11-02', amountMinor: 4500 })
    await db.sql(
      `update public.expenses set status = 'voided', voided_at = now() where id = $1`,
      [id],
    )

    await expect(db.sql(`delete from public.expenses where id = $1`, [id])).rejects.toThrow(
      /record of a correction/i,
    )

    const rows = await db.sql(`select status from public.expenses where id = $1`, [id])
    expect(rows).toHaveLength(1)
  })

  it('does not make the agency itself undeletable', async () => {
    // The guard that keeps a correction must not turn into a lock on tenant
    // deletion: an agency that voided one cost would otherwise be permanent.
    const doomed = await signUp(db, {
      email: 'doomed@expenses.test',
      fullName: 'Closing Down',
      organizationName: 'Closing Down Motors',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    })
    if (!doomed.organizationId) throw new Error('Provisioning failed.')

    const [category] = await db.sql<{ id: string }>(
      `select id from public.expense_categories
        where organization_id = $1 and system_key = 'fuel'`,
      [doomed.organizationId],
    )
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Seat', 'Ibiza', 'GONE-001', 'EUR', 4000) returning id`,
      [doomed.organizationId],
    )
    const [expense] = await db.sql<{ id: string }>(
      `insert into public.expenses
         (organization_id, category_id, allocation, vehicle_id, amount_minor, currency, incurred_on, description)
       values ($1, $2, 'vehicle', $3, 7700, 'EUR', '2032-11-03'::date, 'Voided before closing')
       returning id`,
      [doomed.organizationId, category!.id, vehicle!.id],
    )
    await db.sql(
      `update public.expenses set status = 'voided', voided_at = now() where id = $1`,
      [expense!.id],
    )

    await db.sql(`delete from public.organizations where id = $1`, [doomed.organizationId])

    const survivors = await db.sql(`select id from public.expenses where id = $1`, [expense!.id])
    expect(survivors).toHaveLength(0)
  })
})

describe('the Financing boundary on the dashboard', () => {
  it('leaves an instalment out of the operating result, as the tiles claim', async () => {
    const [lender] = await db.sql<{ id: string }>(
      `insert into public.lenders (organization_id, name) values ($1, 'Banque Atlas') returning id`,
      [organizationId],
    )
    const [plan] = await db.sql<{ id: string }>(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, agreement_type, currency,
          financed_amount_minor, installment_amount_minor, starts_on, first_payment_on, schedule_anchor_day)
       values ($1, $2, $3, 'loan', 'EUR', 15000000, 250000, '2031-01-01'::date, '2031-01-01'::date, 1)
       returning id`,
      [organizationId, vehicleA, lender!.id],
    )

    const before = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number; profit_minor: number }>(
        `select expenses_minor, profit_minor
           from public.organization_overview($1, '2032-12-01T00:00:00Z'::timestamptz, '2033-01-01T00:00:00Z'::timestamptz)`,
        [organizationId],
      ),
    )

    await db.sql(
      `insert into public.expenses
         (organization_id, category_id, allocation, vehicle_id, amount_minor, currency,
          incurred_on, description, source, financing_plan_id)
       values ($1, $2, 'vehicle', $3, 250000, 'EUR', '2032-12-04'::date, 'Loan instalment', 'financing', $4)`,
      [organizationId, categoryFuel, vehicleA, plan!.id],
    )

    const after = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number; profit_minor: number }>(
        `select expenses_minor, profit_minor
           from public.organization_overview($1, '2032-12-01T00:00:00Z'::timestamptz, '2033-01-01T00:00:00Z'::timestamptz)`,
        [organizationId],
      ),
    )

    expect(after[0]!.expenses_minor).toBe(before[0]!.expenses_minor)
    expect(after[0]!.profit_minor).toBe(before[0]!.profit_minor)
  })

  it('leaves it out of the chart the tiles sit above', async () => {
    const series = await db.asUser(ownerId, (session) =>
      session.sql<{ bucket_start: Date; expenses_minor: number }>(
        `select * from public.organization_financial_series($1, '2032-12-01'::date, '2033-01-01'::date, 'month')`,
        [organizationId],
      ),
    )

    const december = series.find(
      (row) =>
        row.bucket_start.getUTCFullYear() === 2032 && row.bucket_start.getUTCMonth() === 11,
    )
    expect(december).toBeDefined()

    // December holds other costs from earlier cases, so the claim is not that
    // the bucket is empty — it is that the bucket is exactly the operating
    // costs, with the instalment left out.
    const [operating] = await db.sql<{ total: number }>(
      `select coalesce(sum(amount_minor), 0)::bigint as total
         from public.expenses
        where organization_id = $1
          and status = 'recorded'
          and currency = 'EUR'
          and financing_plan_id is null
          and incurred_on >= '2032-12-01'::date
          and incurred_on <  '2033-01-01'::date`,
      [organizationId],
    )
    const [withFinancing] = await db.sql<{ total: number }>(
      `select coalesce(sum(amount_minor), 0)::bigint as total
         from public.expenses
        where organization_id = $1
          and status = 'recorded'
          and currency = 'EUR'
          and incurred_on >= '2032-12-01'::date
          and incurred_on <  '2033-01-01'::date`,
      [organizationId],
    )

    expect(Number(december!.expenses_minor)).toBe(Number(operating!.total))
    expect(Number(withFinancing!.total) - Number(operating!.total)).toBe(250000)
  })

  it('still shows the instalment in the agency’s own cost ledger', async () => {
    // Excluded from the operating figures, not hidden from the desk. A cost
    // nobody can find is a different bug from a cost counted twice.
    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ id: string; source: string }>(
        `select id, source from public.expense_ledger
          where organization_id = $1 and incurred_on = '2032-12-04'::date`,
        [organizationId],
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source).toBe('financing')
  })
})

describe('who a correction is attributed to', () => {
  it('is the person who made it, whatever the row claims', async () => {
    const id = await recordExpense({ incurredOn: '2032-11-05', amountMinor: 50000 })

    await db.asUser(managerId, async (session) => {
      // The manager writes somebody else's id into updated_by. The history is
      // not allowed to believe it.
      await session.sql(
        `update public.expenses set amount_minor = 60000, updated_by = $2 where id = $1`,
        [id, staffId],
      )
    })

    const [event] = await db.sql<{ changed_by: string }>(
      `select changed_by from public.expense_change_events
        where expense_id = $1 order by changed_at desc limit 1`,
      [id],
    )
    expect(event!.changed_by).toBe(managerId)
    expect(event!.changed_by).not.toBe(staffId)
  })

  it('falls back to the row when there is no session at all', async () => {
    // A server-side backfill has no auth.uid(); the column is then the only
    // identity there is, and losing it entirely would be worse.
    const id = await recordExpense({ incurredOn: '2032-11-06', amountMinor: 51000 })
    await db.sql(
      `update public.expenses set amount_minor = 52000, updated_by = $2 where id = $1`,
      [id, ownerId],
    )

    const [event] = await db.sql<{ changed_by: string }>(
      `select changed_by from public.expense_change_events
        where expense_id = $1 order by changed_at desc limit 1`,
      [id],
    )
    expect(event!.changed_by).toBe(ownerId)
  })
})

describe('the seeding function', () => {
  it('is not callable by a signed-in user', async () => {
    await db.asUser(ownerId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select app.seed_expense_categories($1)`, [organizationId]),
        /permission denied/i,
      )
    })
  })

  it('still runs for a new agency, because the trigger owns it', async () => {
    const fresh = await signUp(db, {
      email: 'fresh@expenses.test',
      fullName: 'Fresh Start',
      organizationName: 'Fresh Start Motors',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    })
    if (!fresh.organizationId) throw new Error('Provisioning failed.')

    const rows = await db.sql(
      `select id from public.expense_categories where organization_id = $1`,
      [fresh.organizationId],
    )
    expect(rows.length).toBeGreaterThanOrEqual(15)
  })
})
