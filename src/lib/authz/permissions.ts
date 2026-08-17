/**
 * The client-side view of the permission model.
 *
 * IMPORTANT: nothing here grants anything. Authorization is enforced by Row
 * Level Security in `supabase/migrations/20260813090600_rls.sql`; this module
 * exists so the interface can avoid *offering* an action the database is going
 * to refuse. Hiding a button is a courtesy, not a control.
 *
 * The matrix below mirrors the policy matrix in that migration one-for-one, and
 * `permissions.test.ts` reads the live policy expressions back out of Postgres
 * to prove the two have not drifted apart.
 */

export const ORG_ROLES = ['owner', 'admin', 'manager', 'staff'] as const

export type OrgRole = (typeof ORG_ROLES)[number]

/** Mirrors app.role_rank() in SQL. */
const ROLE_RANK: Readonly<Record<OrgRole, number>> = {
  owner: 40,
  admin: 30,
  manager: 20,
  staff: 10,
}

export const ROLE_LABELS: Readonly<Record<OrgRole, string>> = {
  owner: 'Owner',
  admin: 'Administrator',
  manager: 'Manager',
  staff: 'Staff',
}

export const ROLE_DESCRIPTIONS: Readonly<Record<OrgRole, string>> = {
  owner: 'Full control, including billing, ownership transfer and account closure.',
  admin: 'Manages the team, agency settings, financing and the whole fleet.',
  manager: 'Runs day-to-day operations: fleet, contracts, expenses and reporting.',
  staff: 'Front desk: books contracts, records customers and takes payments.',
}

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)
}

export function roleRank(role: OrgRole): number {
  return ROLE_RANK[role]
}

/** Mirrors app.has_min_role(). */
export function hasMinRole(role: OrgRole | null | undefined, minimum: OrgRole): boolean {
  if (!role) return false
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/**
 * Every action the interface gates, and the minimum role the database requires
 * for it. Keys are `<resource>.<action>` so a new module extends this list
 * without restructuring it.
 */
export const PERMISSIONS = {
  'organization.view': 'staff',
  'organization.update': 'admin',

  /*
   * Team.
   *
   * Viewing the roster stays with staff, as it always has. That is not a
   * concession: `profiles` is readable to anyone who shares an agency with you
   * and carries the address GoTrue holds, so the names and emails of colleagues
   * are already organization-internal information every member can reach.
   * Hiding the roster from the front desk would remove a page, not a capability.
   *
   * Everything that *changes* membership starts at administrator, and a manager
   * gains none of it by virtue of reading Reports and financing terms — running
   * the day and deciding who may run it are different authorities. The
   * invitation list and the membership history are administrator-only too:
   * both name people who are not members yet, or are no longer members.
   *
   * These four are not backed by a table policy. Since 20260821100000 the
   * client holds no write privilege on organization_members at all and every
   * change runs inside a database function that checks the caller itself; these
   * entries decide which controls to render, and nothing else.
   */
  'team.view': 'staff',
  'team.invite': 'admin',
  'team.update': 'admin',
  'team.remove': 'admin',
  'team.history': 'admin',
  'team.transferOwnership': 'owner',

  'vehicles.view': 'staff',
  'vehicles.create': 'manager',
  'vehicles.update': 'manager',
  'vehicles.delete': 'admin',

  'vehicleDocuments.view': 'staff',
  'vehicleDocuments.create': 'manager',
  'vehicleDocuments.update': 'manager',
  'vehicleDocuments.delete': 'admin',

  'customers.view': 'staff',
  'customers.create': 'staff',
  'customers.update': 'staff',
  'customers.archive': 'staff',
  // Permanent removal of a person's record, in line with vehicles.delete.
  'customers.delete': 'admin',

  // Recording identification is front-desk work; discarding it is not.
  'customerDocuments.view': 'staff',
  'customerDocuments.create': 'staff',
  'customerDocuments.update': 'staff',
  'customerDocuments.delete': 'manager',

  'rentals.view': 'staff',
  'rentals.create': 'staff',
  'rentals.update': 'staff',
  'rentals.delete': 'manager',

  'payments.view': 'staff',
  'payments.create': 'staff',
  'payments.update': 'manager',
  'payments.delete': 'admin',

  // Everyone at the desk may see what the agency spends; recording it is a
  // manager's job, as it always was. Voiding sits with recording because a void
  // destroys nothing — it is the correction path, and making it rarer than the
  // mistake it fixes would only encourage worse corrections.
  'expenses.view': 'staff',
  'expenses.create': 'manager',
  'expenses.update': 'manager',
  'expenses.void': 'manager',
  'expenses.delete': 'admin',

  // A supplier is operational: a manager recording a repair must be able to add
  // the garage they just used. The category list is structural — renaming one
  // changes how every historical cost reads — so it belongs to an administrator.
  'expenseVendors.manage': 'manager',
  'expenseCategories.manage': 'admin',

  /*
   * Financing keeps the boundary the foundation set: terms are commercially
   * sensitive, so a manager may look and an administrator manages. Recording a
   * lender payment moves a balance and settles an obligation, so it sits with
   * the administrator who owns the agreement rather than with the manager who
   * files a fuel receipt. Only an owner may destroy an unused draft.
   */
  'financing.view': 'manager',
  'financing.create': 'admin',
  'financing.update': 'admin',
  'financing.delete': 'owner',

  'financingPayments.view': 'manager',
  'financingPayments.create': 'admin',
  'financingPayments.void': 'admin',

  'financingDocuments.view': 'manager',
  'financingDocuments.create': 'admin',
  'financingDocuments.delete': 'admin',

  'lenders.view': 'manager',
  'lenders.manage': 'admin',

  /*
   * Tracking. Seeing where the fleet is is operational information the person
   * running the day needs, so viewing sits with the manager alongside the cost
   * ledger and the financing terms they already read. Staff get nothing: a
   * front-desk clerk does not need every car's location, and a vehicle's
   * position during an active rental is a customer's movements.
   *
   * Administration matches Financing exactly. Linking a provider means handing
   * this product a credential to somebody else's system, and assigning a device
   * decides whose location the agency watches — both are an administrator's.
   */
  'gps.view': 'manager',
  'gps.connect': 'admin',
  'gps.assign': 'admin',
  'gps.sync': 'admin',

  'reports.view': 'manager',
  'billing.manage': 'owner',
} as const satisfies Record<string, OrgRole>

export type Permission = keyof typeof PERMISSIONS

export function requiredRoleFor(permission: Permission): OrgRole {
  return PERMISSIONS[permission]
}

/** True when a member holding `role` may attempt `permission`. */
export function can(role: OrgRole | null | undefined, permission: Permission): boolean {
  return hasMinRole(role, PERMISSIONS[permission])
}
