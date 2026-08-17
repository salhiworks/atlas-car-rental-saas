// @vitest-environment node
/**
 * Keeps the interface's permission matrix honest.
 *
 * `src/lib/authz/permissions.ts` decides which controls to render; the RLS
 * policies decide what actually happens. If those two drift apart the product
 * either offers actions that fail, or hides actions a member is entitled to.
 *
 * This test reads the policy expressions back out of a live PostgreSQL instance
 * and checks each one names the role the interface expects. It compares against
 * the real database, not against a second copy of the same assumption.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PERMISSIONS, type OrgRole, type Permission } from '../../src/lib/authz/permissions'

import { TestDatabase } from './support/harness'

/** Which table and command each interface permission ultimately hits. */
const PERMISSION_TARGETS: Partial<
  Record<Permission, { table: string; command: 'select' | 'insert' | 'update' | 'delete' }>
> = {
  'organization.view': { table: 'organizations', command: 'select' },
  'organization.update': { table: 'organizations', command: 'update' },

  'team.view': { table: 'organization_members', command: 'select' },

  'vehicles.view': { table: 'vehicles', command: 'select' },
  'vehicles.create': { table: 'vehicles', command: 'insert' },
  'vehicles.update': { table: 'vehicles', command: 'update' },
  'vehicles.delete': { table: 'vehicles', command: 'delete' },

  'vehicleDocuments.view': { table: 'vehicle_documents', command: 'select' },
  'vehicleDocuments.create': { table: 'vehicle_documents', command: 'insert' },
  'vehicleDocuments.update': { table: 'vehicle_documents', command: 'update' },
  'vehicleDocuments.delete': { table: 'vehicle_documents', command: 'delete' },

  'customers.view': { table: 'customers', command: 'select' },
  'customers.create': { table: 'customers', command: 'insert' },
  'customers.update': { table: 'customers', command: 'update' },
  'customers.delete': { table: 'customers', command: 'delete' },

  'customerDocuments.view': { table: 'customer_documents', command: 'select' },
  'customerDocuments.create': { table: 'customer_documents', command: 'insert' },
  'customerDocuments.update': { table: 'customer_documents', command: 'update' },
  'customerDocuments.delete': { table: 'customer_documents', command: 'delete' },

  'rentals.view': { table: 'rentals', command: 'select' },
  'rentals.create': { table: 'rentals', command: 'insert' },
  'rentals.update': { table: 'rentals', command: 'update' },
  'rentals.delete': { table: 'rentals', command: 'delete' },

  'payments.view': { table: 'payments', command: 'select' },
  'payments.create': { table: 'payments', command: 'insert' },
  'payments.update': { table: 'payments', command: 'update' },
  'payments.delete': { table: 'payments', command: 'delete' },

  'expenses.view': { table: 'expenses', command: 'select' },
  'expenses.create': { table: 'expenses', command: 'insert' },
  'expenses.update': { table: 'expenses', command: 'update' },
  'expenses.delete': { table: 'expenses', command: 'delete' },

  // Creating a supplier while recording a repair; changing the category list.
  'expenseVendors.manage': { table: 'expense_vendors', command: 'insert' },
  'expenseCategories.manage': { table: 'expense_categories', command: 'insert' },

  'financing.view': { table: 'financing_agreements', command: 'select' },
  'financing.create': { table: 'financing_agreements', command: 'insert' },
  'financing.update': { table: 'financing_agreements', command: 'update' },
  'financing.delete': { table: 'financing_agreements', command: 'delete' },

  'financingPayments.view': { table: 'financing_payments', command: 'select' },
  'financingPayments.create': { table: 'financing_payments', command: 'insert' },
  'financingPayments.void': { table: 'financing_payments', command: 'update' },

  'financingDocuments.view': { table: 'financing_documents', command: 'select' },
  'financingDocuments.create': { table: 'financing_documents', command: 'insert' },
  'financingDocuments.delete': { table: 'financing_documents', command: 'delete' },

  'lenders.view': { table: 'lenders', command: 'select' },
  'lenders.manage': { table: 'lenders', command: 'insert' },

  // Tracking. Viewing is the fleet read model; assigning a device is the one
  // write a browser makes, and it goes through gps_unit_assignments.
  'gps.view': { table: 'gps_provider_connections', command: 'select' },
  'gps.assign': { table: 'gps_unit_assignments', command: 'insert' },
}

/**
 * Permissions with no single table behind them.
 * `reports.view` reads across several tables that each carry their own policy;
 * `billing.manage` belongs to the subscription module, which has no schema yet.
 */
const PERMISSIONS_WITHOUT_A_TABLE: readonly Permission[] = [
  'reports.view',
  'billing.manage',
  // Voiding is an UPDATE on expenses through expense_void(), which is SECURITY
  // INVOKER — so it is already covered by the 'expenses.update' policy above.
  'expenses.void',
  // Archiving is an UPDATE on customers, already covered by 'customers.update'.
  'customers.archive',
  /*
   * Tracking's two administration permissions have no table policy of their own,
   * and deliberately so: connecting a provider and synchronising it happen
   * inside the `gps-provider` Edge Function, which checks the caller's role
   * against `organization_members` before it touches the credential. The
   * corresponding tables (`gps_provider_connections`, `gps_units`,
   * `gps_positions`) are readable under RLS and writable ONLY by the service
   * role — a browser cannot insert into them at any role, which is stricter than
   * a policy would be. `supabase/tests/gps.test.ts` proves both halves.
   */
  'gps.connect',
  'gps.sync',
  /*
   * Team's three write permissions had table policies until 20260821100000 took
   * INSERT, UPDATE and DELETE on organization_members away from `authenticated`
   * outright. A policy that asked only `has_min_role(organization_id, 'admin')`
   * could not express what actually governs a membership change — who may grant
   * which role, that nobody edits their own, that an owner always survives, that
   * it is recorded — so the write path moved into functions that can, and the
   * grants went with the policies. The refusal is now a missing privilege rather
   * than a failing policy, which is strictly stronger; `team.test.ts` attacks
   * each function from every role, and the test below proves the grants are
   * gone.
   */
  'team.invite',
  'team.update',
  'team.remove',
  'team.transferOwnership',
  'team.history',
]

const COMMAND_CODES: Record<string, 'select' | 'insert' | 'update' | 'delete'> = {
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
}

interface PolicyRow {
  table_name: string
  policy_name: string
  command: string
  using_expression: string | null
  check_expression: string | null
}

let db: TestDatabase
let policies: PolicyRow[]

beforeAll(async () => {
  db = await TestDatabase.create()

  policies = await db.sql<PolicyRow>(`
    select
      c.relname                                as table_name,
      p.polname                                as policy_name,
      p.polcmd::text                           as command,
      pg_get_expr(p.polqual, p.polrelid)       as using_expression,
      pg_get_expr(p.polwithcheck, p.polrelid)  as check_expression
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
  `)
}, 120_000)

afterAll(async () => {
  await db?.close()
})

/** The expression a given command is actually gated by. */
function expressionFor(table: string, command: string): string | null {
  const match = policies.find(
    (policy) => policy.table_name === table && COMMAND_CODES[policy.command] === command,
  )
  if (!match) return null

  // INSERT is governed by WITH CHECK; the others by USING (plus WITH CHECK on UPDATE).
  return command === 'insert'
    ? match.check_expression
    : (match.using_expression ?? match.check_expression)
}

/** Does the policy expression enforce at least `role`? */
function enforcesRole(expression: string, role: OrgRole): boolean {
  if (role === 'staff') {
    // staff is the lowest rank, so plain membership is equivalent.
    return (
      expression.includes('is_org_member') || /has_min_role\([^)]*'staff'/.test(expression)
    )
  }
  return new RegExp(`has_min_role\\([^)]*'${role}'`).test(expression)
}

describe('interface permissions match database policies', () => {
  it('covers every declared permission', () => {
    const declared = Object.keys(PERMISSIONS) as Permission[]
    const accountedFor = new Set([
      ...Object.keys(PERMISSION_TARGETS),
      ...PERMISSIONS_WITHOUT_A_TABLE,
    ])

    // A new permission must be mapped to a policy here, or explicitly excused.
    expect(declared.filter((permission) => !accountedFor.has(permission))).toEqual([])
  })

  it.each(
    (Object.entries(PERMISSION_TARGETS) as [Permission, { table: string; command: string }][]).map(
      ([permission, target]) => ({
        permission,
        table: target.table,
        command: target.command,
        role: PERMISSIONS[permission],
      }),
    ),
  )(
    '$permission ($role) matches the $command policy on $table',
    ({ table, command, role, permission }) => {
      const expression = expressionFor(table, command)

      expect(expression, `no ${command} policy exists on public.${table}`).not.toBeNull()
      expect(
        enforcesRole(expression!, role),
        `${permission} expects '${role}' but the ${command} policy on ${table} is: ${expression}`,
      ).toBe(true)
    },
  )
})

describe('policy coverage', () => {
  it('protects every table in the public schema', async () => {
    const unprotected = await db.sql<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and (not c.relrowsecurity
             or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
    `)

    expect(unprotected.map((row) => row.relname)).toEqual([])
  })

  it('grants the anonymous role nothing on any tenant table', async () => {
    const grants = await db.sql<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'anon' and table_schema = 'public'
    `)

    expect(grants).toEqual([])
  })

  it('leaves no direct write path to membership, invitations or team history', async () => {
    /*
     * The tables the whole authorization model rests on. A grant reappearing
     * here — through a hand-run statement, a restored backup, or Supabase's
     * default privileges being re-applied — would put every invariant in the
     * Team module back to being optional, so it is asserted rather than assumed.
     */
    const grants = await db.sql<{ table_name: string; grantee: string; privilege_type: string }>(`
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon', 'authenticated')
        and (
          (table_name = 'organization_members' and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
          or table_name in ('organization_invitations', 'organization_team_events')
        )
      order by table_name, grantee, privilege_type
    `)

    expect(grants).toEqual([])
  })

  it('keeps the invitation preview away from every role a browser can hold', async () => {
    // It is the one function that answers a question about an invitation without
    // checking membership, because its only key is the token itself.
    const [row] = await db.sql<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      select
        has_function_privilege('anon', 'public.preview_team_invitation(text)', 'EXECUTE') as anon,
        has_function_privilege('authenticated', 'public.preview_team_invitation(text)', 'EXECUTE') as authenticated,
        has_function_privilege('service_role', 'public.preview_team_invitation(text)', 'EXECUTE') as service
    `)

    expect(row).toEqual({ anon: false, authenticated: false, service: true })
  })

  it('grants the anonymous role no EXECUTE on any public function', async () => {
    // Supabase's default privileges grant EXECUTE to anon explicitly, and
    // `revoke ... from public` does not remove an explicit per-role grant. The
    // test harness reproduces those defaults, so this assertion is meaningful
    // rather than vacuous — it caught exactly this on the live project.
    const reachable = await db.sql<{ proname: string }>(`
      select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('anon', p.oid, 'EXECUTE')
      order by p.proname
    `)

    expect(reachable.map((row) => row.proname)).toEqual([])
  })

  it('keeps the private app schema out of the anonymous role’s reach', async () => {
    const [usage] = await db.sql<{ has_usage: boolean }>(
      `select has_schema_privilege('anon', 'app', 'USAGE') as has_usage`,
    )
    expect(usage?.has_usage).toBe(false)
  })

  it('grants the anonymous role no EXECUTE inside the private app schema either', async () => {
    /*
     * Thirty-nine of the sixty-six functions in `app` carried an anonymous
     * EXECUTE grant, accumulated one migration at a time from Supabase's default
     * privileges — the same way it happened in `public` before 20260814110000
     * caught it there. Nothing was reachable through it (no schema USAGE, and
     * PostgREST exposes only `public`), but the boundary was not where the
     * schema said it was, and one of those functions is now SECURITY DEFINER.
     */
    const reachable = await db.sql<{ proname: string }>(`
      select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'EXECUTE')
      order by p.proname
    `)

    expect(reachable.map((row) => row.proname)).toEqual([])
  })

  it('keeps the authorization helpers callable by a signed-in user', async () => {
    // Every RLS policy is written in terms of these four and a policy expression
    // is evaluated with the caller's own privileges, so revoking them from
    // `authenticated` would refuse every signed-in request on every table.
    const helpers = await db.sql<{ proname: string }>(`
      select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in ('is_org_member', 'has_min_role', 'current_role_in', 'shares_organization_with')
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      order by p.proname
    `)

    expect(helpers.map((row) => row.proname)).toEqual([
      'current_role_in',
      'has_min_role',
      'is_org_member',
      'shares_organization_with',
    ])
  })

  it('restricts every policy to the authenticated role', async () => {
    const openPolicies = await db.sql<{ table_name: string; policy_name: string }>(`
      select c.relname as table_name, p.polname as policy_name
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and (p.polroles = '{0}'::oid[]                       -- PUBLIC
             or exists (select 1 from unnest(p.polroles) r
                        where r::regrole::text = 'anon'))
    `)

    expect(openPolicies).toEqual([])
  })
})
