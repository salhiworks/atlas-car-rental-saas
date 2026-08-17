// @vitest-environment node
/**
 * Proves the dashboard read models are tenant-safe, rather than assuming they
 * are because the tables beneath them have RLS.
 *
 * That assumption is exactly where this class of bug hides. A function declared
 * SECURITY DEFINER, or a view created without `security_invoker`, runs with its
 * owner's privileges — and the owner is the table owner, who bypasses RLS. The
 * tables would still "have RLS" and the leak would still be total.
 *
 * So there are two layers of test here: structural checks that nothing in the
 * schema is capable of bypassing RLS, and behavioural checks that agency A
 * cannot obtain agency B's figures by any route the client can reach.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase

let agencyA: { userId: string; organizationId: string }
let agencyB: { userId: string; organizationId: string }

const PERIOD_FROM = '2031-01-01T00:00:00Z'
const PERIOD_TO = '2031-02-01T00:00:00Z'

/** Seeds one vehicle, one customer, one paid contract and one expense. */
async function seedFinancials(
  organizationId: string,
  plate: string,
  amountMinor: number,
): Promise<void> {
  const [vehicle] = await db.sql<{ id: string }>(
    `insert into public.vehicles (organization_id, make, model, registration_plate, currency)
     values ($1, 'Volvo', 'V60', $2, 'EUR') returning id`,
    [organizationId, plate],
  )
  const [customer] = await db.sql<{ id: string }>(
    `insert into public.customers (organization_id, first_name, last_name)
     values ($1, 'Test', 'Renter') returning id`,
    [organizationId],
  )
  const [rental] = await db.sql<{ id: string }>(
    `insert into public.rentals
       (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
     values ($1, $2, $3, '2031-01-05T09:00:00Z', '2031-01-09T09:00:00Z', 'EUR', 'completed', $4)
     returning id`,
    [organizationId, vehicle!.id, customer!.id, amountMinor],
  )
  await db.sql(
    `insert into public.payments (organization_id, rental_id, amount_minor, currency, paid_at)
     values ($1, $2, $3, 'EUR', '2031-01-06T10:00:00Z')`,
    [organizationId, rental!.id, amountMinor],
  )
  await db.sql(
    `insert into public.expenses (organization_id, vehicle_id, amount_minor, currency, incurred_on, allocation, category_id)
     values ($1, $2, $3, 'EUR', date '2031-01-07', 'vehicle',
             (select id from public.expense_categories
               where organization_id = $1 and system_key = 'fuel'))`,
    [organizationId, vehicle!.id, Math.round(amountMinor / 4)],
  )
}

beforeAll(async () => {
  db = await TestDatabase.create()

  const a = await signUp(db, {
    email: 'owner@alpha-analytics.test',
    organizationName: 'Alpha Analytics Rentals',
    currency: 'EUR',
    timeZone: 'Europe/Berlin',
  })
  const b = await signUp(db, {
    email: 'owner@beta-analytics.test',
    organizationName: 'Beta Analytics Rentals',
    currency: 'EUR',
    timeZone: 'Europe/Berlin',
  })
  if (!a.organizationId || !b.organizationId) throw new Error('Provisioning failed during setup.')

  agencyA = { userId: a.userId, organizationId: a.organizationId }
  agencyB = { userId: b.userId, organizationId: b.organizationId }

  await seedFinancials(agencyA.organizationId, 'ALPHA-1', 100_00)
  await seedFinancials(agencyB.organizationId, 'BETA-1', 999_99)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

describe('nothing in the schema can bypass RLS', () => {
  it('declares every dashboard function SECURITY INVOKER', async () => {
    const definerFunctions = await db.sql<{ proname: string }>(`
      select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
    `)

    /*
     * SECURITY DEFINER in `public` is reserved and enumerated. Each entry here
     * is a place where the application deliberately holds no write privilege of
     * its own, so the only way the row can be created is through a function
     * that checks the caller itself:
     *
     *   create_organization             — the provisioning entry point
     *   financing_generate_schedule     — writes financing_installments, which
     *   financing_activate_agreement      the application may only ever read
     *   gps_store_credential            — the four GPS credential functions
     *   gps_read_credential               reach Supabase Vault, which is
     *   gps_disconnect_connection         deliberately unreachable by every
     *   gps_claim_sync                    role the browser can hold. All four
     *                                     are granted to service_role alone.
     *
     * And the Team module, which is the largest block for one reason: the
     * client holds no INSERT, UPDATE or DELETE on organization_members,
     * organization_invitations or organization_team_events at all, so every
     * membership change has to run inside a function that establishes the caller
     * from auth.uid() and checks the role itself. Each of them does, and
     * supabase/tests/team.test.ts attacks each of them from every role.
     *
     * preview_team_invitation is the one function on this surface that answers a
     * question without checking membership — it is keyed only by a 256-bit token
     * — and it is granted to service_role alone, reached through the invitation
     * Edge Function.
     *
     * And Notifications, for the same reason as Team: the client holds no
     * privilege of any kind on the four notification tables, so reading the feed
     * and recording read/dismissed/snoozed state both have to happen inside a
     * function that establishes the caller from auth.uid(). The feed additionally
     * reads across rentals, vehicles, financing and tracking on the caller's
     * behalf, and decides which of those it is allowed to include from the
     * caller's CURRENT permissions — a definer that hands back less than the
     * caller could already query for themselves, never more. Notably absent from
     * this list is any function that CREATES a notification: there is none.
     *
     * And Billing, which is owner-only and server-written. The five public
     * functions read a projection no client role holds a privilege on, and each
     * one checks the caller against `owner` itself — the same threshold
     * src/lib/authz/permissions.ts declares for 'billing.manage'. There is no
     * definer function here that WRITES a billing row from a browser: every
     * write lives in `app`, granted to service_role alone, and a separate
     * assertion in the migration fails the deploy if `authenticated` can reach
     * one.
     *
     * Anything else appearing in this list is a leak.
     */
    expect(definerFunctions.map((row) => row.proname).sort()).toEqual([
      'accept_team_invitation',
      'billing_access',
      'billing_available_plans',
      'billing_history',
      'billing_overview',
      'billing_set_email',
      'change_team_member_role',
      'create_organization',
      'create_team_invitation',
      'financing_activate_agreement',
      'financing_generate_schedule',
      'gps_claim_action',
      'gps_claim_sync',
      'gps_disconnect_connection',
      'gps_read_credential',
      'gps_store_credential',
      'leave_organization',
      'notification_dismiss',
      'notification_feed',
      'notification_mark_all_read',
      'notification_mark_read',
      'notification_preference_set',
      'notification_preferences_for',
      'notification_snooze',
      'notification_unread_count',
      'preview_team_invitation',
      'record_invitation_delivery',
      'remove_team_member',
      'resend_team_invitation',
      'revoke_team_invitation',
      'team_directory',
      'team_events',
      'team_invitation_message',
      'team_invitations',
      'team_seat_summary',
      'transfer_organization_ownership',
    ])
  })

  it('creates every view with security_invoker', async () => {
    const views = await db.sql<{ relname: string; reloptions: string | null }>(`
      select c.relname, array_to_string(c.reloptions, ',') as reloptions
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
    `)

    expect(views.length).toBeGreaterThan(0)
    for (const view of views) {
      expect(view.reloptions ?? '', `view ${view.relname}`).toContain('security_invoker=true')
    }
  })

  it('fails the deploy guard if a bypassing view is introduced', async () => {
    await db.exec(`create view public.leaky_view as select * from public.vehicles;`)

    try {
      await db.expectRejection(
        () => db.sql(`select app.assert_views_are_security_invoker()`),
        /leaky_view/,
      )
    } finally {
      await db.exec(`drop view if exists public.leaky_view;`)
    }
  })
})

describe('agency A cannot obtain agency B analytics', () => {
  it('refuses the overview for an agency the caller does not belong to', async () => {
    await db.expectRejection(
      () =>
        db.asUser(agencyA.userId, (session) =>
          session.sql(
            `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
            [agencyB.organizationId, PERIOD_FROM, PERIOD_TO],
          ),
        ),
      /not a member of this organization/i,
    )
  })

  it('refuses the financial series for another agency', async () => {
    await db.expectRejection(
      () =>
        db.asUser(agencyA.userId, (session) =>
          session.sql(
            `select * from public.organization_financial_series($1, $2::date, $3::date, 'month')`,
            [agencyB.organizationId, '2031-01-01', '2031-03-01'],
          ),
        ),
      /not a member of this organization/i,
    )
  })

  it("reports only A's own figures, never a total contaminated by B", async () => {
    const [result] = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ revenue_minor: number; expenses_minor: number; fleet_total: number }>(
        `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
        [agencyA.organizationId, PERIOD_FROM, PERIOD_TO],
      ),
    )

    // B booked 999.99 and A booked 100.00. A sees its own figure exactly.
    expect(result?.revenue_minor).toBe(100_00)
    expect(result?.expenses_minor).toBe(25_00)
    expect(result?.fleet_total).toBe(1)
  })

  it('is unaffected by how much data the other agency holds', async () => {
    const before = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ revenue_minor: number }>(
        `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
        [agencyA.organizationId, PERIOD_FROM, PERIOD_TO],
      ),
    )

    await seedFinancials(agencyB.organizationId, 'BETA-2', 500_00)

    const after = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ revenue_minor: number }>(
        `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
        [agencyA.organizationId, PERIOD_FROM, PERIOD_TO],
      ),
    )

    expect(after[0]?.revenue_minor).toBe(before[0]?.revenue_minor)
  })

  it('scopes the availability view to the caller regardless of what is asked for', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ organization_id: string }>(
        // Deliberately asks for B's rows, with no tenant filter of its own.
        `select organization_id from public.vehicle_fleet where organization_id = $1`,
        [agencyB.organizationId],
      ),
    )

    expect(rows).toEqual([])
  })

  it('scopes an unfiltered availability query to the caller', async () => {
    const rows = await db.asUser(agencyA.userId, (session) =>
      session.sql<{ organization_id: string }>(
        `select organization_id from public.vehicle_fleet`,
      ),
    )

    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.organization_id === agencyA.organizationId)).toBe(true)
  })

  it('refuses availability search against another agency', async () => {
    await db.expectRejection(
      () =>
        db.asUser(agencyA.userId, (session) =>
          session.sql(
            `select * from public.vehicles_available_between($1, now(), now() + interval '1 day')`,
            [agencyB.organizationId],
          ),
        ),
      /not a member of this organization/i,
    )
  })

  it('denies a suspended member who is still nominally attached to the agency', async () => {
    const exMember = await signUp(db, { email: 'ex@alpha-analytics.test' })
    await addMember(db, agencyA.organizationId, exMember.userId, 'manager')
    await db.sql(
      `update public.organization_members set status = 'suspended'
       where organization_id = $1 and user_id = $2`,
      [agencyA.organizationId, exMember.userId],
    )

    await db.expectRejection(
      () =>
        db.asUser(exMember.userId, (session) =>
          session.sql(
            `select * from public.organization_overview($1, $2::timestamptz, $3::timestamptz)`,
            [agencyA.organizationId, PERIOD_FROM, PERIOD_TO],
          ),
        ),
      /not a member of this organization/i,
    )
  })

  it('denies anon every analytics entry point', async () => {
    await db.asAnon(async (session) => {
      for (const statement of [
        `select * from public.organization_overview('00000000-0000-0000-0000-000000000000', now(), now() + interval '1 day')`,
        `select * from public.organization_financial_series('00000000-0000-0000-0000-000000000000', current_date, current_date + 1, 'month')`,
        `select * from public.vehicle_fleet`,
        `select * from public.vehicles_available_between('00000000-0000-0000-0000-000000000000', now(), now() + interval '1 day')`,
        // The reporting layer aggregates every sensitive domain at once, so it
        // is the single most valuable thing on the Data API to an unauthorised
        // caller.
        `select * from public.report_business_summary('00000000-0000-0000-0000-000000000000', current_date, current_date + 1)`,
        `select * from public.report_position_summary('00000000-0000-0000-0000-000000000000')`,
        `select * from public.report_fleet_performance('00000000-0000-0000-0000-000000000000', current_date, current_date + 1)`,
        `select * from public.report_customer_balances('00000000-0000-0000-0000-000000000000', null, 25, 0)`,
        `select * from public.report_financing_position('00000000-0000-0000-0000-000000000000')`,
        `select * from public.report_gps_coverage('00000000-0000-0000-0000-000000000000')`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /permission denied/i)
      }
    })
  })

  it('refuses every report to an agency the caller does not belong to', async () => {
    await db.asUser(agencyA.userId, async (session) => {
      for (const statement of [
        `select * from public.report_business_summary($1, current_date, current_date + 1)`,
        `select * from public.report_position_summary($1)`,
        `select * from public.report_fleet_performance($1, current_date, current_date + 1)`,
        `select * from public.report_expense_breakdown($1, current_date, current_date + 1, 'category')`,
        `select * from public.report_customer_balances($1, null, 25, 0)`,
        `select * from public.report_financing_position($1)`,
        `select * from public.report_gps_coverage($1)`,
        `select * from public.report_compliance_summary($1, null)`,
      ]) {
        await session.expectRejection(
          () => session.sql(statement, [agencyB.organizationId]),
          /not permitted to view reports/i,
        )
      }
    })
  })
})
