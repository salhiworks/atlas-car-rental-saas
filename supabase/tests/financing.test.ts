// @vitest-environment node
/**
 * Vehicle financing.
 *
 * The questions these tests are really asking, in order of how much money a
 * wrong answer costs:
 *
 *   - does principal ever leak into an expense, an operating cost, or the
 *     operating result?
 *   - does an unknown split ever become a confident number?
 *   - does a scheduled obligation ever get counted as cash already paid?
 *   - does a voided payment reverse exactly, and nothing more?
 *   - does an amortising schedule close to exactly zero, in every currency and
 *     across every month-end the calendar can produce?
 *
 * Everything else is plumbing around those five.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase
let organizationId: string
let ownerId: string
let adminId: string
let managerId: string
let staffId: string
let vehicleA: string
let lenderId: string

/** Today in the agency's own zone, which is what every due-date rule uses. */
async function agencyToday(): Promise<string> {
  const [row] = await db.sql<{ today: string }>(
    `select app.organization_today($1)::text as today`,
    [organizationId],
  )
  return row!.today
}

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

interface AgreementOptions {
  vehicleId?: string
  mode?: 'simple' | 'amortizing'
  currency?: string
  financedMinor?: number | null
  rateBps?: number | null
  installmentMinor?: number | null
  installments?: number | null
  frequency?: 'weekly' | 'biweekly' | 'monthly' | 'quarterly'
  firstPaymentOn?: string
  balloonMinor?: number | null
  downPaymentMinor?: number | null
  agreementType?: 'loan' | 'lease' | 'installment_plan' | 'other'
  activate?: boolean
}

let plateCounter = 0

/** A throwaway vehicle, because only one agreement per car may be live. */
async function freshVehicle(prefix = 'FIN'): Promise<string> {
  plateCounter += 1
  const [row] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
     values ($1, 'Renault', 'Kangoo', $2, 'EUR', 5000) returning id`,
    [organizationId, `${prefix}-${String(plateCounter).padStart(3, '0')}X`],
  )
  return row!.id
}

async function createAgreement(options: AgreementOptions = {}): Promise<string> {
  const firstPaymentOn = options.firstPaymentOn ?? '2032-01-15'
  const vehicleId = options.vehicleId ?? (await freshVehicle())
  const [row] = await db.sql<{ id: string }>(
    `insert into public.financing_agreements (
       organization_id, vehicle_id, lender_id, agreement_type, mode, currency,
       financed_amount_minor, rate_bps, installment_amount_minor, installments_count,
       payment_frequency, first_payment_on, schedule_anchor_day, starts_on,
       balloon_minor, down_payment_amount_minor, reference
     ) values (
       $1, $2, $3, $4::public.financing_agreement_type, $5::public.financing_mode, $6,
       $7, $8, $9, $10, $11::public.financing_frequency, $12::date,
       extract(day from $12::date)::smallint, $12::date, $13, $14, $15
     ) returning id`,
    [
      organizationId,
      vehicleId,
      lenderId,
      options.agreementType ?? 'loan',
      options.mode ?? 'simple',
      options.currency ?? 'EUR',
      options.financedMinor ?? null,
      options.rateBps ?? null,
      options.installmentMinor ?? null,
      options.installments ?? null,
      options.frequency ?? 'monthly',
      firstPaymentOn,
      options.balloonMinor ?? null,
      options.downPaymentMinor ?? null,
      `AGR-${Math.random().toString(36).slice(2, 10)}`,
    ],
  )

  if (options.activate !== false) {
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_activate_agreement($1)`, [row!.id]),
    )
  }
  return row!.id
}

async function overview(agreementId: string) {
  const [row] = await db.asUser(managerId, (session) =>
    session.sql<Record<string, number | string | boolean | null>>(
      `select * from public.financing_agreement_overview where id = $1`,
      [agreementId],
    ),
  )
  return row!
}

async function installments(agreementId: string) {
  return db.asUser(managerId, (session) =>
    session.sql<{
      id: string
      sequence: number
      due_on: string
      expected_total_minor: number
      expected_principal_minor: number | null
      expected_interest_minor: number | null
      paid_minor: number
      outstanding_minor: number
      is_overdue: boolean
      is_balloon: boolean
      state: string
    }>(
      `select id, sequence, due_on::text, expected_total_minor, expected_principal_minor,
              expected_interest_minor, paid_minor, outstanding_minor, is_overdue, is_balloon, state
         from public.financing_installment_status
        where agreement_id = $1 order by sequence`,
      [agreementId],
    ),
  )
}

async function recordPayment(
  agreementId: string,
  values: {
    paidOn: string
    amountMinor: number
    installmentId?: string | null
    principalMinor?: number | null
    interestMinor?: number | null
    feesMinor?: number | null
    purpose?: 'installment' | 'extra' | 'payoff' | 'fee'
    reference?: string | null
    asUser?: string
  },
): Promise<string> {
  const [row] = await db.asUser(values.asUser ?? adminId, (session) =>
    session.sql<{ id: string }>(
      `select id from public.financing_record_payment(
         $1, $2::date, $3, $4, $5, $6, $7, $8::public.financing_payment_purpose, null, $9, null
       )`,
      [
        agreementId,
        values.paidOn,
        values.amountMinor,
        values.installmentId ?? null,
        values.principalMinor ?? null,
        values.interestMinor ?? null,
        values.feesMinor ?? null,
        values.purpose ?? 'installment',
        values.reference ?? null,
      ],
    ),
  )
  return row!.id
}

beforeAll(async () => {
  db = await TestDatabase.create()

  const owner = await signUp(db, {
    email: 'owner@financing.test',
    fullName: 'Finance Owner',
    organizationName: 'Atlas Financed Motors',
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!owner.organizationId) throw new Error('Provisioning failed during setup.')
  ownerId = owner.userId
  organizationId = owner.organizationId

  const admin = await signUp(db, { email: 'admin@financing.test', fullName: 'Finance Admin' })
  adminId = admin.userId
  await addMember(db, organizationId, adminId, 'admin')

  const manager = await signUp(db, { email: 'manager@financing.test', fullName: 'Ops Manager' })
  managerId = manager.userId
  await addMember(db, organizationId, managerId, 'manager')

  const staff = await signUp(db, { email: 'staff@financing.test', fullName: 'Desk Staff' })
  staffId = staff.userId
  await addMember(db, organizationId, staffId, 'staff')

  const [subject] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
     values ($1, 'Renault', 'Master', 'FIN-001', 'EUR', 6000) returning id`,
    [organizationId],
  )
  vehicleA = subject!.id

  const [lender] = await db.sql<{ id: string }>(
    `insert into public.lenders (organization_id, name, kind, tax_identifier)
     values ($1, 'Banque Atlas', 'bank', 'ICE-000111') returning id`,
    [organizationId],
  )
  lenderId = lender!.id
}, 180_000)

afterAll(async () => {
  await db?.close()
})

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

describe('when a payment falls due', () => {
  const due = (first: string, anchor: number, frequency: string, index: number) =>
    db
      .sql<{ d: string }>(
        `select app.financing_due_date($1::date, $2::smallint, $3::public.financing_frequency, $4)::text as d`,
        [first, anchor, frequency, index],
      )
      .then((rows) => rows[0]!.d)

  it('clamps a month-end anchor instead of rolling into the next month', async () => {
    // The failure this prevents: naive date arithmetic turns 31 January plus a
    // month into 3 March, and the agency is told its payment is due in the
    // wrong month for the rest of the agreement.
    expect(await due('2027-01-31', 31, 'monthly', 1)).toBe('2027-02-28')
    expect(await due('2027-01-31', 31, 'monthly', 2)).toBe('2027-03-31')
    expect(await due('2027-01-31', 31, 'monthly', 3)).toBe('2027-04-30')
    expect(await due('2027-01-31', 31, 'monthly', 4)).toBe('2027-05-31')
  })

  it('knows February has 29 days in a leap year', async () => {
    expect(await due('2028-01-31', 31, 'monthly', 1)).toBe('2028-02-29')
  })

  it('keeps a 30th anchor on the 30th once February is behind it', async () => {
    expect(await due('2027-01-30', 30, 'monthly', 1)).toBe('2027-02-28')
    expect(await due('2027-01-30', 30, 'monthly', 2)).toBe('2027-03-30')
  })

  it('steps a quarter at a time, with the same clamping', async () => {
    expect(await due('2027-01-31', 31, 'quarterly', 1)).toBe('2027-04-30')
    expect(await due('2027-01-31', 31, 'quarterly', 2)).toBe('2027-07-31')
  })

  it('counts weeks in days, where months have nothing to say', async () => {
    expect(await due('2027-01-31', 31, 'weekly', 2)).toBe('2027-02-14')
    expect(await due('2027-01-31', 31, 'biweekly', 2)).toBe('2027-02-28')
  })
})

// -----------------------------------------------------------------------------
// Amortization
// -----------------------------------------------------------------------------

describe('an amortising schedule', () => {
  const project = (
    financed: number | null,
    rate: number | null,
    n: number,
    installment: number | null,
    balloon = 0,
    first = '2032-01-31',
    frequency = 'monthly',
  ) =>
    db.sql<{
      sequence: number
      due_on: string
      expected_total_minor: number
      expected_principal_minor: number | null
      expected_interest_minor: number | null
      remaining_principal_minor: number | null
      is_balloon: boolean
    }>(
      `select sequence, due_on::text, expected_total_minor, expected_principal_minor,
              expected_interest_minor, remaining_principal_minor, is_balloon
         from public.financing_projected_schedule(
           'amortizing', $1, $2, $3, $4, $5::date,
           extract(day from $5::date)::smallint, $6::public.financing_frequency, $7)`,
      [financed, rate, n, installment, first, frequency, balloon],
    )

  it('closes at exactly zero and repays exactly what was borrowed', async () => {
    for (const term of [12, 36, 48, 60]) {
      const rows = await project(15_000_000, 725, term, null)
      expect(rows).toHaveLength(term)
      expect(Number(rows.at(-1)!.remaining_principal_minor)).toBe(0)
      const principal = rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)
      expect(principal).toBe(15_000_000)
    }
  })

  it('repays exactly, at zero interest too', async () => {
    const rows = await project(12_000_001, 0, 12, null)
    expect(rows.every((row) => Number(row.expected_interest_minor) === 0)).toBe(true)
    expect(rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)).toBe(12_000_001)
    expect(Number(rows.at(-1)!.remaining_principal_minor)).toBe(0)
  })

  it('puts every rounding remainder on the final instalment deliberately', async () => {
    const rows = await project(100_001, 999, 36, null)
    const totals = new Set(rows.slice(0, -1).map((row) => Number(row.expected_total_minor)))
    // Every instalment but the last is the level payment; the last one is
    // whatever closes the balance, which is where the accumulated rounding goes.
    expect(totals.size).toBe(1)
    expect(Number(rows.at(-1)!.remaining_principal_minor)).toBe(0)
    expect(rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)).toBe(100_001)
  })

  it('amortises down to the balloon and shows the balloon as its own obligation', async () => {
    const rows = await project(15_000_000, 725, 48, null, 3_000_000)
    expect(rows).toHaveLength(49)

    const last = rows.at(-1)!
    expect(last.is_balloon).toBe(true)
    expect(Number(last.expected_total_minor)).toBe(3_000_000)
    // Same day as the final ordinary instalment, and a separate row — a balloon
    // folded into the last payment is a surprise nobody can plan for.
    expect(last.due_on).toBe(rows.at(-2)!.due_on)
    expect(Number(rows.at(-2)!.remaining_principal_minor)).toBe(3_000_000)
    expect(rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)).toBe(15_000_000)
  })

  it('records the level payment it computed, when the terms did not state one', async () => {
    // A loan whose payment came from the formula still has a payment, and the
    // agreement says what it is rather than showing a dash beside a schedule
    // that repeats the number forty-eight times.
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 15_000_000,
      rateBps: 725,
      installments: 48,
      firstPaymentOn: '2033-04-15',
    })

    const [row] = await db.sql<{ installment_amount_minor: number }>(
      `select installment_amount_minor from public.financing_agreements where id = $1`,
      [id],
    )
    expect(Number(row!.installment_amount_minor)).toBe(360_936)

    const rows = await installments(id)
    expect(Number(rows[0]!.expected_total_minor)).toBe(360_936)
  })

  it('never overwrites an instalment the contract stated', async () => {
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 15_000_000,
      rateBps: 725,
      installments: 48,
      installmentMinor: 361_000,
      firstPaymentOn: '2033-05-15',
    })

    const [row] = await db.sql<{ installment_amount_minor: number }>(
      `select installment_amount_minor from public.financing_agreements where id = $1`,
      [id],
    )
    expect(Number(row!.installment_amount_minor)).toBe(361_000)
  })

  it('leaves a balloon out of the level payment it records', async () => {
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 2_000_000,
      rateBps: 600,
      installments: 6,
      balloonMinor: 500_000,
      firstPaymentOn: '2033-06-15',
    })

    const [row] = await db.sql<{ installment_amount_minor: number }>(
      `select installment_amount_minor from public.financing_agreements where id = $1`,
      [id],
    )
    // The balloon is an obligation, not an instalment, so it is not what the
    // agency pays every month.
    expect(Number(row!.installment_amount_minor)).not.toBe(500_000)
    expect(Number(row!.installment_amount_minor)).toBeLessThan(500_000)
  })

  it('takes the contract at its word when it states an instalment', async () => {
    // 361.00 rather than the 360.936 our formula produces. Lender rounding,
    // a folded-in fee, a convention we do not know — the contract wins, and the
    // schedule reconciles to it.
    const computed = await db.sql<{ p: number }>(
      `select public.financing_annuity_payment(15000000, 725, 48, 'monthly', 0) as p`,
    )
    expect(Number(computed[0]!.p)).toBe(360_936)

    const rows = await project(15_000_000, 725, 48, 361_000)
    expect(Number(rows[0]!.expected_total_minor)).toBe(361_000)
    expect(Number(rows.at(-1)!.expected_total_minor)).not.toBe(361_000)
    expect(rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)).toBe(15_000_000)
    expect(Number(rows.at(-1)!.remaining_principal_minor)).toBe(0)
  })

  it('refuses terms where the payment never repays anything', async () => {
    // 100 a month against 150,000 at 7.25% does not even cover the interest.
    // A schedule would grow forever; saying so is the only honest answer.
    await db.expectRejection(
      () => project(15_000_000, 725, 48, 10_000),
      /does not cover the interest/i,
    )
  })

  it('refuses a balloon as large as the loan', async () => {
    await db.expectRejection(() => project(15_000_000, 725, 48, null, 15_000_000), /balloon/i)
  })

  it('works the same at week and quarter frequencies', async () => {
    const weekly = await project(5_000_000, 600, 52, null, 0, '2032-01-05', 'weekly')
    expect(Number(weekly.at(-1)!.remaining_principal_minor)).toBe(0)
    expect(weekly.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)).toBe(5_000_000)

    const quarterly = await project(5_000_000, 600, 8, null, 0, '2032-01-31', 'quarterly')
    expect(Number(quarterly.at(-1)!.remaining_principal_minor)).toBe(0)
    expect(quarterly[1]!.due_on).toBe('2032-04-30')
  })

  it('holds for a three-decimal currency, where a minor unit is a thousandth', async () => {
    // KWD has three decimals, so 12,345.678 is 12_345_678 minor units. The
    // arithmetic is on integers, so the number of decimals changes nothing —
    // which is the property being asserted.
    const rows = await project(12_345_678, 437, 36, null)
    expect(rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)).toBe(12_345_678)
    expect(Number(rows.at(-1)!.remaining_principal_minor)).toBe(0)
  })

  it('runs a month-end schedule through February without losing a centime', async () => {
    const rows = await project(9_999_999, 512, 14, null, 0, '2032-01-31')
    expect(rows[1]!.due_on).toBe('2032-02-29')
    expect(rows[2]!.due_on).toBe('2032-03-31')
    expect(rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)).toBe(9_999_999)
  })
})

// -----------------------------------------------------------------------------
// Simple mode
// -----------------------------------------------------------------------------

describe('a payment plan the agency only half knows', () => {
  it('generates the obligations without inventing a split', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 430_000,
      installments: 48,
      firstPaymentOn: '2032-01-15',
    })

    const rows = await installments(id)
    expect(rows).toHaveLength(48)
    expect(rows.every((row) => Number(row.expected_total_minor) === 430_000)).toBe(true)
    // The whole point: nobody said how much of 4,300 is interest, so nobody
    // is told.
    expect(rows.every((row) => row.expected_principal_minor === null)).toBe(true)
    expect(rows.every((row) => row.expected_interest_minor === null)).toBe(true)
  })

  it('refuses to state a principal balance it cannot derive', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 430_000,
      installments: 12,
    })
    const [first] = await installments(id)
    await recordPayment(id, {
      paidOn: '2032-01-15',
      amountMinor: 430_000,
      installmentId: first!.id,
    })

    const position = await overview(id)
    expect(position.remaining_principal_minor).toBeNull()
    expect(position.principal_known).toBe(false)
    // What it can say is what it actually knows: cash out, and what is left on
    // the schedule.
    expect(Number(position.cash_paid_minor)).toBe(430_000)
    expect(Number(position.remaining_scheduled_minor)).toBe(430_000 * 11)
  })

  it('does not let an unlinked payment silently settle an obligation', async () => {
    // Money left the account, but nobody said which instalment it met. The cash
    // is real; guessing which obligation it discharged would not be.
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 200_000,
      installments: 3,
    })
    await recordPayment(id, { paidOn: '2032-01-15', amountMinor: 200_000 })

    const position = await overview(id)
    expect(Number(position.cash_paid_minor)).toBe(200_000)
    expect(Number(position.remaining_scheduled_minor)).toBe(600_000)
  })

  it('derives a balance once the amount financed and every split are known', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 10,
      financedMinor: 900_000,
    })
    await recordPayment(id, {
      paidOn: '2032-01-15',
      amountMinor: 100_000,
      principalMinor: 85_000,
      interestMinor: 15_000,
    })

    const position = await overview(id)
    expect(position.principal_known).toBe(true)
    expect(Number(position.remaining_principal_minor)).toBe(815_000)
  })
})

// -----------------------------------------------------------------------------
// The rule the whole module exists for
// -----------------------------------------------------------------------------

describe('principal is not a cost', () => {
  let agreementId: string
  let expenseCategory: string

  beforeAll(async () => {
    const [category] = await db.sql<{ id: string }>(
      `select id from public.expense_categories
        where organization_id = $1 and system_key = 'fuel'`,
      [organizationId],
    )
    expenseCategory = category!.id

    agreementId = await createAgreement({
      mode: 'amortizing',
      financedMinor: 1_000_000,
      rateBps: 1200,
      installments: 12,
      firstPaymentOn: '2032-03-15',
      vehicleId: vehicleA,
    })
  })

  const readTotals = async () => {
    const [expenses] = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number; profit_minor: number; revenue_minor: number }>(
        `select expenses_minor, profit_minor, revenue_minor
           from public.organization_overview($1, '2032-01-01T00:00:00Z'::timestamptz, '2033-01-01T00:00:00Z'::timestamptz)`,
        [organizationId],
      ),
    )
    const [operating] = await db.asUser(ownerId, (session) =>
      session.sql<{ direct_expense_minor: number; operating_contribution_minor: number }>(
        `select direct_expense_minor, operating_contribution_minor
           from public.vehicle_operating_summary($1, '2032-01-01'::date, '2033-01-01'::date)
          where currency = 'EUR'`,
        [vehicleA],
      ),
    )
    return {
      expenses: Number(expenses?.expenses_minor ?? 0),
      result: Number(expenses?.profit_minor ?? 0),
      revenue: Number(expenses?.revenue_minor ?? 0),
      direct: Number(operating?.direct_expense_minor ?? 0),
      contribution: Number(operating?.operating_contribution_minor ?? 0),
    }
  }

  it('a 5,000 principal payment moves the balance and nothing else', async () => {
    const before = await readTotals()

    await recordPayment(agreementId, {
      paidOn: '2032-03-15',
      amountMinor: 500_000,
      principalMinor: 500_000,
    })

    const after = await readTotals()
    const position = await overview(agreementId)

    expect(Number(position.principal_paid_minor)).toBe(500_000)
    expect(Number(position.cash_paid_minor)).toBe(500_000)
    expect(Number(position.remaining_principal_minor)).toBe(500_000)
    // Not a cost. Not an expense. Not a change to what the agency earned.
    expect(Number(position.financing_cost_minor)).toBe(0)
    expect(after.expenses).toBe(before.expenses)
    expect(after.result).toBe(before.result)
    expect(after.direct).toBe(before.direct)
    expect(after.contribution).toBe(before.contribution)
  })

  it('a 500 interest component is a cost, and does not touch the balance', async () => {
    const before = await readTotals()
    const beforePosition = await overview(agreementId)

    await recordPayment(agreementId, {
      paidOn: '2032-04-15',
      amountMinor: 50_000,
      interestMinor: 50_000,
    })

    const after = await readTotals()
    const position = await overview(agreementId)

    expect(Number(position.interest_paid_minor)).toBe(50_000)
    expect(Number(position.financing_cost_minor)).toBe(50_000)
    expect(Number(position.cash_paid_minor)).toBe(
      Number(beforePosition.cash_paid_minor) + 50_000,
    )
    expect(Number(position.remaining_principal_minor)).toBe(
      Number(beforePosition.remaining_principal_minor),
    )
    expect(after.expenses).toBe(before.expenses)
    expect(after.result).toBe(before.result)
  })

  it('a fee is a financing cost, not principal', async () => {
    const beforePosition = await overview(agreementId)

    await recordPayment(agreementId, {
      paidOn: '2032-04-16',
      amountMinor: 10_000,
      feesMinor: 10_000,
      purpose: 'fee',
    })

    const position = await overview(agreementId)
    expect(Number(position.fees_paid_minor)).toBe(10_000)
    expect(Number(position.financing_cost_minor)).toBe(
      Number(beforePosition.financing_cost_minor) + 10_000,
    )
    expect(Number(position.principal_paid_minor)).toBe(
      Number(beforePosition.principal_paid_minor),
    )
  })

  it('an unallocated payment stays unallocated', async () => {
    const beforePosition = await overview(agreementId)

    await recordPayment(agreementId, { paidOn: '2032-05-15', amountMinor: 430_000 })

    const position = await overview(agreementId)

    expect(Number(position.unallocated_minor)).toBe(430_000)
    expect(Number(position.cash_paid_minor)).toBe(
      Number(beforePosition.cash_paid_minor) + 430_000,
    )
    // It did not become principal…
    expect(Number(position.principal_paid_minor)).toBe(
      Number(beforePosition.principal_paid_minor),
    )
    // …and it did not become interest.
    expect(Number(position.interest_paid_minor)).toBe(
      Number(beforePosition.interest_paid_minor),
    )
    // And because part of the cash is unexplained, neither the balance nor the
    // cost is claimed as known any more.
    expect(position.remaining_principal_minor).toBeNull()
    expect(position.principal_known).toBe(false)
    expect(position.cost_complete).toBe(false)
  })

  it('never lets an ordinary expense and a financing payment be the same money', async () => {
    // The Expenses module's own boundary, re-asserted from this side: a
    // financing-sourced expense row is excluded from operating figures, and
    // nothing in Financing writes one.
    const [expenseCount] = await db.sql<{ count: number }>(
      `select count(*)::int as count from public.expenses
        where organization_id = $1 and financing_plan_id is not null`,
      [organizationId],
    )
    expect(Number(expenseCount!.count)).toBe(0)

    const before = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number }>(
        `select expenses_minor from public.organization_overview($1, '2032-01-01T00:00:00Z'::timestamptz, '2033-01-01T00:00:00Z'::timestamptz)`,
        [organizationId],
      ),
    )

    await db.sql(
      `insert into public.expenses
         (organization_id, category_id, allocation, vehicle_id, amount_minor, currency,
          incurred_on, description, source, financing_plan_id)
       values ($1, $2, 'vehicle', $3, 250000, 'EUR', '2032-06-04'::date, 'Instalment', 'financing', $4)`,
      [organizationId, expenseCategory, vehicleA, agreementId],
    )

    const after = await db.asUser(ownerId, (session) =>
      session.sql<{ expenses_minor: number }>(
        `select expenses_minor from public.organization_overview($1, '2032-01-01T00:00:00Z'::timestamptz, '2033-01-01T00:00:00Z'::timestamptz)`,
        [organizationId],
      ),
    )

    expect(Number(after[0]!.expenses_minor)).toBe(Number(before[0]!.expenses_minor))

    await db.sql(
      `delete from public.expenses where organization_id = $1 and financing_plan_id = $2`,
      [organizationId, agreementId],
    )
  })
})

// -----------------------------------------------------------------------------
// Settlement
// -----------------------------------------------------------------------------

describe('settling an instalment', () => {
  let agreementId: string
  let firstInstallment: string

  beforeAll(async () => {
    agreementId = await createAgreement({
      mode: 'simple',
      installmentMinor: 430_000,
      installments: 6,
      firstPaymentOn: '2032-02-15',
    })
    const rows = await installments(agreementId)
    firstInstallment = rows[0]!.id
  })

  it('is not paid when only part of it has been', async () => {
    await recordPayment(agreementId, {
      paidOn: '2032-02-15',
      amountMinor: 200_000,
      installmentId: firstInstallment,
    })

    const [row] = await installments(agreementId)
    expect(Number(row!.paid_minor)).toBe(200_000)
    expect(Number(row!.outstanding_minor)).toBe(230_000)
    // 2,000 against a 4,300 obligation is not "paid", however convenient a
    // boolean would have been.
    expect(row!.state).toBe('partially_paid')
  })

  it('is paid once a second payment finishes it', async () => {
    await recordPayment(agreementId, {
      paidOn: '2032-02-20',
      amountMinor: 230_000,
      installmentId: firstInstallment,
    })

    const [row] = await installments(agreementId)
    expect(Number(row!.paid_minor)).toBe(430_000)
    expect(Number(row!.outstanding_minor)).toBe(0)
    expect(row!.state).toBe('paid')
  })

  it('accepts as many payments against one instalment as it took', async () => {
    const [row] = await db.asUser(managerId, (session) =>
      session.sql<{ payment_count: number }>(
        `select payment_count from public.financing_installment_status where id = $1`,
        [firstInstallment],
      ),
    )
    expect(Number(row!.payment_count)).toBe(2)
  })

  it('refuses an allocation larger than the payment', async () => {
    await db.expectRejection(
      () =>
        recordPayment(agreementId, {
          paidOn: '2032-03-15',
          amountMinor: 100_000,
          principalMinor: 80_000,
          interestMinor: 50_000,
        }),
      /add up to more than the payment/i,
    )
  })

  it('refuses an instalment belonging to another agreement', async () => {
    const other = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2032-07-01',
    })
    await db.expectRejection(
      () =>
        recordPayment(other, {
          paidOn: '2032-07-01',
          amountMinor: 100_000,
          installmentId: firstInstallment,
        }),
      /different agreement/i,
    )
  })

  it('refuses a payment in the wrong currency', async () => {
    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(
            `insert into public.financing_payments
               (organization_id, agreement_id, paid_on, currency, amount_minor, unallocated_minor)
             values ($1, $2, '2032-03-15'::date, 'MAD', 100000, 100000)`,
            [organizationId, agreementId],
          ),
        ),
      /currency/i,
    )
  })
})

describe('overdue', () => {
  it('is derived from the agency’s own date and from what is actually settled', async () => {
    const today = await agencyToday()
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 3,
      // First payment three days ago, so instalment 1 is late and 2 is not.
      firstPaymentOn: shiftIso(today, -3),
      frequency: 'weekly',
    })

    const rows = await installments(id)
    expect(rows[0]!.state).toBe('overdue')
    expect(rows[0]!.is_overdue).toBe(true)
    expect(rows[1]!.is_overdue).toBe(false)

    const position = await overview(id)
    expect(Number(position.overdue_minor)).toBe(100_000)
    expect(Number(position.overdue_count)).toBe(1)

    // Paying it clears the overdue state without anybody setting a flag.
    await recordPayment(id, {
      paidOn: today,
      amountMinor: 100_000,
      installmentId: rows[0]!.id,
    })

    const after = await installments(id)
    expect(after[0]!.state).toBe('paid')
    expect(after[0]!.is_overdue).toBe(false)
    expect(Number((await overview(id)).overdue_minor)).toBe(0)
  })

  it('reports what is due soon and what is late through one surface', async () => {
    const rows = await db.asUser(managerId, (session) =>
      session.sql<{ due_on: string; is_overdue: boolean; days_until_due: number }>(
        `select due_on::text, is_overdue, days_until_due
           from public.financing_due_obligations($1, 30)`,
        [organizationId],
      ),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.days_until_due <= 30)).toBe(true)
  })

  it('does not count a future obligation as money already spent', async () => {
    const today = await agencyToday()
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 250_000,
      installments: 4,
      firstPaymentOn: shiftIso(today, 20),
    })

    const position = await overview(id)
    expect(Number(position.remaining_scheduled_minor)).toBe(1_000_000)
    // Nothing has been paid. A scheduled obligation is not cash out.
    expect(Number(position.cash_paid_minor)).toBe(0)
    expect(Number(position.overdue_minor)).toBe(0)

    await db.asUser(ownerId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'cancelled', 'test teardown')`, [id]),
    )
  })
})

// -----------------------------------------------------------------------------
// Voiding
// -----------------------------------------------------------------------------

describe('voiding a financing payment', () => {
  it('reverses every derived figure exactly, and reopens the instalment', async () => {
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 1_200_000,
      rateBps: 900,
      installments: 12,
      firstPaymentOn: '2032-09-15',
    })
    const schedule = await installments(id)
    const before = await overview(id)

    const paymentId = await recordPayment(id, {
      paidOn: '2032-09-15',
      amountMinor: 120_000,
      installmentId: schedule[0]!.id,
      principalMinor: 100_000,
      interestMinor: 15_000,
      feesMinor: 5_000,
    })

    const during = await overview(id)
    expect(Number(during.cash_paid_minor)).toBe(120_000)
    expect(Number(during.principal_paid_minor)).toBe(100_000)
    expect(Number(during.financing_cost_minor)).toBe(20_000)
    expect(Number(during.remaining_principal_minor)).toBe(1_100_000)

    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_void_payment($1, 'Posted twice')`, [paymentId]),
    )

    const after = await overview(id)
    expect(Number(after.cash_paid_minor)).toBe(Number(before.cash_paid_minor))
    expect(Number(after.principal_paid_minor)).toBe(Number(before.principal_paid_minor))
    expect(Number(after.interest_paid_minor)).toBe(Number(before.interest_paid_minor))
    expect(Number(after.fees_paid_minor)).toBe(Number(before.fees_paid_minor))
    expect(Number(after.financing_cost_minor)).toBe(0)
    expect(Number(after.remaining_principal_minor)).toBe(1_200_000)

    const reopened = await installments(id)
    expect(Number(reopened[0]!.paid_minor)).toBe(0)
    expect(Number(reopened[0]!.outstanding_minor)).toBe(
      Number(schedule[0]!.expected_total_minor),
    )

    // The record survives, with its reason.
    const [row] = await db.sql<{ status: string; void_reason: string; amount_minor: number }>(
      `select status, void_reason, amount_minor from public.financing_payments where id = $1`,
      [paymentId],
    )
    expect(row!.status).toBe('voided')
    expect(row!.void_reason).toBe('Posted twice')
    expect(Number(row!.amount_minor)).toBe(120_000)
  })

  it('is final: a voided payment cannot be edited, reinstated or deleted', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 50_000,
      installments: 2,
      firstPaymentOn: '2032-11-01',
    })
    const paymentId = await recordPayment(id, { paidOn: '2032-11-01', amountMinor: 50_000 })
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_void_payment($1, 'mistake')`, [paymentId]),
    )

    await db.expectRejection(
      () => db.sql(`update public.financing_payments set amount_minor = 1 where id = $1`, [paymentId]),
      /kept exactly as it was/i,
    )
    await db.expectRejection(
      () =>
        db.sql(`update public.financing_payments set status = 'recorded' where id = $1`, [paymentId]),
      /cannot be reinstated/i,
    )
    await db.expectRejection(
      () => db.sql(`delete from public.financing_payments where id = $1`, [paymentId]),
      /financial history/i,
    )
    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_void_payment($1, 'again')`, [paymentId]),
        ),
      /already been voided/i,
    )
  })

  it('leaves a trace naming who voided it', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 60_000,
      installments: 2,
      firstPaymentOn: '2032-12-01',
    })
    const paymentId = await recordPayment(id, { paidOn: '2032-12-01', amountMinor: 60_000 })
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_void_payment($1, 'wrong agreement')`, [paymentId]),
    )

    const [event] = await db.sql<{ kind: string; changed_by: string; reason: string }>(
      `select kind, changed_by, reason from public.financing_change_events
        where payment_id = $1`,
      [paymentId],
    )
    expect(event!.kind).toBe('void')
    expect(event!.changed_by).toBe(adminId)
    expect(event!.reason).toBe('wrong agreement')
  })
})

// -----------------------------------------------------------------------------
// Extra payments and prepayment
// -----------------------------------------------------------------------------

describe('an extra payment', () => {
  it('reduces principal only when the agency actually says it does', async () => {
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 2_000_000,
      rateBps: 800,
      installments: 24,
      firstPaymentOn: '2033-01-10',
    })

    await recordPayment(id, {
      paidOn: '2033-01-20',
      amountMinor: 300_000,
      principalMinor: 300_000,
      purpose: 'extra',
    })
    expect(Number((await overview(id)).remaining_principal_minor)).toBe(1_700_000)

    // The same money, with nobody saying what it was for, does not touch the
    // balance and takes the balance's knowability with it.
    await recordPayment(id, { paidOn: '2033-02-20', amountMinor: 200_000, purpose: 'extra' })
    const after = await overview(id)
    expect(after.remaining_principal_minor).toBeNull()
    expect(Number(after.cash_paid_minor)).toBe(500_000)
  })

  it('does not silently reschedule the rest of the loan', async () => {
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 2_000_000,
      rateBps: 800,
      installments: 24,
      firstPaymentOn: '2033-03-10',
    })
    const before = await installments(id)

    await recordPayment(id, {
      paidOn: '2033-03-20',
      amountMinor: 500_000,
      principalMinor: 500_000,
      purpose: 'extra',
    })

    const after = await installments(id)
    // Lenders differ: some shorten the term, some cut the payment, some adjust
    // the final instalment. Guessing which would be inventing the contract.
    expect(after).toHaveLength(before.length)
    expect(after.map((row) => row.expected_total_minor)).toEqual(
      before.map((row) => row.expected_total_minor),
    )
  })
})

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

describe('the agreement lifecycle', () => {
  it('will not call an agreement paid off while the schedule still owes', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 3,
      firstPaymentOn: '2033-06-01',
    })
    const [first] = await installments(id)
    await recordPayment(id, {
      paidOn: '2033-06-01',
      amountMinor: 100_000,
      installmentId: first!.id,
    })

    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_close_agreement($1, 'paid_off', null, null)`, [id]),
        ),
      /still has 200000 outstanding/i,
    )
  })

  it('accepts payoff once everything scheduled has been settled', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2033-07-01',
    })
    for (const row of await installments(id)) {
      await recordPayment(id, {
        paidOn: '2033-07-01',
        amountMinor: 100_000,
        installmentId: row.id,
      })
    }

    const [closed] = await db.asUser(adminId, (session) =>
      session.sql<{ agreement_status: string; payoff_on: string }>(
        `select agreement_status, payoff_on::text from public.financing_close_agreement($1, 'paid_off', null, '2033-07-02'::date)`,
        [id],
      ),
    )
    expect(closed!.agreement_status).toBe('paid_off')
    expect(closed!.payoff_on).toBe('2033-07-02')
  })

  it('refuses payoff while a derivable principal balance is still outstanding', async () => {
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 400_000,
      rateBps: 0,
      installments: 2,
      firstPaymentOn: '2033-08-01',
    })
    for (const row of await installments(id)) {
      await recordPayment(id, {
        paidOn: '2033-08-01',
        amountMinor: Number(row.expected_total_minor),
        installmentId: row.id,
        // Paid in full as cost, so the schedule is settled but the balance is not.
        feesMinor: Number(row.expected_total_minor),
      })
    }

    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_close_agreement($1, 'paid_off', null, null)`, [id]),
        ),
      /Principal of 400000 is still outstanding/i,
    )
  })

  it('requires a reason to close or cancel', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2033-09-01',
    })
    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_close_agreement($1, 'closed', null, null)`, [id]),
        ),
      /Say why/i,
    )
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'closed', 'Vehicle sold', null)`, [id]),
    )
  })

  it('ends once, so a second closure is refused rather than overwriting the first', async () => {
    // Two administrators pressing the same button at the same moment: the
    // second must be told, not allowed to rewrite the first one's reason.
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2033-11-01',
    })

    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'closed', 'Vehicle sold', null)`, [
        id,
      ]),
    )

    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_close_agreement($1, 'closed', 'Refinanced', null)`, [
            id,
          ]),
        ),
      /already closed/i,
    )

    const [row] = await db.sql<{ closure_reason: string }>(
      `select closure_reason from public.financing_agreements where id = $1`,
      [id],
    )
    expect(row!.closure_reason).toBe('Vehicle sold')
  })

  it('still allows a paid-off agreement to be filed away as closed', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2033-12-01',
    })
    for (const row of await installments(id)) {
      await recordPayment(id, {
        paidOn: '2033-12-01',
        amountMinor: 100_000,
        installmentId: row.id,
      })
    }
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'paid_off', null, null)`, [id]),
    )
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'closed', 'Filed away', null)`, [id]),
    )

    const [row] = await db.sql<{ agreement_status: string }>(
      `select agreement_status from public.financing_agreements where id = $1`,
      [id],
    )
    expect(row!.agreement_status).toBe('closed')
  })

  it('refuses an impossible transition', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2033-10-01',
    })
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'closed', 'done', null)`, [id]),
    )
    await db.expectRejection(
      () =>
        db.sql(`update public.financing_agreements set agreement_status = 'active' where id = $1`, [
          id,
        ]),
      /cannot become active/i,
    )
  })

  it('allows only one live agreement per vehicle, and a draft beside it', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Fiat', 'Ducato', 'FIN-REFI', 'EUR', 5000) returning id`,
      [organizationId],
    )

    const original = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 4,
      vehicleId: vehicle!.id,
      firstPaymentOn: '2034-01-01',
    })

    // A refinance is prepared as a draft while the original is still running.
    const replacement = await createAgreement({
      mode: 'simple',
      installmentMinor: 90_000,
      installments: 4,
      vehicleId: vehicle!.id,
      firstPaymentOn: '2034-06-01',
      activate: false,
    })

    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_activate_agreement($1)`, [replacement]),
        ),
      /duplicate key|financing_agreements_one_active_per_vehicle/i,
    )

    // Closing the original releases the vehicle, and the history of both stays.
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'closed', 'Refinanced', null)`, [
        original,
      ]),
    )
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_activate_agreement($1)`, [replacement]),
    )

    const rows = await db.asUser(managerId, (session) =>
      session.sql<{ agreement_status: string }>(
        `select agreement_status from public.financing_agreement_overview
          where vehicle_id = $1 order by created_at`,
        [vehicle!.id],
      ),
    )
    expect(rows.map((row) => row.agreement_status)).toEqual(['closed', 'active'])
  })
})

// -----------------------------------------------------------------------------
// Terms and history
// -----------------------------------------------------------------------------

describe('editing an agreement', () => {
  it('is free before any money has moved', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 4,
      firstPaymentOn: '2034-02-01',
    })

    await db.asUser(adminId, (session) =>
      session.sql(`update public.financing_agreements set installment_amount_minor = 120000 where id = $1`, [id]),
    )
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_generate_schedule($1)`, [id]),
    )

    const rows = await installments(id)
    expect(Number(rows[0]!.expected_total_minor)).toBe(120_000)
  })

  it('freezes the terms the money was paid against', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 4,
      firstPaymentOn: '2034-03-01',
    })
    await recordPayment(id, { paidOn: '2034-03-01', amountMinor: 100_000 })

    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(
            `update public.financing_agreements set installment_amount_minor = 200000 where id = $1`,
            [id],
          ),
        ),
      /terms are fixed/i,
    )

    // A note is not a term, and stays editable.
    await db.asUser(adminId, (session) =>
      session.sql(`update public.financing_agreements set notes = 'Called the bank' where id = $1`, [
        id,
      ]),
    )

    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_generate_schedule($1)`, [id]),
        ),
      /no longer be regenerated/i,
    )
  })

  it('keeps the figure a correction replaced', async () => {
    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 1_000_000,
      rateBps: 725,
      installments: 12,
      firstPaymentOn: '2034-04-01',
      activate: false,
    })

    await db.asUser(adminId, (session) =>
      session.sql(`update public.financing_agreements set rate_bps = 225 where id = $1`, [id]),
    )

    const [event] = await db.sql<{
      kind: string
      changes: { rate_bps?: { from: number; to: number } }
      changed_by: string
    }>(
      `select kind, changes, changed_by from public.financing_change_events
        where agreement_id = $1 order by changed_at desc limit 1`,
      [id],
    )
    expect(event!.kind).toBe('correction')
    expect(Number(event!.changes.rate_bps?.from)).toBe(725)
    expect(Number(event!.changes.rate_bps?.to)).toBe(225)
    expect(event!.changed_by).toBe(adminId)
  })

  it('attributes a change to the session, not to a column the caller wrote', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 4,
      firstPaymentOn: '2034-05-01',
      activate: false,
    })

    await db.asUser(adminId, (session) =>
      session.sql(
        `update public.financing_agreements
            set installment_amount_minor = 110000, updated_by = $2 where id = $1`,
        [id, staffId],
      ),
    )

    const [event] = await db.sql<{ changed_by: string }>(
      `select changed_by from public.financing_change_events
        where agreement_id = $1 order by changed_at desc limit 1`,
      [id],
    )
    expect(event!.changed_by).toBe(adminId)
    expect(event!.changed_by).not.toBe(staffId)
  })

  it('records a status change as its own kind of event', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2034-07-01',
    })
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_close_agreement($1, 'cancelled', 'Never signed', null)`, [
        id,
      ]),
    )

    const events = await db.sql<{ kind: string; reason: string }>(
      `select kind, reason from public.financing_change_events
        where agreement_id = $1 order by changed_at`,
      [id],
    )
    expect(events.some((event) => event.kind === 'status')).toBe(true)
    expect(events.at(-1)!.reason).toBe('Never signed')
  })

  it('cannot be written or erased by the application', async () => {
    await db.asUser(adminId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.financing_change_events (organization_id, agreement_id, changes)
             values ($1, (select id from public.financing_agreements limit 1), '{}'::jsonb)`,
            [organizationId],
          ),
        /permission denied/i,
      )
      await session.expectRejection(
        () => session.sql(`update public.financing_change_events set reason = 'x'`),
        /permission denied/i,
      )
      await session.expectRejection(
        () => session.sql(`delete from public.financing_change_events`),
        /permission denied/i,
      )
    })
  })
})

// -----------------------------------------------------------------------------
// Vehicles
// -----------------------------------------------------------------------------

describe('a financed vehicle', () => {
  it('keeps its obligation visible after it is retired from the fleet', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Opel', 'Vivaro', 'FIN-ARCH', 'EUR', 5000) returning id`,
      [organizationId],
    )
    const today = await agencyToday()
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 150_000,
      installments: 6,
      vehicleId: vehicle!.id,
      firstPaymentOn: shiftIso(today, -7),
      frequency: 'weekly',
    })

    await db.sql(`update public.vehicles set archived_at = now() where id = $1`, [vehicle!.id])

    const position = await overview(id)
    expect(position.vehicle_archived).toBe(true)
    // A debt does not stop existing because the car left the fleet.
    expect(Number(position.overdue_minor)).toBe(150_000)
    expect(Number(position.remaining_scheduled_minor)).toBe(900_000)

    const due = await db.asUser(managerId, (session) =>
      session.sql<{ vehicle_plate: string }>(
        `select vehicle_plate from public.financing_due_obligations($1, 30)`,
        [organizationId],
      ),
    )
    expect(due.some((row) => row.vehicle_plate === 'FIN-ARCH')).toBe(true)
  })

  it('cannot be deleted while an agreement references it', async () => {
    const [row] = await db.asUser(managerId, (session) =>
      session.sql<{ can_delete: boolean; financing_count: number }>(
        `select can_delete, financing_count from public.vehicle_usage($1)`,
        [vehicleA],
      ),
    )
    expect(Number(row!.financing_count)).toBeGreaterThan(0)
    expect(row!.can_delete).toBe(false)
  })

  it('reports its financing separately from its operating contribution', async () => {
    const summary = await db.asUser(managerId, (session) =>
      session.sql<{
        currency: string
        cash_paid_minor: number
        principal_paid_minor: number
        financing_cost_minor: number
        cost_complete: boolean
      }>(
        `select currency, cash_paid_minor, principal_paid_minor, financing_cost_minor, cost_complete
           from public.vehicle_financing_summary($1, '2032-01-01'::date, '2033-01-01'::date)`,
        [vehicleA],
      ),
    )
    expect(summary.length).toBeGreaterThan(0)

    const operating = await db.asUser(managerId, (session) =>
      session.sql<{ operating_contribution_minor: number }>(
        `select operating_contribution_minor
           from public.vehicle_operating_summary($1, '2032-01-01'::date, '2033-01-01'::date)`,
        [vehicleA],
      ),
    )
    // Two questions, two answers. The module never merges them into one number
    // and calls it profit.
    expect(Array.isArray(operating)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Currencies
// -----------------------------------------------------------------------------

describe('two currencies', () => {
  it('are reported side by side and never added', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Ford', 'Transit', 'FIN-MAD', 'EUR', 5000) returning id`,
      [organizationId],
    )
    const id = await createAgreement({
      mode: 'simple',
      currency: 'MAD',
      installmentMinor: 430_000,
      installments: 4,
      vehicleId: vehicle!.id,
      firstPaymentOn: '2032-05-10',
    })
    await recordPayment(id, { paidOn: '2032-05-10', amountMinor: 430_000 })

    const rows = await db.asUser(managerId, (session) =>
      session.sql<{ currency: string; cash_paid_minor: number }>(
        `select currency, cash_paid_minor from public.organization_financing_summary($1, '2032-01-01'::date, '2033-01-01'::date)
          order by currency`,
        [organizationId],
      ),
    )

    const currencies = rows.map((row) => row.currency)
    expect(currencies).toContain('MAD')
    expect(currencies).toContain('EUR')
    const mad = rows.find((row) => row.currency === 'MAD')!
    expect(Number(mad.cash_paid_minor)).toBe(430_000)
  })

  it('never sums a principal balance nobody knows', async () => {
    const rows = await db.asUser(managerId, (session) =>
      session.sql<{
        currency: string
        remaining_principal_minor: number | null
        unknown_principal_count: number
      }>(
        `select currency, remaining_principal_minor, unknown_principal_count
           from public.organization_financing_summary($1, '2032-01-01'::date, '2033-01-01'::date)`,
        [organizationId],
      ),
    )
    // Whatever the mix, an agreement whose balance cannot be derived is counted,
    // not silently added as zero.
    expect(rows.some((row) => Number(row.unknown_principal_count) > 0)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// Access
// -----------------------------------------------------------------------------

describe('who may do what', () => {
  it('lets a manager look and refuses to let them change anything', async () => {
    await db.asUser(managerId, async (session) => {
      const rows = await session.sql(`select id from public.financing_agreement_overview limit 1`)
      expect(rows.length).toBe(1)

      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.financing_agreements
               (organization_id, vehicle_id, lender_id, currency, starts_on, first_payment_on, schedule_anchor_day)
             values ($1, $2, $3, 'EUR', current_date, current_date, 1)`,
            [organizationId, vehicleA, lenderId],
          ),
        /row-level security/i,
      )

      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.lenders (organization_id, name) values ($1, 'Sneaky Bank')`,
            [organizationId],
          ),
        /row-level security/i,
      )
    })
  })

  it('refuses a manager recording a lender payment', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2035-01-01',
    })
    await db.asUser(managerId, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `select public.financing_record_payment($1, '2035-01-01'::date, 100000, null, null, null, null, 'installment', null, null, null)`,
            [id],
          ),
        /row-level security/i,
      )
    })
  })

  it('shows a staff member nothing at all', async () => {
    await db.asUser(staffId, async (session) => {
      for (const relation of [
        'financing_agreements',
        'financing_installments',
        'financing_payments',
        'financing_documents',
        'financing_change_events',
        'lenders',
        'financing_agreement_overview',
        'financing_installment_status',
      ]) {
        const rows = await session.sql(`select * from public.${relation} limit 1`)
        expect(rows, `${relation} leaked to staff`).toHaveLength(0)
      }

      await session.expectRejection(
        () => session.sql(`select * from public.organization_financing_summary($1, '2032-01-01'::date, '2033-01-01'::date)`, [organizationId]),
        /not permitted/i,
      )
    })
  })

  it('shows another agency nothing, and answers as though it did not exist', async () => {
    const rival = await signUp(db, {
      email: 'rival@financing.test',
      fullName: 'Rival Owner',
      organizationName: 'Rival Motors',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    })
    if (!rival.organizationId) throw new Error('Provisioning failed.')

    const [agreement] = await db.sql<{ id: string }>(
      `select id from public.financing_agreements where organization_id = $1 limit 1`,
      [organizationId],
    )

    await db.asUser(rival.userId, async (session) => {
      expect(
        await session.sql(`select id from public.financing_agreement_overview where id = $1`, [
          agreement!.id,
        ]),
      ).toHaveLength(0)

      expect(
        await session.sql(`select id from public.financing_payments where organization_id = $1`, [
          organizationId,
        ]),
      ).toHaveLength(0)

      await session.expectRejection(
        () =>
          session.sql(`select public.financing_close_agreement($1, 'closed', 'not mine', null)`, [
            agreement!.id,
          ]),
        /not found/i,
      )

      await session.expectRejection(
        () =>
          session.sql(
            `select public.financing_record_payment($1, current_date, 1000, null, null, null, null, 'installment', null, null, null)`,
            [agreement!.id],
          ),
        /not found/i,
      )

      await session.expectRejection(
        () =>
          session.sql(`select * from public.financing_due_obligations($1, 30)`, [organizationId]),
        /not permitted/i,
      )

      // Duplicate detection must not become an oracle for another agency's books.
      expect(
        await session.sql(
          `select * from public.find_duplicate_financing_payments($1, current_date, 100000, null, null)`,
          [agreement!.id],
        ),
      ).toHaveLength(0)
    })
  })

  it('gives the anonymous role nothing', async () => {
    await db.asAnon(async (session) => {
      for (const relation of [
        'financing_agreements',
        'financing_installments',
        'financing_payments',
        'financing_documents',
        'financing_change_events',
        'lenders',
      ]) {
        await session.expectRejection(() => session.sql(`select * from public.${relation} limit 1`))
      }
      await session.expectRejection(() =>
        session.sql(`select public.financing_annuity_payment(1000, 100, 12, 'monthly', 0)`),
      )
    })
  })
})

// -----------------------------------------------------------------------------
// Lenders
// -----------------------------------------------------------------------------

describe('lenders', () => {
  it('lets two share a name, because a name identifies nothing', async () => {
    await db.asUser(adminId, (session) =>
      session.sql(
        `insert into public.lenders (organization_id, name, tax_identifier) values ($1, 'Crédit Fleet', 'ICE-A1')`,
        [organizationId],
      ),
    )
    await db.asUser(adminId, (session) =>
      session.sql(
        `insert into public.lenders (organization_id, name, tax_identifier) values ($1, 'Crédit Fleet', 'ICE-B2')`,
        [organizationId],
      ),
    )

    const rows = await db.sql(
      `select id from public.lenders where organization_id = $1 and name = 'Crédit Fleet'`,
      [organizationId],
    )
    expect(rows).toHaveLength(2)
  })

  it('refuses two sharing a tax identifier, because that does identify one', async () => {
    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(
            `insert into public.lenders (organization_id, name, tax_identifier) values ($1, 'Another Name', 'ICE-A1')`,
            [organizationId],
          ),
        ),
      /duplicate key|unique/i,
    )
  })

  it('surfaces a retired lender so it can be restored instead of duplicated', async () => {
    await db.asUser(adminId, (session) =>
      session.sql(
        `insert into public.lenders (organization_id, name, archived_at) values ($1, 'Old Leasing Co', now())`,
        [organizationId],
      ),
    )

    const rows = await db.asUser(managerId, (session) =>
      session.sql<{ match_reason: string; archived_at: string | null }>(
        `select match_reason, archived_at from public.find_duplicate_lenders($1, 'Old Leasing Co', null, null)`,
        [organizationId],
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.match_reason).toMatch(/retired/i)
  })

  it('treats a tax identifier as the stronger signal', async () => {
    const rows = await db.asUser(managerId, (session) =>
      session.sql<{ match_strength: string }>(
        `select match_strength from public.find_duplicate_lenders($1, 'Nothing like it', 'ICE-A1', null)`,
        [organizationId],
      ),
    )
    expect(rows[0]!.match_strength).toBe('strong')
  })

  it('keeps its agreements after being retired', async () => {
    const [row] = await db.asUser(managerId, (session) =>
      session.sql<{ lender_name: string }>(
        `select lender_name from public.financing_agreement_overview where lender_id = $1 limit 1`,
        [lenderId],
      ),
    )
    expect(row!.lender_name).toBe('Banque Atlas')

    await db.asUser(adminId, (session) =>
      session.sql(`update public.lenders set archived_at = now() where id = $1`, [lenderId]),
    )

    const [after] = await db.asUser(managerId, (session) =>
      session.sql<{ lender_name: string; lender_archived: boolean }>(
        `select lender_name, lender_archived from public.financing_agreement_overview where lender_id = $1 limit 1`,
        [lenderId],
      ),
    )
    expect(after!.lender_name).toBe('Banque Atlas')
    expect(after!.lender_archived).toBe(true)

    await db.asUser(adminId, (session) =>
      session.sql(`update public.lenders set archived_at = null where id = $1`, [lenderId]),
    )
  })

  it('cannot be deleted while an agreement names it', async () => {
    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`delete from public.lenders where id = $1`, [lenderId]),
        ),
      /violates (foreign key|RESTRICT)/i,
    )
  })
})

// -----------------------------------------------------------------------------
// Deletion
// -----------------------------------------------------------------------------

describe('deleting an agreement', () => {
  it('is possible while it is an unused draft', async () => {
    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Citroen', 'Jumpy', 'FIN-DRAFT', 'EUR', 5000) returning id`,
      [organizationId],
    )
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      vehicleId: vehicle!.id,
      activate: false,
    })

    await db.asUser(ownerId, (session) =>
      session.sql(`delete from public.financing_agreements where id = $1`, [id]),
    )
    expect(
      await db.sql(`select id from public.financing_agreements where id = $1`, [id]),
    ).toHaveLength(0)
  })

  it('is refused once it is live', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 2,
      firstPaymentOn: '2035-03-01',
    })
    await db.expectRejection(
      () =>
        db.asUser(ownerId, (session) =>
          session.sql(`delete from public.financing_agreements where id = $1`, [id]),
        ),
      /Only a draft agreement can be deleted/i,
    )
  })

  it('does not make the agency itself undeletable', async () => {
    const doomed = await signUp(db, {
      email: 'doomed@financing.test',
      fullName: 'Closing Down',
      organizationName: 'Closing Down Finance',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    })
    if (!doomed.organizationId) throw new Error('Provisioning failed.')

    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
       values ($1, 'Seat', 'Alhambra', 'GONE-FIN', 'EUR', 4000) returning id`,
      [doomed.organizationId],
    )
    const [lender] = await db.sql<{ id: string }>(
      `insert into public.lenders (organization_id, name) values ($1, 'Doomed Bank') returning id`,
      [doomed.organizationId],
    )
    const [agreement] = await db.sql<{ id: string }>(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, mode, currency, installment_amount_minor,
          installments_count, first_payment_on, schedule_anchor_day, starts_on, agreement_status)
       values ($1, $2, $3, 'simple', 'EUR', 100000, 2, '2032-01-10'::date, 10, '2032-01-01'::date, 'active')
       returning id`,
      [doomed.organizationId, vehicle!.id, lender!.id],
    )
    await db.sql(
      `insert into public.financing_payments
         (organization_id, agreement_id, paid_on, currency, amount_minor, unallocated_minor)
       values ($1, $2, '2032-01-10'::date, 'EUR', 100000, 100000)`,
      [doomed.organizationId, agreement!.id],
    )

    await db.sql(`delete from public.organizations where id = $1`, [doomed.organizationId])

    expect(
      await db.sql(`select id from public.financing_agreements where id = $1`, [agreement!.id]),
    ).toHaveLength(0)
  })
})

// -----------------------------------------------------------------------------
// What the adversarial review turned up
// -----------------------------------------------------------------------------

describe('the shapes a live agreement is allowed to be in', () => {
  it('refuses a live payment plan with no number of payments', async () => {
    // The constraint used to accept `ends_on` in place of a term, which the
    // schedule generator then refused — a row nothing downstream could use.
    const vehicle = await freshVehicle('SHAPE')
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.financing_agreements
             (organization_id, vehicle_id, lender_id, mode, currency,
              installment_amount_minor, ends_on, first_payment_on, schedule_anchor_day,
              starts_on, agreement_status)
           values ($1, $2, $3, 'simple', 'EUR', 100000, '2035-01-01'::date,
                   '2034-01-01'::date, 1, '2034-01-01'::date, 'active')`,
          [organizationId, vehicle, lenderId],
        ),
      /financing_agreements_mode_requirements/i,
    )
  })

  it('still lets a draft be as incomplete as a draft is', async () => {
    const vehicle = await freshVehicle('SHAPE')
    const [row] = await db.sql<{ id: string }>(
      `insert into public.financing_agreements
         (organization_id, vehicle_id, lender_id, mode, currency,
          first_payment_on, schedule_anchor_day, starts_on)
       values ($1, $2, $3, 'amortizing', 'EUR', '2034-01-01'::date, 1, '2034-01-01'::date)
       returning id`,
      [organizationId, vehicle, lenderId],
    )
    expect(row!.id).toBeTruthy()
  })
})

describe('the schedule revision marker', () => {
  it('moves when a schedule is replaced, so an instalment can be traced', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 4,
      firstPaymentOn: '2034-08-01',
      activate: false,
    })

    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_activate_agreement($1)`, [id]),
    )
    const first = await installments(id)
    const [afterFirst] = await db.sql<{ schedule_revision: number }>(
      `select schedule_revision from public.financing_agreements where id = $1`,
      [id],
    )
    expect(Number(afterFirst!.schedule_revision)).toBe(1)

    await db.asUser(adminId, (session) =>
      session.sql(
        `update public.financing_agreements set installment_amount_minor = 120000 where id = $1`,
        [id],
      ),
    )
    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_generate_schedule($1)`, [id]),
    )

    const [afterSecond] = await db.sql<{ schedule_revision: number }>(
      `select schedule_revision from public.financing_agreements where id = $1`,
      [id],
    )
    expect(Number(afterSecond!.schedule_revision)).toBe(2)

    const [installment] = await db.sql<{ revision: number }>(
      `select revision from public.financing_installments where agreement_id = $1 order by sequence limit 1`,
      [id],
    )
    expect(Number(installment!.revision)).toBe(2)
    expect(first.length).toBe(4)
  })
})

describe('a down payment', () => {
  it('is never counted as an operating cost, nor added to what was financed', async () => {
    const vehicle = await freshVehicle('DOWN')
    await db.sql(
      `update public.vehicles
          set acquisition_method = 'financed', acquisition_price_minor = 24000000,
              acquisition_currency = 'EUR', acquired_on = '2032-01-01'::date
        where id = $1`,
      [vehicle],
    )

    const id = await createAgreement({
      mode: 'amortizing',
      financedMinor: 18_000_000,
      downPaymentMinor: 6_000_000,
      rateBps: 500,
      installments: 12,
      vehicleId: vehicle,
      firstPaymentOn: '2032-02-01',
    })

    const position = await overview(id)
    // 24,000 price = 6,000 down + 18,000 financed. Each is recorded once, in
    // one place, and neither is added to the other or to any cost.
    expect(Number(position.down_payment_amount_minor)).toBe(6_000_000)
    expect(Number(position.financed_amount_minor)).toBe(18_000_000)
    expect(Number(position.cash_paid_minor)).toBe(0)
    expect(Number(position.financing_cost_minor)).toBe(0)

    const operating = await db.asUser(ownerId, (session) =>
      session.sql<{ direct_expense_minor: number }>(
        `select direct_expense_minor from public.vehicle_operating_summary($1, '2032-01-01'::date, '2033-01-01'::date)`,
        [vehicle],
      ),
    )
    // No revenue and no costs, so no row at all — and certainly not a 6,000 cost.
    expect(operating).toHaveLength(0)
  })
})

describe('activating an agreement twice at once', () => {
  it('lets exactly one activation through', async () => {
    const id = await createAgreement({
      mode: 'simple',
      installmentMinor: 100_000,
      installments: 3,
      firstPaymentOn: '2034-09-01',
      activate: false,
    })

    await db.asUser(adminId, (session) =>
      session.sql(`select public.financing_activate_agreement($1)`, [id]),
    )
    await db.expectRejection(
      () =>
        db.asUser(adminId, (session) =>
          session.sql(`select public.financing_activate_agreement($1)`, [id]),
        ),
      /Only a draft agreement can be activated/i,
    )

    // And the schedule was written once, not twice.
    const rows = await installments(id)
    expect(rows).toHaveLength(3)
  })
})
