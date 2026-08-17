// @vitest-environment node
/**
 * The scheduling read model and the one domain operation the Calendar adds.
 *
 * The board itself is drawn in the browser, but everything it is allowed to
 * believe comes from here: which bookings overlap a window, whether a hire is
 * late, what a vehicle is committed to next, and whether a move is permitted.
 *
 * Range boundaries get particular attention. A scheduler that drops a booking
 * because its start date is outside the window shows an empty slot for a car
 * that is actually out, which is the worst thing a fleet board can do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { isOverdue } from '../../src/features/calendar/schedule'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let staffId: string
let vehicleA: string
let vehicleB: string
let customerId: string

const DAY = 24 * 60 * 60 * 1000

/** A fixed base year for scheduling fixtures, well away from other suites. */
let cursor = Date.UTC(2030, 0, 1, 9, 0, 0)
function nextPeriod(days = 3): { startsAt: string; endsAt: string } {
  const start = new Date(cursor)
  const end = new Date(cursor + days * DAY)
  cursor += (days + 6) * DAY
  return { startsAt: start.toISOString(), endsAt: end.toISOString() }
}

async function createRental(options: {
  startsAt: string
  endsAt: string
  status?: string
  vehicleId?: string
}): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `insert into public.rentals
       (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
        daily_rate_minor, billable_days)
     values ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'EUR', $6::public.rental_status, 5000, 3)
     returning id`,
    [
      organizationId,
      options.vehicleId ?? vehicleA,
      customerId,
      options.startsAt,
      options.endsAt,
      options.status ?? 'draft',
    ],
  )
  return row!.id
}

async function addDriver(rentalId: string): Promise<void> {
  await db.sql(
    `insert into public.rental_drivers (organization_id, rental_id, customer_id, driver_role)
     values ($1, $2, $3, 'primary')`,
    [organizationId, rentalId, customerId],
  )
}

/** Confirms a rental so it holds its vehicle, the way the desk would. */
async function reserve(rentalId: string): Promise<void> {
  await addDriver(rentalId)
  await db.sql(`select public.rental_confirm($1)`, [rentalId])
}

/** The window query the Calendar issues, expressed exactly as the client does. */
async function scheduleWindow(
  from: string,
  to: string,
  statuses: string[] = ['reserved', 'active'],
): Promise<Array<Record<string, unknown>>> {
  return db.sql(
    `select * from public.rental_schedule
      where organization_id = $1
        and status::text = any($2::text[])
        and starts_at < $3::timestamptz
        and ends_at   > $4::timestamptz
      order by starts_at`,
    [organizationId, `{${statuses.join(',')}}`, to, from],
  )
}

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@calendar.test',
    fullName: 'Calendar Owner',
    organizationName: 'Calendar Motors',
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerId = owner.userId
  organizationId = owner.organizationId

  const staff = await signUp(db, { email: 'staff@calendar.test', fullName: 'Calendar Staff' })
  staffId = staff.userId
  await addMember(db, organizationId, staffId, 'staff')

  const [first] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor, odometer)
     values ($1, 'Peugeot', '208', 'CAL-001', 'EUR', 5000, 10000) returning id`,
    [organizationId],
  )
  const [second] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor, odometer)
     values ($1, 'Dacia', 'Sandero', 'CAL-002', 'EUR', 4000, 8000) returning id`,
    [organizationId],
  )
  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Nadia', 'El Amrani') returning id`,
    [organizationId],
  )

  vehicleA = first!.id
  vehicleB = second!.id
  customerId = customer!.id
}, 120_000)

afterAll(async () => {
  await db?.close()
})

// -----------------------------------------------------------------------------

describe('the window query', () => {
  it('returns a booking wholly inside the window', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    const rows = await scheduleWindow(
      new Date(Date.parse(period.startsAt) - DAY).toISOString(),
      new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    )
    expect(rows.map((row) => row.id)).toContain(id)
  })

  it('returns a booking that started before the window and ends inside it', async () => {
    const period = nextPeriod(10)
    const id = await createRental(period)
    await reserve(id)

    // The window opens midway through the hire — the car is out, and a board
    // that filtered on starts_at alone would show the slot as free.
    const rows = await scheduleWindow(
      new Date(Date.parse(period.startsAt) + 5 * DAY).toISOString(),
      new Date(Date.parse(period.endsAt) + 5 * DAY).toISOString(),
    )
    expect(rows.map((row) => row.id)).toContain(id)
  })

  it('returns a booking that starts inside the window and ends after it', async () => {
    const period = nextPeriod(10)
    const id = await createRental(period)
    await reserve(id)

    const rows = await scheduleWindow(
      new Date(Date.parse(period.startsAt) - DAY).toISOString(),
      new Date(Date.parse(period.startsAt) + 2 * DAY).toISOString(),
    )
    expect(rows.map((row) => row.id)).toContain(id)
  })

  it('returns a booking that covers the entire window', async () => {
    const period = nextPeriod(30)
    const id = await createRental(period)
    await reserve(id)

    const rows = await scheduleWindow(
      new Date(Date.parse(period.startsAt) + 10 * DAY).toISOString(),
      new Date(Date.parse(period.startsAt) + 12 * DAY).toISOString(),
    )
    expect(rows.map((row) => row.id)).toContain(id)
  })

  it('excludes a booking that ends exactly as the window opens', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    // Half-open, matching the exclusion constraint: touching is not overlapping.
    const rows = await scheduleWindow(
      period.endsAt,
      new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    )
    expect(rows.map((row) => row.id)).not.toContain(id)
  })

  it('includes a booking overlapping the window by one minute', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    const rows = await scheduleWindow(
      new Date(Date.parse(period.endsAt) - 60_000).toISOString(),
      new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    )
    expect(rows.map((row) => row.id)).toContain(id)
  })

  it('leaves drafts out unless they are asked for', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)

    const withoutDrafts = await scheduleWindow(period.startsAt, period.endsAt)
    expect(withoutDrafts.map((row) => row.id)).not.toContain(id)

    const withDrafts = await scheduleWindow(period.startsAt, period.endsAt, [
      'reserved',
      'active',
      'draft',
    ])
    expect(withDrafts.map((row) => row.id)).toContain(id)
  })

  it('leaves cancelled bookings out unless they are asked for', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)
    await db.sql(`select public.rental_cancel($1, 'smoke')`, [id])

    const normal = await scheduleWindow(period.startsAt, period.endsAt)
    expect(normal.map((row) => row.id)).not.toContain(id)

    const history = await scheduleWindow(period.startsAt, period.endsAt, ['cancelled'])
    expect(history.map((row) => row.id)).toContain(id)
  })

  it('still shows a past booking on a vehicle that has since been retired', async () => {
    const [retired] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
       values ($1, 'Fiat', 'Panda', 'CAL-OLD', 'EUR') returning id`,
      [organizationId],
    )

    // A finished hire from last year, on a car that has since left the fleet.
    // The fleet guard refuses to archive a vehicle with a live commitment, so
    // history is the only way this state is reachable — and the board still has
    // to be able to draw it.
    const [historic] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          picked_up_at, pickup_odometer, returned_at, return_odometer, completed_at)
       values ($1, $2, $3, now() - interval '400 days', now() - interval '396 days', 'EUR', 'completed',
               now() - interval '400 days', 500, now() - interval '396 days', 900, now() - interval '396 days')
       returning id`,
      [organizationId, retired!.id, customerId],
    )
    await db.sql(`update public.vehicles set archived_at = now() where id = $1`, [retired!.id])

    const rows = await db.sql<{ id: string }>(
      `select id from public.rental_schedule
        where organization_id = $1
          and status = 'completed'
          and starts_at < now() - interval '395 days'
          and ends_at   > now() - interval '401 days'`,
      [organizationId],
    )
    expect(rows.map((row) => row.id)).toContain(historic!.id)
  })
})

// -----------------------------------------------------------------------------

describe('overdue, defined once', () => {
  it('is a hire that is out, past its return, and not back', async () => {
    const [row] = await db.sql<{ overdue: boolean }>(
      `select public.rental_is_overdue('active'::public.rental_status, now() - interval '1 hour', null) as overdue`,
    )
    expect(row?.overdue).toBe(true)
  })

  it('is not overdue once the return has been recorded', async () => {
    const [row] = await db.sql<{ overdue: boolean }>(
      `select public.rental_is_overdue('active'::public.rental_status, now() - interval '1 hour', now()) as overdue`,
    )
    expect(row?.overdue).toBe(false)
  })

  it('is never overdue for a reservation', async () => {
    const [row] = await db.sql<{ overdue: boolean }>(
      `select public.rental_is_overdue('reserved'::public.rental_status, now() - interval '1 day', null) as overdue`,
    )
    expect(row?.overdue).toBe(false)
  })

  it('agrees with the TypeScript twin the board renders with', async () => {
    const cases: Array<[string, string, string | null]> = [
      ['active', '2030-06-01T09:00:00Z', null],
      ['active', '2099-06-01T09:00:00Z', null],
      ['active', '2030-06-01T09:00:00Z', '2030-06-01T10:00:00Z'],
      ['reserved', '2030-06-01T09:00:00Z', null],
      ['completed', '2030-06-01T09:00:00Z', null],
    ]

    const now = new Date()
    for (const [status, endsAt, returnedAt] of cases) {
      const [row] = await db.sql<{ overdue: boolean }>(
        `select public.rental_is_overdue($1::public.rental_status, $2::timestamptz, $3::timestamptz) as overdue`,
        [status, endsAt, returnedAt],
      )
      expect(row?.overdue).toBe(
        isOverdue(
          { status: status as never, ends_at: endsAt, returned_at: returnedAt },
          now,
        ),
      )
    }
  })

  it('reports the same thing on the schedule and on the rentals board', async () => {
    const [row] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          picked_up_at, pickup_odometer)
       values ($1, $2, $3, now() - interval '5 days', now() - interval '1 day', 'EUR', 'active',
               now() - interval '5 days', 11000)
       returning id`,
      [organizationId, vehicleB, customerId],
    )

    const [schedule] = await db.sql<{ is_overdue: boolean }>(
      `select is_overdue from public.rental_schedule where id = $1`,
      [row!.id],
    )
    const [board] = await db.sql<{ is_overdue: boolean }>(
      `select is_overdue from public.rental_board where id = $1`,
      [row!.id],
    )

    expect(schedule?.is_overdue).toBe(true)
    expect(board?.is_overdue).toBe(true)

    // Recording the return clears it on both, without the status changing.
    await db.sql(`select public.rental_check_in($1, 11500)`, [row!.id])

    const [afterSchedule] = await db.sql<{ is_overdue: boolean; status: string }>(
      `select is_overdue, status from public.rental_schedule where id = $1`,
      [row!.id],
    )
    const [afterBoard] = await db.sql<{ is_overdue: boolean }>(
      `select is_overdue from public.rental_board where id = $1`,
      [row!.id],
    )
    expect(afterSchedule?.is_overdue).toBe(false)
    expect(afterSchedule?.status).toBe('active')
    expect(afterBoard?.is_overdue).toBe(false)

    await db.sql(`select public.rental_complete($1)`, [row!.id])
  })
})

// -----------------------------------------------------------------------------

describe('the next commitment', () => {
  it('names what the vehicle is booked for next and how long the gap is', async () => {
    const first = nextPeriod(2)
    const firstId = await createRental(first)
    await reserve(firstId)

    const secondStart = new Date(Date.parse(first.endsAt) + 5 * 60 * 60 * 1000).toISOString()
    const secondId = await createRental({
      startsAt: secondStart,
      endsAt: new Date(Date.parse(secondStart) + DAY).toISOString(),
    })
    await reserve(secondId)

    const [row] = await db.sql<{
      next_rental_id: string
      next_rental_reference: string
      turnaround_minutes: number
    }>(
      `select next_rental_id, next_rental_reference, turnaround_minutes
         from public.rental_schedule where id = $1`,
      [firstId],
    )

    expect(row?.next_rental_id).toBe(secondId)
    expect(row?.next_rental_reference).toMatch(/^RNT-/)
    // Both are in the future, so the gap is measured from the first hire's end.
    expect(Number(row?.turnaround_minutes)).toBe(300)
  })

  it('ignores a draft as a next commitment, because a draft holds nothing', async () => {
    const first = nextPeriod(2)
    const firstId = await createRental(first)
    await reserve(firstId)

    await createRental({
      startsAt: new Date(Date.parse(first.endsAt) + 3_600_000).toISOString(),
      endsAt: new Date(Date.parse(first.endsAt) + 2 * DAY).toISOString(),
    })

    const [row] = await db.sql<{ next_rental_id: string | null }>(
      `select next_rental_id from public.rental_schedule where id = $1`,
      [firstId],
    )
    expect(row?.next_rental_id).toBeNull()
  })

  it('measures the gap from now once a hire is already late', async () => {
    const [late] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          picked_up_at, pickup_odometer)
       values ($1, $2, $3, now() - interval '3 days', now() - interval '2 days', 'EUR', 'active',
               now() - interval '3 days', 12000)
       returning id`,
      [organizationId, vehicleB, customerId],
    )

    const [next] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status)
       values ($1, $2, $3, now() + interval '2 hours', now() + interval '3 days', 'EUR', 'draft')
       returning id`,
      [organizationId, vehicleB, customerId],
    )
    await reserve(next!.id)

    const [row] = await db.sql<{ turnaround_minutes: number }>(
      `select turnaround_minutes from public.rental_schedule where id = $1`,
      [late!.id],
    )

    // Not "minus a day": the useful number is how long until the next customer
    // arrives, counted from now.
    expect(Number(row?.turnaround_minutes)).toBeGreaterThan(100)
    expect(Number(row?.turnaround_minutes)).toBeLessThanOrEqual(120)

    await db.sql(`select public.rental_check_in($1, 12500)`, [late!.id])
    await db.sql(`select public.rental_complete($1)`, [late!.id])
    await db.sql(`select public.rental_cancel($1, 'cleanup')`, [next!.id])
  })
})

// -----------------------------------------------------------------------------

describe('rescheduling', () => {
  it('moves a reservation in time', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    const newStart = new Date(Date.parse(period.startsAt) + DAY).toISOString()
    const newEnd = new Date(Date.parse(period.endsAt) + DAY).toISOString()

    const [moved] = await db.sql<{ starts_at: string; billable_days: number }>(
      `select starts_at, billable_days from public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`,
      [id, newStart, newEnd],
    )

    expect(new Date(String(moved?.starts_at)).toISOString()).toBe(newStart)
    expect(Number(moved?.billable_days)).toBe(2)
  })

  it('recomputes the chargeable days but never the charges', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)
    await db.sql(
      `insert into public.rental_line_items
         (organization_id, rental_id, kind, description, amount_minor, currency)
       values ($1, $2, 'base_rental', '2 days of hire', 10000, 'EUR')`,
      [organizationId, id],
    )

    await db.sql(
      `select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`,
      [id, period.startsAt, new Date(Date.parse(period.startsAt) + 5 * DAY).toISOString()],
    )

    const [row] = await db.sql<{ billable_days: number; total_minor: number }>(
      `select billable_days, total_minor from public.rentals where id = $1`,
      [id],
    )
    expect(Number(row?.billable_days)).toBe(5)
    // Silently repricing somebody's contract because a block was nudged would
    // be a far worse surprise than a day count the desk has to review.
    expect(Number(row?.total_minor)).toBe(10000)
  })

  it('treats the renegotiated return as the agreed one, not as an extension', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    // Confirming records the agreed return; moving the whole booking a week
    // later renegotiates it rather than lengthening the customer's hire.
    const later = new Date(Date.parse(period.startsAt) + 7 * DAY).toISOString()
    const laterEnd = new Date(Date.parse(period.endsAt) + 7 * DAY).toISOString()
    await db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
      id,
      later,
      laterEnd,
    ])

    const [row] = await db.sql<{
      ends_at: string
      original_ends_at: string
      extension_count: number
    }>(`select ends_at, original_ends_at, extension_count from public.rentals where id = $1`, [id])

    expect(new Date(String(row?.original_ends_at)).toISOString()).toBe(laterEnd)
    expect(new Date(String(row?.ends_at)).toISOString()).toBe(laterEnd)
    expect(Number(row?.extension_count)).toBe(0)

    // It now sits a week ahead, over the period the next test uses.
    await db.sql(`select public.rental_cancel($1, 'test cleanup')`, [id])
  })

  it('still records a genuine extension as one', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    await db.sql(`select public.rental_extend($1, $2::timestamptz, 0)`, [
      id,
      new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    ])

    const [row] = await db.sql<{ original_ends_at: string; extension_count: number }>(
      `select original_ends_at, extension_count from public.rentals where id = $1`,
      [id],
    )
    expect(new Date(String(row?.original_ends_at)).toISOString()).toBe(period.endsAt)
    expect(Number(row?.extension_count)).toBe(1)
  })

  it('moves a reservation onto another vehicle', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    const [moved] = await db.sql<{ vehicle_id: string }>(
      `select vehicle_id from public.rental_reschedule($1, $2::timestamptz, $3::timestamptz, $4)`,
      [id, period.startsAt, period.endsAt, vehicleB],
    )
    expect(moved?.vehicle_id).toBe(vehicleB)
  })

  it('refuses a move onto an occupied slot and changes nothing', async () => {
    const blocker = nextPeriod(3)
    const blockerId = await createRental({ ...blocker, vehicleId: vehicleB })
    await reserve(blockerId)

    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    await db.expectRejection(
      () =>
        db.sql(
          `select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz, $4)`,
          [id, blocker.startsAt, blocker.endsAt, vehicleB],
        ),
      /rentals_no_vehicle_overlap|conflicting key/i,
    )

    const [unchanged] = await db.sql<{ vehicle_id: string; starts_at: string }>(
      `select vehicle_id, starts_at from public.rentals where id = $1`,
      [id],
    )
    expect(unchanged?.vehicle_id).toBe(vehicleA)
    expect(new Date(String(unchanged?.starts_at)).toISOString()).toBe(period.startsAt)
  })

  it('refuses a return before the collection', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    await db.expectRejection(
      () =>
        db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
          id,
          period.endsAt,
          period.startsAt,
        ]),
      /return must be after the collection/i,
    )
  })

  it('lets a draft be parked anywhere, because it holds nothing', async () => {
    const taken = nextPeriod(3)
    const takenId = await createRental(taken)
    await reserve(takenId)

    const draftId = await createRental(nextPeriod(1))

    // Overlapping a live reservation is fine for a draft: the exclusion
    // constraint ignores drafts, and so does the board's occupancy.
    await db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
      draftId,
      taken.startsAt,
      taken.endsAt,
    ])

    const [row] = await db.sql<{ status: string }>(
      `select status from public.rentals where id = $1`,
      [draftId],
    )
    expect(row?.status).toBe('draft')
  })

  it('refuses to move a rental that is out with a customer', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)
    await db.sql(`select public.rental_check_out($1, 20000)`, [id])

    await db.expectRejection(
      () =>
        db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
          id,
          period.startsAt,
          new Date(Date.parse(period.endsAt) + DAY).toISOString(),
        ]),
      /extend or return this rental instead/i,
    )

    await db.sql(`select public.rental_check_in($1, 20400)`, [id])
    await db.sql(`select public.rental_complete($1)`, [id])
  })

  it('refuses to move a completed or cancelled rental', async () => {
    const completed = nextPeriod(1)
    const completedId = await createRental(completed)
    await reserve(completedId)
    await db.sql(`select public.rental_check_out($1, 21000)`, [completedId])
    await db.sql(`select public.rental_check_in($1, 21100)`, [completedId])
    await db.sql(`select public.rental_complete($1)`, [completedId])

    await db.expectRejection(
      () =>
        db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
          completedId,
          completed.startsAt,
          completed.endsAt,
        ]),
      /draft or a confirmed reservation/i,
    )

    const cancelled = nextPeriod(1)
    const cancelledId = await createRental(cancelled)
    await reserve(cancelledId)
    await db.sql(`select public.rental_cancel($1, 'no longer needed')`, [cancelledId])

    await db.expectRejection(
      () =>
        db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
          cancelledId,
          cancelled.startsAt,
          cancelled.endsAt,
        ]),
      /draft or a confirmed reservation/i,
    )
  })

  it('refuses a vehicle that is retired or off the road', async () => {
    const [offRoad] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, status)
       values ($1, 'Seat', 'Ibiza', 'CAL-FIX', 'EUR', 'maintenance') returning id`,
      [organizationId],
    )

    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    await db.expectRejection(
      () =>
        db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz, $4)`, [
          id,
          period.startsAt,
          period.endsAt,
          offRoad!.id,
        ]),
      /not in service/i,
    )
  })
})

// -----------------------------------------------------------------------------

describe('contracts survive a reschedule', () => {
  async function reservationWithContract(): Promise<{ id: string; period: ReturnType<typeof nextPeriod> }> {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)
    await db.sql(`select public.rental_issue_contract($1)`, [id])
    return { id, period }
  }

  it('refuses to move a booking whose contract has been issued', async () => {
    const { id, period } = await reservationWithContract()

    const message = await db.expectRejection(
      () =>
        db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
          id,
          new Date(Date.parse(period.startsAt) + DAY).toISOString(),
          new Date(Date.parse(period.endsAt) + DAY).toISOString(),
        ]),
      /requires issuing a new version/i,
    )
    // The refusal names the document, so the desk knows what it is about to amend.
    expect(message).toMatch(/RNT-/)

    const [unchanged] = await db.sql<{ starts_at: string }>(
      `select starts_at from public.rentals where id = $1`,
      [id],
    )
    expect(new Date(String(unchanged?.starts_at)).toISOString()).toBe(period.startsAt)
  })

  it('issues a new version and supersedes the old one when amendment is consented to', async () => {
    const { id, period } = await reservationWithContract()

    await db.sql(
      `select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz, null, true)`,
      [
        id,
        new Date(Date.parse(period.startsAt) + DAY).toISOString(),
        new Date(Date.parse(period.endsAt) + DAY).toISOString(),
      ],
    )

    const contracts = await db.sql<{ version: number; status: string; snapshot: Record<string, Record<string, unknown>> }>(
      `select version, status, snapshot from public.rental_contracts
        where rental_id = $1 order by version`,
      [id],
    )

    expect(contracts).toHaveLength(2)
    expect(contracts[0]?.status).toBe('superseded')
    expect(contracts[1]?.status).toBe('issued')

    // The superseded version still describes the booking as it was signed —
    // moving a block cannot rewrite what somebody agreed to.
    expect(new Date(String(contracts[0]!.snapshot.rental!.starts_at)).toISOString()).toBe(
      period.startsAt,
    )
    expect(new Date(String(contracts[1]!.snapshot.rental!.starts_at)).toISOString()).toBe(
      new Date(Date.parse(period.startsAt) + DAY).toISOString(),
    )
  })

  it('does not demand a new version for a booking with no contract', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    await db.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
      id,
      new Date(Date.parse(period.startsAt) + DAY).toISOString(),
      new Date(Date.parse(period.endsAt) + DAY).toISOString(),
    ])

    const contracts = await db.sql(`select id from public.rental_contracts where rental_id = $1`, [
      id,
    ])
    expect(contracts).toHaveLength(0)
  })

  it('reports on the schedule that a contract is live', async () => {
    const { id } = await reservationWithContract()

    const [row] = await db.sql<{ has_live_contract: boolean; contract_version: number }>(
      `select has_live_contract, contract_version from public.rental_schedule where id = $1`,
      [id],
    )
    expect(row?.has_live_contract).toBe(true)
    expect(Number(row?.contract_version)).toBe(1)
  })
})

// -----------------------------------------------------------------------------

describe('permissions and isolation', () => {
  let rival: { userId: string; organizationId: string }
  let sharedRentalId: string

  beforeAll(async () => {
    const other = await signUp(db, {
      email: 'rival@calendar.test',
      organizationName: 'Rival Scheduling',
      currency: 'EUR',
    })
    if (!other.organizationId) throw new Error('Provisioning failed for the second agency.')
    rival = { userId: other.userId, organizationId: other.organizationId }

    const period = nextPeriod(2)
    sharedRentalId = await createRental(period)
    await reserve(sharedRentalId)
  })

  it('shows another agency nothing on the schedule', async () => {
    await db.asUser(rival.userId, async (session) => {
      const rows = await session.sql(
        `select id from public.rental_schedule where organization_id = $1`,
        [organizationId],
      )
      expect(rows).toHaveLength(0)
    })
  })

  it('does not let another agency find a booking by its id', async () => {
    await db.asUser(rival.userId, async (session) => {
      const rows = await session.sql(`select id from public.rental_schedule where id = $1`, [
        sharedRentalId,
      ])
      expect(rows).toHaveLength(0)
    })
  })

  it('refuses to reschedule another agency\'s booking, indistinguishably from a missing one', async () => {
    await db.asUser(rival.userId, async (session) => {
      const foreign = await session.expectRejection(
        () =>
          session.sql(`select public.rental_reschedule($1, now(), now() + interval '1 day')`, [
            sharedRentalId,
          ]),
        /not found/i,
      )
      const missing = await session.expectRejection(
        () =>
          session.sql(
            `select public.rental_reschedule('00000000-0000-0000-0000-000000000000', now(), now() + interval '1 day')`,
          ),
        /not found/i,
      )
      expect(foreign).toBe(missing)
    })
  })

  it('will not let a booking be moved onto another agency\'s vehicle', async () => {
    const [rivalVehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
       values ($1, 'Kia', 'Picanto', 'RIV-001', 'EUR') returning id`,
      [rival.organizationId],
    )

    await db.asUser(ownerId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `select public.rental_reschedule($1, now() + interval '400 days', now() + interval '402 days', $2)`,
            [sharedRentalId, rivalVehicle!.id],
          ),
        /vehicle not found/i,
      )
    })
  })

  it('lets staff run the board and move a reservation', async () => {
    const period = nextPeriod(2)
    const id = await createRental(period)
    await reserve(id)

    await db.asUser(staffId, async (session) => {
      const rows = await session.sql(
        `select id from public.rental_schedule where organization_id = $1`,
        [organizationId],
      )
      expect(rows.length).toBeGreaterThan(0)

      await session.sql(`select public.rental_reschedule($1, $2::timestamptz, $3::timestamptz)`, [
        id,
        new Date(Date.parse(period.startsAt) + DAY).toISOString(),
        new Date(Date.parse(period.endsAt) + DAY).toISOString(),
      ])
    })

    const [moved] = await db.sql<{ starts_at: string }>(
      `select starts_at from public.rentals where id = $1`,
      [id],
    )
    expect(new Date(String(moved?.starts_at)).toISOString()).toBe(
      new Date(Date.parse(period.startsAt) + DAY).toISOString(),
    )
  })

  it('gives the anonymous role nothing', async () => {
    await db.asAnon(async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.rental_schedule limit 1`),
        /permission denied/i,
      )
      await session.expectRejection(
        () =>
          session.sql(`select public.rental_reschedule($1, now(), now() + interval '1 day')`, [
            sharedRentalId,
          ]),
        /permission denied/i,
      )
      await session.expectRejection(
        () =>
          session.sql(
            `select public.rental_is_overdue('active'::public.rental_status, now(), null)`,
          ),
        /permission denied/i,
      )
    })
  })

  it('keeps the schedule view under security_invoker', async () => {
    const [row] = await db.sql<{ options: string[] | null }>(
      `select c.reloptions as options
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'rental_schedule'`,
    )
    expect(row?.options?.join(',')).toMatch(/security_invoker=(true|on)/)
  })
})
