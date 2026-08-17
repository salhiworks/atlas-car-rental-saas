// @vitest-environment node
/**
 * The rental desk's rules, asserted against the real migrations.
 *
 * The lifecycle, the settlement arithmetic, the deposit/revenue separation and
 * contract immutability are all database invariants here rather than
 * application conventions, so this file drives them through SQL exactly as a
 * direct API call would.
 *
 * On concurrency: PGlite runs a single connection, so two genuinely parallel
 * transactions cannot be opened against it. What is asserted here is that the
 * exclusion constraint is present, immediate and enforced at write time — the
 * property that makes the race safe. The race itself is exercised against the
 * live Supabase project by scripts/live-smoke-test.mjs, which fires overlapping
 * requests in parallel over separate connections.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { billableDays } from '../../src/features/rentals/pricing'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let staffId: string
let vehicleId: string
let secondVehicleId: string
let customerId: string
let driverId: string

const DAY = 24 * 60 * 60 * 1000

/**
 * Odometer readings only ever go up, and check-out advances the vehicle's own
 * reading, so every test has to hand over a number above the last one.
 */
let odometerCursor = 20000
function nextOdometer(step = 400): number {
  odometerCursor += step
  return odometerCursor
}

/** A period offset from a fixed base, so tests never collide on the vehicle. */
let periodCursor = Date.UTC(2028, 0, 1, 9, 0, 0)
function nextPeriod(days = 3): { startsAt: string; endsAt: string } {
  const start = new Date(periodCursor)
  const end = new Date(periodCursor + days * DAY)
  periodCursor += (days + 5) * DAY
  return { startsAt: start.toISOString(), endsAt: end.toISOString() }
}

async function createRental(
  options: {
    startsAt?: string
    endsAt?: string
    status?: string
    vehicleId?: string
    currency?: string
    depositMinor?: number
    taxRateBps?: number
  } = {},
): Promise<string> {
  const period = nextPeriod()
  const [row] = await db.sql<{ id: string }>(
    `insert into public.rentals
       (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
        deposit_minor, tax_rate_bps, daily_rate_minor)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::public.rental_status, $8, $9, 5000)
     returning id`,
    [
      organizationId,
      options.vehicleId ?? vehicleId,
      customerId,
      options.startsAt ?? period.startsAt,
      options.endsAt ?? period.endsAt,
      options.currency ?? 'EUR',
      options.status ?? 'draft',
      options.depositMinor ?? 0,
      options.taxRateBps ?? 0,
    ],
  )
  return row!.id
}

async function addPrimaryDriver(rentalId: string, customer = customerId): Promise<void> {
  await db.sql(
    `insert into public.rental_drivers (organization_id, rental_id, customer_id, driver_role)
     values ($1, $2, $3, 'primary')`,
    [organizationId, rentalId, customer],
  )
}

async function addLine(
  rentalId: string,
  values: { kind?: string; description?: string; amountMinor: number; taxable?: boolean },
): Promise<void> {
  await db.sql(
    `insert into public.rental_line_items
       (organization_id, rental_id, kind, description, amount_minor, currency, is_taxable)
     values ($1, $2, $3::public.rental_charge_kind, $4, $5, 'EUR', $6)`,
    [
      organizationId,
      rentalId,
      values.kind ?? 'base_rental',
      values.description ?? 'Rental charge',
      values.amountMinor,
      values.taxable ?? true,
    ],
  )
}

async function readRental(rentalId: string): Promise<Record<string, number | string | null>> {
  const [row] = await db.sql<Record<string, number | string | null>>(
    `select status, subtotal_minor, extras_minor, discount_minor, tax_minor, total_minor,
            amount_paid_minor, deposit_held_minor, balance_due_minor, payment_status,
            extension_count, ends_at, vehicle_id
       from public.rentals where id = $1`,
    [rentalId],
  )
  return row!
}

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@rentals.test',
    fullName: 'Rental Owner',
    organizationName: 'Rental Desk Motors',
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerId = owner.userId
  organizationId = owner.organizationId

  const staff = await signUp(db, { email: 'staff@rentals.test', fullName: 'Desk Staff' })
  staffId = staff.userId
  await addMember(db, organizationId, staffId, 'staff')

  const [vehicle] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor, odometer)
     values ($1, 'Peugeot', '208', 'RNT-001', 'EUR', 5000, 20000) returning id`,
    [organizationId],
  )
  const [second] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor, odometer)
     values ($1, 'Dacia', 'Sandero', 'RNT-002', 'EUR', 4000, 15000) returning id`,
    [organizationId],
  )
  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name, email)
     values ($1, 'Amina', 'Tazi', 'amina@example.test') returning id`,
    [organizationId],
  )
  const [driver] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Youssef', 'Bennani') returning id`,
    [organizationId],
  )

  vehicleId = vehicle!.id
  secondVehicleId = second!.id
  customerId = customer!.id
  driverId = driver!.id
}, 120_000)

afterAll(async () => {
  await db?.close()
})

// -----------------------------------------------------------------------------

describe('the lifecycle', () => {
  it('confirms a draft into a reservation', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)

    await db.sql(`select public.rental_confirm($1)`, [id])

    const rental = await readRental(id)
    expect(rental.status).toBe('reserved')
  })

  it('refuses to confirm a draft with nobody named as the driver', async () => {
    const id = await createRental()

    await db.expectRejection(
      () => db.sql(`select public.rental_confirm($1)`, [id]),
      /primary driver/i,
    )
    expect((await readRental(id)).status).toBe('draft')
  })

  it('walks draft to reserved to active to completed', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)

    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_check_out($1, $2, 90::smallint, 'Clean, full tank')`, [id, nextOdometer()])
    expect((await readRental(id)).status).toBe('active')

    await db.sql(`select public.rental_check_in($1, $2, 40::smallint, 'Minor scuff, rear bumper')`, [id, nextOdometer()])
    // Returned is not the same as settled: the rental is still active until it
    // is completed, which leaves room to add a fuel or damage charge.
    expect((await readRental(id)).status).toBe('active')

    await db.sql(`select public.rental_complete($1)`, [id])
    expect((await readRental(id)).status).toBe('completed')
  })

  it('will not check out a rental that was never confirmed', async () => {
    const id = await createRental()
    await db.expectRejection(
      () => db.sql(`select public.rental_check_out($1, $2)`, [id, nextOdometer()]),
      /confirmed reservation/i,
    )
  })

  it('will not complete a rental that has not come back', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_check_out($1, $2)`, [id, nextOdometer()])

    await db.expectRejection(
      () => db.sql(`select public.rental_complete($1)`, [id]),
      /record the vehicle/i,
    )
  })

  it('refuses to cancel a rental that is out with a customer', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_check_out($1, $2)`, [id, nextOdometer()])

    await db.expectRejection(
      () => db.sql(`select public.rental_cancel($1, 'changed their mind')`, [id]),
      /draft or a reservation/i,
    )
  })

  it('refuses an illegal transition even when written directly', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])

    // Straight to completed, bypassing every function.
    await db.expectRejection(
      () =>
        db.sql(`update public.rentals set status = 'completed' where id = $1`, [id]),
      /checked out or cancelled/i,
    )
  })

  it('will not reopen a completed rental', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_check_out($1, $2)`, [id, nextOdometer()])
    await db.sql(`select public.rental_check_in($1, $2)`, [id, nextOdometer()])
    await db.sql(`select public.rental_complete($1)`, [id])

    await db.expectRejection(
      () => db.sql(`update public.rentals set status = 'active' where id = $1`, [id]),
      /cannot change status again/i,
    )
  })

  it('keeps a cancelled reservation and its history', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_record_payment($1, 12000, 'inbound', 'rental_charge')`, [id])

    await db.sql(`select public.rental_cancel($1, 'Flight cancelled')`, [id])

    const [row] = await db.sql<{ status: string; cancellation_reason: string; payments: number }>(
      `select r.status, r.cancellation_reason,
              (select count(*) from public.payments p where p.rental_id = r.id)::int as payments
         from public.rentals r where r.id = $1`,
      [id],
    )
    expect(row?.status).toBe('cancelled')
    expect(row?.cancellation_reason).toBe('Flight cancelled')
    // The money that was taken is still on the record; refunding it is a
    // separate, deliberate act.
    expect(Number(row?.payments)).toBe(1)
  })
})

// -----------------------------------------------------------------------------

describe('the odometer', () => {
  it('refuses a hand-over reading below the vehicle mileage', async () => {
    const id = await createRental({ vehicleId: secondVehicleId })
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])

    await db.expectRejection(
      () => db.sql(`select public.rental_check_out($1, 100)`, [id]),
      /below the vehicle's recorded mileage/i,
    )
  })

  it('refuses a return reading below the hand-over reading', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    const out = nextOdometer()
    await db.sql(`select public.rental_check_out($1, $2)`, [id, out])

    await db.expectRejection(
      () => db.sql(`select public.rental_check_in($1, $2)`, [id, out - 1000]),
      /below the reading at hand-over/i,
    )
  })

  it('advances the vehicle mileage as part of the same transaction', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])

    const out = nextOdometer()
    await db.sql(`select public.rental_check_out($1, $2)`, [id, out])

    const [afterOut] = await db.sql<{ odometer: number }>(
      `select odometer from public.vehicles where id = $1`,
      [vehicleId],
    )
    expect(Number(afterOut?.odometer)).toBe(out)

    const back = nextOdometer(850)
    await db.sql(`select public.rental_check_in($1, $2)`, [id, back])
    const [afterIn] = await db.sql<{ odometer: number }>(
      `select odometer from public.vehicles where id = $1`,
      [vehicleId],
    )
    expect(Number(afterIn?.odometer)).toBe(back)
  })
})

// -----------------------------------------------------------------------------

describe('availability', () => {
  it('refuses a second commitment on the same vehicle and period', async () => {
    const period = nextPeriod(4)
    const first = await createRental({ ...period })
    await addPrimaryDriver(first)
    await db.sql(`select public.rental_confirm($1)`, [first])

    const clashing = await createRental({
      startsAt: new Date(Date.parse(period.startsAt) + DAY).toISOString(),
      endsAt: new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    })
    await addPrimaryDriver(clashing, driverId)

    await db.expectRejection(
      () => db.sql(`select public.rental_confirm($1)`, [clashing]),
      /rentals_no_vehicle_overlap|conflicting key/i,
    )
  })

  it('allows a back-to-back booking that starts exactly when the last ends', async () => {
    const period = nextPeriod(2)
    const first = await createRental({ ...period })
    await addPrimaryDriver(first)
    await db.sql(`select public.rental_confirm($1)`, [first])

    // The range is half-open, so an 11:00 return and an 11:00 collection are
    // not a clash — which is exactly how a desk turns a car around.
    const next = await createRental({
      startsAt: period.endsAt,
      endsAt: new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    })
    await addPrimaryDriver(next, driverId)
    await db.sql(`select public.rental_confirm($1)`, [next])

    expect((await readRental(next)).status).toBe('reserved')
  })

  it('leaves the vehicle free while the rental is only a draft', async () => {
    const period = nextPeriod(3)
    await createRental({ ...period })

    // These read models assert membership, so they run as a signed-in member.
    await db.asUser(ownerId, async (session) => {
      const rows = await session.sql<{ id: string }>(
        `select public.vehicles_available_between($1, $2::timestamptz, $3::timestamptz) as id`,
        [organizationId, period.startsAt, period.endsAt],
      )
      expect(rows.map((row) => row.id)).toContain(vehicleId)
    })
  })

  it('names the contract that holds a vehicle', async () => {
    const period = nextPeriod(3)
    const held = await createRental({ ...period })
    await addPrimaryDriver(held)
    await db.sql(`select public.rental_confirm($1)`, [held])

    const conflicts = await db.sql<{ rental_id: string; reference: string; customer_name: string }>(
      `select * from public.rental_period_conflicts($1, $2::timestamptz, $3::timestamptz)`,
      [vehicleId, period.startsAt, period.endsAt],
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.rental_id).toBe(held)
    expect(conflicts[0]?.customer_name).toContain('Amina')

  })

  it('keeps the exclusion constraint immediate, not deferred', async () => {
    // A deferred constraint would let a whole transaction of work build on a
    // double booking before failing at commit. This is the property that makes
    // the constraint safe to rely on mid-transaction.
    const [row] = await db.sql<{ condeferrable: boolean; contype: string }>(
      `select condeferrable, contype from pg_constraint where conname = 'rentals_no_vehicle_overlap'`,
    )
    expect(row?.contype).toBe('x')
    expect(row?.condeferrable).toBe(false)
  })
})

// -----------------------------------------------------------------------------

describe('extension', () => {
  it('extends into free time and bills for it', async () => {
    const period = nextPeriod(2)
    const id = await createRental({ ...period })
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await addLine(id, { amountMinor: 10000, description: '2 days' })

    const extendedTo = new Date(Date.parse(period.endsAt) + 2 * DAY).toISOString()
    await db.sql(`select public.rental_extend($1, $2::timestamptz, 10000, '2 extra days', 2)`, [
      id,
      extendedTo,
    ])

    const rental = await readRental(id)
    expect(Number(rental.extension_count)).toBe(1)
    expect(Number(rental.total_minor)).toBe(20000)
    expect(new Date(String(rental.ends_at)).toISOString()).toBe(extendedTo)
  })

  it('refuses an extension into a period another contract holds', async () => {
    const period = nextPeriod(2)
    const id = await createRental({ ...period })
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])

    const blockerStart = new Date(Date.parse(period.endsAt) + DAY).toISOString()
    const blocker = await createRental({
      startsAt: blockerStart,
      endsAt: new Date(Date.parse(blockerStart) + DAY).toISOString(),
    })
    await addPrimaryDriver(blocker, driverId)
    await db.sql(`select public.rental_confirm($1)`, [blocker])

    await db.expectRejection(
      () =>
        db.sql(`select public.rental_extend($1, $2::timestamptz)`, [
          id,
          new Date(Date.parse(blockerStart) + 12 * 60 * 60 * 1000).toISOString(),
        ]),
      /rentals_no_vehicle_overlap|conflicting key/i,
    )

    // The customer keeps the original return date rather than a half-applied one.
    const rental = await readRental(id)
    expect(new Date(String(rental.ends_at)).toISOString()).toBe(period.endsAt)
    expect(Number(rental.extension_count)).toBe(0)
  })

  it('remembers the date first agreed', async () => {
    const period = nextPeriod(2)
    const id = await createRental({ ...period })
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_extend($1, $2::timestamptz)`, [
      id,
      new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    ])

    const [row] = await db.sql<{ original_ends_at: string }>(
      `select original_ends_at from public.rentals where id = $1`,
      [id],
    )
    expect(new Date(String(row?.original_ends_at)).toISOString()).toBe(period.endsAt)
  })
})

// -----------------------------------------------------------------------------

describe('vehicle substitution', () => {
  it('moves a reservation onto another vehicle', async () => {
    const period = nextPeriod(2)
    const id = await createRental({ ...period })
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])

    await db.sql(`select public.rental_substitute_vehicle($1, $2)`, [id, secondVehicleId])

    expect((await readRental(id)).vehicle_id).toBe(secondVehicleId)

    // And the original vehicle is free again for that period.
    await db.asUser(ownerId, async (session) => {
      const free = await session.sql<{ id: string }>(
        `select public.vehicles_available_between($1, $2::timestamptz, $3::timestamptz) as id`,
        [organizationId, period.startsAt, period.endsAt],
      )
      expect(free.map((row) => row.id)).toContain(vehicleId)
    })
  })

  it('will not change the vehicle after the customer has driven away', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_check_out($1, $2)`, [id, nextOdometer()])

    await db.expectRejection(
      () => db.sql(`select public.rental_substitute_vehicle($1, $2)`, [id, secondVehicleId]),
      /before the customer collects it/i,
    )
  })

  it('will not substitute a retired vehicle', async () => {
    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])

    const [retired] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, archived_at)
       values ($1, 'Fiat', 'Panda', 'RNT-OLD', 'EUR', now()) returning id`,
      [organizationId],
    )

    await db.expectRejection(
      () => db.sql(`select public.rental_substitute_vehicle($1, $2)`, [id, retired!.id]),
      /retired from the fleet/i,
    )
  })
})

// -----------------------------------------------------------------------------

describe('pricing', () => {
  it('derives every charge column from the line items', async () => {
    const id = await createRental({ taxRateBps: 2000 })

    await addLine(id, { kind: 'base_rental', description: '3 days at 50.00', amountMinor: 15000 })
    await addLine(id, { kind: 'child_seat', description: 'Child seat', amountMinor: 3000 })
    await addLine(id, { kind: 'discount', description: 'Returning customer', amountMinor: -1800 })

    const rental = await readRental(id)
    expect(Number(rental.subtotal_minor)).toBe(15000)
    expect(Number(rental.extras_minor)).toBe(3000)
    expect(Number(rental.discount_minor)).toBe(1800)
    // 20% of (15000 + 3000 - 1800)
    expect(Number(rental.tax_minor)).toBe(3240)
    expect(Number(rental.total_minor)).toBe(15000 + 3000 - 1800 + 3240)
  })

  it('leaves an exempt line out of the tax base', async () => {
    const id = await createRental({ taxRateBps: 2000 })
    await addLine(id, { amountMinor: 10000 })
    await addLine(id, { kind: 'other', description: 'Airport levy', amountMinor: 5000, taxable: false })

    const rental = await readRental(id)
    expect(Number(rental.tax_minor)).toBe(2000)
    expect(Number(rental.total_minor)).toBe(17000)
  })

  it('restates the tax when the rate changes, without touching the charges', async () => {
    const id = await createRental({ taxRateBps: 2000 })
    await addLine(id, { amountMinor: 10000 })
    expect(Number((await readRental(id)).tax_minor)).toBe(2000)

    await db.sql(`update public.rentals set tax_rate_bps = 700 where id = $1`, [id])

    const rental = await readRental(id)
    expect(Number(rental.tax_minor)).toBe(700)
    expect(Number(rental.subtotal_minor)).toBe(10000)
    expect(Number(rental.total_minor)).toBe(10700)
  })

  it('ignores a total written straight into the rental', async () => {
    const id = await createRental()
    await addLine(id, { amountMinor: 10000 })

    await db.sql(`update public.rentals set total_minor = 999999 where id = $1`, [id])

    expect(Number((await readRental(id)).total_minor)).toBe(10000)
  })

  it('recomputes when a line is removed', async () => {
    const id = await createRental()
    await addLine(id, { amountMinor: 10000 })
    await addLine(id, { kind: 'delivery', description: 'Delivery', amountMinor: 2500 })
    expect(Number((await readRental(id)).total_minor)).toBe(12500)

    await db.sql(`delete from public.rental_line_items where rental_id = $1 and kind = 'delivery'`, [id])
    expect(Number((await readRental(id)).total_minor)).toBe(10000)
  })

  it('refuses a discount larger than the charges', async () => {
    const id = await createRental()
    await addLine(id, { amountMinor: 5000 })

    await db.expectRejection(
      () => addLine(id, { kind: 'discount', description: 'Too much', amountMinor: -9000 }),
      /discount .* exceeds|rentals_.*_check|violates check/i,
    )
  })

  it('fills the explicit NULLs a bulk insert sends for omitted columns', async () => {
    // PostgREST unions the keys of an array of rows and sends an explicit NULL
    // for whatever a given row omits, which a column default never sees.
    const id = await createRental()
    await db.sql(
      `insert into public.rental_line_items
         (organization_id, rental_id, kind, description, amount_minor, currency,
          quantity, unit_amount_minor, is_taxable, sort_order)
       values ($1, $2, 'other', 'Bulk row', 4000, 'EUR', null, null, null, null)`,
      [organizationId, id],
    )

    const [line] = await db.sql<{
      quantity: string
      unit_amount_minor: number
      is_taxable: boolean
      sort_order: number
    }>(
      `select quantity, unit_amount_minor, is_taxable, sort_order
         from public.rental_line_items where rental_id = $1`,
      [id],
    )
    expect(Number(line?.quantity)).toBe(1)
    expect(Number(line?.unit_amount_minor)).toBe(4000)
    expect(line?.is_taxable).toBe(true)
    expect(Number(line?.sort_order)).toBe(0)
  })

  it('forces every line into the contract currency', async () => {
    const id = await createRental({ currency: 'EUR' })
    await db.sql(
      `insert into public.rental_line_items
         (organization_id, rental_id, kind, description, amount_minor, currency)
       values ($1, $2, 'other', 'Mistyped currency', 4000, 'USD')`,
      [organizationId, id],
    )

    const [line] = await db.sql<{ currency: string }>(
      `select currency from public.rental_line_items where rental_id = $1`,
      [id],
    )
    expect(line?.currency).toBe('EUR')
  })
})

describe('billable days', () => {
  const cases: Array<[string, string, number]> = [
    // A same-day hire is still a day.
    ['2028-06-01T09:00:00Z', '2028-06-01T17:00:00Z', 1],
    ['2028-06-01T09:00:00Z', '2028-06-02T09:00:00Z', 1],
    // Any started day is chargeable.
    ['2028-06-01T09:00:00Z', '2028-06-02T10:00:00Z', 2],
    ['2028-06-01T18:00:00Z', '2028-06-03T10:00:00Z', 2],
    ['2028-06-01T09:00:00Z', '2028-06-08T09:00:00Z', 7],
  ]

  for (const [startsAt, endsAt, expected] of cases) {
    it(`counts ${startsAt} to ${endsAt} as ${expected}`, async () => {
      const [row] = await db.sql<{ days: number }>(
        `select public.rental_billable_days($1::timestamptz, $2::timestamptz) as days`,
        [startsAt, endsAt],
      )
      expect(Number(row?.days)).toBe(expected)
    })
  }

  it('agrees with the TypeScript twin the quote screen uses', async () => {
    // The desk sees a figure before saving and the contract carries one after.
    // If these two ever disagree, the quote is a lie.
    const periods: Array<[string, string]> = [
      ['2028-01-01T09:00:00Z', '2028-01-01T09:00:01Z'],
      ['2028-01-01T09:00:00Z', '2028-01-02T09:00:00Z'],
      ['2028-01-01T09:00:00Z', '2028-01-02T09:00:01Z'],
      ['2028-01-01T18:30:00Z', '2028-01-05T08:15:00Z'],
      ['2028-03-25T09:00:00Z', '2028-03-27T08:00:00Z'],
      ['2028-06-01T00:00:00Z', '2028-07-01T00:00:00Z'],
    ]

    for (const [startsAt, endsAt] of periods) {
      const [row] = await db.sql<{ days: number }>(
        `select public.rental_billable_days($1::timestamptz, $2::timestamptz) as days`,
        [startsAt, endsAt],
      )
      expect(Number(row?.days)).toBe(billableDays(new Date(startsAt), new Date(endsAt)))
    }
  })

  it('is unmoved by a daylight-saving change inside the hire', async () => {
    // Europe/Paris springs forward on 2028-03-26. Local dates would make this
    // look like a different number of days than the elapsed time says.
    const [row] = await db.sql<{ days: number }>(
      `select public.rental_billable_days(
         timestamptz '2028-03-25 10:00:00 Europe/Paris',
         timestamptz '2028-03-27 10:00:00 Europe/Paris'
       ) as days`,
    )
    // 47 elapsed hours — two started days, not three.
    expect(Number(row?.days)).toBe(2)
  })
})

// -----------------------------------------------------------------------------

describe('deposits and revenue', () => {
  it('keeps a deposit out of what the customer has paid', async () => {
    const id = await createRental({ depositMinor: 30000 })
    await addLine(id, { amountMinor: 20000 })

    await db.sql(`select public.rental_record_payment($1, 30000, 'inbound', 'deposit')`, [id])

    const rental = await readRental(id)
    expect(Number(rental.deposit_held_minor)).toBe(30000)
    // The hire itself is still entirely unpaid.
    expect(Number(rental.amount_paid_minor)).toBe(0)
    expect(Number(rental.balance_due_minor)).toBe(20000)
    expect(rental.payment_status).toBe('unpaid')
  })

  it('settles the balance from rental charges only', async () => {
    const id = await createRental({ depositMinor: 30000 })
    await addLine(id, { amountMinor: 20000 })

    await db.sql(`select public.rental_record_payment($1, 30000, 'inbound', 'deposit')`, [id])
    await db.sql(`select public.rental_record_payment($1, 20000, 'inbound', 'rental_charge')`, [id])

    const rental = await readRental(id)
    expect(Number(rental.amount_paid_minor)).toBe(20000)
    expect(Number(rental.balance_due_minor)).toBe(0)
    expect(rental.payment_status).toBe('paid')
    expect(Number(rental.deposit_held_minor)).toBe(30000)
  })

  it('releases the deposit when it is refunded', async () => {
    const id = await createRental({ depositMinor: 30000 })
    await db.sql(`select public.rental_record_payment($1, 30000, 'inbound', 'deposit')`, [id])
    await db.sql(`select public.rental_record_payment($1, 30000, 'outbound', 'deposit')`, [id])

    expect(Number((await readRental(id)).deposit_held_minor)).toBe(0)
  })

  it('refuses to refund more than is held', async () => {
    const id = await createRental({ depositMinor: 30000 })
    await db.sql(`select public.rental_record_payment($1, 20000, 'inbound', 'deposit')`, [id])

    await db.expectRejection(
      () => db.sql(`select public.rental_record_payment($1, 25000, 'outbound', 'deposit')`, [id]),
      /is held as a deposit/i,
    )
  })

  it('will not complete a rental while a deposit is still held', async () => {
    const id = await createRental({ depositMinor: 20000 })
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    await db.sql(`select public.rental_record_payment($1, 20000, 'inbound', 'deposit')`, [id])
    await db.sql(`select public.rental_check_out($1, $2)`, [id, nextOdometer()])
    await db.sql(`select public.rental_check_in($1, $2)`, [id, nextOdometer()])

    await db.expectRejection(
      () => db.sql(`select public.rental_complete($1)`, [id]),
      /still held/i,
    )

    await db.sql(`select public.rental_record_payment($1, 20000, 'outbound', 'deposit')`, [id])
    await db.sql(`select public.rental_complete($1)`, [id])
    expect((await readRental(id)).status).toBe('completed')
  })

  it('counts rental charges as revenue and deposits as neither', async () => {
    const overview = async () => {
      return db.asUser(ownerId, async (session) => {
        const [row] = await session.sql<{ revenue_minor: number; deposits_held_minor: number }>(
          `select revenue_minor, deposits_held_minor
             from public.organization_overview($1, now() - interval '1 day', now() + interval '1 day')`,
          [organizationId],
        )
        return row!
      })
    }

    const before = await overview()

    const id = await createRental()
    await addLine(id, { amountMinor: 40000 })
    await db.sql(`select public.rental_record_payment($1, 40000, 'inbound', 'rental_charge')`, [id])
    await db.sql(`select public.rental_record_payment($1, 15000, 'inbound', 'deposit')`, [id])

    const after = await overview()

    expect(Number(after.revenue_minor) - Number(before.revenue_minor)).toBe(40000)
    expect(Number(after.deposits_held_minor) - Number(before.deposits_held_minor)).toBe(15000)
  })

  it('keeps a deposit out of the revenue chart too', async () => {
    const id = await createRental()
    await db.sql(
      `select public.rental_record_payment($1, 90000, 'inbound', 'deposit', 'card',
              now() - interval '40 days')`,
      [id],
    )

    await db.asUser(ownerId, async (session) => {
      const rows = await session.sql<{ revenue_minor: number }>(
        `select revenue_minor from public.organization_financial_series(
           $1, (now() - interval '60 days')::date, (now() + interval '1 day')::date, 'month')`,
        [organizationId],
      )
      expect(rows.some((row) => Number(row.revenue_minor) === 90000)).toBe(false)
    })
  })
})

describe('voiding a payment', () => {
  it('reverses the money without erasing the entry', async () => {
    const id = await createRental()
    await addLine(id, { amountMinor: 25000 })

    const [payment] = await db.sql<{ id: string }>(
      `select id from public.rental_record_payment($1, 25000, 'inbound', 'rental_charge')`,
      [id],
    )
    expect(Number((await readRental(id)).amount_paid_minor)).toBe(25000)

    await db.sql(`select public.rental_void_payment($1, 'Entered twice')`, [payment!.id])

    expect(Number((await readRental(id)).amount_paid_minor)).toBe(0)

    const [row] = await db.sql<{ voided_at: string; void_reason: string }>(
      `select voided_at, void_reason from public.payments where id = $1`,
      [payment!.id],
    )
    expect(row?.voided_at).not.toBeNull()
    expect(row?.void_reason).toBe('Entered twice')
  })

  it('refuses to void the same payment twice', async () => {
    const id = await createRental()
    const [payment] = await db.sql<{ id: string }>(
      `select id from public.rental_record_payment($1, 5000, 'inbound', 'rental_charge')`,
      [id],
    )
    await db.sql(`select public.rental_void_payment($1)`, [payment!.id])

    await db.expectRejection(
      () => db.sql(`select public.rental_void_payment($1)`, [payment!.id]),
      /already been voided/i,
    )
  })

  it('takes a voided payment out of revenue', async () => {
    const id = await createRental()
    const [payment] = await db.sql<{ id: string }>(
      `select id from public.rental_record_payment($1, 77000, 'inbound', 'rental_charge')`,
      [id],
    )

    const revenue = async () =>
      db.asUser(ownerId, async (session) => {
        const [row] = await session.sql<{ revenue_minor: number }>(
          `select revenue_minor from public.organization_overview($1, now() - interval '1 day', now() + interval '1 day')`,
          [organizationId],
        )
        return Number(row?.revenue_minor)
      })

    const withPayment = await revenue()
    await db.sql(`select public.rental_void_payment($1, 'Card declined')`, [payment!.id])
    expect(withPayment - (await revenue())).toBe(77000)
  })

  it('records a payment in the contract currency, with no way to say otherwise', async () => {
    const id = await createRental({ currency: 'EUR' })
    await db.sql(`select public.rental_record_payment($1, 1000, 'inbound', 'rental_charge')`, [id])

    const [row] = await db.sql<{ currency: string }>(
      `select currency from public.payments where rental_id = $1`,
      [id],
    )
    // A EUR contract settled partly in another currency has no meaningful
    // balance, and the product holds no exchange rate. The function takes the
    // currency from the contract, so the mismatch is not expressible.
    expect(row?.currency).toBe('EUR')
  })
})

// -----------------------------------------------------------------------------

describe('contracts', () => {
  async function issuedContract(): Promise<{ rentalId: string; contractId: string }> {
    const id = await createRental({ taxRateBps: 2000, depositMinor: 50000 })
    await addPrimaryDriver(id, driverId)
    await addLine(id, { amountMinor: 30000, description: '3 days at 100.00' })
    await db.sql(`select public.rental_confirm($1)`, [id])
    const [contract] = await db.sql<{ id: string }>(
      `select id from public.rental_issue_contract($1)`,
      [id],
    )
    return { rentalId: id, contractId: contract!.id }
  }

  it('will not issue a contract for a draft', async () => {
    const id = await createRental()
    await db.expectRejection(
      () => db.sql(`select public.rental_issue_contract($1)`, [id]),
      /confirm the reservation/i,
    )
  })

  it('freezes the agency, vehicle, renter, drivers, pricing and terms', async () => {
    const { contractId } = await issuedContract()

    const [row] = await db.sql<{ snapshot: Record<string, unknown> }>(
      `select snapshot from public.rental_contracts where id = $1`,
      [contractId],
    )
    const snapshot = row!.snapshot as Record<string, Record<string, unknown>>

    expect(snapshot.agency?.name).toBe('Rental Desk Motors')
    expect(snapshot.vehicle?.registration_plate).toBe('RNT-001')
    expect(snapshot.renter?.display_name).toContain('Amina')
    expect(Array.isArray(snapshot.drivers)).toBe(true)
    expect((snapshot.drivers as unknown as Array<Record<string, unknown>>)[0]?.role).toBe('primary')
    expect(snapshot.pricing?.total_minor).toBe(36000)
    expect(snapshot.terms).toBeDefined()
  })

  it('does not change when the underlying records change', async () => {
    const { contractId } = await issuedContract()

    await db.sql(`update public.customers set last_name = 'Renamed' where id = $1`, [customerId])
    await db.sql(`update public.vehicles set registration_plate = 'RNT-999' where id = $1`, [vehicleId])

    const [row] = await db.sql<{ snapshot: Record<string, Record<string, unknown>> }>(
      `select snapshot from public.rental_contracts where id = $1`,
      [contractId],
    )
    expect(row!.snapshot.renter?.display_name).toContain('Tazi')
    expect(row!.snapshot.vehicle?.registration_plate).toBe('RNT-001')

    // Put the fixtures back for the tests that follow.
    await db.sql(`update public.customers set last_name = 'Tazi' where id = $1`, [customerId])
    await db.sql(`update public.vehicles set registration_plate = 'RNT-001' where id = $1`, [vehicleId])
  })

  it('refuses to rewrite an issued snapshot', async () => {
    const { contractId } = await issuedContract()

    await db.sql(`update public.rental_contracts set snapshot = '{"tampered": true}'::jsonb where id = $1`, [
      contractId,
    ])

    const [row] = await db.sql<{ snapshot: Record<string, unknown> }>(
      `select snapshot from public.rental_contracts where id = $1`,
      [contractId],
    )
    expect(row!.snapshot.tampered).toBeUndefined()
    expect(row!.snapshot.agency).toBeDefined()
  })

  it('supersedes the previous version instead of editing it', async () => {
    const { rentalId, contractId } = await issuedContract()

    await addLine(rentalId, { kind: 'late_return', description: 'Late fee', amountMinor: 2000 })

    const [second] = await db.sql<{ id: string; version: number; contract_number: string }>(
      `select id, version, contract_number from public.rental_issue_contract($1, 'Late return charged')`,
      [rentalId],
    )

    const [previous] = await db.sql<{ status: string; supersede_reason: string }>(
      `select status, supersede_reason from public.rental_contracts where id = $1`,
      [contractId],
    )
    expect(previous?.status).toBe('superseded')
    expect(previous?.supersede_reason).toBe('Late return charged')
    expect(Number(second?.version)).toBe(2)
  })

  it('keeps the contract number stable across versions', async () => {
    const { rentalId } = await issuedContract()
    await db.sql(`select public.rental_issue_contract($1)`, [rentalId])

    const rows = await db.sql<{ contract_number: string }>(
      `select contract_number from public.rental_contracts where rental_id = $1`,
      [rentalId],
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.contract_number)).size).toBe(1)
  })

  it('numbers contracts with the agency prefix and the year', async () => {
    const id = await createRental()
    const [row] = await db.sql<{ reference: string }>(
      `select reference from public.rentals where id = $1`,
      [id],
    )
    expect(row?.reference).toMatch(/^RNT-\d{4}-\d{5}$/)
  })

  it('will not unsign a signed contract', async () => {
    const { contractId } = await issuedContract()
    await db.sql(
      `update public.rental_contracts set status = 'signed', signed_at = now(), renter_signature_name = 'A. Tazi'
        where id = $1`,
      [contractId],
    )

    await db.expectRejection(
      () => db.sql(`update public.rental_contracts set status = 'issued' where id = $1`, [contractId]),
      /cannot be returned to unsigned/i,
    )
  })

  it('records the PDF alongside the snapshot without touching it', async () => {
    const { contractId } = await issuedContract()
    await db.sql(
      `update public.rental_contracts
          set pdf_path = $2, pdf_generated_at = now(), pdf_byte_size = 51234,
              pdf_sha256 = repeat('a', 64)
        where id = $1`,
      [contractId, `${organizationId}/contract.pdf`],
    )

    const [row] = await db.sql<{ pdf_path: string; snapshot: Record<string, unknown> }>(
      `select pdf_path, snapshot from public.rental_contracts where id = $1`,
      [contractId],
    )
    expect(row?.pdf_path).toContain(organizationId)
    expect(row!.snapshot.agency).toBeDefined()
  })
})

describe('agency terms', () => {
  it('bumps the version whenever the wording changes', async () => {
    const [before] = await db.sql<{ terms_version: number }>(
      `select terms_version from public.organization_settings where organization_id = $1`,
      [organizationId],
    )

    await db.sql(
      `update public.organization_settings set fuel_policy = 'Return with a full tank.'
        where organization_id = $1`,
      [organizationId],
    )

    const [after] = await db.sql<{ terms_version: number }>(
      `select terms_version from public.organization_settings where organization_id = $1`,
      [organizationId],
    )
    expect(Number(after?.terms_version)).toBe(Number(before?.terms_version) + 1)
  })

  it('leaves the version alone when something unrelated changes', async () => {
    const [before] = await db.sql<{ terms_version: number }>(
      `select terms_version from public.organization_settings where organization_id = $1`,
      [organizationId],
    )
    await db.sql(
      `update public.organization_settings set distance_unit = 'km' where organization_id = $1`,
      [organizationId],
    )
    const [after] = await db.sql<{ terms_version: number }>(
      `select terms_version from public.organization_settings where organization_id = $1`,
      [organizationId],
    )
    expect(Number(after?.terms_version)).toBe(Number(before?.terms_version))
  })

  it('records on the contract which wording it captured', async () => {
    await db.sql(
      `update public.organization_settings set damage_policy = 'Damage is charged at cost.'
        where organization_id = $1`,
      [organizationId],
    )
    const [settings] = await db.sql<{ terms_version: number }>(
      `select terms_version from public.organization_settings where organization_id = $1`,
      [organizationId],
    )

    const id = await createRental()
    await addPrimaryDriver(id)
    await db.sql(`select public.rental_confirm($1)`, [id])
    const [contract] = await db.sql<{ terms_version: number; snapshot: Record<string, Record<string, unknown>> }>(
      `select terms_version, snapshot from public.rental_issue_contract($1)`,
      [id],
    )

    expect(Number(contract?.terms_version)).toBe(Number(settings?.terms_version))
    expect(contract!.snapshot.terms?.damage_policy).toBe('Damage is charged at cost.')
  })
})

// -----------------------------------------------------------------------------

describe('the rentals board', () => {
  it('shows when the renter is not the driver', async () => {
    const id = await createRental()
    await addPrimaryDriver(id, driverId)
    await db.sql(`select public.rental_confirm($1)`, [id])

    const [row] = await db.sql<{
      renter_is_not_driver: boolean
      primary_driver_name: string
      customer_name: string
    }>(`select renter_is_not_driver, primary_driver_name, customer_name from public.rental_board where id = $1`, [id])

    expect(row?.renter_is_not_driver).toBe(true)
    expect(row?.primary_driver_name).toContain('Youssef')
    expect(row?.customer_name).toContain('Amina')
  })

  it('flags a rental that is past its return time', async () => {
    const [row] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          picked_up_at, pickup_odometer)
       values ($1, $2, $3, now() - interval '5 days', now() - interval '1 day', 'EUR', 'active',
               now() - interval '5 days', 70000)
       returning id`,
      [organizationId, secondVehicleId, customerId],
    )

    const [board] = await db.sql<{ is_overdue: boolean }>(
      `select is_overdue from public.rental_board where id = $1`,
      [row!.id],
    )
    expect(board?.is_overdue).toBe(true)

    await db.sql(
      `update public.rentals set status = 'completed', completed_at = now(),
              returned_at = now(), return_odometer = 70500 where id = $1`,
      [row!.id],
    )
  })

  it('reports what a rental would take with it if deleted', async () => {
    const id = await createRental()
    await addLine(id, { amountMinor: 5000 })
    await db.sql(`select public.rental_record_payment($1, 5000, 'inbound', 'rental_charge')`, [id])

    await db.asUser(ownerId, async (session) => {
      const [usage] = await session.sql<{ payment_count: number; can_delete: boolean }>(
        `select payment_count, can_delete from public.rental_usage($1)`,
        [id],
      )
      expect(Number(usage?.payment_count)).toBe(1)
      expect(usage?.can_delete).toBe(false)
    })
  })
})

// -----------------------------------------------------------------------------

describe('permissions and isolation', () => {
  let otherAgency: { userId: string; organizationId: string }
  let sharedRentalId: string

  beforeAll(async () => {
    const other = await signUp(db, {
      email: 'rival@rentals.test',
      organizationName: 'Rival Rentals',
      currency: 'EUR',
    })
    if (!other.organizationId) throw new Error('Provisioning failed for the second agency.')
    otherAgency = { userId: other.userId, organizationId: other.organizationId }

    sharedRentalId = await createRental()
    await addLine(sharedRentalId, { amountMinor: 8000 })
    await db.sql(`select public.rental_issue_contract($1)`, [sharedRentalId]).catch(() => undefined)
  })

  it('hides another agency\'s rentals entirely', async () => {
    await db.asUser(otherAgency.userId, async (session) => {
      const rows = await session.sql(`select id from public.rentals where id = $1`, [sharedRentalId])
      expect(rows).toHaveLength(0)
    })
  })

  it('hides another agency\'s line items and contracts', async () => {
    await db.asUser(otherAgency.userId, async (session) => {
      expect(
        await session.sql(`select id from public.rental_line_items where rental_id = $1`, [sharedRentalId]),
      ).toHaveLength(0)
      expect(
        await session.sql(`select id from public.rental_contracts where rental_id = $1`, [sharedRentalId]),
      ).toHaveLength(0)
      expect(await session.sql(`select id from public.rental_board where id = $1`, [sharedRentalId])).toHaveLength(0)
    })
  })

  /*
   * `rental_usage` used to raise P0002 for anything it would not report on,
   * which PostgREST returns as HTTP 500 — a server error for an ordinary stale
   * bookmark. It now answers with no rows. What must not change is that the
   * three cases below stay in exactly two groups: a rental you may see, and
   * everything else, with no way to tell the "everything else" apart.
   */
  it('reports usage for a rental the caller may see', async () => {
    await db.asUser(ownerId, async (session) => {
      const rows = await session.sql<{ line_item_count: number; can_delete: boolean }>(
        `select line_item_count, can_delete from public.rental_usage($1)`,
        [sharedRentalId],
      )
      expect(rows).toHaveLength(1)
      expect(Number(rows[0]!.line_item_count)).toBe(1)
    })
  })

  it('answers a rental that does not exist with no rows, and no exception', async () => {
    await db.asUser(ownerId, async (session) => {
      const rows = await session.sql(`select * from public.rental_usage($1)`, [
        '00000000-0000-0000-0000-000000000000',
      ])
      expect(rows).toHaveLength(0)
    })
  })

  it('answers another agency\'s rental identically, so the id is not an oracle', async () => {
    await db.asUser(otherAgency.userId, async (session) => {
      const existsElsewhere = await session.sql(`select * from public.rental_usage($1)`, [
        sharedRentalId,
      ])
      const doesNotExist = await session.sql(`select * from public.rental_usage($1)`, [
        '00000000-0000-0000-0000-000000000000',
      ])
      // Same answer for "someone else's" and "nobody's": zero rows either way.
      expect(existsElsewhere).toEqual(doesNotExist)
      expect(existsElsewhere).toHaveLength(0)
    })
  })

  it('still refuses the anonymous role outright', async () => {
    const [row] = await db.sql<{ anon: boolean }>(
      `select has_function_privilege('anon', 'public.rental_usage(uuid)', 'EXECUTE') as anon`,
    )
    expect(row!.anon).toBe(false)
  })

  it('refuses a lifecycle call from outside the agency', async () => {
    await db.asUser(otherAgency.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.rental_confirm($1)`, [sharedRentalId]),
        /not found/i,
      )
    })
  })

  it('lets staff run the desk', async () => {
    await db.asUser(staffId, async (session) => {
      const rows = await session.sql(`select id from public.rentals where organization_id = $1`, [
        organizationId,
      ])
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  it('does not let staff delete a condition photograph', async () => {
    const id = await createRental()
    await db.sql(
      `insert into public.rental_condition_photos
         (organization_id, rental_id, phase, storage_path, content_type, byte_size)
       values ($1, $2, 'pickup', $3, 'image/jpeg', 120000)`,
      [organizationId, id, `${organizationId}/${id}/pickup-1.jpg`],
    )

    await db.asUser(staffId, async (session) => {
      await session.sql(`delete from public.rental_condition_photos where rental_id = $1`, [id])
      const rows = await session.sql(`select id from public.rental_condition_photos where rental_id = $1`, [id])
      // The delete matched nothing: the policy is manager and above.
      expect(rows).toHaveLength(1)
    })
  })

  it('gives the anonymous role nothing', async () => {
    await db.asAnon(async (session) => {
      for (const table of [
        'rentals',
        'rental_line_items',
        'rental_contracts',
        'rental_condition_photos',
        'rental_board',
      ]) {
        await session.expectRejection(
          () => session.sql(`select * from public.${table} limit 1`),
          /permission denied/i,
        )
      }
    })
  })

  it('keeps every rental function out of anon\'s reach', async () => {
    const rows = await db.sql<{ proname: string }>(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like 'rental%'
          and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    )
    expect(rows).toHaveLength(0)
  })

  it('will not accept a driver from another agency', async () => {
    const [outsider] = await db.sql<{ id: string }>(
      `insert into public.customers (organization_id, first_name, last_name)
       values ($1, 'Outside', 'Person') returning id`,
      [otherAgency.organizationId],
    )
    const id = await createRental()

    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.rental_drivers (organization_id, rental_id, customer_id, driver_role)
           values ($1, $2, $3, 'additional')`,
          [organizationId, id, outsider!.id],
        ),
      /rental_drivers_customer_fkey|violates foreign key/i,
    )
  })

  it('will not attach a line item to another agency\'s rental', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.rental_line_items
             (organization_id, rental_id, kind, description, amount_minor, currency)
           values ($1, $2, 'other', 'Cross-tenant', 1000, 'EUR')`,
          [otherAgency.organizationId, sharedRentalId],
        ),
      /rental_line_items_rental_fkey|violates foreign key|Rental not found/i,
    )
  })
})
