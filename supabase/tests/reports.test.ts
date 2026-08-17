// @vitest-environment node
/**
 * Reports: the numbers, and everything that could make them wrong.
 *
 * A reporting layer fails in a particular way. It does not crash — it produces a
 * confident figure that nobody can reconcile, and somebody makes a decision on
 * it. So this suite is organised around the specific lies an analytics module
 * tells:
 *
 *   - a deposit counted as revenue
 *   - a voided record counted anywhere
 *   - a financing principal repayment counted as a cost
 *   - one expense counted twice, or a rental-direct cost counted nowhere
 *   - two currencies added together
 *   - an expense filed by the day it was typed in rather than the day it happened
 *   - a rental spanning two periods counted whole in both
 *   - an unknown rendered as a zero
 *   - one agency's figures visible to another
 *
 * Every assertion below is a number a person would act on. Where a figure also
 * exists in an older read model, the test asserts the two AGREE — a Reports
 * module that quietly disagrees with the dashboard is worse than one that is
 * absent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase
let orgA: string
let ownerA: string
let managerA: string
let staffA: string
let orgB: string
let ownerB: string

let vehicleOne: string
let vehicleTwo: string
let vehicleIdle: string
let vehicleArchived: string
let customerOne: string
let customerTwo: string

/** The reporting window every test shares: July 2032, agency time. */
const FROM = '2032-07-01'
const TO = '2032-08-01'

interface BusinessRow {
  currency: string
  is_default_currency: boolean
  rental_revenue_minor: number
  rental_charges_in_minor: number
  rental_refunds_out_minor: number
  deposit_in_minor: number
  deposit_out_minor: number
  operating_expense_minor: number
  operating_expense_tax_minor: number
  operating_result_minor: number
  financing_cash_paid_minor: number
  financing_principal_minor: number
  financing_cost_minor: number
  financing_unallocated_minor: number
  financing_cost_complete: boolean
  after_financing_minor: number
  rental_payment_count: number
  expense_count: number
  financing_payment_count: number
}

async function business(
  organizationId = orgA,
  from = FROM,
  to = TO,
  asUser = ownerA,
): Promise<BusinessRow[]> {
  return db.asUser(asUser, (session) =>
    session.sql<BusinessRow>(`select * from public.report_business_summary($1, $2::date, $3::date)`, [
      organizationId,
      from,
      to,
    ]),
  )
}

function inCurrency(rows: readonly BusinessRow[], currency: string): BusinessRow {
  const row = rows.find((candidate) => candidate.currency === currency)
  if (!row) throw new Error(`No ${currency} row. Got: ${rows.map((r) => r.currency).join(', ')}`)
  return row
}

// -----------------------------------------------------------------------------
// A fixture with one of everything that has ever been got wrong
// -----------------------------------------------------------------------------

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@reports.test',
    fullName: 'Reporting Owner',
    organizationName: 'Atlas Reporting Motors',
    currency: 'EUR',
    timeZone: 'Europe/Lisbon',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerA = owner.userId
  orgA = owner.organizationId

  const manager = await signUp(db, { email: 'manager@reports.test', fullName: 'Ops Manager' })
  managerA = manager.userId
  await addMember(db, orgA, managerA, 'manager')

  const staff = await signUp(db, { email: 'staff@reports.test', fullName: 'Desk Staff' })
  staffA = staff.userId
  await addMember(db, orgA, staffA, 'staff')

  const otherOwner = await signUp(db, {
    email: 'owner@rival.test',
    fullName: 'Rival Owner',
    organizationName: 'Rival Rentals',
    currency: 'EUR',
    timeZone: 'Europe/Lisbon',
  })
  if (!otherOwner.organizationId) throw new Error('Second agency failed to provision.')
  ownerB = otherOwner.userId
  orgB = otherOwner.organizationId

  // --- Fleet -----------------------------------------------------------------
  const vehicles = await db.sql<{ id: string; registration_plate: string }>(
    `insert into public.vehicles
       (organization_id, make, model, registration_plate, currency, daily_rate_minor, acquired_on,
        insurance_expires_on, inspection_expires_on)
     values
       ($1, 'Renault', 'Clio',   'RPT-001', 'EUR', 4500, '2030-01-01', '2032-07-15', null),
       ($1, 'Peugeot', '208',    'RPT-002', 'EUR', 5000, '2030-01-01', '2033-01-01', '2032-06-01'),
       ($1, 'Toyota',  'Yaris',  'RPT-003', 'EUR', 4000, '2030-01-01', '2033-01-01', '2033-01-01'),
       ($1, 'Dacia',   'Logan',  'RPT-004', 'EUR', 3500, '2030-01-01', null, null)
     returning id, registration_plate`,
    [orgA],
  )
  const byPlate = new Map(vehicles.map((v) => [v.registration_plate, v.id]))
  vehicleOne = byPlate.get('RPT-001')!
  vehicleTwo = byPlate.get('RPT-002')!
  vehicleIdle = byPlate.get('RPT-003')!
  vehicleArchived = byPlate.get('RPT-004')!

  const customers = await db.sql<{ id: string; last_name: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Yasmine', 'Cherkaoui'), ($1, 'Omar', 'Benali')
     returning id, last_name`,
    [orgA],
  )
  customerOne = customers.find((c) => c.last_name === 'Cherkaoui')!.id
  customerTwo = customers.find((c) => c.last_name === 'Benali')!.id
}, 240_000)

afterAll(async () => {
  await db?.close()
})

/** A rental written the way the domain writes one, at whatever status is needed. */
async function seedRental(options: {
  vehicle: string
  customer: string
  reference: string
  starts: string
  ends: string
  status: 'draft' | 'reserved' | 'active' | 'completed' | 'cancelled'
  totalMinor: number
  currency?: string
  completedAt?: string | null
  pickedUpAt?: string | null
  returnedAt?: string | null
  cancelledAt?: string | null
  confirmedAt?: string | null
  pickupOdometer?: number | null
  returnOdometer?: number | null
}): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `insert into public.rentals
       (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
        currency, daily_rate_minor, subtotal_minor, total_minor,
        completed_at, picked_up_at, returned_at, cancelled_at, confirmed_at,
        pickup_odometer, return_odometer)
     values ($1, $2, $3, $4, $5::public.rental_status, $6::timestamptz, $7::timestamptz,
             $8, 4500, $9, $9, $10::timestamptz, $11::timestamptz, $12::timestamptz,
             $13::timestamptz, $14::timestamptz, $15, $16)
     returning id`,
    [
      orgA,
      options.vehicle,
      options.customer,
      options.reference,
      options.status,
      options.starts,
      options.ends,
      options.currency ?? 'EUR',
      options.totalMinor,
      options.completedAt ?? null,
      options.pickedUpAt ?? null,
      options.returnedAt ?? null,
      options.cancelledAt ?? null,
      options.confirmedAt ?? null,
      options.pickupOdometer ?? null,
      options.returnOdometer ?? null,
    ],
  )
  return row!.id
}

async function seedPayment(options: {
  rental: string | null
  customer: string | null
  amountMinor: number
  currency?: string
  purpose?: 'rental_charge' | 'deposit'
  direction?: 'inbound' | 'outbound'
  paidAt: string
  voided?: boolean
}): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `insert into public.payments
       (organization_id, rental_id, customer_id, amount_minor, currency, purpose, direction,
        paid_at, voided_at)
     values ($1, $2, $3, $4, $5, $6::public.payment_purpose, $7::public.payment_direction,
             $8::timestamptz, $9::timestamptz)
     returning id`,
    [
      orgA,
      options.rental,
      options.customer,
      options.amountMinor,
      options.currency ?? 'EUR',
      options.purpose ?? 'rental_charge',
      options.direction ?? 'inbound',
      options.paidAt,
      options.voided ? options.paidAt : null,
    ],
  )
  return row!.id
}

async function categoryId(name: string): Promise<string> {
  const [row] = await db.sql<{ id: string }>(
    `select id from public.expense_categories where organization_id = $1 order by
       case when name = $2 then 0 else 1 end, name limit 1`,
    [orgA, name],
  )
  return row!.id
}

async function seedExpense(options: {
  amountMinor: number
  incurredOn: string
  allocation: 'overhead' | 'vehicle' | 'rental'
  vehicle?: string | null
  rental?: string | null
  currency?: string
  voided?: boolean
  taxMinor?: number
  vendor?: string | null
  category?: string
}): Promise<string> {
  const category = await categoryId(options.category ?? 'Fuel')
  const [row] = await db.sql<{ id: string }>(
    `insert into public.expenses
       (organization_id, category_id, vendor_id, allocation, status, amount_minor,
        tax_amount_minor, currency, incurred_on, vehicle_id, rental_id, voided_at)
     values ($1, $2, $3, $4::public.expense_allocation,
             (case when $5 then 'voided' else 'recorded' end)::public.expense_status,
             $6, $7, $8, $9::date, $10, $11, (case when $5 then now() else null end))
     returning id`,
    [
      orgA,
      category,
      options.vendor ?? null,
      options.allocation,
      options.voided ?? false,
      options.amountMinor,
      options.taxMinor ?? 0,
      options.currency ?? 'EUR',
      options.incurredOn,
      options.vehicle ?? null,
      options.rental ?? null,
    ],
  )
  return row!.id
}

// =============================================================================
// The business summary
// =============================================================================

describe('the business summary', () => {
  let rentalJuly: string
  let rentalSpanning: string

  beforeAll(async () => {
    /*
     * July: one hire paid in full, one deposit taken and partly refunded, one
     * refund of a charge, one voided payment, and a payment on a rental that was
     * later cancelled — which still counts, because the money really arrived.
     */
    rentalJuly = await seedRental({
      vehicle: vehicleOne,
      customer: customerOne,
      reference: 'RPT-R-001',
      starts: '2032-07-05T09:00:00Z',
      ends: '2032-07-10T09:00:00Z',
      status: 'completed',
      totalMinor: 60_000,
      completedAt: '2032-07-10T10:00:00Z',
      pickedUpAt: '2032-07-05T09:30:00Z',
      returnedAt: '2032-07-10T08:30:00Z',
      confirmedAt: '2032-07-01T09:00:00Z',
      pickupOdometer: 10_000,
      returnOdometer: 10_850,
    })

    // A hire that begins in June and ends in July: the utilisation tests below
    // depend on only the overlapping part being counted.
    rentalSpanning = await seedRental({
      vehicle: vehicleTwo,
      customer: customerTwo,
      reference: 'RPT-R-002',
      starts: '2032-06-28T00:00:00Z',
      ends: '2032-07-04T00:00:00Z',
      status: 'completed',
      totalMinor: 30_000,
      completedAt: '2032-07-04T01:00:00Z',
      confirmedAt: '2032-06-27T00:00:00Z',
    })

    const cancelled = await seedRental({
      vehicle: vehicleOne,
      customer: customerTwo,
      reference: 'RPT-R-003',
      starts: '2032-07-20T09:00:00Z',
      ends: '2032-07-22T09:00:00Z',
      status: 'cancelled',
      totalMinor: 20_000,
      cancelledAt: '2032-07-15T09:00:00Z',
      confirmedAt: '2032-07-12T09:00:00Z',
    })

    await seedPayment({
      rental: rentalJuly,
      customer: customerOne,
      amountMinor: 60_000,
      paidAt: '2032-07-10T10:00:00Z',
    })
    await seedPayment({
      rental: rentalSpanning,
      customer: customerTwo,
      amountMinor: 30_000,
      paidAt: '2032-07-04T01:00:00Z',
    })
    // A refund of part of a charge: negative revenue in the period it happened.
    await seedPayment({
      rental: rentalJuly,
      customer: customerOne,
      amountMinor: 5_000,
      direction: 'outbound',
      paidAt: '2032-07-20T10:00:00Z',
    })
    // A deposit in and most of it back out. Neither is revenue.
    await seedPayment({
      rental: rentalJuly,
      customer: customerOne,
      amountMinor: 30_000,
      purpose: 'deposit',
      paidAt: '2032-07-05T09:00:00Z',
    })
    await seedPayment({
      rental: rentalJuly,
      customer: customerOne,
      amountMinor: 30_000,
      purpose: 'deposit',
      direction: 'outbound',
      paidAt: '2032-07-10T11:00:00Z',
    })
    // Voided: never happened.
    await seedPayment({
      rental: rentalJuly,
      customer: customerOne,
      amountMinor: 99_999,
      paidAt: '2032-07-11T10:00:00Z',
      voided: true,
    })
    // Money taken on a booking that was later cancelled. Still received.
    await seedPayment({
      rental: cancelled,
      customer: customerTwo,
      amountMinor: 4_000,
      paidAt: '2032-07-12T10:00:00Z',
    })

    // Costs: one overhead, one vehicle-direct, one rental-direct, one voided,
    // one dated in June but entered in July.
    await seedExpense({ amountMinor: 10_000, incurredOn: '2032-07-03', allocation: 'overhead' })
    await seedExpense({
      amountMinor: 8_000,
      incurredOn: '2032-07-06',
      allocation: 'vehicle',
      vehicle: vehicleOne,
      taxMinor: 1_333,
    })
    await seedExpense({
      amountMinor: 4_000,
      incurredOn: '2032-07-08',
      allocation: 'rental',
      rental: rentalJuly,
    })
    await seedExpense({
      amountMinor: 50_000,
      incurredOn: '2032-07-09',
      allocation: 'overhead',
      voided: true,
    })
    await seedExpense({ amountMinor: 7_000, incurredOn: '2032-06-30', allocation: 'overhead' })
  })

  it('reports revenue as rental-charge cash, net of refunds', async () => {
    const eur = inCurrency(await business(), 'EUR')

    // 60,000 + 30,000 + 4,000 in; 5,000 back out. The voided 99,999 is absent.
    expect(eur.rental_charges_in_minor).toBe(94_000)
    expect(eur.rental_refunds_out_minor).toBe(5_000)
    expect(eur.rental_revenue_minor).toBe(89_000)
  })

  it('never counts a deposit as revenue', async () => {
    const eur = inCurrency(await business(), 'EUR')

    // 30,000 arrived and 30,000 went back. Neither touched revenue.
    expect(eur.deposit_in_minor).toBe(30_000)
    expect(eur.deposit_out_minor).toBe(30_000)
    expect(eur.rental_revenue_minor).toBe(89_000)
  })

  it('never counts a voided payment', async () => {
    const eur = inCurrency(await business(), 'EUR')
    // Three inbound charges plus one outbound. The voided fifth is not there.
    expect(eur.rental_payment_count).toBe(4)
  })

  it('counts money taken on a booking that was later cancelled', async () => {
    // Cancellation is financially inert in this product; the 4,000 really came
    // in on the 12th and a report that hid it could not be reconciled to a bank
    // statement.
    const eur = inCurrency(await business(), 'EUR')
    expect(eur.rental_charges_in_minor).toBe(94_000)
  })

  it('files a cost by the day it was incurred, not the day it was typed in', async () => {
    const eur = inCurrency(await business(), 'EUR')

    // 10,000 + 8,000 + 4,000. The 7,000 incurred on 30 June belongs to June.
    expect(eur.operating_expense_minor).toBe(22_000)
    expect(eur.expense_count).toBe(3)

    const june = inCurrency(await business(orgA, '2032-06-01', '2032-07-01'), 'EUR')
    expect(june.operating_expense_minor).toBe(7_000)
  })

  it('never counts a voided cost', async () => {
    const eur = inCurrency(await business(), 'EUR')
    expect(eur.operating_expense_minor).toBe(22_000)
    expect(eur.operating_expense_minor).not.toBe(72_000)
  })

  it('shows the tax inside a cost without adding it on top', async () => {
    const eur = inCurrency(await business(), 'EUR')
    expect(eur.operating_expense_tax_minor).toBe(1_333)
    expect(eur.operating_expense_minor).toBe(22_000)
  })

  it('computes the operating result from revenue less recorded cost', async () => {
    const eur = inCurrency(await business(), 'EUR')
    expect(eur.operating_result_minor).toBe(89_000 - 22_000)
  })

  it('agrees with the dashboard on the same window', async () => {
    // A Reports figure that silently disagrees with the Overview tile is worse
    // than no Reports figure at all.
    const [overview] = await db.asUser(ownerA, (session) =>
      session.sql<{ revenue_minor: number; expenses_minor: number; profit_minor: number }>(
        `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
        [orgA, '2032-07-01T00:00:00+01:00', '2032-08-01T00:00:00+01:00'],
      ),
    )
    const eur = inCurrency(await business(), 'EUR')

    expect(Number(overview!.revenue_minor)).toBe(eur.rental_revenue_minor)
    expect(Number(overview!.expenses_minor)).toBe(eur.operating_expense_minor)
    expect(Number(overview!.profit_minor)).toBe(eur.operating_result_minor)
  })
})

// =============================================================================
// Currency separation
// =============================================================================

describe('two currencies', () => {
  beforeAll(async () => {
    const usdRental = await seedRental({
      vehicle: vehicleTwo,
      customer: customerOne,
      reference: 'RPT-R-USD',
      starts: '2032-07-18T09:00:00Z',
      ends: '2032-07-19T09:00:00Z',
      status: 'completed',
      totalMinor: 50_000,
      currency: 'USD',
      completedAt: '2032-07-19T10:00:00Z',
    })
    await seedPayment({
      rental: usdRental,
      customer: customerOne,
      amountMinor: 50_000,
      currency: 'USD',
      paidAt: '2032-07-19T10:00:00Z',
    })
    await seedExpense({
      amountMinor: 20_000,
      incurredOn: '2032-07-19',
      allocation: 'overhead',
      currency: 'USD',
    })
  })

  it('returns one row per currency and never a total across them', async () => {
    const rows = await business()
    expect(rows.map((row) => row.currency).sort()).toEqual(['EUR', 'USD'])

    const eur = inCurrency(rows, 'EUR')
    const usd = inCurrency(rows, 'USD')

    expect(eur.rental_revenue_minor).toBe(89_000)
    expect(usd.rental_revenue_minor).toBe(50_000)

    // The combined figure a naive implementation would print does not appear.
    expect(rows.some((row) => row.rental_revenue_minor === 139_000)).toBe(false)
  })

  it('computes the operating result inside each currency', async () => {
    const rows = await business()
    expect(inCurrency(rows, 'EUR').operating_result_minor).toBe(67_000)
    expect(inCurrency(rows, 'USD').operating_result_minor).toBe(30_000)
  })

  it('marks which row is the agency default', async () => {
    const rows = await business()
    expect(inCurrency(rows, 'EUR').is_default_currency).toBe(true)
    expect(inCurrency(rows, 'USD').is_default_currency).toBe(false)
    // Default first, so the interface can lead with the currency the agency
    // actually thinks in.
    expect(rows[0]!.currency).toBe('EUR')
  })

  it('requires a currency for the trend, rather than guessing one', async () => {
    await db.asUser(ownerA, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `select * from public.report_financial_series($1, $2::date, $3::date, 'day', null)`,
            [orgA, FROM, TO],
          ),
        /currency is required/i,
      )
    })
  })
})

// =============================================================================
// Financing: cash, cost and principal are three different things
// =============================================================================

describe('financing', () => {
  let agreement: string

  beforeAll(async () => {
    const [lender] = await db.sql<{ id: string }>(
      `insert into public.lenders (organization_id, name) values ($1, 'Banque Atlas') returning id`,
      [orgA],
    )
    const [row] = await db.sql<{ id: string }>(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, agreement_type, mode, currency, reference,
          financed_amount_minor, rate_bps, installments_count, payment_frequency, first_payment_on,
          schedule_anchor_day, starts_on, agreement_status, activated_at)
       values ($1, $2, $3, 'loan', 'amortizing', 'EUR', 'FIN-RPT-1',
               1000000, 600, 12, 'monthly', '2032-07-01', 1, '2032-07-01', 'active', now())
       returning id`,
      [orgA, vehicleOne, lender!.id],
    )
    agreement = row!.id

    // A principal repayment, an interest charge, a fee and a payment whose
    // composition nobody stated.
    await db.sql(
      `insert into public.financing_payments
         (organization_id, agreement_id, paid_on, currency, amount_minor,
          principal_minor, interest_minor, fees_minor, unallocated_minor)
       values
         ($1, $2, '2032-07-05', 'EUR', 500000, 500000, 0, 0, 0),
         ($1, $2, '2032-07-06', 'EUR',  50000,      0, 50000, 0, 0),
         ($1, $2, '2032-07-07', 'EUR',   1500,      0, 0, 1500, 0)`,
      [orgA, agreement],
    )
  })

  it('counts a principal repayment as cash but never as a cost', async () => {
    const eur = inCurrency(await business(), 'EUR')

    expect(eur.financing_principal_minor).toBe(500_000)
    // Interest 50,000 + fee 1,500. The 500,000 principal is not in it.
    expect(eur.financing_cost_minor).toBe(51_500)
    expect(eur.financing_cash_paid_minor).toBe(551_500)
  })

  it('leaves the operating result untouched by any financing payment', async () => {
    // The whole point of keeping the two apart: a loan repayment is not an
    // operating cost and must not move the operating result by a cent.
    const eur = inCurrency(await business(), 'EUR')
    expect(eur.operating_result_minor).toBe(67_000)
    expect(eur.operating_expense_minor).toBe(22_000)
  })

  it('reports after-financing cash as a separate, clearly weaker figure', async () => {
    const eur = inCurrency(await business(), 'EUR')
    expect(eur.after_financing_minor).toBe(67_000 - 551_500)
    // It is not the operating result, and it is not a profit.
    expect(eur.after_financing_minor).not.toBe(eur.operating_result_minor)
  })

  it('says the cost is complete while every payment is fully allocated', async () => {
    const eur = inCurrency(await business(), 'EUR')
    expect(eur.financing_cost_complete).toBe(true)
    expect(eur.financing_unallocated_minor).toBe(0)
  })

  it('turns incomplete the moment money arrives whose split nobody stated', async () => {
    await db.sql(
      `insert into public.financing_payments
         (organization_id, agreement_id, paid_on, currency, amount_minor,
          principal_minor, interest_minor, fees_minor, unallocated_minor)
       values ($1, $2, '2032-07-20', 'EUR', 430000, 0, 0, 0, 430000)`,
      [orgA, agreement],
    )

    const eur = inCurrency(await business(), 'EUR')

    expect(eur.financing_unallocated_minor).toBe(430_000)
    expect(eur.financing_cost_complete).toBe(false)
    // Cash rose by the whole amount.
    expect(eur.financing_cash_paid_minor).toBe(981_500)
    // Nothing was invented: no principal, no interest.
    expect(eur.financing_principal_minor).toBe(500_000)
    expect(eur.financing_cost_minor).toBe(51_500)
  })
})

// =============================================================================
// Vehicle economics
// =============================================================================

describe('fleet performance', () => {
  interface FleetRow {
    vehicle_id: string
    registration_plate: string
    currency: string
    rental_revenue_minor: number
    vehicle_expense_minor: number
    rental_expense_minor: number
    direct_expense_minor: number
    operating_contribution_minor: number
    financing_cash_minor: number
    after_financing_minor: number
    hires_started: number
    hires_completed: number
    rented_days: string
    in_service_days: string
    utilisation_bps: number | null
    distance_units: number
    expense_count: number
  }

  async function fleet(from = FROM, to = TO): Promise<FleetRow[]> {
    return db.asUser(ownerA, (session) =>
      session.sql<FleetRow>(
        `select * from public.report_fleet_performance($1, $2::date, $3::date)`,
        [orgA, from, to],
      ),
    )
  }

  function forPlate(rows: readonly FleetRow[], plate: string, currency = 'EUR'): FleetRow {
    const row = rows.find((r) => r.registration_plate === plate && r.currency === currency)
    if (!row) throw new Error(`No ${plate}/${currency} row`)
    return row
  }

  it('attributes a rental-direct cost to the vehicle exactly once', async () => {
    const one = forPlate(await fleet(), 'RPT-001')

    // 8,000 on the vehicle, 4,000 through the hire. Twelve thousand once.
    expect(one.vehicle_expense_minor).toBe(8_000)
    expect(one.rental_expense_minor).toBe(4_000)
    expect(one.direct_expense_minor).toBe(12_000)
  })

  it('computes contribution as vehicle revenue less its direct costs', async () => {
    const one = forPlate(await fleet(), 'RPT-001')

    // 60,000 charged and paid, 5,000 refunded, 4,000 on the cancelled booking
    // for the same car — all of it money for this vehicle's hires.
    expect(one.rental_revenue_minor).toBe(59_000)
    expect(one.operating_contribution_minor).toBe(59_000 - 12_000)
  })

  it('excludes overhead from contribution', async () => {
    const one = forPlate(await fleet(), 'RPT-001')
    // The 10,000 overhead is in the organisation's operating result and in no
    // vehicle's contribution. Nothing here divides it across the fleet.
    expect(one.direct_expense_minor).toBe(12_000)
  })

  it('agrees with the per-vehicle model the vehicle page already uses', async () => {
    const [existing] = await db.asUser(ownerA, (session) =>
      session.sql<{
        rental_revenue_minor: number
        direct_expense_minor: number
        operating_contribution_minor: number
      }>(`select * from public.vehicle_operating_summary($1, $2::date, $3::date)`, [
        vehicleOne,
        FROM,
        TO,
      ]),
    )
    const one = forPlate(await fleet(), 'RPT-001')

    expect(Number(existing!.rental_revenue_minor)).toBe(one.rental_revenue_minor)
    expect(Number(existing!.direct_expense_minor)).toBe(one.direct_expense_minor)
    expect(Number(existing!.operating_contribution_minor)).toBe(
      one.operating_contribution_minor,
    )
  })

  it('keeps financing cash out of contribution and beside it', async () => {
    const one = forPlate(await fleet(), 'RPT-001')
    expect(one.operating_contribution_minor).toBe(47_000)
    expect(one.financing_cash_minor).toBe(981_500)
    expect(one.after_financing_minor).toBe(47_000 - 981_500)
  })

  it('shows a vehicle that earned nothing, rather than omitting it', async () => {
    // The row a manager opened the report to find. `vehicle_operating_summary`
    // returns no rows at all for this car.
    const idle = forPlate(await fleet(), 'RPT-003')
    expect(idle.rental_revenue_minor).toBe(0)
    expect(idle.hires_started).toBe(0)
    expect(Number(idle.rented_days)).toBe(0)
    expect(idle.utilisation_bps).toBe(0)
  })

  it('counts only the part of a hire that falls inside the window', async () => {
    /*
     * A six-day hire on a vehicle with nothing else on it: 28 June to 4 July.
     * The agency is in Lisbon, so July begins at 30 June 23:00 UTC and the two
     * halves are 2.958 and 3.042 days. Neither period sees the whole six, and
     * together they are exactly six — which is the property that matters.
     */
    const [boundaryVehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, daily_rate_minor, acquired_on)
       values ($1, 'Seat', 'Ibiza', 'RPT-EDGE', 'EUR', 3000, '2030-01-01')
       returning id`,
      [orgA],
    )
    await seedRental({
      vehicle: boundaryVehicle!.id,
      customer: customerOne,
      reference: 'RPT-R-EDGE',
      starts: '2032-06-28T00:00:00Z',
      ends: '2032-07-04T00:00:00Z',
      status: 'completed',
      totalMinor: 18_000,
      completedAt: '2032-07-04T01:00:00Z',
    })

    const july = Number(forPlate(await fleet(), 'RPT-EDGE').rented_days)
    const june = Number(forPlate(await fleet('2032-06-01', '2032-07-01'), 'RPT-EDGE').rented_days)

    expect(july).toBeGreaterThan(0)
    expect(july).toBeLessThan(6)
    expect(june).toBeGreaterThan(0)
    expect(june).toBeLessThan(6)
    expect(july + june).toBeCloseTo(6, 6)

    await db.sql(`delete from public.rentals where reference = 'RPT-R-EDGE'`)
    await db.sql(`delete from public.vehicles where id = $1`, [boundaryVehicle!.id])
  })

  it('never lets utilisation exceed the time the vehicle existed', async () => {
    for (const row of await fleet()) {
      if (row.utilisation_bps === null) continue
      expect(row.utilisation_bps).toBeGreaterThanOrEqual(0)
      expect(row.utilisation_bps).toBeLessThanOrEqual(10_000)
    }
  })

  it('bounds the denominator by the day the vehicle was acquired', async () => {
    const [row] = await db.sql<{ id: string }>(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, daily_rate_minor, acquired_on)
       values ($1, 'Fiat', 'Panda', 'RPT-LATE', 'EUR', 3000, '2032-07-16')
       returning id`,
      [orgA],
    )
    const rows = await fleet()
    const late = rows.find((r) => r.registration_plate === 'RPT-LATE')!
    // Acquired on the 16th: sixteen days of July, not thirty-one.
    expect(Number(late.in_service_days)).toBeCloseTo(16, 4)
    await db.sql(`delete from public.vehicles where id = $1`, [row!.id])
  })

  it('excludes a cancelled booking from occupancy', async () => {
    // RPT-001's cancelled 20–22 July booking releases the vehicle, so only the
    // 5–10 July hire counts.
    const one = forPlate(await fleet(), 'RPT-001')
    expect(Number(one.rented_days)).toBeCloseTo(5, 5)
  })

  it('keeps an archived vehicle and its history', async () => {
    await db.sql(`update public.vehicles set archived_at = now() where id = $1`, [vehicleArchived])
    const rows = await fleet()
    expect(rows.some((row) => row.registration_plate === 'RPT-004')).toBe(true)
  })

  it('reports distance from the hire odometers, never from the vehicle record', async () => {
    const one = forPlate(await fleet(), 'RPT-001')
    expect(one.distance_units).toBe(850)
  })
})

// =============================================================================
// Cost analysis
// =============================================================================

describe('cost analysis', () => {
  interface BreakdownRow {
    dimension_id: string | null
    dimension_key: string | null
    dimension_label: string
    dimension_archived: boolean
    currency: string
    gross_minor: number
    tax_minor: number
    net_minor: number
    expense_count: number
  }

  async function breakdown(dimension: string): Promise<BreakdownRow[]> {
    return db.asUser(ownerA, (session) =>
      session.sql<BreakdownRow>(
        `select * from public.report_expense_breakdown($1, $2::date, $3::date, $4)`,
        [orgA, FROM, TO, dimension],
      ),
    )
  }

  it('splits spend by allocation using the recorded value, not the category', async () => {
    const rows = (await breakdown('allocation')).filter((row) => row.currency === 'EUR')
    const byKey = new Map(rows.map((row) => [row.dimension_key, row.gross_minor]))

    expect(byKey.get('overhead')).toBe(10_000)
    expect(byKey.get('vehicle')).toBe(8_000)
    expect(byKey.get('rental')).toBe(4_000)
  })

  it('never counts a voided cost in any breakdown', async () => {
    for (const dimension of ['category', 'vendor', 'allocation']) {
      const total = (await breakdown(dimension))
        .filter((row) => row.currency === 'EUR')
        .reduce((sum, row) => sum + Number(row.gross_minor), 0)
      expect(total).toBe(22_000)
    }
  })

  it('reports the tax inside the gross, and a net that subtracts it', async () => {
    const rows = (await breakdown('allocation')).filter(
      (row) => row.currency === 'EUR' && row.dimension_key === 'vehicle',
    )
    expect(rows[0]!.gross_minor).toBe(8_000)
    expect(rows[0]!.tax_minor).toBe(1_333)
    expect(rows[0]!.net_minor).toBe(6_667)
  })

  it('keeps currencies apart in every breakdown', async () => {
    const rows = await breakdown('allocation')
    const usd = rows.filter((row) => row.currency === 'USD')
    expect(usd.reduce((sum, row) => sum + Number(row.gross_minor), 0)).toBe(20_000)
  })

  it('groups suppliers by identity, so two of the same name stay apart', async () => {
    const vendors = await db.sql<{ id: string }>(
      `insert into public.expense_vendors (organization_id, name)
       values ($1, 'Garage Atlas'), ($1, 'Garage Atlas') returning id`,
      [orgA],
    )
    await seedExpense({
      amountMinor: 1_100,
      incurredOn: '2032-07-25',
      allocation: 'overhead',
      vendor: vendors[0]!.id,
    })
    await seedExpense({
      amountMinor: 2_200,
      incurredOn: '2032-07-25',
      allocation: 'overhead',
      vendor: vendors[1]!.id,
    })

    const rows = (await breakdown('vendor')).filter(
      (row) => row.dimension_label === 'Garage Atlas',
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => Number(row.gross_minor)).sort((a, b) => a - b)).toEqual([1_100, 2_200])

    await db.sql(`delete from public.expenses where vendor_id = any($1::uuid[])`, [
      vendors.map((v) => v.id),
    ])
    await db.sql(`delete from public.expense_vendors where id = any($1::uuid[])`, [
      vendors.map((v) => v.id),
    ])
  })

  it('keeps historical spend under a category that has since been renamed', async () => {
    const fuel = await categoryId('Fuel')
    const before = (await breakdown('category')).find((row) => row.dimension_id === fuel)
    expect(before).toBeDefined()

    await db.sql(`update public.expense_categories set name = 'Fuel and charging' where id = $1`, [
      fuel,
    ])
    const after = (await breakdown('category')).find((row) => row.dimension_id === fuel)

    // Same identity, same money, new label. Grouping by name would have split it.
    expect(after!.gross_minor).toBe(before!.gross_minor)
    expect(after!.dimension_label).toBe('Fuel and charging')
    await db.sql(`update public.expense_categories set name = 'Fuel' where id = $1`, [fuel])
  })

  it('keeps spend recorded against a category that has since been archived', async () => {
    const fuel = await categoryId('Fuel')
    await db.sql(`update public.expense_categories set archived_at = now() where id = $1`, [fuel])

    const row = (await breakdown('category')).find((entry) => entry.dimension_id === fuel)
    expect(row).toBeDefined()
    expect(row!.dimension_archived).toBe(true)

    await db.sql(`update public.expense_categories set archived_at = null where id = $1`, [fuel])
  })

  it('refuses a breakdown nobody defined', async () => {
    await db.asUser(ownerA, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.report_expense_breakdown($1, $2::date, $3::date, 'moon')`, [
          orgA,
          FROM,
          TO,
        ]),
        /unsupported breakdown/i,
      )
    })
  })
})

// =============================================================================
// Positions are not period figures
// =============================================================================

describe('current positions', () => {
  interface PositionRow {
    currency: string
    outstanding_minor: number
    outstanding_rental_count: number
    deposits_held_minor: number
    remaining_principal_minor: number | null
    principal_known_count: number
    principal_unknown_count: number
    financing_overdue_minor: number
  }

  async function positions(asUser = ownerA, organizationId = orgA): Promise<PositionRow[]> {
    return db.asUser(asUser, (session) =>
      session.sql<PositionRow>(`select * from public.report_position_summary($1)`, [organizationId]),
    )
  }

  it('reports receivables without a date filter', async () => {
    // A balance is a balance now; a date picker on the page does not make
    // "money customers owe us" a monthly quantity.
    const rows = await positions()
    const eur = rows.find((row) => row.currency === 'EUR')
    expect(eur).toBeDefined()
    expect(eur!.outstanding_minor).toBeGreaterThan(0)
  })

  it('agrees with the dashboard on receivables and deposits', async () => {
    const [overview] = await db.asUser(ownerA, (session) =>
      session.sql<{ outstanding_minor: number; deposits_held_minor: number }>(
        `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
        [orgA, '2032-07-01T00:00:00+01:00', '2032-08-01T00:00:00+01:00'],
      ),
    )
    const eur = (await positions()).find((row) => row.currency === 'EUR')!

    expect(eur.outstanding_minor).toBe(Number(overview!.outstanding_minor))
    expect(eur.deposits_held_minor).toBe(Number(overview!.deposits_held_minor))
  })

  it('leaves a principal nobody can derive out of the sum, and counts it', async () => {
    const eur = (await positions()).find((row) => row.currency === 'EUR')!

    // The unallocated payment made this agreement's balance underivable.
    // NULL is the only honest answer — a zero here would read as "nothing is
    // owed" for an agency that owes at least five thousand.
    expect(eur.principal_unknown_count).toBe(1)
    expect(eur.principal_known_count).toBe(0)
    expect(eur.remaining_principal_minor).toBeNull()
  })

  it('reports zero, not "not derivable", for a currency with no financing at all', async () => {
    // The other half of the same join. An agency with no loans in a currency
    // owes no principal in it, and that is a fact rather than an unknown.
    await seedRental({
      vehicle: vehicleIdle,
      customer: customerTwo,
      reference: 'RPT-R-USD-DEBT',
      // Deliberately outside July: a position is not date-filtered, so this
      // contributes a USD receivable without disturbing any period figure.
      starts: '2032-11-22T09:00:00Z',
      ends: '2032-11-23T09:00:00Z',
      status: 'completed',
      totalMinor: 12_000,
      currency: 'USD',
      completedAt: '2032-11-23T10:00:00Z',
    })

    const usd = (await positions()).find((row) => row.currency === 'USD')
    expect(usd).toBeDefined()
    expect(usd!.remaining_principal_minor).toBe(0)
    expect(usd!.principal_known_count).toBe(0)
    expect(usd!.principal_unknown_count).toBe(0)
  })

  it('refuses another agency entirely', async () => {
    await db.asUser(ownerB, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.report_position_summary($1)`, [orgA]),
        /not permitted to view reports/i,
      )
    })
  })
})

// =============================================================================
// Rentals
// =============================================================================

describe('rental operations', () => {
  interface OpsRow {
    created: number
    confirmed: number
    started: number
    completed: number
    cancelled: number
    returned_late: number
    avg_billable_days: string | null
    cancellation_bps: number | null
  }

  async function ops(from = FROM, to = TO): Promise<OpsRow> {
    const [row] = await db.asUser(ownerA, (session) =>
      session.sql<OpsRow>(`select * from public.report_rental_operations($1, $2::date, $3::date)`, [
        orgA,
        from,
        to,
      ]),
    )
    return row!
  }

  it('counts each lifecycle event by its own date', async () => {
    const row = await ops()

    // Two hires begin in July (5th and 18th); the 28 June one does not.
    expect(row.started).toBe(2)
    // Three completed in July: the 4th, the 10th and the 19th.
    expect(row.completed).toBe(3)
    // One cancellation, on the 15th.
    expect(row.cancelled).toBe(1)
  })

  it('does not let "created" stand in for "started"', async () => {
    const row = await ops()
    // Every fixture rental was created now, not in 2032 — so `created` is zero
    // for the reporting window while `started` is not. A report that filtered
    // everything by created_at would show the opposite.
    expect(row.created).toBe(0)
    expect(row.started).toBe(2)
  })

  it('computes the cancellation rate against real bookings only', async () => {
    const row = await ops()
    /*
     * Two bookings were confirmed inside July and one of them was then
     * cancelled inside July too. Cancelling leaves `confirmed_at` in place, so
     * a denominator of "confirmed plus cancelled" counts that booking twice and
     * can never report more than 50% — a month in which every booking was
     * cancelled would read exactly half.
     *
     * The denominator is distinct real bookings: two.
     */
    expect(row.confirmed).toBe(2)
    expect(row.cancelled).toBe(1)
    expect(row.cancellation_bps).toBe(5_000)
  })

  it('averages the billable duration the domain defines', async () => {
    const row = await ops()
    // 5 + 6 + 1 days across the three hires completed in July.
    expect(Number(row.avg_billable_days)).toBeCloseTo(4, 2)
  })

  it('measures lateness from the recorded timestamps, not from now()', async () => {
    await seedRental({
      vehicle: vehicleIdle,
      customer: customerOne,
      reference: 'RPT-R-LATE',
      starts: '2032-07-02T09:00:00Z',
      ends: '2032-07-03T09:00:00Z',
      status: 'completed',
      totalMinor: 5_000,
      completedAt: '2032-07-04T12:00:00Z',
      pickedUpAt: '2032-07-02T09:00:00Z',
      returnedAt: '2032-07-04T11:00:00Z',
    })
    const row = await ops()
    expect(row.returned_late).toBe(1)
  })

  it('never averages a value across currencies', async () => {
    const values = await db.asUser(ownerA, (session) =>
      session.sql<{ currency: string; avg_completed_value_minor: number | null }>(
        `select * from public.report_rental_values($1, $2::date, $3::date)`,
        [orgA, FROM, TO],
      ),
    )
    expect(values.map((row) => row.currency).sort()).toEqual(['EUR', 'USD'])
    const usd = values.find((row) => row.currency === 'USD')!
    expect(Number(usd.avg_completed_value_minor)).toBe(50_000)
  })
})

// =============================================================================
// Customers
// =============================================================================

describe('customers', () => {
  interface CohortRow {
    renters_in_period: number
    first_time_renters: number
    returning_renters: number
    repeat_rate_bps: number | null
    rentals_in_period: number
    customers_total: number
  }

  async function cohorts(from = FROM, to = TO): Promise<CohortRow> {
    const [row] = await db.asUser(ownerA, (session) =>
      session.sql<CohortRow>(`select * from public.report_customer_cohorts($1, $2::date, $3::date)`, [
        orgA,
        from,
        to,
      ]),
    )
    return row!
  }

  it('counts a first-time renter by their first hire, not by when the record was created', async () => {
    // Both customers were created during setup, months before any of these
    // hires. Cohorting on `customers.created_at` would put every one of them in
    // the same period.
    const row = await cohorts()
    expect(row.first_time_renters).toBeGreaterThan(0)
    expect(row.renters_in_period).toBe(row.first_time_renters + row.returning_renters)
  })

  it('finds the first-ever hire across all history before applying the window', async () => {
    const august = await cohorts('2032-08-01', '2032-09-01')
    // Nobody hired in August, so nobody is new in August.
    expect(august.renters_in_period).toBe(0)
    expect(august.first_time_renters).toBe(0)

    const newCustomer = await db.sql<{ id: string }>(
      `insert into public.customers (organization_id, first_name, last_name)
       values ($1, 'Nadia', 'Alaoui') returning id`,
      [orgA],
    )
    await seedRental({
      vehicle: vehicleIdle,
      customer: newCustomer[0]!.id,
      reference: 'RPT-R-AUG1',
      starts: '2032-08-05T09:00:00Z',
      ends: '2032-08-06T09:00:00Z',
      status: 'completed',
      totalMinor: 4_000,
      completedAt: '2032-08-06T10:00:00Z',
    })
    await seedRental({
      vehicle: vehicleIdle,
      customer: customerOne,
      reference: 'RPT-R-AUG2',
      starts: '2032-08-10T09:00:00Z',
      ends: '2032-08-11T09:00:00Z',
      status: 'completed',
      totalMinor: 4_000,
      completedAt: '2032-08-11T10:00:00Z',
    })

    const again = await cohorts('2032-08-01', '2032-09-01')
    expect(again.renters_in_period).toBe(2)
    // Nadia is new; Yasmine hired in July and is therefore returning.
    expect(again.first_time_renters).toBe(1)
    expect(again.returning_renters).toBe(1)
    expect(again.repeat_rate_bps).toBe(5_000)
  })

  it('does not let a cancelled booking make somebody a renter', async () => {
    const ghost = await db.sql<{ id: string }>(
      `insert into public.customers (organization_id, first_name, last_name)
       values ($1, 'Karim', 'Zerouali') returning id`,
      [orgA],
    )
    await seedRental({
      vehicle: vehicleIdle,
      customer: ghost[0]!.id,
      reference: 'RPT-R-GHOST',
      starts: '2032-09-05T09:00:00Z',
      ends: '2032-09-06T09:00:00Z',
      status: 'cancelled',
      totalMinor: 4_000,
      cancelledAt: '2032-09-01T09:00:00Z',
    })

    const september = await cohorts('2032-09-01', '2032-10-01')
    expect(september.renters_in_period).toBe(0)
  })

  it('lists balances without any contact detail or identity document', async () => {
    const rows = await db.asUser(ownerA, (session) =>
      session.sql<Record<string, unknown>>(
        `select * from public.report_customer_balances($1, null, 25, 0)`,
        [orgA],
      ),
    )
    expect(rows.length).toBeGreaterThan(0)

    const columns = Object.keys(rows[0]!)
    for (const forbidden of [
      'email',
      'phone',
      'secondary_phone',
      'phone_normalized',
      'email_normalized',
      'date_of_birth',
      'address_line1',
      'address_line2',
      'postal_code',
      'notes',
      'license_number',
      'national_id',
      'passport',
    ]) {
      expect(columns).not.toContain(forbidden)
    }
    expect(columns).toContain('display_name')
    expect(columns).toContain('outstanding_minor')
  })

  it('paginates rather than returning every customer at once', async () => {
    const page = await db.asUser(ownerA, (session) =>
      session.sql<{ total_rows: number }>(
        `select * from public.report_customer_balances($1, null, 1, 0)`,
        [orgA],
      ),
    )
    expect(page).toHaveLength(1)
    expect(Number(page[0]!.total_rows)).toBeGreaterThanOrEqual(1)
  })
})

// =============================================================================
// Tracking
// =============================================================================

describe('tracking coverage', () => {
  it('reports a stamped snapshot, and counts untracked vehicles', async () => {
    const [row] = await db.asUser(ownerA, (session) =>
      session.sql<{
        computed_at: string
        vehicles_total: number
        vehicles_tracked: number
        vehicles_untracked: number
        link_online: number
        link_offline: number
        link_unreported: number
        fresh_minutes: number
      }>(`select * from public.report_gps_coverage($1)`, [orgA]),
    )

    expect(row!.computed_at).toBeTruthy()
    expect(Number(row!.vehicles_tracked)).toBe(0)
    expect(Number(row!.vehicles_untracked)).toBe(Number(row!.vehicles_total))
    // The agency's own threshold, echoed back rather than hard-coded on screen.
    expect(Number(row!.fresh_minutes)).toBe(10)
  })

  it('keeps connectivity in three buckets, never two', async () => {
    const [row] = await db.asUser(ownerA, (session) =>
      session.sql<{ link_online: number; link_offline: number; link_unreported: number }>(
        `select * from public.report_gps_coverage($1)`,
        [orgA],
      ),
    )
    // A tracker whose provider reports no link state is not offline.
    expect(row).toHaveProperty('link_unreported')
    expect(Number(row!.link_offline)).toBe(0)
    expect(Number(row!.link_unreported)).toBe(0)
  })
})

// =============================================================================
// Compliance
// =============================================================================

describe('compliance', () => {
  it('uses the agency threshold and counts a missing date apart from an expired one', async () => {
    const rows = await db.asUser(ownerA, (session) =>
      session.sql<{
        document_kind: string
        lead_days: number
        expired: number
        due_soon: number
        valid: number
        unrecorded: number
      }>(`select * from public.report_compliance_summary($1, null)`, [orgA]),
    )

    const byKind = new Map(rows.map((row) => [row.document_kind, row]))
    expect(byKind.size).toBe(3)
    expect(Number(byKind.get('insurance')!.lead_days)).toBe(30)

    // A vehicle with no insurance date recorded is a data gap, not a vehicle
    // driving uninsured, and the two are counted separately.
    expect(Number(byKind.get('registration')!.unrecorded)).toBeGreaterThan(0)
    expect(Number(byKind.get('registration')!.expired)).toBe(0)
  })
})

// =============================================================================
// Tenancy and roles
// =============================================================================

describe('who may read a report', () => {
  const REPORTS = [
    `select * from public.report_business_summary($1, '2032-07-01'::date, '2032-08-01'::date)`,
    `select * from public.report_position_summary($1)`,
    `select * from public.report_financial_series($1, '2032-07-01'::date, '2032-08-01'::date, 'day', 'EUR')`,
    `select * from public.report_fleet_performance($1, '2032-07-01'::date, '2032-08-01'::date)`,
    `select * from public.report_utilisation_series($1, '2032-07-01'::date, '2032-08-01'::date, 'day')`,
    `select * from public.report_expense_breakdown($1, '2032-07-01'::date, '2032-08-01'::date, 'category')`,
    `select * from public.report_rental_operations($1, '2032-07-01'::date, '2032-08-01'::date)`,
    `select * from public.report_rental_values($1, '2032-07-01'::date, '2032-08-01'::date)`,
    `select * from public.report_customer_cohorts($1, '2032-07-01'::date, '2032-08-01'::date)`,
    `select * from public.report_customer_balances($1, null, 25, 0)`,
    `select * from public.report_customer_revenue($1, '2032-07-01'::date, '2032-08-01'::date, 10)`,
    `select * from public.report_financing_position($1)`,
    `select * from public.report_gps_coverage($1)`,
    `select * from public.report_compliance_summary($1, null)`,
  ]

  it('lets a manager read every report', async () => {
    await db.asUser(managerA, async (session) => {
      for (const statement of REPORTS) {
        await session.sql(statement, [orgA])
      }
    })
  })

  it('refuses a member of staff every report', async () => {
    // Reports combine financial, customer and location data. The front desk
    // does not need the agency's economics, and hiding a sidebar entry is not
    // a control.
    await db.asUser(staffA, async (session) => {
      for (const statement of REPORTS) {
        await session.expectRejection(
          () => session.sql(statement, [orgA]),
          /not permitted to view reports/i,
        )
      }
    })
  })

  it('refuses another agency every report, with the same message', async () => {
    // The same sentence a staff member gets, so nobody can learn whether an
    // organization exists by comparing error text.
    await db.asUser(ownerB, async (session) => {
      for (const statement of REPORTS) {
        await session.expectRejection(
          () => session.sql(statement, [orgA]),
          /not permitted to view reports/i,
        )
      }
    })
  })

  it('gives the anonymous role nothing at all', async () => {
    await db.asAnon(async (session) => {
      for (const statement of REPORTS) {
        await session.expectRejection(
          () => session.sql(statement.replace('$1', `'${orgA}'`)),
          /permission denied/i,
        )
      }
    })
  })

  it('reports agency A its own figures, never a total contaminated by B', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Rival', 'Car', 'RIVAL-1', 'EUR', 9999) returning id`,
      [orgB],
    )
    const [customer] = await db.sql<{ id: string }>(
      `insert into public.customers (organization_id, first_name, last_name)
       values ($1, 'Rival', 'Customer') returning id`,
      [orgB],
    )
    const [rental] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
          currency, daily_rate_minor, subtotal_minor, total_minor)
       values ($1, $2, $3, 'RIVAL-R-1', 'completed', '2032-07-05T09:00:00Z',
               '2032-07-06T09:00:00Z', 'EUR', 9999, 999999, 999999)
       returning id`,
      [orgB, vehicle!.id, customer!.id],
    )
    await db.sql(
      `insert into public.payments
         (organization_id, rental_id, customer_id, amount_minor, currency, purpose, paid_at)
       values ($1, $2, $3, 999999, 'EUR', 'rental_charge', '2032-07-05T10:00:00Z')`,
      [orgB, rental!.id, customer!.id],
    )

    const eur = inCurrency(await business(), 'EUR')
    expect(eur.rental_revenue_minor).toBe(89_000)

    const fleetRows = await db.asUser(ownerA, (session) =>
      session.sql<{ registration_plate: string }>(
        `select * from public.report_fleet_performance($1, $2::date, $3::date)`,
        [orgA, FROM, TO],
      ),
    )
    expect(fleetRows.some((row) => row.registration_plate === 'RIVAL-1')).toBe(false)
  })
})

// =============================================================================
// The defects an adversarial review found
//
// Each of these produced a confident, wrong number rather than an error — which
// is how an analytics module actually fails. Every one is reproduced here first
// and then asserted against the fix.
// =============================================================================

describe('regressions', () => {
  it('counts an early return followed by a re-hire once, not twice', async () => {
    /*
     * The availability constraint guards `reserved` and `active` only, and
     * completing a hire does not pull its `ends_at` back to the actual return.
     * So a completed contract keeps its whole original interval AND frees the
     * car for a new booking — the ordinary early-return path.
     *
     * Summing each hire's overlap separately reported 28 days of occupancy in a
     * 31-day month for a vehicle that was committed for 19.
     */
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, daily_rate_minor, acquired_on)
       values ($1, 'Opel', 'Corsa', 'RPT-OVERLAP', 'EUR', 3000, '2030-01-01') returning id`,
      [orgA],
    )

    // Booked 1–15 July, returned early on the 5th and completed.
    await seedRental({
      vehicle: vehicle!.id,
      customer: customerOne,
      reference: 'RPT-R-OV1',
      starts: '2032-07-01T00:00:00Z',
      ends: '2032-07-15T00:00:00Z',
      status: 'completed',
      totalMinor: 42_000,
      completedAt: '2032-07-05T12:00:00Z',
      returnedAt: '2032-07-05T12:00:00Z',
    })
    // Re-let from the 6th to the 20th — legal, because a completed contract is
    // not in the exclusion index.
    await seedRental({
      vehicle: vehicle!.id,
      customer: customerTwo,
      reference: 'RPT-R-OV2',
      starts: '2032-07-06T00:00:00Z',
      ends: '2032-07-20T00:00:00Z',
      status: 'reserved',
      totalMinor: 42_000,
    })

    const [row] = await db.asUser(ownerA, (session) =>
      session.sql<{ rented_days: string; utilisation_bps: number }>(
        `select rented_days, utilisation_bps from public.report_fleet_performance($1, $2::date, $3::date)
         where registration_plate = 'RPT-OVERLAP'`,
        [orgA, FROM, TO],
      ),
    )

    // The union of [1,15) and [6,20) is [1,20) — nineteen days, not twenty-eight.
    expect(Number(row!.rented_days)).toBeCloseTo(19, 4)
    expect(row!.utilisation_bps).toBeLessThan(7_000)

    await db.sql(`delete from public.rentals where reference in ('RPT-R-OV1', 'RPT-R-OV2')`)
    await db.sql(`delete from public.vehicles where id = $1`, [vehicle!.id])
  })

  it('never reports more vehicle-days rented than the fleet had available', async () => {
    const rows = await db.asUser(ownerA, (session) =>
      session.sql<{ vehicle_days_available: string; vehicle_days_rented: string }>(
        `select * from public.report_utilisation_series($1, $2::date, $3::date, 'day')`,
        [orgA, FROM, TO],
      ),
    )
    for (const row of rows) {
      expect(Number(row.vehicle_days_rented)).toBeLessThanOrEqual(
        Number(row.vehicle_days_available) + 1e-6,
      )
    }
  })

  it('never measures days from before the period in the first bucket', async () => {
    /*
     * `generate_series` starts at date_trunc(granularity, from), which precedes
     * the period whenever it does not begin on a bucket boundary. Every quarter
     * reaches this: a quarter is charted weekly and quarters do not start on a
     * Monday.
     */
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, daily_rate_minor, acquired_on)
       values ($1, 'Kia', 'Picanto', 'RPT-BUCKET', 'EUR', 3000, '2030-01-01') returning id`,
      [orgA],
    )
    // Entirely inside June — nothing of it belongs to a July report.
    await seedRental({
      vehicle: vehicle!.id,
      customer: customerOne,
      reference: 'RPT-R-JUNE',
      starts: '2032-06-25T00:00:00Z',
      ends: '2032-06-30T00:00:00Z',
      status: 'completed',
      totalMinor: 15_000,
      completedAt: '2032-06-30T01:00:00Z',
    })

    const rows = await db.asUser(ownerA, (session) =>
      session.sql<{ bucket_start: string; vehicle_days_rented: string }>(
        `select * from public.report_utilisation_series($1, '2032-07-01'::date, '2032-10-01'::date, 'week')`,
        [orgA],
      ),
    )

    // The first weekly bucket begins on the Monday before 1 July, which is
    // exactly the condition that used to pull June into a July report.
    const first = rows[0]!
    expect(new Date(first.bucket_start).getTime()).toBeLessThan(
      new Date('2032-07-01T00:00:00Z').getTime(),
    )

    // Measured against the same fleet with the June hire removed: the totals
    // must be identical, because none of June belongs to this report.
    const withJune = rows.reduce((sum, row) => sum + Number(row.vehicle_days_rented), 0)
    await db.sql(`delete from public.rentals where reference = 'RPT-R-JUNE'`)
    const withoutJune = (
      await db.asUser(ownerA, (session) =>
        session.sql<{ vehicle_days_rented: string }>(
          `select * from public.report_utilisation_series($1, '2032-07-01'::date, '2032-10-01'::date, 'week')`,
          [orgA],
        ),
      )
    ).reduce((sum, row) => sum + Number(row.vehicle_days_rented), 0)

    expect(withJune).toBeCloseTo(withoutJune, 6)

    await db.sql(`delete from public.vehicles where id = $1`, [vehicle!.id])
  })

  it('reports no vehicle-days for an agency that owns no vehicles', async () => {
    // A LEFT JOIN's all-NULL row used to coalesce into a full bucket, inventing
    // a fleet of one for an agency with none.
    const empty = await signUp(db, {
      email: 'owner@empty-reports.test',
      fullName: 'Empty Owner',
      organizationName: 'Empty Motors',
      currency: 'EUR',
      timeZone: 'UTC',
    })

    const rows = await db.asUser(empty.userId, (session) =>
      session.sql<{ vehicle_days_available: string }>(
        `select * from public.report_utilisation_series($1, $2::date, $3::date, 'day')`,
        [empty.organizationId, FROM, TO],
      ),
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(Number(row.vehicle_days_available)).toBe(0)
    }
  })

  it('ranks top customers inside each currency, never across them', async () => {
    /*
     * A single `order by revenue desc limit N` compares euro cents against
     * dollar cents and truncates before the caller can scope the answer, so a
     * currency's panel could come back empty on a screen that had just reported
     * revenue in it.
     */
    const rows = await db.asUser(ownerA, (session) =>
      session.sql<{ currency: string; revenue_minor: number }>(
        `select * from public.report_customer_revenue($1, $2::date, $3::date, 1)`,
        [orgA, FROM, TO],
      ),
    )
    const currencies = new Set(rows.map((row) => row.currency))
    // A limit of one means one per currency, not one overall.
    expect(currencies.size).toBeGreaterThan(1)
    expect(rows).toHaveLength(currencies.size)
  })

  it('paginates balances inside one currency, so a page is never empty by accident', async () => {
    const usd = await db.asUser(ownerA, (session) =>
      session.sql<{ currency: string; total_rows: number }>(
        `select * from public.report_customer_balances($1, 'USD', 25, 0)`,
        [orgA],
      ),
    )
    for (const row of usd) expect(row.currency).toBe('USD')

    const eur = await db.asUser(ownerA, (session) =>
      session.sql<{ currency: string; total_rows: number }>(
        `select * from public.report_customer_balances($1, 'EUR', 25, 0)`,
        [orgA],
      ),
    )
    for (const row of eur) expect(row.currency).toBe('EUR')

    // Each currency's count describes its own population, not the union.
    if (usd.length > 0 && eur.length > 0) {
      expect(Number(usd[0]!.total_rows)).toBe(usd.length)
      expect(Number(eur[0]!.total_rows)).toBe(eur.length)
    }
  })

  it('has no cross-currency balances signature left to call by accident', async () => {
    const overloads = await db.sql<{ args: string }>(
      `select pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'report_customer_balances'`,
    )
    expect(overloads).toHaveLength(1)
    // Four arguments, the second of them the currency. The three-argument
    // cross-currency version must be gone rather than merely shadowed.
    expect(overloads[0]!.args.split(',')).toHaveLength(4)
    expect(overloads[0]!.args).not.toBe('uuid, integer, integer')
  })
})

// =============================================================================
// Shape and safety
// =============================================================================

describe('the report functions themselves', () => {
  it('are all security invoker, so row-level security decides what they see', async () => {
    const definers = await db.sql<{ proname: string }>(
      `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'report\\_%' and p.prosecdef`,
    )
    expect(definers).toHaveLength(0)
  })

  it('refuse an inverted period rather than returning nothing', async () => {
    await db.asUser(ownerA, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.report_business_summary($1, $2::date, $3::date)`, [
            orgA,
            '2032-08-01',
            '2032-07-01',
          ]),
        /must end after it starts/i,
      )
    })
  })

  it('refuse a granularity nobody defined', async () => {
    await db.asUser(ownerA, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `select * from public.report_financial_series($1, $2::date, $3::date, 'fortnight', 'EUR')`,
            [orgA, FROM, TO],
          ),
        /unsupported granularity/i,
      )
    })
  })

  it('zero-fill a quiet bucket, because no activity is a fact', async () => {
    const rows = await db.asUser(ownerA, (session) =>
      session.sql<{ bucket_start: string; rental_revenue_minor: number }>(
        `select * from public.report_financial_series($1, $2::date, $3::date, 'day', 'EUR')`,
        [orgA, FROM, TO],
      ),
    )
    expect(rows).toHaveLength(31)
    // The first of July saw no money; that is a real zero, not a gap.
    expect(Number(rows[0]!.rental_revenue_minor)).toBe(0)
    expect(rows.some((row) => Number(row.rental_revenue_minor) !== 0)).toBe(true)
  })

  it('never invent a bucket outside the window', async () => {
    const rows = await db.asUser(ownerA, (session) =>
      session.sql<{ bucket_start: string }>(
        `select * from public.report_financial_series($1, $2::date, $3::date, 'month', 'EUR')`,
        [orgA, FROM, TO],
      ),
    )
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0]!.bucket_start).toISOString()).toContain('2032-07-01')
  })
})
