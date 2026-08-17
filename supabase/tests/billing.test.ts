// @vitest-environment node
/**
 * SaaS Billing, against a real PostgreSQL.
 *
 * Two questions run through all of it.
 *
 * The first is whether this module can say something untrue. A subscription that
 * looks active because a browser said so; an agency shown a plan nobody sold
 * them; a "payment failed" notification in a deployment that has never taken a
 * payment; a manager reading the owner's invoice amount. Most of what follows
 * asserts that none of those can happen.
 *
 * The second is whether an unconfigured deployment behaves. There is no Stripe
 * credential and no catalogue here, and that state must be calm and honest
 * everywhere: no fake subscription, no fake exemption, no errors leaking into
 * Vehicles or Reports, and no agency losing access to its own records.
 *
 * Nothing in this file talks to Stripe. What it proves is the database's half:
 * the projection, the guards, the permissions and the derivation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase

interface Cast {
  organizationId: string
  owner: string
  admin: string
  manager: string
  staff: string
  rivalOrg: string
  rival: string
}

let cast: Cast
let seq = 0

async function seedCast(): Promise<Cast> {
  seq += 1
  const owner = await signUp(db, {
    email: `owner${seq}@billing.test`,
    fullName: 'Owner One',
    organizationName: `Billing ${seq}`,
    currency: 'MAD',
    timeZone: 'Africa/Casablanca',
  })
  if (!owner.organizationId) throw new Error('provisioning failed')

  const admin = await signUp(db, { email: `admin${seq}@billing.test`, fullName: 'Admin One' })
  const manager = await signUp(db, { email: `manager${seq}@billing.test`, fullName: 'Manager One' })
  const staff = await signUp(db, { email: `staff${seq}@billing.test`, fullName: 'Staff One' })
  await addMember(db, owner.organizationId, admin.userId, 'admin')
  await addMember(db, owner.organizationId, manager.userId, 'manager')
  await addMember(db, owner.organizationId, staff.userId, 'staff')

  const rival = await signUp(db, {
    email: `rival${seq}@billing.test`,
    organizationName: `Rival ${seq}`,
    currency: 'EUR',
    timeZone: 'Europe/Paris',
  })
  if (!rival.organizationId) throw new Error('rival provisioning failed')

  return {
    organizationId: owner.organizationId,
    owner: owner.userId,
    admin: admin.userId,
    manager: manager.userId,
    staff: staff.userId,
    rivalOrg: rival.organizationId,
    rival: rival.userId,
  }
}

/**
 * Puts the deployment into a configured state, the way the billing service would.
 *
 * Only reachable here because these statements run as the database owner. No
 * client role can execute any of it, which is asserted separately — a test
 * fixture must not be a production mutation surface.
 */
async function configurePlatform(organizationId?: string): Promise<void> {
  await db.sql(
    `select app.billing_report_platform_state(true, 'test', 'Stripe is configured.')`,
  )
  await db.sql(`select app.billing_replace_catalogue($1::jsonb)`, [
    JSON.stringify([
      {
        plan_key: 'standard',
        display_name: 'Standard',
        stripe_price_id: 'price_test_standard',
        currency: 'EUR',
        amount_minor: 4900,
        interval: 'month',
        interval_count: 1,
        mode: 'test',
        sort_order: 0,
      },
      {
        plan_key: 'standard_annual',
        display_name: 'Standard, yearly',
        stripe_price_id: 'price_test_standard_year',
        currency: 'EUR',
        amount_minor: 49000,
        interval: 'year',
        interval_count: 1,
        mode: 'test',
        sort_order: 1,
      },
    ]),
  ])
  if (organizationId) {
    await db.sql(`select app.billing_claim_customer($1, $2, 'test', $3)`, [
      organizationId,
      `cus_test_${organizationId.slice(0, 8)}`,
      'billing@agency.test',
    ])
  }
}

/** Applies a subscription the way a verified webhook would. */
async function applySubscription(
  organizationId: string,
  over: Partial<{
    id: string
    status: string
    priceId: string
    eventAt: string
    cancelAtPeriodEnd: boolean
    cancelAt: string | null
    endedAt: string | null
    periodEnd: string
  }> = {},
): Promise<string> {
  const [row] = await db.sql<{ outcome: string }>(
    `select app.billing_apply_subscription(
       $1, $2, 'test', $3::public.stripe_subscription_status, $4, 'EUR', 4900, 'month', 1, 1,
       now() - interval '5 days', $5::timestamptz,
       $6, $7::timestamptz, null, $8::timestamptz, null, null,
       $9::timestamptz, 'evt_test_1'
     ) as outcome`,
    [
      over.id ?? 'sub_test_1',
      `cus_test_${organizationId.slice(0, 8)}`,
      over.status ?? 'active',
      over.priceId ?? 'price_test_standard',
      over.periodEnd ?? new Date(Date.now() + 25 * 86400_000).toISOString(),
      over.cancelAtPeriodEnd ?? false,
      over.cancelAt ?? null,
      over.endedAt ?? null,
      over.eventAt ?? new Date().toISOString(),
    ],
  )
  return row!.outcome
}

/** Clears just the subscriptions, for tests that walk several statuses. */
async function resetSubscriptions(): Promise<void> {
  await db.exec(`
    select app.billing_writing();
    delete from public.billing_subscriptions;
  `)
}

async function accessState(actor: string, organizationId?: string): Promise<string> {
  const [row] = await db.asUser(actor, (session) =>
    session.sql<{ state: string }>(`select public.billing_access($1) as state`, [
      organizationId ?? cast.organizationId,
    ]),
  )
  return row!.state
}

async function overview(actor: string, organizationId?: string) {
  const [row] = await db.asUser(actor, (session) =>
    session.sql<Record<string, unknown>>(`select * from public.billing_overview($1)`, [
      organizationId ?? cast.organizationId,
    ]),
  )
  return row!
}

beforeAll(async () => {
  db = await TestDatabase.create()
}, 180_000)

afterAll(async () => {
  await db?.close()
})

/**
 * Removes billing rows between tests.
 *
 * Announces itself as a billing writer first, exactly as the service does — the
 * guard trigger refuses a delete that arrives from anywhere else, which is the
 * behaviour under test elsewhere in this file. One `exec` so both statements
 * share a transaction and the flag applies to the second.
 */
async function resetBilling(): Promise<void> {
  await db.exec(`
    select app.billing_writing();
    delete from public.billing_events;
    delete from public.billing_checkout_sessions;
    delete from public.billing_subscriptions;
    delete from public.billing_customers;
    delete from public.billing_plans;
    delete from public.billing_webhook_events;
  `)
}

beforeEach(async () => {
  cast = await seedCast()
  await resetBilling()
  // Every test starts from the deployment's real state: nothing configured.
  await db.sql(
    `select app.billing_report_platform_state(false, null, 'No Stripe configuration has been reported by the server.')`,
  )
})

// -----------------------------------------------------------------------------
describe('a deployment with no Stripe configuration', () => {
  it('says so, rather than inventing a subscription', async () => {
    expect(await accessState(cast.owner)).toBe('platform_unconfigured')

    const rows = await db.sql(`select 1 from public.billing_subscriptions`)
    const customers = await db.sql(`select 1 from public.billing_customers`)
    const plans = await db.sql(`select 1 from public.billing_plans`)
    expect(rows).toHaveLength(0)
    expect(customers).toHaveLength(0)
    expect(plans).toHaveLength(0)
  })

  it('is not a subscription, an exemption or a grandfathered plan', async () => {
    const row = await overview(cast.owner)
    expect(row.access_state).toBe('platform_unconfigured')
    // Nothing that would render as a plan.
    expect(row.status).toBeNull()
    expect(row.plan_key).toBeNull()
    expect(row.amount_minor).toBeNull()
    expect(row.current_period_end).toBeNull()
    expect(row.has_customer).toBe(false)
    expect(row.platform_configured).toBe(false)
    expect(row.stripe_configured).toBe(false)
    expect(row.catalog_configured).toBe(false)
  })

  it('offers no plans, because none are configured', async () => {
    const plans = await db.asUser(cast.owner, (session) =>
      session.sql(`select * from public.billing_available_plans($1)`, [cast.organizationId]),
    )
    expect(plans).toEqual([])
  })

  it('produces no billing notification of any kind', async () => {
    const rows = await db.asUser(cast.owner, (session) =>
      session.sql<{ category: string }>(`select * from public.notification_feed($1, 'all')`, [
        cast.organizationId,
      ]),
    )
    // An unconfigured platform is a deployment fact, not tenant delinquency.
    expect(rows.filter((r) => r.category === 'billing')).toEqual([])
  })

  it('leaves every other module working', async () => {
    // The whole point: Billing being unconfigured must not touch anything else.
    const [vehicle] = await db.asUser(cast.manager, (session) =>
      session.sql<{ id: string }>(
        `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
         values ($1, 'Renault', 'Clio', 'BIL-${seq}', 'MAD') returning id`,
        [cast.organizationId],
      ),
    )
    expect(vehicle?.id).toBeTruthy()

    const fleet = await db.asUser(cast.manager, (session) =>
      session.sql(`select * from public.fleet_status_counts($1)`, [cast.organizationId]),
    )
    expect(fleet).toHaveLength(1)

    const overviewRows = await db.asUser(cast.manager, (session) =>
      session.sql(
        `select * from public.organization_overview($1, now() - interval '30 days', now())`,
        [cast.organizationId],
      ),
    )
    expect(overviewRows).toHaveLength(1)
  })
})

// -----------------------------------------------------------------------------
describe('who may see billing', () => {
  it('answers the owner and refuses everybody else', async () => {
    await configurePlatform(cast.organizationId)
    expect((await overview(cast.owner)).access_state).toBeTruthy()

    for (const actor of [cast.admin, cast.manager, cast.staff]) {
      await db.asUser(actor, async (session) => {
        await session.expectRejection(
          () => session.sql(`select * from public.billing_overview($1)`, [cast.organizationId]),
          /only an owner/i,
        )
        await session.expectRejection(
          () =>
            session.sql(`select * from public.billing_available_plans($1)`, [cast.organizationId]),
          /only an owner/i,
        )
        await session.expectRejection(
          () => session.sql(`select * from public.billing_history($1)`, [cast.organizationId]),
          /only an owner/i,
        )
        await session.expectRejection(
          () => session.sql(`select public.billing_set_email($1, 'x@y.test')`, [cast.organizationId]),
          /only an owner/i,
        )
      })
    }
  })

  it('gives every member the generic state and nothing else', async () => {
    await configurePlatform(cast.organizationId)
    await applySubscription(cast.organizationId, { status: 'past_due' })

    // A four-value enum. No amount, no plan, no email, no Stripe identifier.
    expect(await accessState(cast.staff)).toBe('attention')
    expect(await accessState(cast.manager)).toBe('attention')
  })

  it('gives anon nothing at all', async () => {
    await db.asAnon(async (session) => {
      for (const statement of [
        `select * from public.billing_overview('00000000-0000-0000-0000-000000000000')`,
        `select public.billing_access('00000000-0000-0000-0000-000000000000')`,
        `select * from public.billing_available_plans('00000000-0000-0000-0000-000000000000')`,
        `select * from public.billing_subscriptions`,
        `select * from public.billing_customers`,
        `select * from public.billing_webhook_events`,
        `select * from public.billing_platform_state`,
        `select app.billing_platform_configured()`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /permission denied/i)
      }
    })
  })

  it('gives no client role a table privilege on anything billing', async () => {
    const grants = await db.sql(`
      select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name like 'billing%'
        and grantee in ('anon', 'authenticated')
    `)
    expect(grants).toEqual([])
  })

  it('gives no signed-in user access to a billing service function', async () => {
    const reachable = await db.sql<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname like 'billing%'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    `)
    expect(reachable).toEqual([])
  })

  it('exposes exactly five billing functions to a browser, and none of them writes Stripe state', async () => {
    const reachable = await db.sql<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'billing%'
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      order by p.proname
    `)
    expect(reachable.map((r) => r.proname)).toEqual([
      'billing_access',
      'billing_available_plans',
      'billing_history',
      'billing_overview',
      'billing_set_email',
    ])
  })
})

// -----------------------------------------------------------------------------
describe('nothing a client can reach writes the projection', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
    await applySubscription(cast.organizationId)
  })

  it('refuses a direct write to the subscription projection at every role', async () => {
    for (const actor of [cast.owner, cast.admin, cast.manager, cast.staff]) {
      await db.asUser(actor, async (session) => {
        await session.expectRejection(
          () =>
            session.sql(`update public.billing_subscriptions set status = 'active'`),
          /permission denied/i,
        )
        await session.expectRejection(
          () =>
            session.sql(
              `insert into public.billing_subscriptions
                 (organization_id, stripe_subscription_id, stripe_customer_id, mode, status, stripe_event_at)
               values ($1, 'sub_forged', 'cus_forged', 'test', 'active', now())`,
              [cast.organizationId],
            ),
          /permission denied/i,
        )
      })
    }
  })

  it('refuses a direct write to the webhook ledger', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.billing_webhook_events
               (stripe_event_id, event_type, event_created_at) values ('evt_forged', 'x', now())`,
          ),
        /permission denied/i,
      )
      await session.expectRejection(
        () => session.sql(`update public.billing_webhook_events set processed_at = now()`),
        /permission denied/i,
      )
    })
  })

  it('refuses a write that does not announce itself, even from the table owner', async () => {
    /*
     * The third line of defence, tested with the first two removed.
     *
     * A client is stopped by having no privilege, and then by row-level security
     * having no write policy. This is what remains if a future migration, a
     * restored backup or one `grant all` typed at the wrong moment undoes those:
     * the guard trigger, which refuses any write that did not come from a
     * billing service function. Run here as the table owner, who bypasses both
     * of the other two.
     */
    await db.expectRejection(
      () => db.sql(`update public.billing_subscriptions set status = 'canceled'`),
      /written by the billing service/i,
    )
    await db.expectRejection(
      () => db.sql(`delete from public.billing_subscriptions`),
      /written by the billing service/i,
    )
    // A row-level trigger cannot fire on a table with no rows, so the ledger
    // gets one first — through the service function, which is the only way.
    await db.sql(
      `select app.billing_claim_webhook_event('evt_guard_1', 'invoice.paid', now(), 'in_1')`,
    )
    await db.expectRejection(
      () => db.sql(`update public.billing_webhook_events set processed_at = now()`),
      /written by the billing service/i,
    )
  })

  it('lets the owner change the billing address and nothing else', async () => {
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.billing_set_email($1, 'Accounts@Agency.test')`, [
        cast.organizationId,
      ]),
    )
    const [row] = await db.sql<{ billing_email: string }>(
      `select billing_email from public.billing_customers where organization_id = $1`,
      [cast.organizationId],
    )
    // Normalised, because an address that differs only in case is the same address.
    expect(row!.billing_email).toBe('accounts@agency.test')

    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.billing_set_email($1, 'not an address')`, [
          cast.organizationId,
        ]),
        /not a valid email/i,
      )
    })
  })
})

// -----------------------------------------------------------------------------
describe('one agency cannot reach another’s billing', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
    await applySubscription(cast.organizationId)
  })

  it('refuses the overview, the plans, the history and the state', async () => {
    await db.asUser(cast.rival, async (session) => {
      for (const statement of [
        `select * from public.billing_overview('${cast.organizationId}')`,
        `select * from public.billing_available_plans('${cast.organizationId}')`,
        `select * from public.billing_history('${cast.organizationId}')`,
        `select public.billing_access('${cast.organizationId}')`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /(only an owner|not a member)/i)
      }
    })
  })

  it('cannot infer anything from a cross-tenant Stripe identifier', async () => {
    // No client role holds a privilege on the projection at all, so a direct
    // read is refused rather than merely filtered — which is stronger than RLS.
    await db.asUser(cast.rival, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.billing_subscriptions`),
        /permission denied/i,
      )
    })

    const own = await overview(cast.rival, cast.rivalOrg)
    expect(own.subscription_id).toBeNull()
    expect(own.has_customer).toBe(false)
  })

  it('cannot write state into another agency', async () => {
    await db.asUser(cast.rival, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.billing_set_email($1, 'x@y.test')`, [cast.organizationId]),
        /only an owner/i,
      )
    })
    const [row] = await db.sql<{ billing_email: string | null }>(
      `select billing_email from public.billing_customers where organization_id = $1`,
      [cast.organizationId],
    )
    expect(row!.billing_email).toBe('billing@agency.test')
  })
})

// -----------------------------------------------------------------------------
describe('Stripe status becomes product access in one place', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
  })

  it('maps every one of Stripe’s eight statuses deliberately', async () => {
    const expected: Record<string, string> = {
      active: 'normal',
      trialing: 'normal',
      past_due: 'attention',
      unpaid: 'attention',
      incomplete: 'attention',
      incomplete_expired: 'attention',
      paused: 'attention',
      canceled: 'attention',
    }

    for (const [status, state] of Object.entries(expected)) {
      await resetSubscriptions()
      await applySubscription(cast.organizationId, { status })
      expect(await accessState(cast.owner), status).toBe(state)
    }
  })

  it('never restricts access, because no restriction policy has been decided', async () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
      await resetSubscriptions()
      await applySubscription(cast.organizationId, { status })
      expect(await accessState(cast.owner)).not.toBe('restricted')
    }
  })

  it('asks for attention when billing is configured and no plan was chosen', async () => {
    expect(await accessState(cast.owner)).toBe('attention')
  })

  it('leaves the rest of the product working while a payment has failed', async () => {
    await applySubscription(cast.organizationId, { status: 'past_due' })
    expect(await accessState(cast.owner)).toBe('attention')

    // Real contracts and real customers. A failed card does not lock the desk.
    const [vehicle] = await db.asUser(cast.manager, (session) =>
      session.sql<{ id: string }>(
        `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
         values ($1, 'Dacia', 'Logan', 'PD-${seq}', 'MAD') returning id`,
        [cast.organizationId],
      ),
    )
    expect(vehicle?.id).toBeTruthy()
  })
})

// -----------------------------------------------------------------------------
describe('the subscription projection', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
  })

  it('reads the plan from the price, and keeps the money Stripe charged', async () => {
    await applySubscription(cast.organizationId)
    const row = await overview(cast.owner)

    expect(row.plan_key).toBe('standard')
    expect(row.plan_name).toBe('Standard')
    expect(row.currency).toBe('EUR')
    expect(Number(row.amount_minor)).toBe(4900)
    expect(row.billing_interval).toBe('month')
  })

  it('does not convert the price into the agency’s operational currency', async () => {
    await applySubscription(cast.organizationId)
    const [organization] = await db.sql<{ default_currency: string }>(
      `select default_currency from public.organizations where id = $1`,
      [cast.organizationId],
    )
    // The agency rents in MAD and is billed in EUR. Both are true at once.
    expect(organization!.default_currency.trim()).toBe('MAD')
    expect((await overview(cast.owner)).currency).toBe('EUR')
  })

  it('refuses to travel backwards when an older event arrives late', async () => {
    const recent = new Date().toISOString()
    const older = new Date(Date.now() - 3600_000).toISOString()

    await applySubscription(cast.organizationId, { status: 'active', eventAt: recent })
    // Stripe retries for three days and guarantees no ordering: a cancellation
    // generated an hour ago can arrive after an activation generated now.
    const outcome = await applySubscription(cast.organizationId, {
      status: 'canceled',
      eventAt: older,
    })

    expect(outcome).toBe('stale')
    expect((await overview(cast.owner)).status).toBe('active')
  })

  it('applies a newer event over an older projection', async () => {
    await applySubscription(cast.organizationId, {
      status: 'active',
      eventAt: new Date(Date.now() - 3600_000).toISOString(),
    })
    const outcome = await applySubscription(cast.organizationId, {
      status: 'past_due',
      eventAt: new Date().toISOString(),
    })

    expect(outcome).toBe('applied')
    expect((await overview(cast.owner)).status).toBe('past_due')
  })

  it('is idempotent: the same event ten times leaves one subscription', async () => {
    const at = new Date().toISOString()
    for (let i = 0; i < 10; i += 1) {
      await applySubscription(cast.organizationId, { eventAt: at })
    }
    const rows = await db.sql(`select 1 from public.billing_subscriptions where organization_id = $1`, [
      cast.organizationId,
    ])
    expect(rows).toHaveLength(1)
  })

  it('ignores an event for a Stripe customer it has never heard of', async () => {
    const [row] = await db.sql<{ outcome: string }>(
      `select app.billing_apply_subscription(
         'sub_stranger', 'cus_someone_else', 'test', 'active', 'price_test_standard',
         'EUR', 4900, 'month', 1, 1, now(), now() + interval '30 days',
         false, null, null, null, null, null, now(), 'evt_x'
       ) as outcome`,
    )
    // Never resolved through metadata. No mapping, no tenant, no write.
    expect(row!.outcome).toBe('unknown_customer')
    expect(await db.sql(`select 1 from public.billing_subscriptions`)).toHaveLength(0)
  })

  it('refuses a second live subscription and records the anomaly', async () => {
    await applySubscription(cast.organizationId, { id: 'sub_test_1' })
    const outcome = await applySubscription(cast.organizationId, { id: 'sub_test_2' })

    expect(outcome).toBe('anomaly')
    const [live] = await db.sql<{ n: number }>(
      `select count(*)::int as n from public.billing_subscriptions
        where organization_id = $1 and status in ('trialing','active','past_due','unpaid','paused')`,
      [cast.organizationId],
    )
    // One, still. And a support-visible note rather than a silent choice.
    expect(live!.n).toBe(1)
    const events = await db.asUser(cast.owner, (session) =>
      session.sql<{ kind: string }>(`select * from public.billing_history($1)`, [
        cast.organizationId,
      ]),
    )
    expect(events.map((e) => e.kind)).toContain('anomaly_detected')
  })

  it('keeps a cancelled subscription as history when a new one begins', async () => {
    await applySubscription(cast.organizationId, {
      id: 'sub_old',
      status: 'canceled',
      endedAt: new Date(Date.now() - 86400_000).toISOString(),
    })
    await applySubscription(cast.organizationId, { id: 'sub_new', status: 'active' })

    const rows = await db.sql<{ stripe_subscription_id: string }>(
      `select stripe_subscription_id from public.billing_subscriptions where organization_id = $1`,
      [cast.organizationId],
    )
    expect(rows).toHaveLength(2)
    // And the effective one is derived, not flagged.
    expect((await overview(cast.owner)).subscription_id).toBe('sub_new')
  })

  it('reports a scheduled cancellation from either of Stripe’s two fields', async () => {
    const endsAt = new Date(Date.now() + 10 * 86400_000).toISOString()

    await applySubscription(cast.organizationId, { cancelAtPeriodEnd: true })
    expect((await overview(cast.owner)).cancel_scheduled).toBe(true)

    await resetSubscriptions()
    // The Customer Portal on flexible billing sets cancel_at and leaves the
    // deprecated boolean false.
    await applySubscription(cast.organizationId, { cancelAt: endsAt })
    const row = await overview(cast.owner)
    expect(row.cancel_scheduled).toBe(true)
    expect(new Date(row.cancel_effective_at as string).toISOString().slice(0, 10)).toBe(
      endsAt.slice(0, 10),
    )
  })

  it('distinguishes "cancels on a date" from "cancelled now"', async () => {
    await applySubscription(cast.organizationId, {
      status: 'active',
      cancelAtPeriodEnd: true,
    })
    const scheduled = await overview(cast.owner)
    expect(scheduled.status).toBe('active')
    expect(scheduled.cancel_scheduled).toBe(true)
    expect(scheduled.ended_at).toBeNull()

    await resetSubscriptions()
    await applySubscription(cast.organizationId, {
      status: 'canceled',
      endedAt: new Date().toISOString(),
    })
    const ended = await overview(cast.owner)
    expect(ended.status).toBe('canceled')
    expect(ended.ended_at).toBeTruthy()
  })

  it('keeps a subscription whose price has left the catalogue', async () => {
    await applySubscription(cast.organizationId, { priceId: 'price_test_standard' })
    // The plan is withdrawn from sale; the subscription is not rewritten.
    await db.sql(`select app.billing_replace_catalogue('[]'::jsonb)`)

    const row = await overview(cast.owner)
    expect(row.plan_key).toBe('standard')
    expect(row.status).toBe('active')
  })
})

// -----------------------------------------------------------------------------
describe('the webhook ledger', () => {
  it('claims an event once and reports every redelivery as a duplicate', async () => {
    const [first] = await db.sql<{ r: string }>(
      `select app.billing_claim_webhook_event('evt_1', 'customer.subscription.updated', now(), 'sub_1') as r`,
    )
    expect(first!.r).toBe('claimed')

    await db.sql(`select app.billing_finish_webhook_event('evt_1', 'applied', null, null)`)

    for (let i = 0; i < 5; i += 1) {
      const [again] = await db.sql<{ r: string }>(
        `select app.billing_claim_webhook_event('evt_1', 'customer.subscription.updated', now(), 'sub_1') as r`,
      )
      expect(again!.r).toBe('duplicate')
    }
    const [row] = await db.sql<{ attempts: number }>(
      `select attempts from public.billing_webhook_events where stripe_event_id = 'evt_1'`,
    )
    // Counted, so support can see a retry storm.
    expect(row!.attempts).toBe(6)
  })

  it('deduplicates two distinct events describing the same change', async () => {
    const at = new Date().toISOString()
    const [first] = await db.sql<{ r: string }>(
      `select app.billing_claim_webhook_event('evt_a', 'customer.subscription.updated', $1, 'sub_1') as r`,
      [at],
    )
    // Stripe documents that two separate Event objects can be generated for one
    // change; the event id alone does not catch it.
    const [second] = await db.sql<{ r: string }>(
      `select app.billing_claim_webhook_event('evt_b', 'customer.subscription.updated', $1, 'sub_1') as r`,
      [at],
    )
    expect(first!.r).toBe('claimed')
    expect(second!.r).toBe('duplicate')
  })

  it('leaves a failed event open so a retry can succeed', async () => {
    await db.sql(
      `select app.billing_claim_webhook_event('evt_2', 'invoice.paid', now(), 'in_1')`,
    )
    await db.sql(`select app.billing_fail_webhook_event('evt_2', 'stripe_unavailable')`)

    const [row] = await db.sql<{ processed_at: string | null; result: string }>(
      `select processed_at, result from public.billing_webhook_events where stripe_event_id = 'evt_2'`,
    )
    expect(row!.processed_at).toBeNull()
    expect(row!.result).toBe('failed')

    // And the retry is allowed to claim it again.
    const [retry] = await db.sql<{ r: string }>(
      `select app.billing_claim_webhook_event('evt_2', 'invoice.paid', now(), 'in_1') as r`,
    )
    expect(retry!.r).toBe('claimed')
  })

  it('stores no Stripe payload', async () => {
    const columns = await db.sql<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'billing_webhook_events'
    `)
    const names = columns.map((c) => c.column_name)
    for (const forbidden of ['payload', 'body', 'data', 'raw', 'event_json']) {
      expect(names).not.toContain(forbidden)
    }
  })
})

// -----------------------------------------------------------------------------
describe('billing belongs to the organization', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
    await applySubscription(cast.organizationId)
  })

  it('survives an ownership transfer unchanged', async () => {
    const before = await db.sql<{ stripe_customer_id: string }>(
      `select stripe_customer_id from public.billing_customers where organization_id = $1`,
      [cast.organizationId],
    )
    const subscriptionBefore = (await overview(cast.owner)).subscription_id

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.transfer_organization_ownership($1, $2)`, [
        cast.organizationId,
        cast.admin,
      ]),
    )

    const after = await db.sql<{ stripe_customer_id: string }>(
      `select stripe_customer_id from public.billing_customers where organization_id = $1`,
      [cast.organizationId],
    )
    expect(after).toHaveLength(1)
    expect(after[0]!.stripe_customer_id).toBe(before[0]!.stripe_customer_id)

    // The new owner manages billing; the old one no longer can.
    const asNewOwner = await overview(cast.admin)
    expect(asNewOwner.subscription_id).toBe(subscriptionBefore)

    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.billing_overview($1)`, [cast.organizationId]),
        /only an owner/i,
      )
    })
  })

  it('is not keyed on whoever created the agency', async () => {
    // created_by is provenance and is not updated by a transfer, so nothing in
    // billing may depend on it.
    const [customer] = await db.sql<{ organization_id: string }>(
      `select organization_id from public.billing_customers where organization_id = $1`,
      [cast.organizationId],
    )
    expect(customer!.organization_id).toBe(cast.organizationId)

    await db.sql(`update public.organizations set created_by = null where id = $1`, [
      cast.organizationId,
    ])
    expect((await overview(cast.owner)).subscription_id).toBe('sub_test_1')
  })

  it('cuts a removed member off immediately', async () => {
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.remove_team_member($1, $2)`, [cast.organizationId, cast.admin]),
    )
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.billing_access($1)`, [cast.organizationId]),
        /not a member/i,
      )
    })
  })

  it('keeps two agencies’ billing apart for one person', async () => {
    // The owner also owns the rival agency in this fixture's shape? No — they
    // are separate people, so the owner joins the second agency as an owner.
    const second = await signUp(db, {
      email: `second${seq}@billing.test`,
      organizationName: `Second ${seq}`,
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    })
    await addMember(db, second.organizationId!, cast.owner, 'owner')

    const first = await overview(cast.owner, cast.organizationId)
    const other = await overview(cast.owner, second.organizationId!)

    expect(first.subscription_id).toBe('sub_test_1')
    expect(other.subscription_id).toBeNull()
    expect(other.has_customer).toBe(false)
  })
})

// -----------------------------------------------------------------------------
describe('deleting an agency', () => {
  it('is refused while a live subscription exists', async () => {
    await configurePlatform(cast.organizationId)
    await applySubscription(cast.organizationId, { status: 'active' })

    await db.expectRejection(
      () => db.sql(`delete from public.organizations where id = $1`, [cast.organizationId]),
      /live subscription/i,
    )
  })

  it('is allowed once the subscription has ended, and takes its billing with it', async () => {
    await configurePlatform(cast.organizationId)
    await applySubscription(cast.organizationId, {
      status: 'canceled',
      endedAt: new Date().toISOString(),
    })

    await db.sql(`delete from public.organizations where id = $1`, [cast.organizationId])

    for (const table of [
      'billing_customers',
      'billing_subscriptions',
      'billing_checkout_sessions',
      'billing_events',
    ]) {
      const rows = await db.sql(
        `select 1 from public.${table} where organization_id = $1`,
        [cast.organizationId],
      )
      expect(rows, table).toHaveLength(0)
    }
  })

  it('does not make an Auth account undeletable', async () => {
    await configurePlatform(cast.organizationId)
    await db.sql(
      `select app.billing_record_checkout($1, 'cs_test_1', 'standard', 'price_test_standard',
                                          'test', now() + interval '1 hour', $2)`,
      [cast.organizationId, cast.owner],
    )

    const leaving = await signUp(db, { email: `erasable${seq}@billing.test`, fullName: 'Erasable' })
    await addMember(db, cast.organizationId, leaving.userId, 'admin')
    await db.sql(
      `select app.billing_note_event($1, 'reconciled', 'Refreshed.', $2, null)`,
      [cast.organizationId, leaving.userId],
    )

    // The referential action a guard must never refuse.
    await db.sql(`delete from auth.users where id = $1`, [leaving.userId])

    const [event] = await db.sql<{ actor_user_id: string | null; actor_label: string }>(
      `select actor_user_id, actor_label from public.billing_events
        where organization_id = $1 and kind = 'reconciled'`,
      [cast.organizationId],
    )
    expect(event!.actor_user_id).toBeNull()
    // The name survives as text, so history still reads correctly.
    expect(event!.actor_label).toBe('Erasable')
  })
})

// -----------------------------------------------------------------------------
describe('billing notifications', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
  })

  async function billingFeed(actor: string) {
    return db.asUser(actor, (session) =>
      session.sql<{ kind: string; category: string; action_path: string }>(
        `select * from public.notification_feed($1, 'all')`,
        [cast.organizationId],
      ),
    )
  }

  it('tells the owner about a failed payment, and nobody else', async () => {
    await applySubscription(cast.organizationId, { status: 'active' })
    await applySubscription(cast.organizationId, {
      status: 'past_due',
      eventAt: new Date(Date.now() + 1000).toISOString(),
    })

    const owner = await billingFeed(cast.owner)
    expect(owner.map((r) => r.kind)).toContain('billing_payment_failed')
    expect(owner.find((r) => r.kind === 'billing_payment_failed')?.action_path).toBe('/billing')

    for (const actor of [cast.admin, cast.manager, cast.staff]) {
      const rows = await billingFeed(actor)
      expect(rows.filter((r) => r.category === 'billing')).toEqual([])
    }
  })

  it('files a billing event under billing, not under team', async () => {
    await applySubscription(cast.organizationId, { status: 'active' })
    const owner = await billingFeed(cast.owner)
    const activated = owner.find((r) => r.kind === 'billing_subscription_activated')

    expect(activated?.category).toBe('billing')
    expect(activated?.action_path).toBe('/billing')
  })

  it('does not duplicate a notification when the same event is replayed', async () => {
    const at = new Date().toISOString()
    for (let i = 0; i < 5; i += 1) {
      await applySubscription(cast.organizationId, { status: 'active', eventAt: at })
    }
    const rows = await billingFeed(cast.owner)
    expect(rows.filter((r) => r.kind === 'billing_subscription_activated')).toHaveLength(1)
  })

  it('surfaces a current attention condition that resolves itself', async () => {
    await applySubscription(cast.organizationId, { status: 'past_due' })
    const attention = await billingFeed(cast.owner)
    expect(attention.map((r) => r.kind)).toContain('billing_attention_required')

    await applySubscription(cast.organizationId, {
      status: 'active',
      eventAt: new Date(Date.now() + 1000).toISOString(),
    })
    const recovered = await billingFeed(cast.owner)
    // Nobody dismissed it. It stopped being true.
    expect(recovered.map((r) => r.kind)).not.toContain('billing_attention_required')
  })

  it('cannot be forged by a client', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.billing_events (organization_id, kind, summary)
             values ($1, 'payment_failed', 'forged')`,
            [cast.organizationId],
          ),
        /permission denied/i,
      )
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.notification_events
               (organization_id, kind, severity, occurred_at, source_table, source_id)
             values ($1, 'billing_payment_failed', 'urgent', now(), 'billing_events', gen_random_uuid())`,
            [cast.organizationId],
          ),
        /permission denied/i,
      )
    })
  })

  it('can be muted by the owner, for the owner alone', async () => {
    await applySubscription(cast.organizationId, { status: 'past_due' })
    expect((await billingFeed(cast.owner)).some((r) => r.category === 'billing')).toBe(true)

    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.notification_preference_set($1, 'billing', true)`, [
        cast.organizationId,
      ]),
    )
    expect((await billingFeed(cast.owner)).some((r) => r.category === 'billing')).toBe(false)
  })

  it('refuses to let a manager mute a category they never receive', async () => {
    await db.asUser(cast.manager, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.notification_preference_set($1, 'billing', true)`, [
            cast.organizationId,
          ]),
        /do not receive/i,
      )
    })
  })
})

// -----------------------------------------------------------------------------
describe('SaaS billing does not touch the agency’s own books', () => {
  it('changes no rental, expense, financing or reporting figure', async () => {
    await configurePlatform(cast.organizationId)

    const [vehicle] = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
       values ($1, 'Renault', 'Clio', 'BOOK-${seq}', 'MAD') returning id`,
      [cast.organizationId],
    )
    const [customer] = await db.sql<{ id: string }>(
      `insert into public.customers (organization_id, first_name, last_name)
       values ($1, 'Nadia', 'Fassi') returning id`,
      [cast.organizationId],
    )
    const [rental] = await db.sql<{ id: string }>(
      `insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
       values ($1, $2, $3, now() - interval '5 days', now() - interval '3 days', 'MAD', 'completed', 90000)
       returning id`,
      [cast.organizationId, vehicle!.id, customer!.id],
    )
    await db.sql(
      `insert into public.payments (organization_id, rental_id, amount_minor, currency, paid_at)
       values ($1, $2, 90000, 'MAD', now() - interval '3 days')`,
      [cast.organizationId, rental!.id],
    )

    const before = await db.asUser(cast.manager, (session) =>
      session.sql<Record<string, unknown>>(
        `select * from public.organization_overview($1, now() - interval '30 days', now())`,
        [cast.organizationId],
      ),
    )

    // A whole subscription lifecycle, at our expense, not theirs.
    await applySubscription(cast.organizationId, { status: 'active' })
    await applySubscription(cast.organizationId, {
      status: 'past_due',
      eventAt: new Date(Date.now() + 1000).toISOString(),
    })
    await db.sql(
      `select app.billing_apply_invoice($1, 'sub_test_1', 'in_test_1', 'open', 4900, 'EUR', true, now(), 'evt_i')`,
      [`cus_test_${cast.organizationId.slice(0, 8)}`],
    )

    const after = await db.asUser(cast.manager, (session) =>
      session.sql<Record<string, unknown>>(
        `select * from public.organization_overview($1, now() - interval '30 days', now())`,
        [cast.organizationId],
      ),
    )

    expect(after).toEqual(before)

    // And no expense appeared. Whether to record our fee is the agency's
    // bookkeeping decision, not ours to make for them.
    const expenses = await db.sql(`select 1 from public.expenses where organization_id = $1`, [
      cast.organizationId,
    ])
    expect(expenses).toHaveLength(0)
  })

  it('reports seats and fleet as facts, with no limit attached', async () => {
    await configurePlatform(cast.organizationId)
    await db.sql(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, archived_at)
       values ($1, 'A', 'B', 'ACT-${seq}', 'MAD', null),
              ($1, 'A', 'B', 'ARC-${seq}', 'MAD', now())`,
      [cast.organizationId],
    )

    const row = await overview(cast.owner)
    // Four members, one active vehicle: the archived one is not the fleet.
    expect(row.active_members).toBe(4)
    expect(row.active_vehicles).toBe(1)

    // No entitlement is enforced anywhere: nothing was sold that limits either.
    const [plan] = await db.sql<{ entitlements: Record<string, unknown> }>(
      `select entitlements from public.billing_plans where plan_key = 'standard'`,
    )
    expect(plan!.entitlements).toEqual({})
  })
})

// -----------------------------------------------------------------------------
describe('checkout intents', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
  })

  it('supersedes an earlier open session rather than keeping two', async () => {
    for (const id of ['cs_test_1', 'cs_test_2']) {
      await db.sql(
        `select app.billing_record_checkout($1, $2, 'standard', 'price_test_standard',
                                            'test', now() + interval '1 hour', $3)`,
        [cast.organizationId, id, cast.owner],
      )
    }

    const rows = await db.sql<{ stripe_session_id: string; state: string }>(
      `select stripe_session_id, state from public.billing_checkout_sessions
        where organization_id = $1 order by created_at`,
      [cast.organizationId],
    )
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'open'])
  })

  it('offers an open session back rather than minting another', async () => {
    await db.sql(
      `select app.billing_record_checkout($1, 'cs_test_9', 'standard', 'price_test_standard',
                                          'test', now() + interval '1 hour', $2)`,
      [cast.organizationId, cast.owner],
    )
    const [row] = await db.sql<{ id: string | null }>(
      `select app.billing_open_checkout($1, 'standard') as id`,
      [cast.organizationId],
    )
    expect(row!.id).toBe('cs_test_9')
  })

  it('does not offer a session that is about to expire', async () => {
    await db.sql(
      `select app.billing_record_checkout($1, 'cs_test_soon', 'standard', 'price_test_standard',
                                          'test', now() + interval '30 seconds', $2)`,
      [cast.organizationId, cast.owner],
    )
    const [row] = await db.sql<{ id: string | null }>(
      `select app.billing_open_checkout($1, 'standard') as id`,
      [cast.organizationId],
    )
    // Handing back a session with seconds left is handing back a dead end.
    expect(row!.id).toBeNull()
  })

  it('marks the session completed when the subscription arrives', async () => {
    await db.sql(
      `select app.billing_record_checkout($1, 'cs_test_done', 'standard', 'price_test_standard',
                                          'test', now() + interval '1 hour', $2)`,
      [cast.organizationId, cast.owner],
    )
    await applySubscription(cast.organizationId)

    const [row] = await db.sql<{ state: string }>(
      `select state from public.billing_checkout_sessions where stripe_session_id = 'cs_test_done'`,
    )
    expect(row!.state).toBe('completed')
    // And the page can stop saying "confirming".
    expect((await overview(cast.owner)).pending_checkout).toBe(false)
  })

  it('reports a pending checkout without unlocking anything', async () => {
    await db.sql(
      `select app.billing_record_checkout($1, 'cs_test_pending', 'standard', 'price_test_standard',
                                          'test', now() + interval '1 hour', $2)`,
      [cast.organizationId, cast.owner],
    )
    const row = await overview(cast.owner)

    expect(row.pending_checkout).toBe(true)
    // A started checkout is not a subscription.
    expect(row.status).toBeNull()
    expect(row.access_state).toBe('attention')
  })

  it('stores no card data anywhere', async () => {
    const columns = await db.sql<{ table_name: string; column_name: string }>(`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name like 'billing%'
    `)
    for (const { column_name } of columns) {
      expect(column_name).not.toMatch(/card|pan|cvc|cvv|expiry|exp_month|exp_year|number/i)
    }
  })
})

// -----------------------------------------------------------------------------
describe('the catalogue', () => {
  it('is empty until a commercial decision is made', async () => {
    const plans = await db.sql(`select 1 from public.billing_plans`)
    expect(plans).toHaveLength(0)
  })

  it('resolves a plan key to a price, and refuses anything else', async () => {
    await configurePlatform()

    const [resolved] = await db.sql<{ stripe_price_id: string }>(
      `select stripe_price_id from app.billing_resolve_plan('standard', 'test')`,
    )
    expect(resolved!.stripe_price_id).toBe('price_test_standard')

    // A price id is not a plan key, and neither is a plan from the other mode.
    const unknown = await db.sql(`select * from app.billing_resolve_plan('price_test_standard', 'test')`)
    const wrongMode = await db.sql(`select * from app.billing_resolve_plan('standard', 'live')`)
    expect(unknown.filter((r) => (r as { plan_key?: string }).plan_key)).toHaveLength(0)
    expect(wrongMode.filter((r) => (r as { plan_key?: string }).plan_key)).toHaveLength(0)
  })

  it('withdraws a plan that has left the configuration, in one step', async () => {
    await configurePlatform()
    expect(await db.sql(`select 1 from public.billing_plans where is_active`)).toHaveLength(2)

    await db.sql(`select app.billing_replace_catalogue($1::jsonb)`, [
      JSON.stringify([
        {
          plan_key: 'standard',
          display_name: 'Standard',
          stripe_price_id: 'price_test_standard',
          currency: 'EUR',
          amount_minor: 4900,
          interval: 'month',
          interval_count: 1,
          mode: 'test',
        },
      ]),
    ])

    const active = await db.sql<{ plan_key: string }>(
      `select plan_key from public.billing_plans where is_active`,
    )
    expect(active.map((p) => p.plan_key)).toEqual(['standard'])
    // Withdrawn, not deleted: an existing subscription still names its plan.
    expect(await db.sql(`select 1 from public.billing_plans`)).toHaveLength(2)
  })

  it('offers both intervals when both are configured, with their own prices', async () => {
    await configurePlatform(cast.organizationId)
    const plans = await db.asUser(cast.owner, (session) =>
      session.sql<{ plan_key: string; billing_interval: string; amount_minor: string; currency: string }>(
        `select * from public.billing_available_plans($1)`,
        [cast.organizationId],
      ),
    )

    expect(plans.map((p) => [p.plan_key, p.billing_interval, Number(p.amount_minor)])).toEqual([
      ['standard', 'month', 4900],
      ['standard_annual', 'year', 49000],
    ])
    // Every one carries the currency Stripe charges, not the agency's.
    expect(plans.every((p) => p.currency === 'EUR')).toBe(true)
  })
})

// -----------------------------------------------------------------------------
describe('defects found by attacking the module', () => {
  beforeEach(async () => {
    await configurePlatform(cast.organizationId)
  })

  it('does not tell a paying agency that billing is not set up', async () => {
    /*
     * The worst thing this module could say, and it could.
     *
     * app.billing_platform_configured() requires a sellable plan. The access
     * state used to consult it FIRST, so withdrawing the last plan from sale —
     * an ordinary commercial act — told every subscribed agency that billing was
     * unconfigured, hid its plan, price and renewal date, and dropped its
     * attention notification. A plan leaving the shop window has nothing to do
     * with whether an existing subscription is real.
     */
    await applySubscription(cast.organizationId, { status: 'active' })
    await db.sql(`select app.billing_replace_catalogue('[]'::jsonb)`)

    expect(await accessState(cast.owner)).toBe('normal')
    const row = await overview(cast.owner)
    expect(row.status).toBe('active')
    expect(row.subscription_id).toBe('sub_test_1')
    // Still honest about what is for sale.
    expect(row.catalog_configured).toBe(false)
  })

  it('still reports attention for a failed payment with nothing for sale', async () => {
    await applySubscription(cast.organizationId, { status: 'past_due' })
    await db.sql(`select app.billing_replace_catalogue('[]'::jsonb)`)
    expect(await accessState(cast.owner)).toBe('attention')
  })

  it('does not let an older invoice event clear a newer payment failure', async () => {
    await applySubscription(cast.organizationId, { status: 'past_due' })
    const customer = `cus_test_${cast.organizationId.slice(0, 8)}`
    const failedAt = new Date().toISOString()
    const earlier = new Date(Date.now() - 3600_000).toISOString()

    await db.sql(
      `select app.billing_apply_invoice($1, 'sub_test_1', 'in_late', 'open', 4900, 'EUR', true, $2, 'evt_f')`,
      [customer, failedAt],
    )
    expect((await overview(cast.owner)).payment_failed_at).toBeTruthy()

    // A paid invoice generated an hour BEFORE the failure, arriving after it.
    const [outcome] = await db.sql<{ o: string }>(
      `select app.billing_apply_invoice($1, 'sub_test_1', 'in_old', 'paid', 4900, 'EUR', false, $2, 'evt_p') as o`,
      [customer, earlier],
    )
    expect(outcome!.o).toBe('stale')
    // The failure stands. Clearing it would have shown a healthy subscription to
    // an owner whose card had just failed.
    expect((await overview(cast.owner)).payment_failed_at).toBeTruthy()
  })

  it('tells the caller when an invoice arrives before its subscription', async () => {
    const customer = `cus_test_${cast.organizationId.slice(0, 8)}`
    const [outcome] = await db.sql<{ o: string }>(
      `select app.billing_apply_invoice($1, 'sub_missing', 'in_1', 'paid', 4900, 'EUR', false, now(), 'evt_x') as o`,
      [customer],
    )
    // Stripe does not order its events, so this is ordinary — and the webhook
    // must retry rather than discard the invoice's outcome.
    expect(outcome!.o).toBe('no_subscription')
  })

  it('does not make an agency undeletable once a webhook has been recorded', async () => {
    /*
     * billing_webhook_events.organization_id is ON DELETE SET NULL, so deleting
     * the agency issues an UPDATE on this table. The guard's allowance used to
     * name only the auth.users references, so the cascade's own update was
     * refused — the third time a guard in this schema has made a row undeletable
     * by refusing a referential action.
     */
    await db.sql(
      `select app.billing_claim_webhook_event('evt_tenant_1', 'invoice.paid', now(), 'in_1')`,
    )
    await db.sql(
      `select app.billing_finish_webhook_event('evt_tenant_1', 'applied', $1, null)`,
      [cast.organizationId],
    )
    const [before] = await db.sql<{ organization_id: string | null }>(
      `select organization_id from public.billing_webhook_events where stripe_event_id = 'evt_tenant_1'`,
    )
    expect(before!.organization_id).toBe(cast.organizationId)

    await db.sql(`delete from public.organizations where id = $1`, [cast.organizationId])

    const [after] = await db.sql<{ organization_id: string | null }>(
      `select organization_id from public.billing_webhook_events where stripe_event_id = 'evt_tenant_1'`,
    )
    // The ledger row survives — it describes Stripe's traffic, not the tenant —
    // with its reference nulled.
    expect(after!.organization_id).toBeNull()
  })

  it('records a duplicate-subscription anomaly once, however often Stripe retries', async () => {
    await applySubscription(cast.organizationId, { id: 'sub_a' })
    for (let i = 0; i < 5; i += 1) {
      const outcome = await applySubscription(cast.organizationId, { id: 'sub_b' })
      expect(outcome).toBe('anomaly')
    }

    const [count] = await db.sql<{ n: number }>(
      `select count(*)::int as n from public.billing_events
        where organization_id = $1 and kind = 'anomaly_detected'`,
      [cast.organizationId],
    )
    // One anomaly, not one per retry — and therefore one notification.
    expect(count!.n).toBe(1)
  })

  it('marks a deleted Stripe customer through a service function', async () => {
    const customer = `cus_test_${cast.organizationId.slice(0, 8)}`
    const [outcome] = await db.sql<{ o: string }>(
      `select app.billing_mark_customer_deleted($1) as o`,
      [customer],
    )
    expect(outcome!.o).toBe('applied')

    const [row] = await db.sql<{ deleted_at: string | null }>(
      `select deleted_at from public.billing_customers where organization_id = $1`,
      [cast.organizationId],
    )
    expect(row!.deleted_at).toBeTruthy()
    // The mapping stays: the identifier must not be reused.
    expect((await overview(cast.owner)).has_customer).toBe(false)

    // A redelivery is a no-op rather than moving the timestamp.
    const first = row!.deleted_at
    await db.sql(`select app.billing_mark_customer_deleted($1)`, [customer])
    const [again] = await db.sql<{ deleted_at: string }>(
      `select deleted_at from public.billing_customers where organization_id = $1`,
      [cast.organizationId],
    )
    expect(String(again!.deleted_at)).toBe(String(first))
  })

  it('reports an unknown customer rather than pretending to have marked one', async () => {
    const [outcome] = await db.sql<{ o: string }>(
      `select app.billing_mark_customer_deleted('cus_nobody') as o`,
    )
    expect(outcome!.o).toBe('unknown_customer')
  })

  it('stops offering a cancellation date once the subscription has ended', async () => {
    await applySubscription(cast.organizationId, {
      status: 'canceled',
      cancelAtPeriodEnd: true,
      endedAt: new Date().toISOString(),
    })
    const row = await overview(cast.owner)

    // "Cancels on the 4th" beside a "Cancelled" badge is the page arguing with
    // itself, and a reader believes whichever half is worse for them.
    expect(row.cancel_scheduled).toBe(false)
    expect(row.cancel_effective_at).toBeNull()
    expect(row.ended_at).toBeTruthy()
  })

  it('does not report a trial that finished a year ago', async () => {
    await db.sql(
      `select app.billing_apply_subscription(
         'sub_trial', $1, 'test', 'active', 'price_test_standard', 'EUR', 4900, 'month', 1, 1,
         now() - interval '5 days', now() + interval '25 days',
         false, null, null, null,
         now() - interval '400 days', now() - interval '370 days',
         now(), 'evt_trial')`,
      [`cus_test_${cast.organizationId.slice(0, 8)}`],
    )
    // Stripe keeps trial_end forever; a trial that finished is not a trial.
    expect((await overview(cast.owner)).trial_end).toBeNull()
  })
})
