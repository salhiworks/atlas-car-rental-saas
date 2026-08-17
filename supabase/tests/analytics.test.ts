// @vitest-environment node
/**
 * The Overview read models. A dashboard that quietly reports a wrong number is
 * worse than one that reports nothing, so these cover the empty case, the
 * populated case, the tenant boundary and the mixed-currency case explicitly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let outsiderId: string

const PERIOD_FROM = '2030-01-01T00:00:00Z'
const PERIOD_TO = '2030-02-01T00:00:00Z'

/**
 * Counts and minor-unit amounts arrive as JS numbers: PostgREST serialises
 * bigint as a JSON number, and PGlite decodes int8 the same way. Minor units
 * stay exact well past any realistic fleet turnover — Number.MAX_SAFE_INTEGER
 * is about 90 trillion major units at two decimal places.
 */
interface Overview {
  currency: string
  time_zone: string
  fleet_total: number
  fleet_available: number
  fleet_rented: number
  customers_total: number
  rentals_total: number
  rentals_active: number
  revenue_minor: number
  expenses_minor: number
  profit_minor: number
  outstanding_minor: number
  excluded_currency_records: number
}

const overview = (userId: string) =>
  db.asUser(userId, (session) =>
    session.sql<Overview>(
      `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
      [organizationId, PERIOD_FROM, PERIOD_TO],
    ),
  )

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@analytics.test',
    organizationName: 'Analytics Rentals',
    currency: 'EUR',
    timeZone: 'Europe/Madrid',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerId = owner.userId
  organizationId = owner.organizationId

  const outsider = await signUp(db, {
    email: 'outsider@analytics.test',
    organizationName: 'Unrelated Fleet',
  })
  outsiderId = outsider.userId
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('organization_overview', () => {
  it('reports genuine zeros for an agency with no records', async () => {
    const [result] = await overview(ownerId)

    expect(result).toMatchObject({
      currency: 'EUR',
      time_zone: 'Europe/Madrid',
      fleet_total: 0,
      customers_total: 0,
      rentals_total: 0,
      revenue_minor: 0,
      expenses_minor: 0,
      profit_minor: 0,
      outstanding_minor: 0,
      excluded_currency_records: 0,
    })
  })

  it('refuses to report on an agency the caller does not belong to', async () => {
    await db.expectRejection(() => overview(outsiderId), /not a member of this organization/i)
  })

  it('rejects an inverted reporting period', async () => {
    await db.expectRejection(
      () =>
        db.asUser(ownerId, (session) =>
          session.sql(
            `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
            [organizationId, PERIOD_TO, PERIOD_FROM],
          ),
        ),
      /must end after it starts/i,
    )
  })

  it('counts fleet, customers, contracts and money once records exist', async () => {
    // Both vehicles are operationally 'available'. "Rented" is not a stored
    // state — it is derived from the contract one of them is out on right now.
    const [outOnHire] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, status)
       values ($1, 'Kia', 'Rio', 'ANA-1', 'EUR', 'available') returning id`,
      [organizationId],
    )
    const [onTheLot] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, status)
       values ($1, 'Kia', 'Ceed', 'ANA-2', 'EUR', 'available') returning id`,
      [organizationId],
    )
    const [customer] = await db.sql<{ id: string }>(
      `insert into public.customers (organization_id, first_name, last_name)
       values ($1, 'Alan', 'Turing') returning id`,
      [organizationId],
    )

    // A contract in progress at this moment.
    await db.sql(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
       values ($1, $2, $3, now() - interval '1 day', now() + interval '1 day', 'EUR', 'active', 0)`,
      [organizationId, outOnHire!.id, customer!.id],
    )

    // A finished contract inside the reporting period, partly settled.
    const [settled] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          total_minor, deposit_minor, completed_at)
       values ($1, $2, $3, '2030-01-10T09:00:00Z', '2030-01-15T09:00:00Z', 'EUR', 'completed',
               50000, 20000, '2030-01-15T09:00:00Z')
       returning id`,
      [organizationId, onTheLot!.id, customer!.id],
    )

    await db.sql(
      `insert into public.payments (organization_id, rental_id, amount_minor, currency, paid_at)
       values ($1, $2, 30000, 'EUR', '2030-01-11T10:00:00Z')`,
      [organizationId, settled!.id],
    )
    await db.sql(
      `insert into public.expenses (organization_id, vehicle_id, amount_minor, currency, incurred_on, allocation, category_id)
       values ($1, $2, 12000, 'EUR', date '2030-01-12', 'vehicle',
               (select id from public.expense_categories
                 where organization_id = $1 and system_key = 'maintenance'))`,
      [organizationId, outOnHire!.id],
    )

    const [result] = await overview(ownerId)

    expect(result).toMatchObject({
      fleet_total: 2,
      fleet_available: 1,
      fleet_rented: 1,
      customers_total: 1,
      rentals_total: 2,
      rentals_active: 1,
      rentals_completed_in_period: 1,
      revenue_minor: 30000,
      expenses_minor: 12000,
      profit_minor: 18000,
      outstanding_minor: 20000,
    })
  })

  it('excludes records in other currencies rather than summing them', async () => {
    await db.sql(
      `insert into public.expenses (organization_id, amount_minor, currency, incurred_on, allocation, category_id)
       values ($1, 99999, 'USD', date '2030-01-20', 'overhead',
               (select id from public.expense_categories
                 where organization_id = $1 and system_key = 'other'))`,
      [organizationId],
    )

    const [result] = await overview(ownerId)

    // The USD expense must not have moved the EUR total.
    expect(result?.expenses_minor).toBe(12000)
    expect(Number(result?.excluded_currency_records)).toBe(1)
  })

  it('leaves activity outside the period out of the totals', async () => {
    await db.sql(
      `insert into public.expenses (organization_id, amount_minor, currency, incurred_on, allocation, category_id)
       values ($1, 77777, 'EUR', date '2030-05-01', 'overhead',
               (select id from public.expense_categories
                 where organization_id = $1 and system_key = 'other'))`,
      [organizationId],
    )

    const [result] = await overview(ownerId)
    expect(result?.expenses_minor).toBe(12000)
  })
})

describe('organization_financial_series', () => {
  it('returns a bucket for every month in the window, including empty ones', async () => {
    const rows = await db.asUser(ownerId, (session) =>
      session.sql<{ bucket_start: string; revenue_minor: number; expenses_minor: number }>(
        `select * from public.organization_financial_series($1, $2::date, $3::date, 'month')`,
        [organizationId, '2030-01-01', '2030-04-01'],
      ),
    )

    expect(rows).toHaveLength(3)
    expect(rows[0]?.revenue_minor).toBe(30000)
    expect(rows[0]?.expenses_minor).toBe(12000)
    expect(rows[1]?.revenue_minor).toBe(0)
    expect(rows[2]?.revenue_minor).toBe(0)
  })

  it('refuses an unsupported granularity', async () => {
    await db.expectRejection(
      () =>
        db.asUser(ownerId, (session) =>
          session.sql(
            `select * from public.organization_financial_series($1, $2::date, $3::date, 'fortnight')`,
            [organizationId, '2030-01-01', '2030-04-01'],
          ),
        ),
      /unsupported granularity/i,
    )
  })

  it('refuses to report on an agency the caller does not belong to', async () => {
    await db.expectRejection(
      () =>
        db.asUser(outsiderId, (session) =>
          session.sql(
            `select * from public.organization_financial_series($1, $2::date, $3::date, 'month')`,
            [organizationId, '2030-01-01', '2030-04-01'],
          ),
        ),
      /not a member of this organization/i,
    )
  })
})
