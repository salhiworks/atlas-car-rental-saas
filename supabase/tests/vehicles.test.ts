// @vitest-environment node
/**
 * The Vehicles module at the database level.
 *
 * Everything here runs as the `authenticated` role, so RLS is genuinely in
 * force — the same position a browser occupies. These cover the guarantees the
 * interface is built on top of: tenant isolation, role gating, plate and VIN
 * uniqueness, the derived availability model, archive-versus-delete, media
 * scoping, and the storage policies that keep one agency's photographs away
 * from another's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase

interface Agency {
  userId: string
  organizationId: string
  managerId: string
  staffId: string
  adminId: string
}

let agencyA: Agency
let agencyB: Agency
let vehicleA: string
let vehicleB: string
let customerA: string

async function setUpAgency(slug: string, name: string): Promise<Agency> {
  const owner = await signUp(db, {
    email: `owner@${slug}.test`,
    organizationName: name,
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error(`Provisioning failed for ${name}`)

  const manager = await signUp(db, { email: `manager@${slug}.test` })
  const staff = await signUp(db, { email: `staff@${slug}.test` })
  const admin = await signUp(db, { email: `admin@${slug}.test` })

  await addMember(db, owner.organizationId, manager.userId, 'manager')
  await addMember(db, owner.organizationId, staff.userId, 'staff')
  await addMember(db, owner.organizationId, admin.userId, 'admin')

  return {
    userId: owner.userId,
    organizationId: owner.organizationId,
    managerId: manager.userId,
    staffId: staff.userId,
    adminId: admin.userId,
  }
}

async function createVehicle(
  organizationId: string,
  plate: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const columns = {
    make: 'Renault',
    model: 'Clio',
    registration_plate: plate,
    currency: 'EUR',
    daily_rate_minor: 4500,
    ...overrides,
  }
  const names = Object.keys(columns)
  const placeholders = names.map((_, index) => `$${index + 2}`)

  const [row] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, ${names.join(', ')})
     values ($1, ${placeholders.join(', ')}) returning id`,
    [organizationId, ...Object.values(columns)],
  )
  return row!.id
}

beforeAll(async () => {
  db = await TestDatabase.create()

  agencyA = await setUpAgency('alpha-fleet', 'Alpha Fleet')
  agencyB = await setUpAgency('beta-fleet', 'Beta Fleet')

  vehicleA = await createVehicle(agencyA.organizationId, 'ALPHA-100')
  vehicleB = await createVehicle(agencyB.organizationId, 'BETA-100')

  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Ada', 'Lovelace') returning id`,
    [agencyA.organizationId],
  )
  customerA = customer!.id
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('tenant isolation', () => {
  it('shows a member only their own agency’s vehicles', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ organization_id: string }>(`select organization_id from public.vehicles`),
    )

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.organization_id === agencyA.organizationId)).toBe(true)
  })

  it('returns nothing when asking for another agency’s vehicle by id', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from public.vehicles where id = $1`, [vehicleB]),
    )
    expect(rows).toEqual([])
  })

  it('cannot tell a foreign vehicle apart from one that does not exist', async () => {
    // Both must fail identically, or the error itself confirms the record exists.
    const foreign = await db.expectRejection(() =>
      db.asUser(agencyA.userId, (session) =>
        session.sql(`select * from public.vehicle_usage($1)`, [vehicleB]),
      ),
    )
    const missing = await db.expectRejection(() =>
      db.asUser(agencyA.userId, (session) =>
        session.sql(`select * from public.vehicle_usage($1)`, [
          '00000000-0000-0000-0000-000000000000',
        ]),
      ),
    )

    expect(foreign).toBe(missing)
    expect(foreign).toMatch(/vehicle not found/i)
  })

  it('cannot modify another agency’s vehicle', async () => {
    await db.asUser(agencyA.userId, (session) =>
      session.sql(`update public.vehicles set odometer = 999999 where id = $1`, [vehicleB]),
    )

    const [after] = await db.sql<{ odometer: number }>(
      `select odometer from public.vehicles where id = $1`,
      [vehicleB],
    )
    expect(after?.odometer).toBe(0)
  })

  it('cannot insert a vehicle into another agency', async () => {
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

  it('scopes the fleet view to the caller', async () => {
    const rows = await db.asUser(agencyB.userId, (session) =>
      session.sql<{ organization_id: string }>(
        `select organization_id from public.vehicle_fleet`,
      ),
    )
    expect(rows.every((row) => row.organization_id === agencyB.organizationId)).toBe(true)
  })

  it('scopes the fleet counts to the caller', async () => {
    const [counts] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ total: number }>(`select * from public.fleet_status_counts($1)`, [
        agencyA.organizationId,
      ]),
    )
    expect(counts?.total).toBe(1)

    await db.expectRejection(
      () =>
        db.asUser(agencyA.userId, (session) =>
          session.sql(`select * from public.fleet_status_counts($1)`, [agencyB.organizationId]),
        ),
      /not a member of this organization/i,
    )
  })

  it('denies anon every vehicle surface', async () => {
    await db.asAnon(async (session) => {
      for (const statement of [
        `select * from public.vehicles`,
        `select * from public.vehicle_fleet`,
        `select * from public.vehicle_images`,
        `select * from public.vehicle_documents`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /permission denied/i)
      }
    })
  })
})

describe('role enforcement', () => {
  it('lets staff read the fleet but not add to it', async () => {
    await db.asUser(agencyA.staffId, async (session) => {
      const rows = await session.sql(`select id from public.vehicles`)
      expect(rows.length).toBeGreaterThan(0)

      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
             values ($1, 'Ford', 'Focus', 'STAFF-ADD', 'EUR')`,
            [agencyA.organizationId],
          ),
        /row-level security/i,
      )
    })
  })

  it('does not let staff edit a vehicle', async () => {
    await db.asUser(agencyA.staffId, (session) =>
      session.sql(`update public.vehicles set odometer = 12345 where id = $1`, [vehicleA]),
    )

    const [after] = await db.sql<{ odometer: number }>(
      `select odometer from public.vehicles where id = $1`,
      [vehicleA],
    )
    expect(after?.odometer).toBe(0)
  })

  it('lets a manager add and edit', async () => {
    const id = await db.asUser(agencyA.managerId, async (session) => {
      const [row] = await session.sql<{ id: string }>(
        `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
         values ($1, 'Ford', 'Focus', 'MGR-ADD', 'EUR') returning id`,
        [agencyA.organizationId],
      )
      await session.sql(`update public.vehicles set odometer = 5000 where id = $1`, [row!.id])
      return row!.id
    })

    const [after] = await db.sql<{ odometer: number }>(
      `select odometer from public.vehicles where id = $1`,
      [id],
    )
    expect(after?.odometer).toBe(5000)
  })

  it('does not let a manager delete a vehicle', async () => {
    const id = await createVehicle(agencyA.organizationId, 'MGR-DEL')

    await db.asUser(agencyA.managerId, (session) =>
      session.sql(`delete from public.vehicles where id = $1`, [id]),
    )

    const rows = await db.sql(`select id from public.vehicles where id = $1`, [id])
    expect(rows).toHaveLength(1)
  })

  it('lets an admin delete a vehicle with no history', async () => {
    const id = await createVehicle(agencyA.organizationId, 'ADMIN-DEL')

    await db.asUser(agencyA.adminId, (session) =>
      session.sql(`delete from public.vehicles where id = $1`, [id]),
    )

    const rows = await db.sql(`select id from public.vehicles where id = $1`, [id])
    expect(rows).toEqual([])
  })

  it('gates photo and document writes at manager, and reads at membership', async () => {
    await db.asUser(agencyA.staffId, async (session) => {
      // Reading is ordinary membership.
      await session.sql(`select id from public.vehicle_images`)

      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.vehicle_images
               (organization_id, vehicle_id, storage_path, content_type, byte_size)
             values ($1, $2, $3, 'image/png', 1024)`,
            [agencyA.organizationId, vehicleA, `${agencyA.organizationId}/${vehicleA}/staff.png`],
          ),
        /row-level security/i,
      )
    })
  })
})

describe('identifier uniqueness', () => {
  it('refuses a duplicate plate within an agency, ignoring case and spacing', async () => {
    await createVehicle(agencyA.organizationId, 'DUP-PLATE-1')

    await db.expectRejection(
      () => createVehicle(agencyA.organizationId, '  dup-plate-1  '),
      /vehicles_plate_unique_idx|duplicate key/i,
    )
  })

  it('allows the same plate in a different agency', async () => {
    await createVehicle(agencyA.organizationId, 'SHARED-PLATE')
    const id = await createVehicle(agencyB.organizationId, 'SHARED-PLATE')
    expect(id).toBeTruthy()
  })

  it('frees a plate once the vehicle is retired', async () => {
    const id = await createVehicle(agencyA.organizationId, 'RECYCLED-1')
    await db.sql(`update public.vehicles set archived_at = now() where id = $1`, [id])

    const replacement = await createVehicle(agencyA.organizationId, 'RECYCLED-1')
    expect(replacement).toBeTruthy()
  })

  it('refuses a duplicate VIN within an agency', async () => {
    await createVehicle(agencyA.organizationId, 'VIN-A', { vin: 'VF15RJL0X12345678' })

    await db.expectRejection(
      () => createVehicle(agencyA.organizationId, 'VIN-B', { vin: 'VF15RJL0X12345678' }),
      /vehicles_vin_unique_idx|duplicate key/i,
    )
  })
})

describe('status is operational only', () => {
  it('refuses to store an occupancy state on a vehicle', async () => {
    for (const status of ['rented', 'reserved']) {
      await db.expectRejection(
        () => db.sql(`update public.vehicles set status = $1 where id = $2`, [status, vehicleA]),
        /vehicles_status_is_operational|violates check constraint/i,
      )
    }
  })

  it('accepts the three states an agency actually decides', async () => {
    for (const status of ['maintenance', 'unavailable', 'available']) {
      await db.sql(`update public.vehicles set status = $1 where id = $2`, [status, vehicleA])
    }

    const [row] = await db.sql<{ status: string }>(
      `select status from public.vehicles where id = $1`,
      [vehicleA],
    )
    expect(row?.status).toBe('available')
  })
})

describe('derived availability', () => {
  async function effectiveStatus(vehicleId: string): Promise<string> {
    const [row] = await db.sql<{ effective_status: string }>(
      `select effective_status from public.vehicle_fleet where vehicle_id = $1`,
      [vehicleId],
    )
    return row!.effective_status
  }

  it('reports an idle in-service vehicle as available', async () => {
    const id = await createVehicle(agencyA.organizationId, 'AVAIL-1')
    expect(await effectiveStatus(id)).toBe('available')
  })

  it('reports a vehicle out on a contract as rented, without anything writing that', async () => {
    const id = await createVehicle(agencyA.organizationId, 'RENTED-1')
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status)
       values ($1, $2, $3, now() - interval '2 hours', now() + interval '2 days', 'EUR', 'active')`,
      [agencyA.organizationId, id, customerA],
    )

    expect(await effectiveStatus(id)).toBe('rented')

    // The stored column is untouched — nothing had to be synchronised.
    const [row] = await db.sql<{ status: string }>(
      `select status from public.vehicles where id = $1`,
      [id],
    )
    expect(row?.status).toBe('available')
  })

  it('returns to available the moment the contract completes', async () => {
    const id = await createVehicle(agencyA.organizationId, 'RETURNED-1')
    const [rental] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          picked_up_at, pickup_odometer)
       values ($1, $2, $3, now() - interval '2 hours', now() + interval '2 days', 'EUR', 'active',
               now() - interval '2 hours', 1000)
       returning id`,
      [agencyA.organizationId, id, customerA],
    )
    expect(await effectiveStatus(id)).toBe('rented')

    // The lifecycle guard requires the return to be recorded first — a vehicle
    // cannot be back in the fleet without anyone having taken it back.
    await db.sql(
      `update public.rentals
          set status = 'completed', completed_at = now(),
              returned_at = now(), return_odometer = 1200
        where id = $1`,
      [rental!.id],
    )

    // No cleanup step, no stale 'rented' left behind.
    expect(await effectiveStatus(id)).toBe('available')
  })

  it('lets maintenance override an idle vehicle', async () => {
    const id = await createVehicle(agencyA.organizationId, 'MAINT-1', { status: 'maintenance' })
    expect(await effectiveStatus(id)).toBe('maintenance')
  })

  it('does not offer a vehicle in maintenance for a booking', async () => {
    const id = await createVehicle(agencyA.organizationId, 'MAINT-2', { status: 'maintenance' })

    const available = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ vehicles_available_between: string }>(
        `select * from public.vehicles_available_between($1, now(), now() + interval '1 day')`,
        [agencyA.organizationId],
      ),
    )

    expect(available.map((row) => row.vehicles_available_between)).not.toContain(id)
  })

  it('excludes a vehicle already committed for the requested period', async () => {
    const id = await createVehicle(agencyA.organizationId, 'BOOKED-1')
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status)
       values ($1, $2, $3, '2032-05-01T09:00:00Z', '2032-05-10T09:00:00Z', 'EUR', 'reserved')`,
      [agencyA.organizationId, id, customerA],
    )

    const overlapping = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ vehicles_available_between: string }>(
        `select * from public.vehicles_available_between($1, '2032-05-05T09:00:00Z', '2032-05-07T09:00:00Z')`,
        [agencyA.organizationId],
      ),
    )
    expect(overlapping.map((row) => row.vehicles_available_between)).not.toContain(id)

    const afterwards = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ vehicles_available_between: string }>(
        `select * from public.vehicles_available_between($1, '2032-05-10T09:00:00Z', '2032-05-12T09:00:00Z')`,
        [agencyA.organizationId],
      ),
    )
    expect(afterwards.map((row) => row.vehicles_available_between)).toContain(id)
  })

  it('agrees with the exclusion constraint that ultimately decides', async () => {
    const id = await createVehicle(agencyA.organizationId, 'AGREES-1')
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status)
       values ($1, $2, $3, '2033-01-01T09:00:00Z', '2033-01-05T09:00:00Z', 'EUR', 'reserved')`,
      [agencyA.organizationId, id, customerA],
    )

    // The helper says no...
    const offered = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ vehicles_available_between: string }>(
        `select * from public.vehicles_available_between($1, '2033-01-03T09:00:00Z', '2033-01-04T09:00:00Z')`,
        [agencyA.organizationId],
      ),
    )
    expect(offered.map((row) => row.vehicles_available_between)).not.toContain(id)

    // ...and so does the database, if you try anyway.
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.rentals
             (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status)
           values ($1, $2, $3, '2033-01-03T09:00:00Z', '2033-01-04T09:00:00Z', 'EUR', 'reserved')`,
          [agencyA.organizationId, id, customerA],
        ),
      /rentals_no_vehicle_overlap|conflicting key value/i,
    )
  })
})

describe('archive versus delete', () => {
  it('reports that a vehicle with contract history cannot be deleted', async () => {
    const id = await createVehicle(agencyA.organizationId, 'HISTORY-1')
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, completed_at)
       values ($1, $2, $3, '2029-01-01T09:00:00Z', '2029-01-05T09:00:00Z', 'EUR', 'completed', '2029-01-05T09:00:00Z')`,
      [agencyA.organizationId, id, customerA],
    )

    const [usage] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ rentals_count: number; can_delete: boolean }>(
        `select * from public.vehicle_usage($1)`,
        [id],
      ),
    )

    expect(usage?.rentals_count).toBe(1)
    expect(usage?.can_delete).toBe(false)

    // And the database backs that up rather than cascading through the books.
    await db.expectRejection(
      () => db.sql(`delete from public.vehicles where id = $1`, [id]),
      /still referenced|violates foreign key|violates RESTRICT setting/i,
    )
  })

  it('archives that vehicle instead, keeping its history', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `select id from public.vehicles where registration_plate = 'HISTORY-1'`,
    )

    await db.asUser(agencyA.managerId, (session) =>
      session.sql(`update public.vehicles set archived_at = now() where id = $1`, [vehicle!.id]),
    )

    const [after] = await db.sql<{ archived_at: string | null }>(
      `select archived_at from public.vehicles where id = $1`,
      [vehicle!.id],
    )
    expect(after?.archived_at).not.toBeNull()

    const rentals = await db.sql(`select id from public.rentals where vehicle_id = $1`, [
      vehicle!.id,
    ])
    expect(rentals).toHaveLength(1)
  })

  it('drops an archived vehicle out of the live fleet counts', async () => {
    const [counts] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ archived: number }>(`select * from public.fleet_status_counts($1)`, [
        agencyA.organizationId,
      ]),
    )
    expect(counts!.archived).toBeGreaterThan(0)
  })

  it('refuses to archive a vehicle still committed to a contract', async () => {
    const id = await createVehicle(agencyA.organizationId, 'COMMITTED-1')
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status)
       values ($1, $2, $3, '2034-01-01T09:00:00Z', '2034-01-05T09:00:00Z', 'EUR', 'reserved')`,
      [agencyA.organizationId, id, customerA],
    )

    await db.expectRejection(
      () => db.sql(`update public.vehicles set archived_at = now() where id = $1`, [id]),
      /active or upcoming contract/i,
    )
  })

  it('reports a vehicle with only photos as deletable, and cascades them', async () => {
    const id = await createVehicle(agencyA.organizationId, 'PHOTOS-ONLY')
    await db.sql(
      `insert into public.vehicle_images
         (organization_id, vehicle_id, storage_path, content_type, byte_size)
       values ($1, $2, $3, 'image/png', 2048)`,
      [agencyA.organizationId, id, `${agencyA.organizationId}/${id}/only.png`],
    )

    const [usage] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ images_count: number; can_delete: boolean }>(
        `select * from public.vehicle_usage($1)`,
        [id],
      ),
    )
    expect(usage?.images_count).toBe(1)
    expect(usage?.can_delete).toBe(true)

    await db.sql(`delete from public.vehicles where id = $1`, [id])

    const orphans = await db.sql(`select id from public.vehicle_images where vehicle_id = $1`, [id])
    expect(orphans).toEqual([])
  })
})

describe('photographs', () => {
  it('makes the first photo primary without anyone choosing', async () => {
    const id = await createVehicle(agencyA.organizationId, 'PRIMARY-1')
    await db.sql(
      `insert into public.vehicle_images (organization_id, vehicle_id, storage_path, content_type, byte_size)
       values ($1, $2, $3, 'image/jpeg', 1000)`,
      [agencyA.organizationId, id, `${agencyA.organizationId}/${id}/one.jpg`],
    )

    const [row] = await db.sql<{ is_primary: boolean }>(
      `select is_primary from public.vehicle_images where vehicle_id = $1`,
      [id],
    )
    expect(row?.is_primary).toBe(true)
  })

  it('keeps exactly one primary when another is chosen', async () => {
    const id = await createVehicle(agencyA.organizationId, 'PRIMARY-2')
    const paths = ['a', 'b', 'c']
    const ids: string[] = []

    for (const name of paths) {
      const [row] = await db.sql<{ id: string }>(
        `insert into public.vehicle_images (organization_id, vehicle_id, storage_path, content_type, byte_size)
         values ($1, $2, $3, 'image/jpeg', 1000) returning id`,
        [agencyA.organizationId, id, `${agencyA.organizationId}/${id}/${name}.jpg`],
      )
      ids.push(row!.id)
    }

    await db.sql(`update public.vehicle_images set is_primary = true where id = $1`, [ids[2]!])

    const primaries = await db.sql<{ id: string }>(
      `select id from public.vehicle_images where vehicle_id = $1 and is_primary`,
      [id],
    )
    expect(primaries).toHaveLength(1)
    expect(primaries[0]?.id).toBe(ids[2])
  })

  it('promotes a replacement when the primary is deleted', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `select id from public.vehicles where registration_plate = 'PRIMARY-2'`,
    )
    const [primary] = await db.sql<{ id: string }>(
      `select id from public.vehicle_images where vehicle_id = $1 and is_primary`,
      [vehicle!.id],
    )

    await db.sql(`delete from public.vehicle_images where id = $1`, [primary!.id])

    const primaries = await db.sql(
      `select id from public.vehicle_images where vehicle_id = $1 and is_primary`,
      [vehicle!.id],
    )
    expect(primaries).toHaveLength(1)
  })

  it('cannot attach a photo to another agency’s vehicle', async () => {
    await db.asUser(agencyA.managerId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.vehicle_images
               (organization_id, vehicle_id, storage_path, content_type, byte_size)
             values ($1, $2, $3, 'image/png', 1024)`,
            [agencyA.organizationId, vehicleB, `${agencyA.organizationId}/${vehicleB}/x.png`],
          ),
        /vehicle_images_vehicle_fkey|violates foreign key/i,
      )
    })
  })

  it('rejects a content type outside the allow-list', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.vehicle_images
             (organization_id, vehicle_id, storage_path, content_type, byte_size)
           values ($1, $2, $3, 'image/svg+xml', 512)`,
          [agencyA.organizationId, vehicleA, `${agencyA.organizationId}/${vehicleA}/evil.svg`],
        ),
      /violates check constraint/i,
    )
  })
})

describe('storage policies', () => {
  const insertObject = (session: TestDatabase, bucket: string, name: string) =>
    session.sql(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name])

  it('lets a manager write media under their own agency’s prefix', async () => {
    await db.asUser(agencyA.managerId, (session) =>
      insertObject(session, 'vehicle-photos', `${agencyA.organizationId}/${vehicleA}/ok.jpg`),
    )

    const rows = await db.sql(`select id from storage.objects where name like $1`, [
      `${agencyA.organizationId}/%`,
    ])
    expect(rows.length).toBeGreaterThan(0)
  })

  it('refuses a write under another agency’s prefix', async () => {
    await db.asUser(agencyA.managerId, async (session) => {
      await session.expectRejection(
        () =>
          insertObject(session, 'vehicle-photos', `${agencyB.organizationId}/${vehicleB}/steal.jpg`),
        /row-level security/i,
      )
    })
  })

  it('refuses staff any write, matching the vehicle edit boundary', async () => {
    await db.asUser(agencyA.staffId, async (session) => {
      await session.expectRejection(
        () =>
          insertObject(session, 'vehicle-photos', `${agencyA.organizationId}/${vehicleA}/staff.jpg`),
        /row-level security/i,
      )
    })
  })

  it('does not let one agency read another’s objects, even knowing the exact key', async () => {
    const key = `${agencyB.organizationId}/${vehicleB}/private.jpg`
    await db.sql(`insert into storage.objects (bucket_id, name) values ('vehicle-photos', $1)`, [key])

    const seen = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from storage.objects where name = $1`, [key]),
    )
    expect(seen).toEqual([])

    // And the owning agency can read it.
    const owned = await db.asUser(agencyB.userId, (session) =>
      session.sql(`select id from storage.objects where name = $1`, [key]),
    )
    expect(owned).toHaveLength(1)
  })

  it('refuses a malformed key that does not start with an agency id', async () => {
    await db.asUser(agencyA.managerId, async (session) => {
      await session.expectRejection(
        () => insertObject(session, 'vehicle-photos', 'not-a-uuid/whatever.jpg'),
        /row-level security/i,
      )
    })
  })

  it('applies the same rules to the documents bucket', async () => {
    await db.asUser(agencyA.managerId, (session) =>
      insertObject(session, 'vehicle-documents', `${agencyA.organizationId}/${vehicleA}/doc.pdf`),
    )

    await db.asUser(agencyA.staffId, async (session) => {
      await session.expectRejection(
        () =>
          insertObject(
            session,
            'vehicle-documents',
            `${agencyA.organizationId}/${vehicleA}/staff.pdf`,
          ),
        /row-level security/i,
      )
    })
  })
})

describe('vehicle documents', () => {
  it('cannot attach a document to another agency’s vehicle', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.vehicle_documents (organization_id, vehicle_id, document_type)
           values ($1, $2, 'insurance')`,
          [agencyA.organizationId, vehicleB],
        ),
      /vehicle_documents_vehicle_fkey|violates foreign key/i,
    )
  })

  it('refuses an expiry date before the issue date', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.vehicle_documents
             (organization_id, vehicle_id, document_type, issued_on, expires_on)
           values ($1, $2, 'insurance', date '2026-06-01', date '2026-01-01')`,
          [agencyA.organizationId, vehicleA],
        ),
      /vehicle_documents_period_valid|violates check constraint/i,
    )
  })
})
