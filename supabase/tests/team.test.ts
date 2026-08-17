// @vitest-environment node
/**
 * The Team, invitation and membership module, against a real PostgreSQL.
 *
 * Membership is the authorization fact every other module reads, so most of what
 * is asserted here is not "does the feature work" but "does the feature refuse".
 * Each attack is run as the Postgres `authenticated` role with auth.uid() set to
 * the attacker — the same position a browser occupies — so a passing test means
 * the database refused, not that a component declined to render a button.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { TestDatabase, addMember, signUp } from './support/harness'

let db: TestDatabase

/** One agency with a full cast, rebuilt for each test that mutates membership. */
interface Cast {
  organizationId: string
  owner: string
  admin: string
  manager: string
  staff: string
  outsiderOrg: string
  outsider: string
}

let seq = 0

async function seedCast(): Promise<Cast> {
  seq += 1
  const suffix = `${seq}`

  const owner = await signUp(db, {
    email: `owner${suffix}@atlas.test`,
    fullName: 'Owner One',
    organizationName: `Atlas ${suffix}`,
  })
  if (!owner.organizationId) throw new Error('provisioning did not create an agency')

  const admin = await signUp(db, { email: `admin${suffix}@atlas.test`, fullName: 'Admin One' })
  const manager = await signUp(db, { email: `manager${suffix}@atlas.test`, fullName: 'Manager One' })
  const staff = await signUp(db, { email: `staff${suffix}@atlas.test`, fullName: 'Staff One' })

  await addMember(db, owner.organizationId, admin.userId, 'admin')
  await addMember(db, owner.organizationId, manager.userId, 'manager')
  await addMember(db, owner.organizationId, staff.userId, 'staff')

  const outsider = await signUp(db, {
    email: `rival${suffix}@rival.test`,
    fullName: 'Rival Owner',
    organizationName: `Rival ${suffix}`,
  })
  if (!outsider.organizationId) throw new Error('rival provisioning failed')

  return {
    organizationId: owner.organizationId,
    owner: owner.userId,
    admin: admin.userId,
    manager: manager.userId,
    staff: staff.userId,
    outsiderOrg: outsider.organizationId,
    outsider: outsider.userId,
  }
}

/** Creates an invitation as `actor` and returns the one-time token. */
async function invite(
  actor: string,
  organizationId: string,
  email: string,
  role: 'admin' | 'manager' | 'staff',
): Promise<{ invitationId: string; token: string; outcome: string }> {
  return db.asUser(actor, async (session) => {
    const [row] = await session.sql<{
      invitation_id: string
      token: string
      outcome: string
    }>(`select * from public.create_team_invitation($1, $2, $3)`, [organizationId, email, role])
    if (!row) throw new Error('no invitation returned')
    return { invitationId: row.invitation_id, token: row.token, outcome: row.outcome }
  })
}

/**
 * Moves an invitation's issue clock into the past.
 *
 * The resend floor is deliberately measured from when a token was last minted,
 * so a test that reissues immediately is testing the throttle rather than the
 * thing it meant to test. This ages the row the way two minutes of real time
 * would, without two minutes of real time.
 */
async function ageInvitation(invitationId: string, interval = '10 minutes'): Promise<void> {
  await db.sql(
    `update public.organization_invitations
        set last_issued_at = now() - $2::interval
      where id = $1`,
    [invitationId, interval],
  )
}

async function roleOf(organizationId: string, userId: string): Promise<string | null> {
  const [row] = await db.sql<{ role: string }>(
    `select role from public.organization_members where organization_id = $1 and user_id = $2 and status = 'active'`,
    [organizationId, userId],
  )
  return row?.role ?? null
}

let cast: Cast

beforeAll(async () => {
  db = await TestDatabase.create()
}, 180_000)

afterAll(async () => {
  await db?.close()
})

beforeEach(async () => {
  cast = await seedCast()
})

// -----------------------------------------------------------------------------
describe('the write surface', () => {
  it('grants no client role INSERT, UPDATE or DELETE on organization_members', async () => {
    const grants = await db.sql<{ grantee: string; privilege_type: string }>(`
      select grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'organization_members'
        and grantee in ('anon', 'authenticated')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    `)
    expect(grants).toEqual([])
  })

  it('refuses a direct promotion even to an administrator', async () => {
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `update public.organization_members set role = 'owner' where organization_id = $1 and user_id = $2`,
            [cast.organizationId, cast.admin],
          ),
        /permission denied/i,
      )
    })

    expect(await roleOf(cast.organizationId, cast.admin)).toBe('admin')
  })

  it('refuses a direct membership insert', async () => {
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'admin')`,
            [cast.organizationId, cast.outsider],
          ),
        /permission denied/i,
      )
    })
  })

  it('refuses a direct membership delete', async () => {
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(
            `delete from public.organization_members where organization_id = $1 and user_id = $2`,
            [cast.organizationId, cast.staff],
          ),
        /permission denied/i,
      )
    })
    expect(await roleOf(cast.organizationId, cast.staff)).toBe('staff')
  })

  it('grants no client role any access to the invitation or history tables', async () => {
    const grants = await db.sql<{ table_name: string }>(`
      select table_name
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name in ('organization_invitations', 'organization_team_events')
        and grantee in ('anon', 'authenticated')
    `)
    expect(grants).toEqual([])
  })
})

// -----------------------------------------------------------------------------
describe('who may invite, and as what', () => {
  it('lets an owner invite an administrator', async () => {
    const result = await invite(cast.owner, cast.organizationId, 'new@atlas.test', 'admin')
    expect(result.outcome).toBe('created')
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('lets an administrator invite another administrator', async () => {
    const result = await invite(cast.admin, cast.organizationId, 'peer@atlas.test', 'admin')
    expect(result.outcome).toBe('created')
  })

  it('refuses a manager', async () => {
    await db.asUser(cast.manager, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.create_team_invitation($1, $2, 'staff')`, [
            cast.organizationId,
            'nope@atlas.test',
          ]),
        /cannot invite/i,
      )
    })
  })

  it('refuses a staff member', async () => {
    await db.asUser(cast.staff, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.create_team_invitation($1, $2, 'admin')`, [
            cast.organizationId,
            'nope@atlas.test',
          ]),
        /cannot invite/i,
      )
    })
  })

  it('refuses owner as an invited role, from the owner themselves', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.create_team_invitation($1, $2, 'owner')`, [
            cast.organizationId,
            'heir@atlas.test',
          ]),
        /transferred, not invited/i,
      )
    })
  })

  it('refuses owner at the storage layer too', async () => {
    await db.expectRejection(
      () =>
        db.sql(
          `insert into public.organization_invitations
             (organization_id, email, email_normalized, role, expires_at, token_digest)
           values ($1, 'x@atlas.test', 'x@atlas.test', 'owner', now() + interval '1 day', '\\x00')`,
          [cast.organizationId],
        ),
      /organization_invitations_never_owner/,
    )
  })

  it('refuses an outsider naming another agency', async () => {
    await db.asUser(cast.outsider, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.create_team_invitation($1, $2, 'staff')`, [
            cast.organizationId,
            'wedge@rival.test',
          ]),
        /not a member/i,
      )
    })
  })
})

// -----------------------------------------------------------------------------
describe('invitation lifecycle', () => {
  it('stores a digest and never the token', async () => {
    const { token, invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'digest@atlas.test',
      'staff',
    )

    const [row] = await db.sql<{ has_token: number; digest_matches: boolean }>(
      `select
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'organization_invitations'
             and column_name in ('token', 'raw_token', 'secret'))::int as has_token,
         token_digest = sha256(convert_to($2, 'utf8')) as digest_matches
       from public.organization_invitations where id = $1`,
      [invitationId, token],
    )

    expect(row?.has_token).toBe(0)
    expect(row?.digest_matches).toBe(true)
  })

  it('produces a different token every time', async () => {
    const tokens = new Set<string>()
    for (let index = 0; index < 5; index += 1) {
      const { token } = await invite(
        cast.owner,
        cast.organizationId,
        `unique${index}@atlas.test`,
        'staff',
      )
      tokens.add(token)
    }
    expect(tokens.size).toBe(5)
  })

  it('reissues rather than duplicating a second invitation to the same address', async () => {
    const first = await invite(cast.owner, cast.organizationId, 'dup@atlas.test', 'staff')
    await ageInvitation(first.invitationId)
    const second = await invite(cast.admin, cast.organizationId, 'DUP@atlas.test', 'manager')

    expect(second.outcome).toBe('reissued')
    expect(second.invitationId).toBe(first.invitationId)
    expect(second.token).not.toBe(first.token)

    const [row] = await db.sql<{ count: string; role: string }>(
      `select count(*)::text as count, max(role::text) as role
       from public.organization_invitations
       where organization_id = $1 and email_normalized = 'dup@atlas.test'`,
      [cast.organizationId],
    )
    expect(row?.count).toBe('1')
    expect(row?.role).toBe('manager')
  })

  it('lets a second agency invite the same address independently', async () => {
    await invite(cast.owner, cast.organizationId, 'shared@person.test', 'staff')
    const other = await invite(cast.outsider, cast.outsiderOrg, 'shared@person.test', 'manager')
    expect(other.outcome).toBe('created')
  })

  it('reports an existing member instead of inviting them again', async () => {
    const result = await invite(cast.owner, cast.organizationId, `staff${seq}@atlas.test`, 'staff')
    expect(result.outcome).toBe('already_member')
    expect(result.token).toBeNull()
  })

  it('normalises case and surrounding whitespace', async () => {
    const first = await invite(cast.owner, cast.organizationId, '  Case@Atlas.TEST ', 'staff')
    await ageInvitation(first.invitationId)
    const second = await invite(cast.owner, cast.organizationId, 'case@atlas.test', 'staff')
    expect(second.invitationId).toBe(first.invitationId)
  })

  it('refuses an address that is not one', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.create_team_invitation($1, 'not-an-address', 'staff')`, [
            cast.organizationId,
          ]),
        /not a valid email/i,
      )
    })
  })

  it('derives state from facts rather than storing a status', async () => {
    const columns = await db.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'organization_invitations'
         and column_name = 'status'`,
    )
    expect(columns).toEqual([])
  })
})

// -----------------------------------------------------------------------------
describe('resend and revoke', () => {
  it('rotates the token so the previous link stops working', async () => {
    const invited = await signUp(db, { email: 'rotate@atlas.test', fullName: 'Rotate' })
    const first = await invite(cast.owner, cast.organizationId, 'rotate@atlas.test', 'staff')
    await ageInvitation(first.invitationId)

    const second = await db.asUser(cast.owner, async (session) => {
      const [row] = await session.sql<{ token: string }>(
        `select * from public.resend_team_invitation($1)`,
        [first.invitationId],
      )
      return row!.token
    })

    expect(second).not.toBe(first.token)

    await db.asUser(invited.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [first.token]),
        /not valid/i,
      )
    })

    await db.asUser(invited.userId, async (session) => {
      const [row] = await session.sql<{ outcome: string }>(
        `select * from public.accept_team_invitation($1)`,
        [second],
      )
      expect(row?.outcome).toBe('joined')
    })
  })

  it('enforces the resend cooldown from the moment a token was minted', async () => {
    const first = await invite(cast.owner, cast.organizationId, 'cooldown@atlas.test', 'staff')

    /*
     * The regression this covers.
     *
     * The floor used to be measured from `last_sent_at`, which only
     * record_invitation_delivery() writes — a separate call the client makes
     * afterwards and may simply never make. Nothing below reports any delivery,
     * so under the old rule this loop was free: unlimited token rotations and
     * unlimited provider sends from one authorised account.
     */
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.resend_team_invitation($1)`, [first.invitationId]),
        /moments ago/i,
      )
    })

    const [row] = await db.sql<{ last_sent_at: string | null }>(
      `select last_sent_at from public.organization_invitations where id = $1`,
      [first.invitationId],
    )
    expect(row?.last_sent_at).toBeNull()
  })

  it('applies the same floor to inviting the same address again', async () => {
    // Otherwise "invite again" is a resend with the throttle taken off.
    await invite(cast.owner, cast.organizationId, 'again@atlas.test', 'staff')

    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.create_team_invitation($1, $2, 'staff')`, [
            cast.organizationId,
            'again@atlas.test',
          ]),
        /issued moments ago/i,
      )
    })
  })

  it('recording delivery cannot move the resend floor', async () => {
    const first = await invite(cast.owner, cast.organizationId, 'delivery@atlas.test', 'staff')

    await db.asUser(cast.owner, async (session) => {
      await session.sql(
        `select public.record_invitation_delivery($1, 'accepted_by_provider', 'test')`,
        [first.invitationId],
      )
    })

    const [row] = await db.sql<{ moved: boolean; sends: number }>(
      `select last_issued_at > created_at as moved, send_count as sends
       from public.organization_invitations where id = $1`,
      [first.invitationId],
    )
    // The delivery fact was recorded; the throttle clock was not touched.
    expect(row?.moved).toBe(false)
    expect(Number(row?.sends)).toBe(1)
  })

  it('caps how many invitations one agency can mint in an hour', async () => {
    // The ceiling is 25. Twenty-four more addresses reach it exactly.
    await db.sql(
      `insert into public.organization_invitations
         (organization_id, email, email_normalized, role, invited_by, expires_at, token_digest)
       select $1, 'flood' || n || '@atlas.test', 'flood' || n || '@atlas.test', 'staff', $2,
              now() + interval '7 days', sha256(convert_to('flood-' || n || $3, 'utf8'))
       from generate_series(1, 25) as n`,
      [cast.organizationId, cast.owner, cast.organizationId],
    )

    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select * from public.create_team_invitation($1, $2, 'staff')`, [
            cast.organizationId,
            'one.too.many@atlas.test',
          ]),
        /a lot of invitations/i,
      )
    })

    // Another agency is unaffected: the ceiling is per organization.
    const other = await invite(cast.outsider, cast.outsiderOrg, 'fine@rival.test', 'staff')
    expect(other.outcome).toBe('created')
  })

  it('invalidates the token on revoke', async () => {
    const invited = await signUp(db, { email: 'revoked@atlas.test', fullName: 'Revoked' })
    const { invitationId, token } = await invite(
      cast.owner,
      cast.organizationId,
      'revoked@atlas.test',
      'staff',
    )

    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.revoke_team_invitation($1, 'Changed our minds')`, [
        invitationId,
      ])
    })

    await db.asUser(invited.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /not valid/i,
      )
    })

    // The evidence survives; only the capability is gone.
    const [row] = await db.sql<{ revoke_reason: string; revoked_at: string }>(
      `select revoke_reason, revoked_at from public.organization_invitations where id = $1`,
      [invitationId],
    )
    expect(row?.revoke_reason).toBe('Changed our minds')
    expect(row?.revoked_at).not.toBeNull()
  })

  it('refuses a manager revoking an invitation', async () => {
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'guarded@atlas.test',
      'staff',
    )
    await db.asUser(cast.manager, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.revoke_team_invitation($1)`, [invitationId]),
        /cannot revoke/i,
      )
    })
  })

  it('refuses another agency touching an invitation it cannot see', async () => {
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'crosstenant@atlas.test',
      'staff',
    )
    await db.asUser(cast.outsider, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.revoke_team_invitation($1)`, [invitationId]),
        /not found/i,
      )
      await session.expectRejection(
        () => session.sql(`select * from public.resend_team_invitation($1)`, [invitationId]),
        /not found/i,
      )
    })
  })

  it('expires an invitation that has run out of time', async () => {
    const invited = await signUp(db, { email: 'stale@atlas.test', fullName: 'Stale' })
    const token = 'x'.repeat(43)

    /*
     * Written directly rather than created and then backdated: `created_at` is
     * frozen against updates and a CHECK forbids an expiry before it, so an
     * invitation cannot be edited into the past. This is one that was genuinely
     * issued ten days ago and lapsed three days later.
     */
    const [row] = await db.sql<{ id: string }>(
      `insert into public.organization_invitations
         (organization_id, email, email_normalized, role, invited_by,
          created_at, expires_at, token_digest)
       values ($1, 'stale@atlas.test', 'stale@atlas.test', 'staff', $2,
               now() - interval '10 days', now() - interval '3 days',
               sha256(convert_to($3, 'utf8')))
       returning id`,
      [cast.organizationId, cast.owner, token],
    )
    const invitationId = row!.id

    await db.asUser(invited.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /expired/i,
      )
    })

    // Still legible in the interface rather than quietly deleted.
    const [listed] = await db.asUser(cast.owner, (session) =>
      session.sql<{ state: string; id: string }>(
        `select id, state from public.team_invitations($1, true) where id = $2`,
        [cast.organizationId, invitationId],
      ),
    )
    expect(listed?.state).toBe('expired')
  })
})

// -----------------------------------------------------------------------------
describe('acceptance', () => {
  it('creates exactly one membership and closes the invitation', async () => {
    const invited = await signUp(db, { email: 'joiner@atlas.test', fullName: 'Joiner' })
    const { invitationId, token } = await invite(
      cast.owner,
      cast.organizationId,
      'joiner@atlas.test',
      'manager',
    )

    const outcome = await db.asUser(invited.userId, async (session) => {
      const [row] = await session.sql<{ outcome: string; role: string; organization_name: string }>(
        `select * from public.accept_team_invitation($1)`,
        [token],
      )
      return row
    })

    expect(outcome?.outcome).toBe('joined')
    expect(outcome?.role).toBe('manager')

    const memberships = await db.sql(
      `select 1 from public.organization_members where organization_id = $1 and user_id = $2`,
      [cast.organizationId, invited.userId],
    )
    expect(memberships).toHaveLength(1)

    const [invitation] = await db.sql<{ accepted_by: string }>(
      `select accepted_by from public.organization_invitations where id = $1`,
      [invitationId],
    )
    expect(invitation?.accepted_by).toBe(invited.userId)
  })

  it('refuses an account whose verified email is a different address', async () => {
    const wrong = await signUp(db, { email: 'someone.else@atlas.test', fullName: 'Wrong Account' })
    const { token } = await invite(cast.owner, cast.organizationId, 'intended@atlas.test', 'staff')

    await db.asUser(wrong.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /sent to a different account/i,
      )
    })

    expect(await roleOf(cast.organizationId, wrong.userId)).toBeNull()
  })

  it('refuses an account whose email is not confirmed', async () => {
    const unconfirmed = await signUp(db, { email: 'unconfirmed@atlas.test', fullName: 'Pending' })
    await db.sql(`update auth.users set email_confirmed_at = null where id = $1`, [
      unconfirmed.userId,
    ])
    const { token } = await invite(
      cast.owner,
      cast.organizationId,
      'unconfirmed@atlas.test',
      'staff',
    )

    await db.asUser(unconfirmed.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /confirm your email/i,
      )
    })
  })

  it('is idempotent for somebody who is already a member', async () => {
    const invited = await signUp(db, { email: 'already@atlas.test', fullName: 'Already' })
    const { token } = await invite(cast.owner, cast.organizationId, 'already@atlas.test', 'staff')
    await addMember(db, cast.organizationId, invited.userId, 'manager')

    const outcome = await db.asUser(invited.userId, async (session) => {
      const [row] = await session.sql<{ outcome: string; role: string }>(
        `select * from public.accept_team_invitation($1)`,
        [token],
      )
      return row
    })

    expect(outcome?.outcome).toBe('already_member')
    // The invitation did not overwrite the role they already hold.
    expect(outcome?.role).toBe('manager')

    const memberships = await db.sql(
      `select 1 from public.organization_members where organization_id = $1 and user_id = $2`,
      [cast.organizationId, invited.userId],
    )
    expect(memberships).toHaveLength(1)
  })

  it('refuses to be used twice', async () => {
    const invited = await signUp(db, { email: 'twice@atlas.test', fullName: 'Twice' })
    const { token } = await invite(cast.owner, cast.organizationId, 'twice@atlas.test', 'staff')

    await db.asUser(invited.userId, async (session) => {
      await session.sql(`select * from public.accept_team_invitation($1)`, [token])
    })

    // Removed again, then the same link tried a second time.
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.remove_team_member($1, $2)`, [
        cast.organizationId,
        invited.userId,
      ])
    })

    await db.asUser(invited.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /already been used/i,
      )
    })
  })

  it('readmits a suspended member rather than failing on a constraint', async () => {
    /*
     * `organization_members` is unique on (organization, user) and has carried a
     * `suspended` status since the foundation, so an acceptance that looked only
     * for an ACTIVE row would insert straight into a unique violation — a raw
     * database error shown to somebody who did nothing wrong.
     */
    const returning = await signUp(db, { email: 'suspended@atlas.test', fullName: 'Suspended' })
    await addMember(db, cast.organizationId, returning.userId, 'staff')
    await db.sql(
      `update public.organization_members set status = 'suspended'
        where organization_id = $1 and user_id = $2`,
      [cast.organizationId, returning.userId],
    )

    const { token } = await invite(cast.owner, cast.organizationId, 'suspended@atlas.test', 'manager')

    const outcome = await db.asUser(returning.userId, async (session) => {
      const [row] = await session.sql<{ outcome: string; role: string }>(
        `select * from public.accept_team_invitation($1)`,
        [token],
      )
      return row
    })

    expect(outcome?.outcome).toBe('joined')
    expect(outcome?.role).toBe('manager')
    expect(await roleOf(cast.organizationId, returning.userId)).toBe('manager')

    const memberships = await db.sql(
      `select 1 from public.organization_members where organization_id = $1 and user_id = $2`,
      [cast.organizationId, returning.userId],
    )
    expect(memberships).toHaveLength(1)

    const [event] = await db.sql<{ detail: string }>(
      `select detail from public.organization_team_events
       where organization_id = $1 and target_user_id = $2 and event = 'invitation_accepted'`,
      [cast.organizationId, returning.userId],
    )
    expect(event?.detail).toMatch(/suspended/i)
  })

  it('refuses a token that never existed without saying anything else', async () => {
    const nobody = await signUp(db, { email: 'nobody@atlas.test', fullName: 'Nobody' })
    await db.asUser(nobody.userId, async (session) => {
      const message = await session.expectRejection(() =>
        session.sql(`select * from public.accept_team_invitation($1)`, ['a'.repeat(43)]),
      )
      expect(message).toMatch(/not valid/i)
      expect(message).not.toMatch(/atlas|organization|expired|revoked/i)
    })
  })

  it('lets one person hold memberships in two agencies at once', async () => {
    const consultant = await signUp(db, { email: 'both@consult.test', fullName: 'Consultant' })

    const a = await invite(cast.owner, cast.organizationId, 'both@consult.test', 'manager')
    const b = await invite(cast.outsider, cast.outsiderOrg, 'both@consult.test', 'staff')

    await db.asUser(consultant.userId, async (session) => {
      await session.sql(`select * from public.accept_team_invitation($1)`, [a.token])
      await session.sql(`select * from public.accept_team_invitation($1)`, [b.token])
    })

    expect(await roleOf(cast.organizationId, consultant.userId)).toBe('manager')
    expect(await roleOf(cast.outsiderOrg, consultant.userId)).toBe('staff')
  })

  it('refuses an invitation whose author has lost the authority to have sent it', async () => {
    const invited = await signUp(db, { email: 'latent@atlas.test', fullName: 'Latent' })
    const { token } = await invite(cast.admin, cast.organizationId, 'latent@atlas.test', 'admin')

    // The administrator becomes staff. Their outstanding invitation should not
    // survive as a grant of a role they can no longer make.
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.change_team_member_role($1, $2, 'staff')`, [
        cast.organizationId,
        cast.admin,
      ])
    })

    await db.asUser(invited.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /not valid|no longer/i,
      )
    })

    expect(await roleOf(cast.organizationId, invited.userId)).toBeNull()
  })

  it('revokes a removed administrator’s outstanding invitations', async () => {
    const { invitationId } = await invite(
      cast.admin,
      cast.organizationId,
      'orphan@atlas.test',
      'manager',
    )

    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.remove_team_member($1, $2)`, [
        cast.organizationId,
        cast.admin,
      ])
    })

    const [row] = await db.sql<{ revoked_at: string | null }>(
      `select revoked_at from public.organization_invitations where id = $1`,
      [invitationId],
    )
    expect(row?.revoked_at).not.toBeNull()
  })
})

// -----------------------------------------------------------------------------
/**
 * What the adversarial review found.
 *
 * Each of these is a defect that survived two independent verifiers whose
 * instruction was to refute it, and each is written as the attack rather than as
 * the fix — so a regression restores the attack, not merely a red test.
 */
describe('review regressions', () => {
  it('refuses a spent token even when the member was later suspended', async () => {
    /*
     * The replay. Acceptance used to check for an existing membership BEFORE it
     * checked whether the invitation had been used, so somebody who accepted,
     * was suspended, and still held the original email could reinstate
     * themselves at the invited role — which may be higher than the role they
     * were suspended at — leaving an ordinary "joined" event as the only trace.
     */
    const eve = await signUp(db, { email: 'replay@atlas.test', fullName: 'Eve' })
    const { token } = await invite(cast.owner, cast.organizationId, 'replay@atlas.test', 'admin')

    await db.asUser(eve.userId, (session) =>
      session.sql(`select * from public.accept_team_invitation($1)`, [token]),
    )
    expect(await roleOf(cast.organizationId, eve.userId)).toBe('admin')

    await db.sql(
      `update public.organization_members set status = 'suspended', role = 'staff'
        where organization_id = $1 and user_id = $2`,
      [cast.organizationId, eve.userId],
    )

    await db.asUser(eve.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /already been used/i,
      )
    })

    const [row] = await db.sql<{ status: string; role: string }>(
      `select status, role from public.organization_members
        where organization_id = $1 and user_id = $2`,
      [cast.organizationId, eve.userId],
    )
    expect(row?.status).toBe('suspended')
    expect(row?.role).toBe('staff')
  })

  it('still answers the second of two tabs after a real acceptance', async () => {
    // The reason the token is not rotated on acceptance: the losing tab belongs
    // to somebody who has just successfully joined.
    const joiner = await signUp(db, { email: 'secondtab@atlas.test', fullName: 'Second Tab' })
    const { token } = await invite(
      cast.owner,
      cast.organizationId,
      'secondtab@atlas.test',
      'manager',
    )

    const outcomes = await db.asUser(joiner.userId, async (session) => {
      const first = await session.sql<{ outcome: string }>(
        `select * from public.accept_team_invitation($1)`,
        [token],
      )
      const second = await session.sql<{ outcome: string }>(
        `select * from public.accept_team_invitation($1)`,
        [token],
      )
      return [first[0]?.outcome, second[0]?.outcome]
    })
    expect(outcomes).toEqual(['joined', 'already_member'])
  })

  it('reads the roster address from Auth, so a member cannot forge a colleague', async () => {
    /*
     * `profiles` is writable by its owner and `email` sat inside that grant, so
     * any member could set it to a colleague's address — producing two roster
     * rows identical in name, address and role, with nothing on screen to tell
     * an owner which one they meant to promote.
     */
    await db.asUser(cast.staff, (session) =>
      session.sql(`update public.profiles set full_name = 'Manager One', email = $1 where id = $2`, [
        `manager${seq}@atlas.test`,
        cast.staff,
      ]),
    )

    const [mirrored] = await db.sql<{ email: string }>(
      `select email from public.profiles where id = $1`,
      [cast.staff],
    )
    // The mirror snapped back to the authority.
    expect(mirrored?.email).toBe(`staff${seq}@atlas.test`)

    const rows = await db.asUser(cast.owner, (session) =>
      session.sql<{ user_id: string; email: string; display_name: string }>(
        `select * from public.team_directory($1)`,
        [cast.organizationId],
      ),
    )
    const addresses = rows.map((row) => row.email)
    expect(new Set(addresses).size).toBe(addresses.length)
    expect(rows.find((row) => row.user_id === cast.staff)?.email).toBe(`staff${seq}@atlas.test`)
  })

  it('does not let a member suppress an invitation by claiming its address', async () => {
    // The same forgery, aimed at create_team_invitation's already-member check:
    // it answered "already_member", created nothing, and reported success.
    await db.sql(`update public.profiles set email = 'newcto@atlas.test' where id = $1`, [
      cast.staff,
    ])

    const result = await invite(cast.owner, cast.organizationId, 'newcto@atlas.test', 'admin')
    expect(result.outcome).toBe('created')
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('counts a resend against the agency ceiling', async () => {
    // The ceiling used to sit only on creation, so an agency with enough open
    // invitations could loop resends and use the product as a mail relay.
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'ceiling.resend@atlas.test',
      'staff',
    )
    await ageInvitation(invitationId)

    await db.sql(
      `insert into public.organization_invitations
         (organization_id, email, email_normalized, role, invited_by, expires_at, token_digest)
       select $1::uuid, 'bulk' || n || '@atlas.test', 'bulk' || n || '@atlas.test', 'staff', $2::uuid,
              now() + interval '7 days', sha256(convert_to('bulk-' || n || $3, 'utf8'))
       from generate_series(1, 25) as n`,
      [cast.organizationId, cast.owner, cast.organizationId],
    )

    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.resend_team_invitation($1)`, [invitationId]),
        /a lot of invitations/i,
      )
    })
  })

  it('moves invited_by to whoever last issued the invitation', async () => {
    /*
     * The authority cascade keys on `invited_by`. Leaving it on the original
     * author meant demoting them revoked an invitation a higher-authority
     * administrator had taken over, while demoting the administrator who
     * actually rotated the token and chose the role revoked nothing.
     */
    const first = await invite(cast.admin, cast.organizationId, 'handover@atlas.test', 'staff')
    await ageInvitation(first.invitationId)
    await invite(cast.owner, cast.organizationId, 'handover@atlas.test', 'admin')

    const [row] = await db.sql<{ invited_by: string; role: string }>(
      `select invited_by, role from public.organization_invitations where id = $1`,
      [first.invitationId],
    )
    expect(row?.invited_by).toBe(cast.owner)
    expect(row?.role).toBe('admin')

    // Demoting the original author now leaves the owner's invitation alone.
    await db.asUser(cast.owner, (session) =>
      session.sql(`select public.change_team_member_role($1, $2, 'staff')`, [
        cast.organizationId,
        cast.admin,
      ]),
    )
    const [after] = await db.sql<{ revoked_at: string | null }>(
      `select revoked_at from public.organization_invitations where id = $1`,
      [first.invitationId],
    )
    expect(after?.revoked_at).toBeNull()
  })

  it('records that a one-time link was handed over, once per issued token', async () => {
    // `manual_link` and its audit event existed and nothing ever wrote them,
    // so disclosing a bearer capability left no trace at all.
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'revealed@atlas.test',
      'staff',
    )

    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.record_invitation_delivery($1, 'manual_link', 'shown')`, [
        invitationId,
      ])
      // A second look at the same dialog is not a second disclosure.
      await session.sql(`select public.record_invitation_delivery($1, 'manual_link', 'shown')`, [
        invitationId,
      ])
    })

    const events = await db.sql(
      `select 1 from public.organization_team_events
        where invitation_id = $1 and event = 'invitation_link_revealed'`,
      [invitationId],
    )
    expect(events).toHaveLength(1)

    const [row] = await db.sql<{ delivery_state: string }>(
      `select delivery_state from public.organization_invitations where id = $1`,
      [invitationId],
    )
    expect(row?.delivery_state).toBe('manual_link')
  })

  it('does not leave a doomed revocation behind when the inviter loses authority', async () => {
    /*
     * The guard used to write a revocation and then raise, which rolled its own
     * write back — the link stayed live and became acceptable again the moment
     * its author was restored. The durable revocation belongs to the demotion,
     * which now shares a lock with invitation creation so the race cannot occur.
     */
    const target = await signUp(db, { email: 'latent2@atlas.test', fullName: 'Latent Two' })
    const { invitationId, token } = await invite(
      cast.admin,
      cast.organizationId,
      'latent2@atlas.test',
      'admin',
    )

    await db.sql(
      `update public.organization_members set role = 'manager'
        where organization_id = $1 and user_id = $2`,
      [cast.organizationId, cast.admin],
    )

    await db.asUser(target.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /no longer valid/i,
      )
    })

    // Refused, and honest about it: the row was not silently rewritten by a
    // statement that could never commit.
    const [row] = await db.sql<{ revoked_at: string | null; token_version: number }>(
      `select revoked_at, token_version from public.organization_invitations where id = $1`,
      [invitationId],
    )
    expect(row?.revoked_at).toBeNull()
    expect(Number(row?.token_version)).toBe(1)
    expect(await roleOf(cast.organizationId, target.userId)).toBeNull()
  })
})

// -----------------------------------------------------------------------------
describe('role changes', () => {
  it('lets an owner promote a staff member to manager', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.change_team_member_role($1, $2, 'manager')`, [
        cast.organizationId,
        cast.staff,
      ])
    })
    expect(await roleOf(cast.organizationId, cast.staff)).toBe('manager')
  })

  it('lets an administrator change another administrator', async () => {
    const peer = await signUp(db, { email: 'peer.admin@atlas.test', fullName: 'Peer' })
    await addMember(db, cast.organizationId, peer.userId, 'admin')

    await db.asUser(cast.admin, async (session) => {
      await session.sql(`select public.change_team_member_role($1, $2, 'manager')`, [
        cast.organizationId,
        peer.userId,
      ])
    })
    expect(await roleOf(cast.organizationId, peer.userId)).toBe('manager')
  })

  it('refuses self-promotion at every rank', async () => {
    for (const [actor, target] of [
      [cast.staff, 'manager'],
      [cast.manager, 'admin'],
      [cast.admin, 'owner'],
    ] as const) {
      await db.asUser(actor, async (session) => {
        await session.expectRejection(
          () =>
            session.sql(`select public.change_team_member_role($1, $2, $3)`, [
              cast.organizationId,
              actor,
              target,
            ]),
          /own role|cannot grant|transferred, not assigned/i,
        )
      })
    }

    expect(await roleOf(cast.organizationId, cast.staff)).toBe('staff')
    expect(await roleOf(cast.organizationId, cast.manager)).toBe('manager')
    expect(await roleOf(cast.organizationId, cast.admin)).toBe('admin')
  })

  it('refuses an administrator demoting the owner', async () => {
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.change_team_member_role($1, $2, 'staff')`, [
            cast.organizationId,
            cast.owner,
          ]),
        /cannot change the role of a owner/i,
      )
    })
    expect(await roleOf(cast.organizationId, cast.owner)).toBe('owner')
  })

  it('refuses a manager changing anybody', async () => {
    await db.asUser(cast.manager, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
            cast.organizationId,
            cast.staff,
          ]),
        /cannot change|cannot grant/i,
      )
    })
  })

  it('refuses assigning owner through the role-change path', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.change_team_member_role($1, $2, 'owner')`, [
            cast.organizationId,
            cast.admin,
          ]),
        /transferred, not assigned/i,
      )
    })
  })

  it('refuses acting on a member of another agency', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.change_team_member_role($1, $2, 'staff')`, [
            cast.organizationId,
            cast.outsider,
          ]),
        /not a member of this organization/i,
      )
    })
    expect(await roleOf(cast.outsiderOrg, cast.outsider)).toBe('owner')
  })

  it('writes one history entry naming both roles', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
        cast.organizationId,
        cast.manager,
      ])
    })

    const [event] = await db.sql<{
      event: string
      previous_role: string
      new_role: string
      actor_name: string
      target_name: string
    }>(
      `select event, previous_role, new_role, actor_name, target_name
       from public.organization_team_events
       where organization_id = $1 and event = 'role_changed'
       order by occurred_at desc limit 1`,
      [cast.organizationId],
    )

    expect(event?.previous_role).toBe('manager')
    expect(event?.new_role).toBe('admin')
    expect(event?.actor_name).toBe('Owner One')
    expect(event?.target_name).toBe('Manager One')
  })
})

// -----------------------------------------------------------------------------
describe('removal and leaving', () => {
  it('revokes access immediately for the removed member', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.remove_team_member($1, $2)`, [
        cast.organizationId,
        cast.manager,
      ])
    })

    await db.asUser(cast.manager, async (session) => {
      const orgs = await session.sql(`select id from public.organizations where id = $1`, [
        cast.organizationId,
      ])
      expect(orgs).toEqual([])

      const members = await session.sql(
        `select 1 from public.organization_members where organization_id = $1`,
        [cast.organizationId],
      )
      expect(members).toEqual([])
    })
  })

  it('keeps the account, the profile and the work behind', async () => {
    const vehicle = await db.sql<{ id: string }>(
      `insert into public.vehicles (organization_id, make, model, registration_plate, currency, created_by)
       values ($1, 'Dacia', 'Logan', 'REM-1', 'MAD', $2) returning id`,
      [cast.organizationId, cast.manager],
    )

    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.remove_team_member($1, $2)`, [
        cast.organizationId,
        cast.manager,
      ])
    })

    const [profile] = await db.sql<{ id: string }>(`select id from public.profiles where id = $1`, [
      cast.manager,
    ])
    expect(profile?.id).toBe(cast.manager)

    const [user] = await db.sql<{ id: string }>(`select id from auth.users where id = $1`, [
      cast.manager,
    ])
    expect(user?.id).toBe(cast.manager)

    const [row] = await db.sql<{ created_by: string }>(
      `select created_by from public.vehicles where id = $1`,
      [vehicle[0]!.id],
    )
    expect(row?.created_by).toBe(cast.manager)
  })

  it('leaves other agencies untouched', async () => {
    const consultant = await signUp(db, { email: 'multi@consult.test', fullName: 'Multi' })
    await addMember(db, cast.organizationId, consultant.userId, 'manager')
    await addMember(db, cast.outsiderOrg, consultant.userId, 'staff')

    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.remove_team_member($1, $2)`, [
        cast.organizationId,
        consultant.userId,
      ])
    })

    expect(await roleOf(cast.organizationId, consultant.userId)).toBeNull()
    expect(await roleOf(cast.outsiderOrg, consultant.userId)).toBe('staff')
  })

  it('refuses an administrator removing the owner', async () => {
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.remove_team_member($1, $2)`, [
            cast.organizationId,
            cast.owner,
          ]),
        /cannot remove a owner/i,
      )
    })
    expect(await roleOf(cast.organizationId, cast.owner)).toBe('owner')
  })

  it('refuses removing yourself through the generic path', async () => {
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.remove_team_member($1, $2)`, [
            cast.organizationId,
            cast.admin,
          ]),
        /leave organization/i,
      )
    })
  })

  it('lets a non-owner leave', async () => {
    await db.asUser(cast.staff, async (session) => {
      await session.sql(`select public.leave_organization($1)`, [cast.organizationId])
    })
    expect(await roleOf(cast.organizationId, cast.staff)).toBeNull()
  })

  it('refuses the last owner leaving', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () => session.sql(`select public.leave_organization($1)`, [cast.organizationId]),
        /transfer ownership before leaving/i,
      )
    })
    expect(await roleOf(cast.organizationId, cast.owner)).toBe('owner')
  })

  it('refuses demoting the last owner', async () => {
    // Even by themselves, and even through a second owner path.
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
            cast.organizationId,
            cast.owner,
          ]),
        /own role/i,
      )
    })
    expect(await roleOf(cast.organizationId, cast.owner)).toBe('owner')
  })
})

// -----------------------------------------------------------------------------
describe('ownership transfer', () => {
  it('moves ownership and sets the outgoing role in one transaction', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.transfer_organization_ownership($1, $2, 'admin')`, [
        cast.organizationId,
        cast.admin,
      ])
    })

    expect(await roleOf(cast.organizationId, cast.admin)).toBe('owner')
    expect(await roleOf(cast.organizationId, cast.owner)).toBe('admin')

    const [count] = await db.sql<{ owners: string }>(
      `select count(*)::text as owners from public.organization_members
       where organization_id = $1 and role = 'owner' and status = 'active'`,
      [cast.organizationId],
    )
    expect(count?.owners).toBe('1')
  })

  it('refuses an administrator initiating one', async () => {
    await db.asUser(cast.admin, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.transfer_organization_ownership($1, $2)`, [
            cast.organizationId,
            cast.admin,
          ]),
        /only the owner/i,
      )
    })
  })

  it('refuses a target from another agency', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.transfer_organization_ownership($1, $2)`, [
            cast.organizationId,
            cast.outsider,
          ]),
        /active member of this organization/i,
      )
    })
    expect(await roleOf(cast.organizationId, cast.owner)).toBe('owner')
  })

  it('refuses keeping owner as the outgoing role', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.transfer_organization_ownership($1, $2, 'owner')`, [
            cast.organizationId,
            cast.admin,
          ]),
        /role you will keep/i,
      )
    })
  })

  it('records who received it and what the previous owner became', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.transfer_organization_ownership($1, $2, 'manager')`, [
        cast.organizationId,
        cast.admin,
      ])
    })

    const [event] = await db.sql<{ new_role: string; detail: string; target_name: string }>(
      `select new_role, detail, target_name from public.organization_team_events
       where organization_id = $1 and event = 'ownership_transferred'`,
      [cast.organizationId],
    )
    expect(event?.new_role).toBe('owner')
    expect(event?.target_name).toBe('Admin One')
    expect(event?.detail).toMatch(/now manager/)
  })
})

// -----------------------------------------------------------------------------
describe('tenant isolation', () => {
  it('refuses a rival reading the roster, invitations or history', async () => {
    await invite(cast.owner, cast.organizationId, 'secret@atlas.test', 'staff')

    await db.asUser(cast.outsider, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.team_directory($1)`, [cast.organizationId]),
        /not a member/i,
      )
      await session.expectRejection(
        () => session.sql(`select * from public.team_invitations($1)`, [cast.organizationId]),
        /not permitted/i,
      )
      await session.expectRejection(
        () => session.sql(`select * from public.team_events($1)`, [cast.organizationId]),
        /not permitted/i,
      )
    })
  })

  it('refuses a manager and a staff member reading invitations or history', async () => {
    for (const actor of [cast.manager, cast.staff]) {
      await db.asUser(actor, async (session) => {
        await session.expectRejection(
          () => session.sql(`select * from public.team_invitations($1)`, [cast.organizationId]),
          /not permitted/i,
        )
        await session.expectRejection(
          () => session.sql(`select * from public.team_events($1)`, [cast.organizationId]),
          /not permitted/i,
        )
      })
    }
  })

  it('lets every member read the roster', async () => {
    for (const actor of [cast.owner, cast.admin, cast.manager, cast.staff]) {
      const rows = await db.asUser(actor, (session) =>
        session.sql<{ user_id: string; is_self: boolean }>(
          `select * from public.team_directory($1)`,
          [cast.organizationId],
        ),
      )
      expect(rows).toHaveLength(4)
      expect(rows.filter((row) => row.is_self)).toHaveLength(1)
    }
  })

  it('gives anon nothing at all', async () => {
    await db.asAnon(async (session) => {
      for (const statement of [
        `select * from public.team_directory('00000000-0000-0000-0000-000000000000')`,
        `select * from public.team_invitations('00000000-0000-0000-0000-000000000000')`,
        `select * from public.accept_team_invitation('x')`,
        `select * from public.preview_team_invitation('x')`,
        `select * from public.organization_invitations`,
        `select * from public.organization_team_events`,
      ]) {
        await session.expectRejection(() => session.sql(statement), /permission denied/i)
      }
    })
  })

  it('keeps the preview away from ordinary signed-in users', async () => {
    await db.asUser(cast.staff, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.preview_team_invitation('x')`),
        /permission denied/i,
      )
    })
  })
})

// -----------------------------------------------------------------------------
describe('what the delivery function may read', () => {
  it('gives an administrator the fields an email needs and no token', async () => {
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'message@atlas.test',
      'manager',
    )

    const [row] = await db.asUser(cast.admin, (session) =>
      session.sql<Record<string, unknown>>(
        `select * from public.team_invitation_message($1)`,
        [invitationId],
      ),
    )

    expect(row?.email).toBe('message@atlas.test')
    expect(row?.role).toBe('manager')
    expect(row?.invited_by_name).toBe('Owner One')
    expect(row?.organization_name).toContain('Atlas')
    expect(Object.keys(row ?? {})).not.toContain('token_digest')
  })

  it('refuses a manager, a staff member and another agency', async () => {
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'guarded.message@atlas.test',
      'staff',
    )

    for (const actor of [cast.manager, cast.staff, cast.outsider]) {
      await db.asUser(actor, async (session) => {
        await session.expectRejection(
          () => session.sql(`select * from public.team_invitation_message($1)`, [invitationId]),
          /not found/i,
        )
      })
    }
  })
})

// -----------------------------------------------------------------------------
describe('the preview endpoint', () => {
  it('returns the agency, role and expiry, and no address', async () => {
    const { token } = await invite(
      cast.owner,
      cast.organizationId,
      'preview.person@atlas.test',
      'manager',
    )

    const [row] = await db.sql<{
      organization_name: string
      role: string
      state: string
      email_masked: string
      invited_by_name: string
    }>(`select * from public.preview_team_invitation($1)`, [token])

    expect(row?.organization_name).toContain('Atlas')
    expect(row?.role).toBe('manager')
    expect(row?.state).toBe('pending')
    expect(row?.invited_by_name).toBe('Owner One')
    // One visible character and the domain; the rest of the local part is gone.
    expect(row?.email_masked).toBe(`p${'•'.repeat('preview.person'.length - 1)}@atlas.test`)
    expect(row?.email_masked).not.toContain('preview.person')
  })

  it('refuses an unknown token', async () => {
    await db.expectRejection(
      () => db.sql(`select * from public.preview_team_invitation($1)`, ['z'.repeat(43)]),
      /not valid/i,
    )
  })
})

// -----------------------------------------------------------------------------
describe('immutable history', () => {
  it('refuses an update or a delete even from the table owner', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
        cast.organizationId,
        cast.staff,
      ])
    })

    await db.expectRejection(
      () => db.sql(`update public.organization_team_events set detail = 'rewritten'`),
      /cannot be update/i,
    )
    await db.expectRejection(
      () => db.sql(`delete from public.organization_team_events`),
      /cannot be delete/i,
    )
  })

  it('does not make an Auth account undeletable', async () => {
    /*
     * The regression this covers, and it was found by a live cleanup failing.
     *
     * `actor_user_id`, `target_user_id` and `invited_by` all reference
     * auth.users with ON DELETE SET NULL, and that referential action is an
     * UPDATE. An immutability trigger that refused it — or a freeze that
     * silently reverted it — would make anybody who had ever appeared in team
     * history or sent an invitation impossible to delete from Auth, which is a
     * product that cannot honour an erasure request.
     */
    const leaving = await signUp(db, { email: 'erasable@atlas.test', fullName: 'Erasable' })
    await addMember(db, cast.organizationId, leaving.userId, 'admin')

    await db.asUser(leaving.userId, async (session) => {
      await session.sql(`select * from public.create_team_invitation($1, $2, 'staff')`, [
        cast.organizationId,
        'their.invite@atlas.test',
      ])
    })
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.remove_team_member($1, $2)`, [
        cast.organizationId,
        leaving.userId,
      ])
    })

    const before = await db.sql<{ n: string }>(
      `select count(*)::text as n from public.organization_team_events
       where actor_user_id = $1 or target_user_id = $1`,
      [leaving.userId],
    )
    expect(Number(before[0]!.n)).toBeGreaterThan(0)

    await db.sql(`delete from auth.users where id = $1`, [leaving.userId])

    // The events survive, and still name the person as text.
    const [kept] = await db.sql<{ target_name: string; actor_user_id: string | null }>(
      `select target_name, actor_user_id from public.organization_team_events
       where organization_id = $1 and event = 'member_removed'
       order by occurred_at desc limit 1`,
      [cast.organizationId],
    )
    expect(kept?.target_name).toBe('Erasable')
    expect(kept?.actor_user_id).not.toBeNull()

    const [invitation] = await db.sql<{ invited_by: string | null; email: string }>(
      `select invited_by, email from public.organization_invitations
       where email_normalized = 'their.invite@atlas.test'`,
    )
    expect(invitation?.invited_by).toBeNull()
    expect(invitation?.email).toBe('their.invite@atlas.test')
  })

  it('does not make an agency undeletable', async () => {
    /*
     * Worse than the account case and found the same way: team events reference
     * their organization ON DELETE CASCADE, and a trigger that refused every
     * delete refused the cascade too — so an agency became impossible to delete
     * the moment anything happened to its team.
     */
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
        cast.organizationId,
        cast.staff,
      ])
    })

    const before = await db.sql<{ n: string }>(
      `select count(*)::text as n from public.organization_team_events where organization_id = $1`,
      [cast.organizationId],
    )
    expect(Number(before[0]!.n)).toBeGreaterThan(0)

    await db.sql(`delete from public.organizations where id = $1`, [cast.organizationId])

    const after = await db.sql(
      `select 1 from public.organization_team_events where organization_id = $1`,
      [cast.organizationId],
    )
    expect(after).toEqual([])
  })

  it('does not make an invitation undeletable', async () => {
    /*
     * The third instance of the same mistake, found when a live check could not
     * remove the invitation it had just created. `invitation_id` references
     * organization_invitations ON DELETE SET NULL — the same referential action
     * as the two user columns — so an exception that whitelisted only those two
     * left every audited invitation permanently undeletable.
     */
    const { invitationId, token } = await invite(
      cast.owner,
      cast.organizationId,
      'deletable@atlas.test',
      'staff',
    )

    const events = await db.sql<{ n: string }>(
      `select count(*)::text as n from public.organization_team_events where invitation_id = $1`,
      [invitationId],
    )
    expect(Number(events[0]!.n)).toBeGreaterThan(0)

    await db.sql(`delete from public.organization_invitations where id = $1`, [invitationId])

    // The event survives and still says what happened; only the pointer moved.
    const [kept] = await db.sql<{ target_email: string; invitation_id: string | null }>(
      `select target_email, invitation_id from public.organization_team_events
       where organization_id = $1 and target_email = 'deletable@atlas.test'
       order by occurred_at desc limit 1`,
      [cast.organizationId],
    )
    expect(kept?.target_email).toBe('deletable@atlas.test')
    expect(kept?.invitation_id).toBeNull()

    // And the token it carried is gone with it.
    const orphan = await signUp(db, { email: 'deletable@atlas.test', fullName: 'Deletable' })
    await db.asUser(orphan.userId, async (session) => {
      await session.expectRejection(
        () => session.sql(`select * from public.accept_team_invitation($1)`, [token]),
        /not valid/i,
      )
    })
  })

  it('still refuses every other edit to an event', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
        cast.organizationId,
        cast.staff,
      ])
    })

    for (const statement of [
      `update public.organization_team_events set detail = 'rewritten'`,
      `update public.organization_team_events set actor_name = 'Somebody Else'`,
      `update public.organization_team_events set new_role = 'owner'`,
      `update public.organization_team_events set actor_user_id = target_user_id`,
      `update public.organization_team_events set occurred_at = now()`,
    ]) {
      await db.expectRejection(() => db.sql(statement), /cannot be update/i)
    }
  })

  it('never stores a token in the history', async () => {
    const { token } = await invite(cast.owner, cast.organizationId, 'audited@atlas.test', 'staff')

    const [row] = await db.sql<{ hits: string }>(
      `select count(*)::text as hits from public.organization_team_events
       where detail like '%' || $1 || '%' or target_email like '%' || $1 || '%'`,
      [token],
    )
    expect(row?.hits).toBe('0')
  })
})

// -----------------------------------------------------------------------------
/**
 * Interleavings, replayed in order.
 *
 * PGlite is a single connection, so these are not races — they are the states a
 * race can leave behind, asserted deterministically. The genuinely concurrent
 * versions, with independent connections against real PostgreSQL, are in the
 * live smoke suite; what these prove is that no ordering of the same operations
 * produces an invalid result, which is the half a lock cannot demonstrate.
 */
describe('interleaved operations', () => {
  it('does not restore access when a role change lands after a removal', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.remove_team_member($1, $2)`, [
        cast.organizationId,
        cast.manager,
      ])
      await session.expectRejection(
        () =>
          session.sql(`select public.change_team_member_role($1, $2, 'admin')`, [
            cast.organizationId,
            cast.manager,
          ]),
        /not a member of this organization/i,
      )
    })

    expect(await roleOf(cast.organizationId, cast.manager)).toBeNull()
  })

  it('leaves exactly one owner when a transfer is followed by a removal attempt', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.transfer_organization_ownership($1, $2, 'admin')`, [
        cast.organizationId,
        cast.admin,
      ])
      // The outgoing owner is now an administrator and cannot touch the new one.
      await session.expectRejection(
        () =>
          session.sql(`select public.remove_team_member($1, $2)`, [
            cast.organizationId,
            cast.admin,
          ]),
        /cannot remove a owner/i,
      )
    })

    const [count] = await db.sql<{ owners: string }>(
      `select count(*)::text as owners from public.organization_members
       where organization_id = $1 and role = 'owner' and status = 'active'`,
      [cast.organizationId],
    )
    expect(count?.owners).toBe('1')
  })

  it('leaves one owner when two transfers run back to back', async () => {
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.transfer_organization_ownership($1, $2, 'admin')`, [
        cast.organizationId,
        cast.admin,
      ])
    })

    // The second transfer is attempted by the account that was the owner when it
    // decided to. It no longer is, and the function re-reads that under the lock.
    await db.asUser(cast.owner, async (session) => {
      await session.expectRejection(
        () =>
          session.sql(`select public.transfer_organization_ownership($1, $2, 'admin')`, [
            cast.organizationId,
            cast.manager,
          ]),
        /only the owner/i,
      )
    })

    const [count] = await db.sql<{ owners: string }>(
      `select count(*)::text as owners from public.organization_members
       where organization_id = $1 and role = 'owner' and status = 'active'`,
      [cast.organizationId],
    )
    expect(count?.owners).toBe('1')
    expect(await roleOf(cast.organizationId, cast.admin)).toBe('owner')
  })

  it('keeps one invitation when the same address is invited twice in a row', async () => {
    const first = await invite(cast.owner, cast.organizationId, 'racer@atlas.test', 'staff')
    await ageInvitation(first.invitationId)
    await invite(cast.admin, cast.organizationId, 'racer@atlas.test', 'staff')

    const [row] = await db.sql<{ open: string }>(
      `select count(*)::text as open from public.organization_invitations
       where organization_id = $1 and email_normalized = 'racer@atlas.test'
         and accepted_at is null and revoked_at is null`,
      [cast.organizationId],
    )
    expect(row?.open).toBe('1')
  })

  it('produces one membership when the same token is accepted twice', async () => {
    const invited = await signUp(db, { email: 'doubletab@atlas.test', fullName: 'Double Tab' })
    const { token } = await invite(cast.owner, cast.organizationId, 'doubletab@atlas.test', 'staff')

    const outcomes = await db.asUser(invited.userId, async (session) => {
      const first = await session.sql<{ outcome: string }>(
        `select * from public.accept_team_invitation($1)`,
        [token],
      )
      const second = await session.sql<{ outcome: string }>(
        `select * from public.accept_team_invitation($1)`,
        [token],
      )
      return [first[0]?.outcome, second[0]?.outcome]
    })

    expect(outcomes).toEqual(['joined', 'already_member'])

    const memberships = await db.sql(
      `select 1 from public.organization_members where organization_id = $1 and user_id = $2`,
      [cast.organizationId, invited.userId],
    )
    expect(memberships).toHaveLength(1)

    const events = await db.sql(
      `select 1 from public.organization_team_events
       where organization_id = $1 and event = 'invitation_accepted' and target_user_id = $2`,
      [cast.organizationId, invited.userId],
    )
    expect(events).toHaveLength(1)
  })

  it('takes the agency lock before any row lock, everywhere', async () => {
    /*
     * Lock ORDER, not merely lock presence.
     *
     * The review fixes added the agency advisory lock to the invitation paths,
     * and two of them took it after locking the invitation row — the reverse of
     * the order create_team_invitation uses. A create racing a resend on one
     * agency would then each hold what the other was waiting for and PostgreSQL
     * would abort one with a deadlock.
     */
    for (const fn of [
      'create_team_invitation',
      'resend_team_invitation',
      'accept_team_invitation',
    ]) {
      const [source] = await db.sql<{ body: string }>(
        `select prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1`,
        [fn],
      )
      const body = source!.body
      const advisory = body.indexOf('lock_organization_membership')
      const rowLock = body.indexOf('for update')

      expect(advisory, `${fn} does not take the agency lock`).toBeGreaterThan(-1)
      expect(rowLock, `${fn} does not lock a row`).toBeGreaterThan(-1)
      expect(advisory, `${fn} locks a row before the agency`).toBeLessThan(rowLock)
    }
  })

  it('takes owner-affecting work under an advisory lock', async () => {
    // The lock is what makes the assertions above hold across connections rather
    // than only in sequence, so its presence is asserted rather than assumed.
    const [lock] = await db.sql<{ body: string }>(
      `select prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'lock_organization_membership'`,
    )
    expect(lock?.body).toMatch(/pg_advisory_xact_lock/)

    const [owners] = await db.sql<{ body: string }>(
      `select prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'lock_and_count_active_owners'`,
    )
    expect(owners?.body).toMatch(/lock_organization_membership/)
    expect(owners?.body).toMatch(/for update/i)

    /*
     * Everything that decides a membership question for one agency takes the
     * SAME lock — including invitation creation and reissue, which is what
     * stops an invitation being minted in the window where its author is being
     * demoted.
     */
    for (const fn of [
      'change_team_member_role',
      'remove_team_member',
      'leave_organization',
      'transfer_organization_ownership',
      'create_team_invitation',
      'resend_team_invitation',
      'accept_team_invitation',
    ]) {
      const [source] = await db.sql<{ body: string }>(
        `select prosrc as body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1`,
        [fn],
      )
      expect(source?.body, `${fn} does not take the agency membership lock`).toMatch(
        /lock_organization_membership|lock_and_count_active_owners/,
      )
    }
  })
})

// -----------------------------------------------------------------------------
describe('invited sign-up does not provision an agency', () => {
  it('skips provisioning when an open invitation exists for the address', async () => {
    await invite(cast.owner, cast.organizationId, 'recruit@atlas.test', 'staff')

    // The dedicated invitation screen sends no agency name, but the control is
    // that even the ordinary sign-up payload cannot force one.
    const recruit = await signUp(db, {
      email: 'recruit@atlas.test',
      fullName: 'Recruit',
      organizationName: 'Accidental Agency',
    })

    expect(recruit.organizationId).toBeNull()

    const [count] = await db.sql<{ total: string }>(
      `select count(*)::text as total from public.organizations where name = 'Accidental Agency'`,
    )
    expect(count?.total).toBe('0')
  })

  it('still provisions for somebody signing up independently', async () => {
    const independent = await signUp(db, {
      email: 'independent@own.test',
      fullName: 'Independent',
      organizationName: 'Own Agency',
    })
    expect(independent.organizationId).not.toBeNull()
  })

  it('provisions again once the invitation has been settled', async () => {
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'declined@atlas.test',
      'staff',
    )
    await db.asUser(cast.owner, async (session) => {
      await session.sql(`select public.revoke_team_invitation($1)`, [invitationId])
    })

    const declined = await signUp(db, {
      email: 'declined@atlas.test',
      fullName: 'Declined',
      organizationName: 'Second Thoughts',
    })
    expect(declined.organizationId).not.toBeNull()
  })

  it('leaves the invitation pending rather than accepting it on sign-up', async () => {
    const { invitationId } = await invite(
      cast.owner,
      cast.organizationId,
      'pending.signup@atlas.test',
      'manager',
    )
    const recruit = await signUp(db, {
      email: 'pending.signup@atlas.test',
      fullName: 'Pending Signup',
    })

    const [row] = await db.sql<{ accepted_at: string | null }>(
      `select accepted_at from public.organization_invitations where id = $1`,
      [invitationId],
    )
    expect(row?.accepted_at).toBeNull()
    expect(await roleOf(cast.organizationId, recruit.userId)).toBeNull()
  })
})
