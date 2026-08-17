// @vitest-environment node
/**
 * The Customers & Drivers module at the database level.
 *
 * This module holds passports, national IDs and driving licences, so the tenant
 * and role boundaries get more attention here than anywhere else. Everything
 * runs as the `authenticated` role with RLS genuinely in force — the same
 * position a browser occupies.
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
let customerA: string
let customerB: string
let vehicleA: string

async function setUpAgency(slug: string, name: string): Promise<Agency> {
  const owner = await signUp(db, {
    email: `owner@${slug}.test`,
    organizationName: name,
    currency: 'EUR',
    timeZone: 'Europe/Lisbon',
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

async function createCustomer(
  organizationId: string,
  first: string,
  last: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const columns = { first_name: first, last_name: last, ...extra }
  const names = Object.keys(columns)
  const placeholders = names.map((_, index) => `$${index + 2}`)

  const [row] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, ${names.join(', ')})
     values ($1, ${placeholders.join(', ')}) returning id`,
    [organizationId, ...Object.values(columns)],
  )
  return row!.id
}

async function addDocument(
  organizationId: string,
  customerId: string,
  type: string,
  number: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const columns = {
    document_type: type,
    document_number: number,
    ...extra,
  }
  const names = Object.keys(columns)
  const placeholders = names.map((_, index) => `$${index + 3}`)

  const [row] = await db.sql<{ id: string }>(
    `insert into public.customer_documents (organization_id, customer_id, ${names.join(', ')})
     values ($1, $2, ${placeholders.join(', ')}) returning id`,
    [organizationId, customerId, ...Object.values(columns)],
  )
  return row!.id
}

beforeAll(async () => {
  db = await TestDatabase.create()

  agencyA = await setUpAgency('alpha-customers', 'Alpha Customers')
  agencyB = await setUpAgency('beta-customers', 'Beta Customers')

  customerA = await createCustomer(agencyA.organizationId, 'Amina', 'Benali', {
    email: 'amina@example.com',
    phone: '+212 600 112233',
    nationality_country_code: 'MA',
  })
  customerB = await createCustomer(agencyB.organizationId, 'Beto', 'Silva', {
    email: 'beto@example.com',
  })

  const [vehicle] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
     values ($1, 'Renault', 'Clio', 'CUST-1', 'EUR') returning id`,
    [agencyA.organizationId],
  )
  vehicleA = vehicle!.id
}, 180_000)

afterAll(async () => {
  await db?.close()
})

describe('tenant isolation', () => {
  it('shows a member only their own agency’s customers', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ organization_id: string }>(`select organization_id from public.customers`),
    )

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.organization_id === agencyA.organizationId)).toBe(true)
  })

  it('returns nothing when asking for another agency’s customer by id', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from public.customers where id = $1`, [customerB]),
    )
    expect(rows).toEqual([])
  })

  it('cannot search another agency’s customers', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from public.customers where email ilike '%beto%'`),
    )
    expect(rows).toEqual([])
  })

  it('scopes the directory view to the caller', async () => {
    const rows = await db.asUser(agencyB.userId, (session) =>
      session.sql<{ organization_id: string }>(
        `select organization_id from public.customer_directory`,
      ),
    )
    expect(rows.every((row) => row.organization_id === agencyB.organizationId)).toBe(true)
  })

  it('cannot read another agency’s identification', async () => {
    await addDocument(agencyB.organizationId, customerB, 'passport', 'BETA-SECRET-1')

    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from public.customer_documents`),
    )
    expect(rows).toEqual([])
  })

  it('cannot modify or archive another agency’s customer', async () => {
    await db.asUser(agencyA.userId, (session) =>
      session.sql(`update public.customers set first_name = 'Hacked' where id = $1`, [customerB]),
    )
    await db.asUser(agencyA.userId, (session) =>
      session.sql(`update public.customers set archived_at = now() where id = $1`, [customerB]),
    )

    const [after] = await db.sql<{ first_name: string; archived_at: string | null }>(
      `select first_name, archived_at from public.customers where id = $1`,
      [customerB],
    )
    expect(after?.first_name).toBe('Beto')
    expect(after?.archived_at).toBeNull()
  })

  it('cannot delete another agency’s customer', async () => {
    await db.asUser(agencyA.adminId, (session) =>
      session.sql(`delete from public.customers where id = $1`, [customerB]),
    )

    const rows = await db.sql(`select id from public.customers where id = $1`, [customerB])
    expect(rows).toHaveLength(1)
  })

  it('cannot insert a customer into another agency', async () => {
    await db.asUser(agencyA.userId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.customers (organization_id, first_name, last_name)
             values ($1, 'Injected', 'Row')`,
            [agencyB.organizationId],
          ),
        /row-level security/i,
      )
    })
  })

  it('cannot attach identification to another agency’s customer', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.customer_documents (organization_id, customer_id, document_type, document_number)
           values ($1, $2, 'passport', 'CROSS-1')`,
          [agencyA.organizationId, customerB],
        ),
      /customer_documents_customer_fkey|violates foreign key/i,
    )
  })

  it('gives a foreign customer id the same answer as a missing one', async () => {
    const foreign = await db.expectRejection(() =>
      db.asUser(agencyA.userId, (session) =>
        session.sql(`select * from public.customer_usage($1)`, [customerB]),
      ),
    )
    const missing = await db.expectRejection(() =>
      db.asUser(agencyA.userId, (session) =>
        session.sql(`select * from public.customer_usage($1)`, [
          '00000000-0000-0000-0000-000000000000',
        ]),
      ),
    )

    expect(foreign).toBe(missing)
    expect(foreign).toMatch(/customer not found/i)
  })

  it('gives the same answer from the rental and financial summaries', async () => {
    for (const fn of ['customer_rental_summary', 'customer_financial_summary']) {
      const foreign = await db.expectRejection(() =>
        db.asUser(agencyA.userId, (session) =>
          session.sql(`select * from public.${fn}($1)`, [customerB]),
        ),
      )
      const missing = await db.expectRejection(() =>
        db.asUser(agencyA.userId, (session) =>
          session.sql(`select * from public.${fn}($1)`, [
            '00000000-0000-0000-0000-000000000000',
          ]),
        ),
      )
      expect(foreign, fn).toBe(missing)
    }
  })

  it('denies anon every customer surface', async () => {
    await db.asAnon(async (session) => {
      for (const statement of [
        `select * from public.customers`,
        `select * from public.customer_documents`,
        `select * from public.customer_directory`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /permission denied/i)
      }

      for (const fn of [
        `select * from public.customer_usage('00000000-0000-0000-0000-000000000000')`,
        `select * from public.customer_rental_summary('00000000-0000-0000-0000-000000000000')`,
        `select * from public.find_customer_duplicates('00000000-0000-0000-0000-000000000000')`,
      ]) {
        await session.expectRejection(() => session.sql(fn), /permission denied/i)
      }
    })
  })
})

describe('duplicate detection', () => {
  it('never hints about another agency’s customers', async () => {
    // Agency B has a customer with this exact passport and email.
    await createCustomer(agencyB.organizationId, 'Shared', 'Identity', {
      email: 'shared@example.com',
      phone: '+212600999888',
    })
    const [betaTwin] = await db.sql<{ id: string }>(
      `select id from public.customers where email = 'shared@example.com'`,
    )
    await addDocument(agencyB.organizationId, betaTwin!.id, 'passport', 'SHARED-PASSPORT-9')

    const hints = await db.asUser(agencyA.userId, (session) =>
      session.sql(
        `select * from public.find_customer_duplicates($1, $2, $3, $4::jsonb)`,
        [
          agencyA.organizationId,
          'shared@example.com',
          '+212600999888',
          JSON.stringify([
            { document_type: 'passport', document_number: 'SHARED-PASSPORT-9', issuing_country: null },
          ]),
        ],
      ),
    )

    expect(hints).toEqual([])
  })

  it('refuses to run against an agency the caller does not belong to', async () => {
    await db.expectRejection(
      () =>
        db.asUser(agencyA.userId, (session) =>
          session.sql(`select * from public.find_customer_duplicates($1)`, [
            agencyB.organizationId,
          ]),
        ),
      /not a member of this organization/i,
    )
  })

  it('flags a matching passport as a strong match', async () => {
    await addDocument(agencyA.organizationId, customerA, 'passport', 'AB 123 456', {
      issuing_country: 'MA',
    })

    const hints = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ customer_id: string; match_strength: string; match_reason: string }>(
        `select * from public.find_customer_duplicates($1, null, null, $2::jsonb)`,
        [
          agencyA.organizationId,
          // Typed differently — same passport.
          JSON.stringify([
            { document_type: 'passport', document_number: 'ab123456', issuing_country: 'ma' },
          ]),
        ],
      ),
    )

    expect(hints).toHaveLength(1)
    expect(hints[0]?.customer_id).toBe(customerA)
    expect(hints[0]?.match_strength).toBe('strong')
    expect(hints[0]?.match_reason).toMatch(/passport/i)
  })

  it('flags shared contact details only weakly', async () => {
    const hints = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ match_strength: string }>(
        `select * from public.find_customer_duplicates($1, $2, $3)`,
        [agencyA.organizationId, 'amina@example.com', '212600112233'],
      ),
    )

    expect(hints.length).toBeGreaterThan(0)
    // Families and companies share a phone; this must warn, never block.
    expect(hints.every((hint) => hint.match_strength === 'weak')).toBe(true)
  })

  it('can exclude the customer being edited so a record cannot match itself', async () => {
    const hints = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select * from public.find_customer_duplicates($1, $2, null, '[]'::jsonb, $3)`, [
        agencyA.organizationId,
        'amina@example.com',
        customerA,
      ]),
    )

    expect(hints).toEqual([])
  })

  it('surfaces an archived customer so staff restore rather than duplicate', async () => {
    const retired = await createCustomer(agencyA.organizationId, 'Retired', 'Renter')
    await addDocument(agencyA.organizationId, retired, 'national_id', 'OLD-ID-777', {
      issuing_country: 'MA',
    })
    await db.sql(`update public.customers set archived_at = now() where id = $1`, [retired])

    const hints = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ customer_id: string; archived_at: string | null }>(
        `select * from public.find_customer_duplicates($1, null, null, $2::jsonb)`,
        [
          agencyA.organizationId,
          JSON.stringify([
            { document_type: 'national_id', document_number: 'OLD ID 777', issuing_country: 'MA' },
          ]),
        ],
      ),
    )

    expect(hints).toHaveLength(1)
    expect(hints[0]?.customer_id).toBe(retired)
    expect(hints[0]?.archived_at).not.toBeNull()
  })
})

describe('identifier uniqueness', () => {
  it('refuses the same passport twice in one agency, however it is typed', async () => {
    const other = await createCustomer(agencyA.organizationId, 'Second', 'Person')

    await db.expectRejection(
      () =>
        addDocument(agencyA.organizationId, other, 'passport', 'ab-123-456', {
          issuing_country: 'MA',
        }),
      /customer_documents_unique_number_idx|duplicate key/i,
    )
  })

  it('allows the same number under a different document type', async () => {
    const other = await createCustomer(agencyA.organizationId, 'Third', 'Person')
    const id = await addDocument(agencyA.organizationId, other, 'national_id', 'AB123456', {
      issuing_country: 'MA',
    })
    expect(id).toBeTruthy()
  })

  it('allows the same passport in a different agency', async () => {
    const id = await addDocument(agencyB.organizationId, customerB, 'passport', 'AB123456', {
      issuing_country: 'MA',
    })
    expect(id).toBeTruthy()
  })

  it('treats a different issuing country as a different document', async () => {
    const other = await createCustomer(agencyA.organizationId, 'Fourth', 'Person')
    const id = await addDocument(agencyA.organizationId, other, 'passport', 'AB123456', {
      issuing_country: 'PT',
    })
    expect(id).toBeTruthy()
  })

  it('refuses an expiry before the issue date', async () => {
    await db.expectRejection(
      () =>
        addDocument(agencyA.organizationId, customerA, 'other', 'PERIOD-1', {
          issued_on: '2026-06-01',
          expires_on: '2026-01-01',
        }),
      /customer_documents_period_valid|violates check constraint/i,
    )
  })

  it('refuses vehicle classes on anything but a licence', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.customer_documents
             (organization_id, customer_id, document_type, document_number, license_classes)
           values ($1, $2, 'passport', 'CLASSES-1', array['B'])`,
          [agencyA.organizationId, customerA],
        ),
      /classes_are_for_licences|violates check constraint/i,
    )
  })
})

describe('role enforcement', () => {
  it('lets staff read, create and update customers and their identification', async () => {
    await db.asUser(agencyA.staffId, async (session) => {
      const rows = await session.sql(`select id from public.customers`)
      expect(rows.length).toBeGreaterThan(0)

      const [created] = await session.sql<{ id: string }>(
        `insert into public.customers (organization_id, first_name, last_name)
         values ($1, 'Walk', 'In') returning id`,
        [agencyA.organizationId],
      )
      await session.sql(
        `insert into public.customer_documents (organization_id, customer_id, document_type, document_number)
         values ($1, $2, 'passport', 'STAFF-ADDED-1')`,
        [agencyA.organizationId, created!.id],
      )
    })
  })

  it('does not let staff delete identification', async () => {
    const [document] = await db.sql<{ id: string }>(
      `select id from public.customer_documents where document_number = 'STAFF-ADDED-1'`,
    )

    await db.asUser(agencyA.staffId, (session) =>
      session.sql(`delete from public.customer_documents where id = $1`, [document!.id]),
    )

    const rows = await db.sql(`select id from public.customer_documents where id = $1`, [
      document!.id,
    ])
    expect(rows).toHaveLength(1)
  })

  it('lets a manager delete identification', async () => {
    const [document] = await db.sql<{ id: string }>(
      `select id from public.customer_documents where document_number = 'STAFF-ADDED-1'`,
    )

    await db.asUser(agencyA.managerId, (session) =>
      session.sql(`delete from public.customer_documents where id = $1`, [document!.id]),
    )

    const rows = await db.sql(`select id from public.customer_documents where id = $1`, [
      document!.id,
    ])
    expect(rows).toEqual([])
  })

  it('does not let a manager permanently delete a customer', async () => {
    const disposable = await createCustomer(agencyA.organizationId, 'Manager', 'Delete')

    await db.asUser(agencyA.managerId, (session) =>
      session.sql(`delete from public.customers where id = $1`, [disposable]),
    )

    const rows = await db.sql(`select id from public.customers where id = $1`, [disposable])
    expect(rows).toHaveLength(1)
  })

  it('lets an admin permanently delete an unused customer', async () => {
    const [disposable] = await db.sql<{ id: string }>(
      `select id from public.customers where first_name = 'Manager' and last_name = 'Delete'`,
    )

    await db.asUser(agencyA.adminId, (session) =>
      session.sql(`delete from public.customers where id = $1`, [disposable!.id]),
    )

    const rows = await db.sql(`select id from public.customers where id = $1`, [disposable!.id])
    expect(rows).toEqual([])
  })
})

describe('storage policies', () => {
  const insertObject = (session: TestDatabase, name: string) =>
    session.sql(`insert into storage.objects (bucket_id, name) values ('customer-documents', $1)`, [
      name,
    ])

  it('lets staff write under their own agency’s prefix', async () => {
    await db.asUser(agencyA.staffId, (session) =>
      insertObject(session, `${agencyA.organizationId}/${customerA}/passport.pdf`),
    )

    const rows = await db.sql(`select id from storage.objects where name like $1`, [
      `${agencyA.organizationId}/%`,
    ])
    expect(rows.length).toBeGreaterThan(0)
  })

  it('refuses a write under another agency’s prefix', async () => {
    await db.asUser(agencyA.staffId, async (session) => {
      await session.expectRejection(
        () => insertObject(session, `${agencyB.organizationId}/${customerB}/steal.pdf`),
        /row-level security/i,
      )
    })
  })

  it('refuses a path that does not start with an agency id', async () => {
    await db.asUser(agencyA.staffId, async (session) => {
      await session.expectRejection(
        () => insertObject(session, 'not-a-uuid/anything.pdf'),
        /row-level security/i,
      )
    })
  })

  it('refuses a path traversal attempt', async () => {
    await db.asUser(agencyA.staffId, async (session) => {
      await session.expectRejection(
        () => insertObject(session, `../${agencyB.organizationId}/${customerB}/x.pdf`),
        /row-level security/i,
      )
    })
  })

  it('does not let one agency read another’s scans, even knowing the exact key', async () => {
    const key = `${agencyB.organizationId}/${customerB}/private-passport.pdf`
    await db.sql(`insert into storage.objects (bucket_id, name) values ('customer-documents', $1)`, [
      key,
    ])

    const seen = await db.asUser(agencyA.userId, (session) =>
      session.sql(`select id from storage.objects where name = $1`, [key]),
    )
    expect(seen).toEqual([])

    const owned = await db.asUser(agencyB.userId, (session) =>
      session.sql(`select id from storage.objects where name = $1`, [key]),
    )
    expect(owned).toHaveLength(1)
  })

  it('reserves deleting a scan for a manager', async () => {
    const key = `${agencyA.organizationId}/${customerA}/deletable.pdf`
    await db.sql(`insert into storage.objects (bucket_id, name) values ('customer-documents', $1)`, [
      key,
    ])

    await db.asUser(agencyA.staffId, (session) =>
      session.sql(`delete from storage.objects where name = $1`, [key]),
    )
    expect(await db.sql(`select id from storage.objects where name = $1`, [key])).toHaveLength(1)

    await db.asUser(agencyA.managerId, (session) =>
      session.sql(`delete from storage.objects where name = $1`, [key]),
    )
    expect(await db.sql(`select id from storage.objects where name = $1`, [key])).toEqual([])
  })
})

describe('archive and delete', () => {
  it('reports a customer with contract history as undeletable', async () => {
    const [rental] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor, completed_at)
       values ($1, $2, $3, '2029-01-01T09:00:00Z', '2029-01-05T09:00:00Z', 'EUR', 'completed', 50000, '2029-01-05T09:00:00Z')
       returning id`,
      [agencyA.organizationId, vehicleA, customerA],
    )
    expect(rental?.id).toBeTruthy()

    const [usage] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ rentals_count: number; can_delete: boolean }>(
        `select * from public.customer_usage($1)`,
        [customerA],
      ),
    )

    expect(usage?.rentals_count).toBe(1)
    expect(usage?.can_delete).toBe(false)

    // And the database refuses rather than cascading through the books.
    await db.expectRejection(
      () => db.sql(`delete from public.customers where id = $1`, [customerA]),
      /still referenced|violates foreign key|violates RESTRICT setting/i,
    )
  })

  it('archives instead, keeping the contract intact', async () => {
    await db.asUser(agencyA.staffId, (session) =>
      session.sql(`update public.customers set archived_at = now() where id = $1`, [customerA]),
    )

    const [after] = await db.sql<{ archived_at: string | null }>(
      `select archived_at from public.customers where id = $1`,
      [customerA],
    )
    expect(after?.archived_at).not.toBeNull()

    const rentals = await db.sql(`select id from public.rentals where customer_id = $1`, [customerA])
    expect(rentals).toHaveLength(1)
  })

  it('keeps an archived customer visible on their historical contract', async () => {
    // Rentals join customers directly; archiving must not hide the counterparty
    // on a contract that has already been signed.
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ display_name: string }>(
        `select c.display_name
         from public.rentals r
         join public.customers c on c.id = r.customer_id
         where r.customer_id = $1`,
        [customerA],
      ),
    )

    expect(rows[0]?.display_name).toBe('Amina Benali')
  })

  it('restores an archived customer', async () => {
    await db.asUser(agencyA.staffId, (session) =>
      session.sql(`update public.customers set archived_at = null where id = $1`, [customerA]),
    )

    const [after] = await db.sql<{ archived_at: string | null }>(
      `select archived_at from public.customers where id = $1`,
      [customerA],
    )
    expect(after?.archived_at).toBeNull()
  })

  it('cascades identification when a deletable customer is removed', async () => {
    const disposable = await createCustomer(agencyA.organizationId, 'Cascade', 'Target')
    await addDocument(agencyA.organizationId, disposable, 'passport', 'CASCADE-1')

    await db.asUser(agencyA.adminId, (session) =>
      session.sql(`delete from public.customers where id = $1`, [disposable]),
    )

    const orphans = await db.sql(
      `select id from public.customer_documents where customer_id = $1`,
      [disposable],
    )
    expect(orphans).toEqual([])
  })
})

describe('directory read model', () => {
  it('reports rental context and licence validity without exposing numbers', async () => {
    await addDocument(agencyA.organizationId, customerA, 'driver_license', 'DL-8842197', {
      issuing_country: 'MA',
      expires_on: '2030-09-30',
      license_classes: ['B'],
    })

    const [row] = await db.asUser(agencyA.userId, (session) =>
      session.sql<Record<string, unknown>>(
        `select * from public.customer_directory where customer_id = $1`,
        [customerA],
      ),
    )

    expect(row?.has_driver_license).toBe(true)
    expect(row?.driver_license_expires_on).toBeTruthy()
    expect(row?.rental_count).toBe(1)

    // The read model carries validity, not identifiers.
    const serialised = JSON.stringify(row)
    expect(serialised).not.toContain('DL-8842197')
    expect(serialised).not.toContain('AB 123 456')
  })

  it('reports an unambiguous outstanding balance', async () => {
    const [row] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{
        outstanding_currency_count: number
        outstanding_minor: number | null
        outstanding_currency: string | null
      }>(`select * from public.customer_directory where customer_id = $1`, [customerA]),
    )

    expect(row?.outstanding_currency_count).toBe(1)
    expect(row?.outstanding_minor).toBe(50_000)
    expect(row?.outstanding_currency).toBe('EUR')
  })

  it('refuses to state a total once currencies are mixed', async () => {
    const [otherVehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
       values ($1, 'Kia', 'Rio', 'CUST-2', 'USD') returning id`,
      [agencyA.organizationId],
    )
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor, completed_at)
       values ($1, $2, $3, '2029-03-01T09:00:00Z', '2029-03-05T09:00:00Z', 'USD', 'completed', 30000, '2029-03-05T09:00:00Z')`,
      [agencyA.organizationId, otherVehicle!.id, customerA],
    )

    const [row] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ outstanding_currency_count: number; outstanding_minor: number | null }>(
        `select * from public.customer_directory where customer_id = $1`,
        [customerA],
      ),
    )

    // Two currencies, so no single figure — never EUR + USD added together.
    expect(row?.outstanding_currency_count).toBe(2)
    expect(row?.outstanding_minor).toBeNull()
  })

  it('reports money per currency in the financial summary', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ currency: string; outstanding_minor: number }>(
        `select * from public.customer_financial_summary($1)`,
        [customerA],
      ),
    )

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.currency).sort()).toEqual(['EUR', 'USD'])
    expect(rows.find((row) => row.currency === 'EUR')?.outstanding_minor).toBe(50_000)
    expect(rows.find((row) => row.currency === 'USD')?.outstanding_minor).toBe(30_000)
  })
})
