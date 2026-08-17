import { describe, expect, it } from 'vitest'

import {
  ORG_ROLES,
  PERMISSIONS,
  type OrgRole,
  type Permission,
  can,
  hasMinRole,
  isOrgRole,
  requiredRoleFor,
  roleRank,
} from './permissions'

describe('role hierarchy', () => {
  it('orders owner above admin above manager above staff', () => {
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'))
    expect(roleRank('admin')).toBeGreaterThan(roleRank('manager'))
    expect(roleRank('manager')).toBeGreaterThan(roleRank('staff'))
  })

  it('satisfies a role requirement with itself', () => {
    for (const role of ORG_ROLES) {
      expect(hasMinRole(role, role)).toBe(true)
    }
  })

  it('grants a higher role everything a lower one has', () => {
    expect(hasMinRole('owner', 'staff')).toBe(true)
    expect(hasMinRole('admin', 'manager')).toBe(true)
    expect(hasMinRole('manager', 'staff')).toBe(true)
  })

  it('refuses a lower role what a higher one requires', () => {
    expect(hasMinRole('staff', 'manager')).toBe(false)
    expect(hasMinRole('manager', 'admin')).toBe(false)
    expect(hasMinRole('admin', 'owner')).toBe(false)
  })

  it('treats absence of a role as no access at all', () => {
    expect(hasMinRole(null, 'staff')).toBe(false)
    expect(hasMinRole(undefined, 'staff')).toBe(false)
    expect(can(null, 'organization.view')).toBe(false)
  })

  it('recognises only the four defined roles', () => {
    expect(isOrgRole('owner')).toBe(true)
    expect(isOrgRole('superadmin')).toBe(false)
    expect(isOrgRole('')).toBe(false)
    expect(isOrgRole(null)).toBe(false)
  })
})

describe('permission matrix', () => {
  const permissions = Object.keys(PERMISSIONS) as Permission[]

  it('maps every permission to a real role', () => {
    for (const permission of permissions) {
      expect(ORG_ROLES).toContain(requiredRoleFor(permission))
    }
  })

  it('grants an owner every permission', () => {
    for (const permission of permissions) {
      expect(can('owner', permission)).toBe(true)
    }
  })

  it('is monotonic: a role that can do something implies every higher role can too', () => {
    const ascending: OrgRole[] = ['staff', 'manager', 'admin', 'owner']

    for (const permission of permissions) {
      let seenAllowed = false
      for (const role of ascending) {
        const allowed = can(role, permission)
        if (seenAllowed) {
          expect(allowed).toBe(true)
        }
        if (allowed) seenAllowed = true
      }
    }
  })

  it('keeps front-desk staff out of financing, reports and billing', () => {
    expect(can('staff', 'financing.view')).toBe(false)
    expect(can('staff', 'reports.view')).toBe(false)
    expect(can('staff', 'billing.manage')).toBe(false)
    expect(can('staff', 'organization.update')).toBe(false)
    expect(can('staff', 'team.invite')).toBe(false)
  })

  it('lets front-desk staff do front-desk work', () => {
    expect(can('staff', 'customers.create')).toBe(true)
    expect(can('staff', 'rentals.create')).toBe(true)
    expect(can('staff', 'payments.create')).toBe(true)
    expect(can('staff', 'organization.view')).toBe(true)
  })

  it('reserves destructive financial actions for administrators and above', () => {
    expect(can('manager', 'payments.delete')).toBe(false)
    expect(can('admin', 'payments.delete')).toBe(true)
    expect(can('admin', 'financing.delete')).toBe(false)
    expect(can('owner', 'financing.delete')).toBe(true)
  })
})
