-- =============================================================================
-- 20260821100000_team_membership.sql
--
-- Team, invitations and membership management.
--
-- Membership is the authorization fact this whole product rests on: every RLS
-- policy in every module is written in terms of app.is_org_member() and
-- app.has_min_role(), and both read exactly one table. A defect here is not a
-- Team bug, it is a cross-tenant data breach in nine modules at once. This file
-- is written accordingly.
--
-- WHAT CHANGES, AND WHY
--
-- 1. DIRECT WRITES TO organization_members ARE CLOSED.
--
--    Until now `authenticated` held INSERT/UPDATE/DELETE on the table, scoped by
--    policies that asked only `has_min_role(organization_id, 'admin')`. That was
--    adequate while nothing but an admin could reach it, but it means every
--    invariant this module introduces — no self-promotion, no owner through an
--    invitation, an audit trail, the last-owner guarantee under concurrency —
--    could be walked straight past with one PostgREST call:
--
--        PATCH /rest/v1/organization_members?id=eq...  {"role": "admin"}
--
--    So the grants go, the write policies go with them, and every membership
--    change now happens inside a function in this file. SELECT stays: reading
--    the roster is not a mutation and the tenant policy already scopes it.
--
-- 2. AN INVITATION IS OUR OWN DOMAIN OBJECT, NOT SUPABASE'S.
--
--    Supabase's Auth Admin invitation was checked against the current
--    documentation before this was designed, and it does not fit: inviting an
--    address that already belongs to a confirmed user returns an error, so it
--    handles exactly one of the two cases this product must support. It also
--    creates an Auth user before anybody has accepted anything, which would
--    make "invited" and "has an account" the same fact when they are not.
--
--    So authentication stays Supabase's job and membership stays ours. The
--    invitation carries its own 256-bit token, and the same code path serves a
--    brand-new person and somebody who already runs another agency here.
--
-- 3. NOTHING GRANTS `owner`.
--
--    There is no code path in this file that can produce an owner except
--    transfer_organization_ownership(). Not an invitation, not a role change,
--    not a direct write. The check is in the database and in a CHECK constraint
--    on the invitation row itself, not in the absence of a dropdown option.
--
-- 4. AN ORGANIZATION CANNOT REACH ZERO OWNERS.
--
--    Enforced by locking the owner rows and counting inside the transaction that
--    is about to change one, so two concurrent "demote the other owner" requests
--    serialise instead of both reading 2 and both writing.
--
-- WHAT IS DELIBERATELY NOT HERE: seat limits (Billing does not exist yet),
-- custom roles, SSO/SCIM, domain auto-join, a global superadmin, and any
-- deletion of an Auth account. Removing somebody from an agency removes them
-- from that agency.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- pgcrypto supplies gen_random_bytes(), the only source of invitation entropy
-- used here. Already enabled on the project; stated so the migration is
-- self-contained and the test harness matches production.
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'invitation_delivery' and typnamespace = 'public'::regnamespace
  ) then
    /*
     * Delivery is a separate fact from the invitation itself, and these names
     * say only what is actually known.
     *
     * `accepted_by_provider` is not "delivered". An email API returning 202
     * means it took custody of the message; whether it reached an inbox, a spam
     * folder or a bounce is not something this system observes. Claiming
     * delivery from a 202 is the lie that leaves an administrator waiting for a
     * colleague who never got anything.
     */
    create type public.invitation_delivery as enum (
      'pending',              -- created; no send attempted yet
      'accepted_by_provider', -- the email provider took the message. Not receipt.
      'failed',               -- the provider refused, or could not be reached
      'manual_link',          -- no provider configured; an admin took a one-time link
      'not_configured'        -- no provider configured and no link taken yet
    );
  end if;

  if not exists (
    select 1 from pg_type where typname = 'team_event' and typnamespace = 'public'::regnamespace
  ) then
    create type public.team_event as enum (
      'invitation_created',
      'invitation_resent',
      'invitation_revoked',
      'invitation_accepted',
      'invitation_link_revealed',
      'role_changed',
      'member_removed',
      'member_left',
      'ownership_transferred'
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- One place that decides how long an invitation lives
--
-- Not a constant repeated in SQL, in the Edge Function and in a React
-- component, which is how three different expiry rules end up in one product.
-- The row carries `expires_at`; every reader displays that column and nobody
-- recomputes it.
-- -----------------------------------------------------------------------------

create or replace function app.invitation_ttl()
returns interval language sql immutable parallel safe as $$ select interval '7 days' $$;

comment on function app.invitation_ttl() is
  'How long a new or reissued invitation stays acceptable. The single definition of invitation expiry.';

create or replace function app.invitation_resend_cooldown()
returns interval language sql immutable parallel safe as $$ select interval '2 minutes' $$;

comment on function app.invitation_resend_cooldown() is
  'Server-side floor between two issues of the same invitation. A disabled button is not a rate limit.';

create or replace function app.invitation_hourly_limit()
returns integer language sql immutable parallel safe as $$ select 25 $$;

comment on function app.invitation_hourly_limit() is
  'How many invitations one agency may mint in an hour. Not an anti-abuse platform; a ceiling below which no real agency operates and above which nothing good is happening.';

-- -----------------------------------------------------------------------------
-- Email normalisation
--
-- One rule, and it is the one GoTrue uses: trim, lower-case, nothing else.
-- Stripping dots or plus-addressing would be a home-grown parser that disagrees
-- with the authentication system about who two addresses belong to, and the
-- disagreement would surface as an invitation that can never be accepted.
-- -----------------------------------------------------------------------------

create or replace function app.normalize_email(p_email text)
returns text language sql immutable parallel safe as $$
  select nullif(lower(btrim(coalesce(p_email, ''))), '')
$$;

comment on function app.normalize_email(text) is
  'Matching form of an email address: trimmed and lower-cased, exactly as GoTrue stores it.';

-- -----------------------------------------------------------------------------
-- Role authority
--
-- Two predicates, used by every function below, so the answer to "may this
-- person do this to that person" is written once.
-- -----------------------------------------------------------------------------

create or replace function app.may_grant_role(
  p_actor_role  public.org_role,
  p_target_role public.org_role
)
returns boolean language sql immutable parallel safe as $$
  select p_actor_role is not null
     and p_target_role is not null
     -- Ownership is never granted. It is transferred, by an owner, deliberately.
     and p_target_role <> 'owner'
     -- Membership administration starts at administrator. A manager reads
     -- reports and financing terms; that is not the same authority as deciding
     -- who else can.
     and app.role_rank(p_actor_role) >= app.role_rank('admin')
     -- Nobody hands out authority they do not hold. An administrator may make
     -- another administrator — that matches how this product has always treated
     -- the role — but cannot mint anything above themselves.
     and app.role_rank(p_target_role) <= app.role_rank(p_actor_role);
$$;

comment on function app.may_grant_role(public.org_role, public.org_role) is
  'May an actor holding the first role grant the second? Never owner, never above the actor, never below administrator.';

create or replace function app.may_act_on_member(
  p_actor_role  public.org_role,
  p_target_role public.org_role
)
returns boolean language sql immutable parallel safe as $$
  select p_actor_role is not null
     and p_target_role is not null
     and app.role_rank(p_actor_role) >= app.role_rank('admin')
     -- An owner is out of reach of an administrator entirely: not demotable,
     -- not removable, not a transfer target chosen by anybody but themselves.
     and app.role_rank(p_target_role) <= app.role_rank(p_actor_role);
$$;

comment on function app.may_act_on_member(public.org_role, public.org_role) is
  'May an actor holding the first role change or remove a member holding the second? Equal rank is allowed; above is not.';

-- -----------------------------------------------------------------------------
-- The owner invariant, enforced with a lock
--
-- Counting owners without locking them is the classic way to end up with none:
-- two administrators each read "2 owners", each decide their change is safe, and
-- both commit. Locking the owner rows first makes the second transaction wait
-- and re-read, so it sees 1 and refuses.
-- -----------------------------------------------------------------------------

create or replace function app.lock_and_count_active_owners(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Serialises every owner-affecting operation on one agency, whichever rows it
  -- touches. Two transfers, a transfer racing a removal, and a demotion racing a
  -- leave all queue behind this rather than interleaving.
  perform pg_advisory_xact_lock(hashtext('app.organization_owners'), hashtext(p_organization_id::text));

  -- Taken in two statements because Postgres refuses FOR UPDATE alongside an
  -- aggregate: the first takes the row locks, the second counts what is now
  -- pinned. Both run under the advisory lock, so no owner row can appear or
  -- vanish between them.
  perform 1
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.role = 'owner'
    and m.status = 'active'
  order by m.user_id
  for update;

  select count(*) into v_count
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.role = 'owner'
    and m.status = 'active';

  return v_count;
end;
$$;

comment on function app.lock_and_count_active_owners(uuid) is
  'Locks an agency''s owner set for the rest of the transaction and returns how many active owners it has.';

-- -----------------------------------------------------------------------------
-- Display names for audit snapshots
--
-- Team events record who did what to whom as text at the time it happened, not
-- as a join executed later. A removed member still has a profile, but they no
-- longer share an organization with anybody here, so `profiles` stops being
-- readable to the agency the moment they leave — and a history that reads
-- "someone removed someone" is not a history.
-- -----------------------------------------------------------------------------

create or replace function app.actor_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email, '')
  from public.profiles p
  where p.id = p_user_id;
$$;

-- =============================================================================
-- organization_invitations
-- =============================================================================

create table if not exists public.organization_invitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  -- As typed, for display back to the person who sent it.
  email            public.email_address not null,
  -- What everything actually matches on.
  email_normalized text not null check (email_normalized = lower(btrim(email_normalized))),

  role             public.org_role not null,

  invited_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,

  /*
   * A digest, never the token.
   *
   * The raw token is a bearer capability: whoever holds it becomes a member of
   * this agency. Storing it would mean a database backup, a leaked read replica
   * or one over-broad SELECT hands out memberships. SHA-256 of a 256-bit random
   * value is not reversible and not guessable, so this column is safe to hold
   * and useless to steal.
   */
  token_digest     bytea not null,
  -- Incremented every time the token is rotated, so "this link is from before
  -- the resend" is a fact the audit trail can state.
  token_version    integer not null default 1 check (token_version >= 1),

  /*
   * Two different clocks, and the difference matters.
   *
   * `last_issued_at` is when a token was last minted. It is written by the
   * functions that mint one and by nothing else, so it is what the resend floor
   * is measured against.
   *
   * `last_sent_at` is when an email was last handed to a provider, which is a
   * separate optional call the client makes afterwards. Throttling on that would
   * mean a caller who simply never reports delivery is never throttled — which
   * is not a hypothetical, it is one loop over the resend RPC.
   */
  last_issued_at   timestamptz not null default now(),
  last_sent_at     timestamptz,
  send_count       integer not null default 0 check (send_count >= 0),
  delivery_state   public.invitation_delivery not null default 'pending',
  -- A category and a short sentence. Never a provider payload, never a key.
  delivery_detail  text check (delivery_detail is null or char_length(delivery_detail) <= 300),

  accepted_at      timestamptz,
  accepted_by      uuid references auth.users (id) on delete set null,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users (id) on delete set null,
  revoke_reason    text check (revoke_reason is null or char_length(revoke_reason) <= 300),

  updated_at       timestamptz not null default now(),

  -- An ordinary invitation can never carry ownership. Enforced here as well as
  -- in every function, because a CHECK constraint cannot be forgotten.
  constraint organization_invitations_never_owner check (role <> 'owner'),
  constraint organization_invitations_expiry_after_creation check (expires_at > created_at),
  -- Two outcomes cannot both have happened.
  constraint organization_invitations_single_outcome
    check (accepted_at is null or revoked_at is null),
  constraint organization_invitations_accepted_consistent
    check ((accepted_at is null) = (accepted_by is null)),
  constraint organization_invitations_revoked_consistent
    check ((revoked_at is null) = (revoked_by is null)),
  constraint organization_invitations_token_unique unique (token_digest)
);

comment on table public.organization_invitations is
  'An offer of membership in one agency. Grants nothing until accepted. Holds a digest of its token, never the token.';
comment on column public.organization_invitations.email_normalized is
  'Trimmed, lower-cased address. The matching key; `email` is kept for display.';
comment on column public.organization_invitations.token_digest is
  'SHA-256 of the invitation token. The token itself exists only in the email and in the recipient''s URL.';
comment on column public.organization_invitations.delivery_state is
  'What is known about the email. `accepted_by_provider` means an API took the message, not that anybody received it.';

/*
 * One open invitation per address per agency.
 *
 * Scoped to the organization on purpose: a person may be invited by two agencies
 * at once, and a global constraint on the address would make the second agency's
 * invitation depend on the first agency's paperwork. Only *open* invitations
 * collide, so history accumulates and a revoked or accepted invitation never
 * blocks a fresh one.
 */
create unique index if not exists organization_invitations_one_open_per_email_idx
  on public.organization_invitations (organization_id, email_normalized)
  where accepted_at is null and revoked_at is null;

create index if not exists organization_invitations_organization_idx
  on public.organization_invitations (organization_id, created_at desc);

create index if not exists organization_invitations_email_open_idx
  on public.organization_invitations (email_normalized)
  where accepted_at is null and revoked_at is null;

drop trigger if exists organization_invitations_set_updated_at on public.organization_invitations;
create trigger organization_invitations_set_updated_at
  before update on public.organization_invitations
  for each row execute function app.set_updated_at();

drop trigger if exists organization_invitations_freeze_columns on public.organization_invitations;
create trigger organization_invitations_freeze_columns
  before update on public.organization_invitations
  /*
   * `invited_by` is deliberately NOT frozen.
   *
   * It references auth.users with ON DELETE SET NULL, and freeze_columns()
   * restores whatever it is told to freeze — so the referential action would be
   * silently reverted and the foreign key would then refuse the delete, making
   * anybody who has ever sent an invitation permanently undeletable. Nothing is
   * lost by leaving it out: no client role holds UPDATE on this table at all,
   * so the only writer is the domain, and the domain never rewrites it.
   */
  for each row execute function app.freeze_columns(
    'id', 'organization_id', 'email_normalized', 'created_at'
  );

-- =============================================================================
-- organization_team_events — the membership history
--
-- Not a generic audit framework. Nine event kinds, one row each, written only by
-- the functions in this file, and readable only by the people who administer the
-- agency it belongs to. Names and addresses are snapshotted as text at the time
-- of the event so the history survives the departure it records.
-- =============================================================================

create table if not exists public.organization_team_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event           public.team_event not null,
  occurred_at     timestamptz not null default now(),

  actor_user_id   uuid references auth.users (id) on delete set null,
  actor_name      text not null default '' check (char_length(actor_name) <= 200),

  target_user_id  uuid references auth.users (id) on delete set null,
  target_name     text not null default '' check (char_length(target_name) <= 200),
  -- The invited address, or the address of the member acted on. Organization
  -- internal, visible to that organization's administrators, and nowhere else.
  target_email    text check (target_email is null or char_length(target_email) <= 320),

  previous_role   public.org_role,
  new_role        public.org_role,

  invitation_id   uuid references public.organization_invitations (id) on delete set null,
  detail          text check (detail is null or char_length(detail) <= 300)
);

comment on table public.organization_team_events is
  'Immutable record of membership and invitation events for one agency. Written by domain functions only; never updated or deleted.';

create index if not exists organization_team_events_organization_idx
  on public.organization_team_events (organization_id, occurred_at desc);

/*
 * Immutable means immutable — with exactly one exception, and it is not a hole.
 *
 * No grant is issued for UPDATE or DELETE, so this trigger is the second lock
 * rather than the first: it catches a future migration, a psql session or a
 * mistakenly re-granted privilege, which is the class of thing that quietly
 * rewrites a history nobody is watching.
 *
 * THE EXCEPTIONS. Both are referential actions rather than edits, and both are
 * spelled out in 20260821100100_actor_deletion.sql, which is where they were
 * found: `actor_user_id` and `target_user_id` reference auth.users ON DELETE
 * SET NULL, and `organization_id` references organizations ON DELETE CASCADE.
 * A trigger that refused either would make an Auth account — or, worse, an
 * entire agency — permanently undeletable. Neither costs the history anything:
 * the names, the address and both roles are snapshotted as text precisely so
 * the record survives the accounts it refers to.
 */
create or replace function app.team_events_are_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'actor_user_id' - 'target_user_id' - 'invitation_id')
           = (to_jsonb(old) - 'actor_user_id' - 'target_user_id' - 'invitation_id')
     and (new.actor_user_id  is null or new.actor_user_id  is not distinct from old.actor_user_id)
     and (new.target_user_id is null or new.target_user_id is not distinct from old.target_user_id)
     and (new.invitation_id  is null or new.invitation_id  is not distinct from old.invitation_id)
     and (new.actor_user_id, new.target_user_id, new.invitation_id)
           is distinct from (old.actor_user_id, old.target_user_id, old.invitation_id)
  then
    return new;
  end if;

  raise exception 'Team history cannot be % once written.', lower(tg_op)
    using errcode = '42501';
end;
$$;

drop trigger if exists organization_team_events_immutable on public.organization_team_events;
create trigger organization_team_events_immutable
  before update or delete on public.organization_team_events
  for each row execute function app.team_events_are_immutable();

/** Records one event. Actor identity comes from the session, never an argument. */
create or replace function app.record_team_event(
  p_organization_id uuid,
  p_event           public.team_event,
  p_target_user_id  uuid    default null,
  p_target_email    text    default null,
  p_previous_role   public.org_role default null,
  p_new_role        public.org_role default null,
  p_invitation_id   uuid    default null,
  p_detail          text    default null,
  p_target_name     text    default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  insert into public.organization_team_events (
    organization_id, event, actor_user_id, actor_name,
    target_user_id, target_name, target_email,
    previous_role, new_role, invitation_id, detail
  ) values (
    p_organization_id, p_event, v_actor, left(coalesce(app.actor_display_name(v_actor), ''), 200),
    p_target_user_id,
    left(coalesce(p_target_name, app.actor_display_name(p_target_user_id), ''), 200),
    left(p_target_email, 320),
    p_previous_role, p_new_role, p_invitation_id, left(p_detail, 300)
  );
end;
$$;

-- =============================================================================
-- Invitation state, derived rather than stored
--
-- There is no `status` column. `accepted_at`, `revoked_at` and `expires_at` are
-- the facts; the state is a function of them, so it is impossible for a row to
-- claim it is pending while carrying an acceptance timestamp.
-- =============================================================================

create or replace function app.invitation_state(
  p_accepted_at timestamptz,
  p_revoked_at  timestamptz,
  p_expires_at  timestamptz
)
returns text language sql immutable parallel safe as $$
  select case
    when p_accepted_at is not null then 'accepted'
    when p_revoked_at  is not null then 'revoked'
    when p_expires_at  <= now()    then 'expired'
    else 'pending'
  end;
$$;

-- now() is stable, not immutable; the function above is only ever called with
-- live values, so mark it stable to keep the planner honest.
alter function app.invitation_state(timestamptz, timestamptz, timestamptz) stable;

-- =============================================================================
-- Token generation
--
-- 32 bytes from pgcrypto's CSPRNG, rendered base64url so it survives a URL
-- fragment untouched. Not a UUID, not a hash of the email and a timestamp, and
-- not anything a client contributes to.
-- =============================================================================

create or replace function app.new_invitation_token()
returns text
language sql
volatile
set search_path = ''
as $$
  -- '=' padding and any line breaks encode() inserts are removed rather than
  -- translated; '+' and '/' become '-' and '_'.
  select translate(
    encode(extensions.gen_random_bytes(32), 'base64'),
    '+/=' || chr(10) || chr(13),
    '-_'
  );
$$;

comment on function app.new_invitation_token() is
  'A 256-bit URL-safe invitation token from the cryptographic RNG. Returned once, stored never.';

create or replace function app.invitation_token_digest(p_token text)
returns bytea
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- sha256() is core PostgreSQL, so the digest does not depend on an extension
  -- being present in the search path at call time.
  select sha256(convert_to(coalesce(p_token, ''), 'utf8'));
$$;

-- =============================================================================
-- Cascading revocation
--
-- An invitation is a promise made by somebody with the authority to make it. If
-- that authority goes away before the invitation is accepted, the promise goes
-- with it — otherwise a demoted administrator leaves behind a latent grant of a
-- role they could no longer create, redeemable weeks later.
-- =============================================================================

create or replace function app.revoke_invitations_beyond_authority(
  p_organization_id uuid,
  p_user_id         uuid,
  p_detail          text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  public.org_role;
  v_count integer := 0;
  v_row   record;
begin
  select m.role into v_role
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id
    and m.status = 'active';

  for v_row in
    select i.id, i.role, i.email
    from public.organization_invitations i
    where i.organization_id = p_organization_id
      and i.invited_by = p_user_id
      and i.accepted_at is null
      and i.revoked_at is null
      -- No membership at all, or a role that could not issue this invitation now.
      and (v_role is null or not app.may_grant_role(v_role, i.role))
    for update
  loop
    update public.organization_invitations
       set revoked_at = now(),
           revoked_by = coalesce((select auth.uid()), p_user_id),
           revoke_reason = left(p_detail, 300),
           -- Rotate the digest as well. Revocation is checked on acceptance, so
           -- this is belt and braces: even a leaked digest cannot be matched
           -- against a token that still exists in somebody's inbox.
           token_digest = app.invitation_token_digest(app.new_invitation_token()),
           token_version = token_version + 1
     where id = v_row.id;

    perform app.record_team_event(
      p_organization_id, 'invitation_revoked', null, v_row.email,
      null, v_row.role, v_row.id, p_detail
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function app.revoke_invitations_beyond_authority(uuid, uuid, text) is
  'Revokes a member''s still-open invitations that their current role could no longer issue. Called after every demotion, removal and departure.';

-- =============================================================================
-- Guard trigger: let the vetted domain functions through
--
-- app.guard_membership_changes() blocks self role changes and owner grants for
-- any actor who is not an owner. Ownership transfer legitimately does both — an
-- owner promotes somebody else and steps down in the same transaction — and the
-- trigger cannot tell a transfer from an attack.
--
-- The functions in this file therefore raise a transaction-local flag around
-- their writes, exactly as provisioning already does. The flag is safe because
-- there is no way to set it from a client: set_config() lives in pg_catalog and
-- PostgREST exposes only `public`, `authenticated` cannot create functions, and
-- the flag is cleared before every function returns.
-- =============================================================================

create or replace function app.guard_membership_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor            uuid := (select auth.uid());
  v_actor_role       public.org_role;
  v_row              public.organization_members;
  v_active_owners    integer;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;

  -- Provisioning, service-role maintenance, and the membership operations in
  -- 20260821100000_team_membership.sql, each of which has already performed a
  -- stricter version of every check below.
  if v_actor is null
     or coalesce(current_setting('app.provisioning', true), '') = 'on'
     or coalesce(current_setting('app.membership_operation', true), '') = 'on'
  then
    return v_row;
  end if;

  v_actor_role := app.current_role_in(v_row.organization_id);

  select count(*)
    into v_active_owners
  from public.organization_members m
  where m.organization_id = v_row.organization_id
    and m.role = 'owner'
    and m.status = 'active';

  if tg_op = 'INSERT' then
    if new.role = 'owner' and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can add another owner.'
        using errcode = '42501';
    end if;

  elsif tg_op = 'UPDATE' then
    if old.user_id = v_actor and (new.role <> old.role or new.status <> old.status) then
      raise exception 'You cannot change your own role or status.'
        using errcode = '42501';
    end if;

    if (old.role = 'owner' or new.role = 'owner') and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can grant or revoke the owner role.'
        using errcode = '42501';
    end if;

    if old.role = 'owner' and old.status = 'active'
       and (new.role <> 'owner' or new.status <> 'active')
       and v_active_owners <= 1 then
      raise exception 'An organization must always keep at least one active owner.'
        using errcode = '23514';
    end if;

  elsif tg_op = 'DELETE' then
    if old.role = 'owner' and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can remove another owner.'
        using errcode = '42501';
    end if;

    if old.role = 'owner' and old.status = 'active' and v_active_owners <= 1 then
      raise exception 'An organization must always keep at least one active owner.'
        using errcode = '23514';
    end if;
  end if;

  return v_row;
end;
$$;

-- =============================================================================
-- Read models
-- =============================================================================

/**
 * The roster.
 *
 * Every member of the agency may see who else is in it and what role they hold —
 * that is already true of this schema, because `profiles` is readable to anyone
 * who shares an organization with you and carries the address GoTrue holds.
 * Restricting the column here would hide it from one screen while leaving it one
 * PostgREST call away, which is decoration rather than a control.
 *
 * There is no "last seen" and no "online now". Those facts do not exist in this
 * database, and a Team page that invented them would be lying in a place people
 * make staffing decisions.
 */
create or replace function public.team_directory(p_organization_id uuid)
returns table (
  user_id      uuid,
  display_name text,
  email        text,
  role         public.org_role,
  joined_at    timestamptz,
  job_title    text,
  is_self      boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  return query
  select m.user_id,
         coalesce(nullif(btrim(p.full_name), ''), split_part(coalesce(p.email, ''), '@', 1), 'Member'),
         p.email,
         m.role,
         m.joined_at,
         m.job_title,
         m.user_id = v_actor
  from public.organization_members m
  left join public.profiles p on p.id = m.user_id
  where m.organization_id = p_organization_id
    and m.status = 'active'
  order by app.role_rank(m.role) desc, m.joined_at, m.user_id;
end;
$$;

comment on function public.team_directory(uuid) is
  'Active members of one agency: who they are, their role and when they joined. Any member may read it.';

/**
 * Invitations.
 *
 * Administrators only, and never the digest. `p_include_history` decides whether
 * settled invitations come back: the Team page shows what is outstanding by
 * default, because a list dominated by two years of accepted invitations is a
 * list nobody reads.
 */
create or replace function public.team_invitations(
  p_organization_id uuid,
  p_include_history boolean default false,
  p_limit           integer default 50,
  p_offset          integer default 0
)
returns table (
  id             uuid,
  email          text,
  role           public.org_role,
  state          text,
  created_at     timestamptz,
  expires_at     timestamptz,
  last_sent_at   timestamptz,
  send_count     integer,
  delivery_state public.invitation_delivery,
  delivery_detail text,
  invited_by_name text,
  revoke_reason  text,
  accepted_at    timestamptz,
  resend_available_at timestamptz,
  total_count    bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not app.has_min_role(p_organization_id, 'admin') then
    raise exception 'Not permitted to view invitations for this organization.'
      using errcode = '42501';
  end if;

  return query
  with scoped as (
    select i.*
    from public.organization_invitations i
    where i.organization_id = p_organization_id
      and (
        p_include_history
        or app.invitation_state(i.accepted_at, i.revoked_at, i.expires_at) in ('pending', 'expired')
      )
  ),
  counted as (select count(*) as total from scoped)
  select s.id,
         -- `email` is the public.email_address domain on the table; the return
         -- type is plain text, and PostgreSQL does not consider those the same
         -- structure.
         s.email::text,
         s.role,
         app.invitation_state(s.accepted_at, s.revoked_at, s.expires_at),
         s.created_at,
         s.expires_at,
         s.last_sent_at,
         s.send_count,
         s.delivery_state,
         s.delivery_detail,
         coalesce(app.actor_display_name(s.invited_by), ''),
         s.revoke_reason,
         s.accepted_at,
         s.last_issued_at + app.invitation_resend_cooldown(),
         counted.total
  from scoped s
  cross join counted
  order by
    -- Outstanding work first, then whatever is most recent.
    case app.invitation_state(s.accepted_at, s.revoked_at, s.expires_at)
      when 'pending' then 0 when 'expired' then 1 else 2 end,
    s.created_at desc
  limit v_limit offset v_offset;
end;
$$;

comment on function public.team_invitations(uuid, boolean, integer, integer) is
  'Invitations for one agency, with derived state. Administrators only. Never returns the token or its digest.';

/** Membership history. Administrators only. */
create or replace function public.team_events(
  p_organization_id uuid,
  p_limit           integer default 30,
  p_offset          integer default 0
)
returns table (
  id             uuid,
  event          public.team_event,
  occurred_at    timestamptz,
  actor_name     text,
  target_name    text,
  target_email   text,
  previous_role  public.org_role,
  new_role       public.org_role,
  detail         text,
  total_count    bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not app.has_min_role(p_organization_id, 'admin') then
    raise exception 'Not permitted to view team history for this organization.'
      using errcode = '42501';
  end if;

  return query
  with counted as (
    select count(*) as total
    from public.organization_team_events e
    where e.organization_id = p_organization_id
  )
  select e.id, e.event, e.occurred_at, e.actor_name, e.target_name, e.target_email,
         e.previous_role, e.new_role, e.detail, counted.total
  from public.organization_team_events e
  cross join counted
  where e.organization_id = p_organization_id
  order by e.occurred_at desc, e.id desc
  limit v_limit offset v_offset;
end;
$$;

/**
 * Who owns this agency, and how many people it has.
 *
 * Billing does not exist yet and this function invents nothing for it. It exists
 * because ownership is about to matter to more than one module, and "read it off
 * a join somebody wrote in a component" is how two modules end up disagreeing
 * about who the owner is.
 */
create or replace function public.team_seat_summary(p_organization_id uuid)
returns table (
  active_members  integer,
  owners          integer,
  admins          integer,
  managers        integer,
  staff           integer,
  open_invitations integer,
  owner_user_id   uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  return query
  select
    count(*)::integer,
    count(*) filter (where m.role = 'owner')::integer,
    count(*) filter (where m.role = 'admin')::integer,
    count(*) filter (where m.role = 'manager')::integer,
    count(*) filter (where m.role = 'staff')::integer,
    (
      select count(*)::integer
      from public.organization_invitations i
      where i.organization_id = p_organization_id
        and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
    ),
    (
      select m2.user_id
      from public.organization_members m2
      where m2.organization_id = p_organization_id
        and m2.role = 'owner' and m2.status = 'active'
      order by m2.joined_at, m2.user_id
      limit 1
    )
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.status = 'active';
end;
$$;

-- =============================================================================
-- Invitation creation
-- =============================================================================

/**
 * Creates — or reissues — an invitation, and hands back the only copy of its
 * token.
 *
 * `invited_by` is auth.uid(), never an argument: a browser saying who sent an
 * invitation is a browser choosing whose authority the invitation carries.
 *
 * Three outcomes, and the caller is told which:
 *   `created`        a new invitation exists
 *   `reissued`       one was already open for this address; its token was
 *                    rotated and its expiry reset rather than a second row
 *                    appearing beside it
 *   `already_member` this person is already in the agency; nothing was created
 *
 * Nothing here reveals whether the address belongs to an account elsewhere in
 * the product. An administrator learns about their own agency and no other.
 */
create or replace function public.create_team_invitation(
  p_organization_id uuid,
  p_email           text,
  p_role            public.org_role
)
returns table (
  invitation_id uuid,
  token         text,
  expires_at    timestamptz,
  outcome       text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_actor_role  public.org_role;
  v_email       text;
  v_normalized  text;
  v_token       text;
  v_existing    public.organization_invitations;
  v_target_user uuid;
  v_id          uuid;
  v_expires     timestamptz;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_actor_role := app.current_role_in(p_organization_id);
  if v_actor_role is null then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  if p_role = 'owner' then
    raise exception 'Ownership is transferred, not invited.' using errcode = '42501';
  end if;

  if not app.may_grant_role(v_actor_role, p_role) then
    raise exception 'You cannot invite somebody as %.', p_role using errcode = '42501';
  end if;

  v_email := left(btrim(coalesce(p_email, '')), 320);
  v_normalized := app.normalize_email(v_email);

  if v_normalized is null then
    raise exception 'An email address is required.' using errcode = '22004';
  end if;
  -- Same shape rule the rest of the schema uses, so an address that is accepted
  -- here is an address the profile table could hold.
  if v_normalized !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That is not a valid email address.' using errcode = '22023';
  end if;

  -- Serialise two administrators inviting the same person at the same moment.
  -- The partial unique index would catch the duplicate anyway; the lock turns a
  -- constraint violation into one coherent outcome.
  perform pg_advisory_xact_lock(
    hashtext('public.create_team_invitation'),
    hashtext(p_organization_id::text || '|' || v_normalized)
  );

  /*
   * A ceiling for the whole agency, per hour.
   *
   * Everything else here asks whether this caller may invite this person; this
   * asks whether an agency is minting invitations at a rate that means anything
   * good. An administrator hammering a button, a retry loop, and somebody using
   * an authorised account to spray a mailing list all look the same from here,
   * and all three should stop.
   */
  if (
    select count(*) from public.organization_invitations i
    where i.organization_id = p_organization_id
      and i.last_issued_at > now() - interval '1 hour'
  ) >= app.invitation_hourly_limit() then
    raise exception 'This agency has sent a lot of invitations in the last hour. Try again shortly.'
      using errcode = '55006';
  end if;

  -- Already in the agency? Say so, and create nothing. Looked up through the
  -- profile mirror rather than auth.users so this cannot become a way to ask
  -- whether an arbitrary address has an account at all.
  select m.user_id into v_target_user
  from public.organization_members m
  join public.profiles p on p.id = m.user_id
  where m.organization_id = p_organization_id
    and m.status = 'active'
    and app.normalize_email(p.email) = v_normalized
  limit 1;

  if v_target_user is not null then
    return query select null::uuid, null::text, null::timestamptz, 'already_member'::text;
    return;
  end if;

  v_token := app.new_invitation_token();
  v_expires := now() + app.invitation_ttl();

  select * into v_existing
  from public.organization_invitations i
  where i.organization_id = p_organization_id
    and i.email_normalized = v_normalized
    and i.accepted_at is null
    and i.revoked_at is null
  for update;

  if found then
    /*
     * An open invitation already exists. Reissue it rather than stacking a
     * second one beside it: three identical invitations in a list teach an
     * administrator to ignore the list.
     *
     * The role and the expiry are both refreshed, and the token is rotated, so
     * the older link stops working — which is what "reissue" has to mean if it
     * is to be safe. And because it rotates a token, it is subject to the same
     * floor as an explicit resend: otherwise "invite again" is a resend with the
     * throttle taken off.
     */
    if v_existing.last_issued_at + app.invitation_resend_cooldown() > now() then
      raise exception 'That invitation was issued moments ago. Try again shortly.'
        using errcode = '55006';
    end if;

    update public.organization_invitations
       set email          = v_email,
           role           = p_role,
           token_digest   = app.invitation_token_digest(v_token),
           token_version  = token_version + 1,
           expires_at     = v_expires,
           last_issued_at = now(),
           delivery_state = 'pending',
           delivery_detail = null
     where id = v_existing.id
     returning id into v_id;

    perform app.record_team_event(
      p_organization_id, 'invitation_created', null, v_email,
      case when v_existing.role <> p_role then v_existing.role end, p_role, v_id,
      'Reissued; the previous link stopped working.'
    );

    return query select v_id, v_token, v_expires, 'reissued'::text;
    return;
  end if;

  insert into public.organization_invitations (
    organization_id, email, email_normalized, role, invited_by,
    expires_at, token_digest
  ) values (
    p_organization_id, v_email, v_normalized, p_role, v_actor,
    v_expires, app.invitation_token_digest(v_token)
  )
  returning id into v_id;

  perform app.record_team_event(
    p_organization_id, 'invitation_created', null, v_email, null, p_role, v_id, null
  );

  return query select v_id, v_token, v_expires, 'created'::text;
end;
$$;

comment on function public.create_team_invitation(uuid, text, public.org_role) is
  'Creates or reissues an invitation and returns its token once. The token is never stored and never returned again.';

/**
 * Reissues an existing invitation with a fresh token and a fresh expiry.
 *
 * Resend is a security operation, not a convenience: sending the same bearer
 * token again forever means every copy of every old email stays redeemable. The
 * previous link stops working the moment this returns, and there is a
 * server-side floor between sends that a disabled button cannot provide.
 */
create or replace function public.resend_team_invitation(p_invitation_id uuid)
returns table (
  invitation_id uuid,
  token         text,
  expires_at    timestamptz,
  outcome       text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_actor_role public.org_role;
  v_invitation public.organization_invitations;
  v_token      text;
  v_expires    timestamptz;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.id = p_invitation_id
  for update;

  -- An invitation belonging to another agency and one that never existed give
  -- the same answer, so this cannot be used to probe for identifiers.
  if not found or not app.is_org_member(v_invitation.organization_id) then
    raise exception 'That invitation was not found.' using errcode = 'P0002';
  end if;

  v_actor_role := app.current_role_in(v_invitation.organization_id);
  if not app.may_grant_role(v_actor_role, v_invitation.role) then
    raise exception 'You cannot resend an invitation for the % role.', v_invitation.role
      using errcode = '42501';
  end if;

  if v_invitation.accepted_at is not null then
    raise exception 'That invitation has already been accepted.' using errcode = '22023';
  end if;
  if v_invitation.revoked_at is not null then
    raise exception 'That invitation was revoked. Invite the person again to send a new one.'
      using errcode = '22023';
  end if;

  /*
   * The floor, measured from when a token was last minted.
   *
   * NOT from `last_sent_at`: that column is written by record_invitation_delivery(),
   * which is a separate call the client makes afterwards and may simply never
   * make. Throttling on it would mean this loop is free:
   *
   *     while true: rpc('resend_team_invitation', id)
   *
   * — unlimited token rotations and unlimited provider sends from one authorised
   * account, which is precisely the careless-or-malicious administrator this is
   * here to stop.
   */
  if v_invitation.last_issued_at + app.invitation_resend_cooldown() > now() then
    raise exception 'That invitation was sent moments ago. Try again shortly.'
      using errcode = '55006';
  end if;

  v_token := app.new_invitation_token();
  v_expires := now() + app.invitation_ttl();

  update public.organization_invitations
     set token_digest    = app.invitation_token_digest(v_token),
         token_version   = token_version + 1,
         expires_at      = v_expires,
         last_issued_at  = now(),
         delivery_state  = 'pending',
         delivery_detail = null
   where id = p_invitation_id;

  perform app.record_team_event(
    v_invitation.organization_id, 'invitation_resent', null, v_invitation.email,
    null, v_invitation.role, p_invitation_id,
    'A new link was issued; the previous one stopped working.'
  );

  return query select p_invitation_id, v_token, v_expires, 'reissued'::text;
end;
$$;

/** Revokes a pending invitation and invalidates its token immediately. */
create or replace function public.revoke_team_invitation(
  p_invitation_id uuid,
  p_reason        text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_actor_role public.org_role;
  v_invitation public.organization_invitations;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.id = p_invitation_id
  for update;

  if not found or not app.is_org_member(v_invitation.organization_id) then
    raise exception 'That invitation was not found.' using errcode = 'P0002';
  end if;

  v_actor_role := app.current_role_in(v_invitation.organization_id);
  if not app.may_grant_role(v_actor_role, v_invitation.role) then
    raise exception 'You cannot revoke an invitation for the % role.', v_invitation.role
      using errcode = '42501';
  end if;

  if v_invitation.accepted_at is not null then
    raise exception 'That invitation has already been accepted. Remove the member instead.'
      using errcode = '22023';
  end if;

  -- Already revoked: nothing to do, and no error worth showing somebody who
  -- clicked twice.
  if v_invitation.revoked_at is not null then
    return;
  end if;

  update public.organization_invitations
     set revoked_at    = now(),
         revoked_by    = v_actor,
         revoke_reason = left(btrim(p_reason), 300),
         -- The link in the recipient's inbox stops matching anything.
         token_digest  = app.invitation_token_digest(app.new_invitation_token()),
         token_version = token_version + 1
   where id = p_invitation_id;

  perform app.record_team_event(
    v_invitation.organization_id, 'invitation_revoked', null, v_invitation.email,
    null, v_invitation.role, p_invitation_id, left(btrim(p_reason), 300)
  );
end;
$$;

/**
 * Everything an invitation email needs, and nothing else.
 *
 * The delivery function has to name the agency, the inviter and the role in a
 * message, and it has to know where to send it. Reading that back through
 * team_invitations() would mean the Edge Function walking the caller's agencies
 * looking for a matching row; this is one call with the same authorization.
 *
 * The token is not here. It exists only in the return value of the function that
 * minted it, in the message that carries it, and in the recipient's browser.
 */
create or replace function public.team_invitation_message(p_invitation_id uuid)
returns table (
  organization_name text,
  email             text,
  role              public.org_role,
  invited_by_name   text,
  expires_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invitation public.organization_invitations;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.id = p_invitation_id;

  if not found or not app.has_min_role(v_invitation.organization_id, 'admin') then
    raise exception 'That invitation was not found.' using errcode = 'P0002';
  end if;

  return query
  select o.name,
         v_invitation.email::text,
         v_invitation.role,
         coalesce(app.actor_display_name(v_invitation.invited_by), ''),
         v_invitation.expires_at
  from public.organizations o
  where o.id = v_invitation.organization_id;
end;
$$;

/**
 * Records what happened when the invitation email was sent.
 *
 * Called by the delivery function after it has heard from the provider. Kept
 * separate from creation because an invitation existing and an email being
 * accepted are two facts, and conflating them is what produces a Team page that
 * says "Invitation sent" when nothing left the building.
 */
create or replace function public.record_invitation_delivery(
  p_invitation_id uuid,
  p_state         public.invitation_delivery,
  p_detail        text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invitation public.organization_invitations;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.id = p_invitation_id;

  if not found or not app.has_min_role(v_invitation.organization_id, 'admin') then
    raise exception 'That invitation was not found.' using errcode = 'P0002';
  end if;

  -- Delivery facts only. `last_issued_at`, which the resend floor is measured
  -- against, is written by the functions that mint a token and by nothing else.
  update public.organization_invitations
     set delivery_state  = p_state,
         delivery_detail = left(btrim(p_detail), 300),
         last_sent_at    = case when p_state in ('accepted_by_provider', 'manual_link')
                                then now() else last_sent_at end,
         send_count      = case when p_state in ('accepted_by_provider', 'manual_link')
                                then send_count + 1 else send_count end
   where id = p_invitation_id;

  -- Handing an administrator a raw link is a disclosure of a bearer capability.
  -- It is a legitimate fallback when no email provider is configured, and it is
  -- recorded as what it is.
  if p_state = 'manual_link' then
    perform app.record_team_event(
      v_invitation.organization_id, 'invitation_link_revealed', null, v_invitation.email,
      null, v_invitation.role, p_invitation_id,
      'A one-time invitation link was shown for manual delivery.'
    );
  end if;
end;
$$;

-- =============================================================================
-- Preview
--
-- The one thing a signed-out visitor can ask about. Granted to `service_role`
-- alone: it is reached through the Team invitation Edge Function, which passes
-- nothing but the token and returns nothing but what is below. `anon` keeps zero
-- database access, exactly as it has since 20260814110000.
--
-- It returns no email address, no organization id, no user id and no invitation
-- id — nothing that could be used against any other endpoint. An unknown token
-- and an expired one are distinguishable, and deliberately so: "this invitation
-- has expired, ask for another" is the message the person needs, and it is only
-- reachable by somebody already holding a 256-bit secret.
-- =============================================================================

create or replace function public.preview_team_invitation(p_token text)
returns table (
  organization_name text,
  role              public.org_role,
  expires_at        timestamptz,
  state             text,
  invited_by_name   text,
  email_masked      text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invitation public.organization_invitations;
  v_local      text;
begin
  if p_token is null or char_length(p_token) < 20 then
    raise exception 'That invitation link is not valid.' using errcode = 'P0002';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.token_digest = app.invitation_token_digest(p_token);

  if not found then
    raise exception 'That invitation link is not valid.' using errcode = 'P0002';
  end if;

  v_local := split_part(v_invitation.email_normalized, '@', 1);

  return query
  select o.name,
         v_invitation.role,
         v_invitation.expires_at,
         app.invitation_state(v_invitation.accepted_at, v_invitation.revoked_at, v_invitation.expires_at),
         coalesce(app.actor_display_name(v_invitation.invited_by), ''),
         -- Enough for somebody signed in as the wrong account to recognise which
         -- of their addresses this was meant for, and not enough to be an
         -- address anybody could use.
         left(v_local, 1) || repeat('•', greatest(char_length(v_local) - 1, 1))
           || '@' || split_part(v_invitation.email_normalized, '@', 2)
  from public.organizations o
  where o.id = v_invitation.organization_id;
end;
$$;

comment on function public.preview_team_invitation(text) is
  'Minimal, non-identifying description of an invitation, keyed only by its token. Reachable through the invitation Edge Function; never by a browser.';

-- =============================================================================
-- Acceptance
--
-- The security-critical transaction of this module. Everything it checks, it
-- checks while holding the invitation row, so two tabs, two devices or two
-- retries produce exactly one membership.
-- =============================================================================

create or replace function public.accept_team_invitation(p_token text)
returns table (
  organization_id   uuid,
  organization_name text,
  role              public.org_role,
  outcome           text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor        uuid := (select auth.uid());
  v_email        text;
  v_confirmed_at timestamptz;
  v_invitation   public.organization_invitations;
  v_state        text;
  v_inviter_role public.org_role;
  v_existing     public.org_role;
  v_status       public.member_status;
  v_org_name     text;
begin
  if v_actor is null then
    raise exception 'Sign in to accept this invitation.' using errcode = '42501';
  end if;

  /*
   * The authoritative identity, taken from GoTrue's own table.
   *
   * Not a typed email field, not user_metadata, not a claim the client attached:
   * possession of an invitation link is not permission to choose which account
   * it lands in, and every one of those three is something the browser controls.
   */
  select app.normalize_email(u.email), u.email_confirmed_at
    into v_email, v_confirmed_at
  from auth.users u
  where u.id = v_actor;

  if v_email is null then
    raise exception 'Your account has no email address on file.' using errcode = '42501';
  end if;
  if v_confirmed_at is null then
    raise exception 'Confirm your email address before joining an agency.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.token_digest = app.invitation_token_digest(p_token)
  for update;

  if not found then
    raise exception 'That invitation link is not valid.' using errcode = 'P0002';
  end if;

  -- The address is checked before the state is reported, so a stale link cannot
  -- tell a stranger anything about an invitation that was not sent to them.
  if v_invitation.email_normalized <> v_email then
    raise exception 'This invitation was sent to a different account.' using errcode = '42501';
  end if;

  v_state := app.invitation_state(v_invitation.accepted_at, v_invitation.revoked_at, v_invitation.expires_at);

  if v_state = 'revoked' then
    raise exception 'That invitation was withdrawn.' using errcode = '42501';
  end if;
  if v_state = 'expired' then
    raise exception 'That invitation has expired. Ask for a new one.' using errcode = '42501';
  end if;

  select o.name into v_org_name
  from public.organizations o
  where o.id = v_invitation.organization_id;

  if v_org_name is null then
    raise exception 'That agency no longer exists.' using errcode = 'P0002';
  end if;

  /*
   * Any existing membership row, not just an active one.
   *
   * `organization_members` is unique on (organization, user), and this schema
   * has carried a `suspended` status since the foundation. Looking only for an
   * active row would send a suspended member straight into an INSERT and a raw
   * unique-violation message — a database constraint shown to a person who has
   * done nothing wrong. A suspended member accepting a valid invitation is
   * being readmitted, so the row is reinstated at the invited role.
   */
  select m.role, m.status into v_existing, v_status
  from public.organization_members m
  where m.organization_id = v_invitation.organization_id
    and m.user_id = v_actor;

  if v_existing is not null and v_status <> 'active' then
    perform set_config('app.membership_operation', 'on', true);

    update public.organization_members m
       set status = 'active', role = v_invitation.role
     where m.organization_id = v_invitation.organization_id
       and m.user_id = v_actor;

    update public.organization_invitations
       set accepted_at = now(), accepted_by = v_actor
     where id = v_invitation.id;

    perform set_config('app.membership_operation', 'off', true);

    perform app.record_team_event(
      v_invitation.organization_id, 'invitation_accepted', v_actor, v_invitation.email,
      v_existing, v_invitation.role, v_invitation.id, 'Readmitted from a suspended membership.'
    );

    return query select v_invitation.organization_id, v_org_name, v_invitation.role, 'joined'::text;
    return;
  end if;

  if v_existing is not null then
    if v_invitation.accepted_at is null then
      update public.organization_invitations
         set accepted_at = now(), accepted_by = v_actor
       where id = v_invitation.id;

      perform app.record_team_event(
        v_invitation.organization_id, 'invitation_accepted', v_actor, v_invitation.email,
        null, v_existing, v_invitation.id, 'Already a member; the invitation was closed.'
      );
    end if;

    return query select v_invitation.organization_id, v_org_name, v_existing, 'already_member'::text;
    return;
  end if;

  if v_state = 'accepted' then
    -- Accepted by somebody else's account, or accepted and then removed. Either
    -- way this token is spent and does not grant anything again.
    raise exception 'That invitation has already been used.' using errcode = '42501';
  end if;

  /*
   * Does the person who sent this still have the authority to send it?
   *
   * Demotion and removal already revoke an administrator's open invitations, so
   * this is the race guard rather than the main defence: an invitation created a
   * second before its author was demoted must not outlive the demotion. An
   * invitation with no author left — the account was deleted from Auth — is
   * treated as still valid, because `invited_by` is nulled by the foreign key
   * and there is nothing left to re-check.
   */
  if v_invitation.invited_by is not null then
    select m.role into v_inviter_role
    from public.organization_members m
    where m.organization_id = v_invitation.organization_id
      and m.user_id = v_invitation.invited_by
      and m.status = 'active';

    if not app.may_grant_role(v_inviter_role, v_invitation.role) then
      update public.organization_invitations
         set revoked_at = now(),
             revoked_by = v_invitation.invited_by,
             revoke_reason = 'The person who sent it no longer has authority to grant this role.',
             token_digest = app.invitation_token_digest(app.new_invitation_token()),
             token_version = token_version + 1
       where id = v_invitation.id;

      raise exception 'That invitation is no longer valid. Ask an administrator to send a new one.'
        using errcode = '42501';
    end if;
  end if;

  perform set_config('app.membership_operation', 'on', true);

  insert into public.organization_members (organization_id, user_id, role, status, invited_by)
  values (v_invitation.organization_id, v_actor, v_invitation.role, 'active', v_invitation.invited_by);

  update public.organization_invitations
     set accepted_at = now(), accepted_by = v_actor
   where id = v_invitation.id;

  perform set_config('app.membership_operation', 'off', true);

  perform app.record_team_event(
    v_invitation.organization_id, 'invitation_accepted', v_actor, v_invitation.email,
    null, v_invitation.role, v_invitation.id, null
  );

  return query select v_invitation.organization_id, v_org_name, v_invitation.role, 'joined'::text;
end;
$$;

comment on function public.accept_team_invitation(text) is
  'Validates a token, verifies the caller''s confirmed Auth email matches the invited address, and creates exactly one membership. Atomic and idempotent.';

-- =============================================================================
-- Role changes, removal, departure, transfer
-- =============================================================================

create or replace function public.change_team_member_role(
  p_organization_id uuid,
  p_user_id         uuid,
  p_role            public.org_role
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_actor_role  public.org_role;
  v_target      public.organization_members;
  v_owners      integer;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_actor_role := app.current_role_in(p_organization_id);
  if v_actor_role is null then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  /*
   * Nobody changes their own role here.
   *
   * Not "nobody promotes themselves" — nobody *changes* their own role, in
   * either direction, through this function. An administrator who wants less
   * authority leaves, or asks another administrator; an owner who wants out
   * transfers ownership. A generic self-edit is one typo away from an agency
   * with no administrator left in it.
   */
  if p_user_id = v_actor then
    raise exception 'You cannot change your own role.' using errcode = '42501';
  end if;

  if p_role = 'owner' then
    raise exception 'Ownership is transferred, not assigned.' using errcode = '42501';
  end if;

  -- Owner rows are locked first, in one order everywhere, so a demotion racing a
  -- transfer cannot interleave.
  v_owners := app.lock_and_count_active_owners(p_organization_id);

  select * into v_target
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id
    and m.status = 'active'
  for update;

  if not found then
    raise exception 'That person is not a member of this organization.' using errcode = 'P0002';
  end if;

  if not app.may_act_on_member(v_actor_role, v_target.role) then
    raise exception 'You cannot change the role of a %.', v_target.role using errcode = '42501';
  end if;
  if not app.may_grant_role(v_actor_role, p_role) then
    raise exception 'You cannot grant the % role.', p_role using errcode = '42501';
  end if;

  if v_target.role = p_role then
    return;
  end if;

  if v_target.role = 'owner' and v_owners <= 1 then
    raise exception 'An organization must always keep at least one active owner.'
      using errcode = '23514';
  end if;

  perform set_config('app.membership_operation', 'on', true);

  update public.organization_members
     set role = p_role
   where organization_id = p_organization_id
     and user_id = p_user_id;

  perform set_config('app.membership_operation', 'off', true);

  perform app.record_team_event(
    p_organization_id, 'role_changed', p_user_id, null, v_target.role, p_role, null, null
  );

  -- A demoted administrator's outstanding invitations go with the demotion.
  perform app.revoke_invitations_beyond_authority(
    p_organization_id, p_user_id,
    'The person who sent it no longer has authority to grant this role.'
  );
end;
$$;

comment on function public.change_team_member_role(uuid, uuid, public.org_role) is
  'Changes another member''s role. Never the caller''s own, never to owner, never above the caller, never past the last-owner rule.';

/**
 * Removes somebody's access to one agency.
 *
 * This deletes a membership. It does not delete an account, a profile, a
 * membership of any other agency, or one row of the work the person did: every
 * business record in this schema references `auth.users` directly and none of
 * them are touched. Team history keeps their name as text, so the record of what
 * they did here survives their leaving it.
 */
create or replace function public.remove_team_member(
  p_organization_id uuid,
  p_user_id         uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_actor_role public.org_role;
  v_target     public.organization_members;
  v_owners     integer;
  v_name       text;
  v_email      text;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_actor_role := app.current_role_in(p_organization_id);
  if v_actor_role is null then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  if p_user_id = v_actor then
    raise exception 'Use Leave organization to remove yourself.' using errcode = '42501';
  end if;

  v_owners := app.lock_and_count_active_owners(p_organization_id);

  select * into v_target
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id
    and m.status = 'active'
  for update;

  if not found then
    raise exception 'That person is not a member of this organization.' using errcode = 'P0002';
  end if;

  if not app.may_act_on_member(v_actor_role, v_target.role) then
    raise exception 'You cannot remove a %.', v_target.role using errcode = '42501';
  end if;

  if v_target.role = 'owner' and v_owners <= 1 then
    raise exception 'An organization must always keep at least one active owner.'
      using errcode = '23514';
  end if;

  -- Snapshot before the membership disappears: after this transaction the
  -- profile is no longer readable to anyone in the agency.
  select coalesce(nullif(btrim(p.full_name), ''), p.email, ''), p.email
    into v_name, v_email
  from public.profiles p where p.id = p_user_id;

  perform set_config('app.membership_operation', 'on', true);

  delete from public.organization_members
   where organization_id = p_organization_id
     and user_id = p_user_id;

  perform set_config('app.membership_operation', 'off', true);

  perform app.record_team_event(
    p_organization_id, 'member_removed', p_user_id, v_email, v_target.role, null, null, null, v_name
  );

  -- After the membership is gone, not before: the helper decides what to revoke
  -- from the role the person holds *now*, and a member who is still an
  -- administrator when it runs looks perfectly entitled to everything they sent.
  perform app.revoke_invitations_beyond_authority(
    p_organization_id, p_user_id, 'The person who sent it is no longer a member.'
  );
end;
$$;

/** Leaves an agency. Keeps the account, the profile and every other membership. */
create or replace function public.leave_organization(p_organization_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_role   public.org_role;
  v_owners integer;
  v_name   text;
  v_email  text;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_owners := app.lock_and_count_active_owners(p_organization_id);

  select m.role into v_role
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = v_actor
    and m.status = 'active'
  for update;

  if v_role is null then
    raise exception 'You are not a member of this organization.' using errcode = 'P0002';
  end if;

  if v_role = 'owner' and v_owners <= 1 then
    raise exception 'Transfer ownership before leaving: an organization must always keep an owner.'
      using errcode = '23514';
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), p.email, ''), p.email
    into v_name, v_email
  from public.profiles p where p.id = v_actor;

  perform set_config('app.membership_operation', 'on', true);

  delete from public.organization_members
   where organization_id = p_organization_id
     and user_id = v_actor;

  perform set_config('app.membership_operation', 'off', true);

  perform app.record_team_event(
    p_organization_id, 'member_left', v_actor, v_email, v_role, null, null, null, v_name
  );

  -- After the departure, for the same reason removal revokes afterwards.
  perform app.revoke_invitations_beyond_authority(
    p_organization_id, v_actor, 'The person who sent it has left the organization.'
  );
end;
$$;

/**
 * Hands an agency to somebody else.
 *
 * The only way an owner is ever created. One transaction: the target becomes
 * owner and the outgoing owner takes the role they chose, so there is no instant
 * — not even inside the transaction — at which the agency has nobody in charge,
 * and no way for a failure between two browser calls to leave two owners or
 * none.
 */
create or replace function public.transfer_organization_ownership(
  p_organization_id uuid,
  p_user_id         uuid,
  p_outgoing_role   public.org_role default 'admin'
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_target public.organization_members;
  v_owners integer;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  if app.current_role_in(p_organization_id) is distinct from 'owner' then
    raise exception 'Only the owner can transfer ownership.' using errcode = '42501';
  end if;

  if p_user_id = v_actor then
    raise exception 'You already own this organization.' using errcode = '22023';
  end if;

  if p_outgoing_role = 'owner' then
    raise exception 'Choose the role you will keep after the transfer.' using errcode = '22023';
  end if;

  v_owners := app.lock_and_count_active_owners(p_organization_id);

  -- Re-read the caller's own membership under the lock. Between the role check
  -- above and this line another transfer may have completed and demoted them.
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = v_actor
      and m.role = 'owner'
      and m.status = 'active'
  ) then
    raise exception 'Only the owner can transfer ownership.' using errcode = '42501';
  end if;

  -- The target is read from this organization's membership, never taken on
  -- trust: an id belonging to another agency simply is not a member here.
  select * into v_target
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = p_user_id
    and m.status = 'active'
  for update;

  if not found then
    raise exception 'Choose an active member of this organization.' using errcode = 'P0002';
  end if;

  perform set_config('app.membership_operation', 'on', true);

  update public.organization_members
     set role = 'owner'
   where organization_id = p_organization_id and user_id = p_user_id;

  update public.organization_members
     set role = p_outgoing_role
   where organization_id = p_organization_id and user_id = v_actor;

  perform set_config('app.membership_operation', 'off', true);

  -- The invariant, re-asserted against what is actually in the table rather
  -- than against what this function believes it just did.
  select count(*) into v_owners
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.role = 'owner'
    and m.status = 'active';

  if v_owners < 1 then
    raise exception 'Ownership transfer would leave the organization without an owner.'
      using errcode = '23514';
  end if;

  perform app.record_team_event(
    p_organization_id, 'ownership_transferred', p_user_id, null, v_target.role, 'owner', null,
    'The previous owner is now ' || p_outgoing_role || '.'
  );

  -- The outgoing owner may no longer be able to grant what they promised.
  perform app.revoke_invitations_beyond_authority(
    p_organization_id, v_actor,
    'The person who sent it no longer has authority to grant this role.'
  );
end;
$$;

comment on function public.transfer_organization_ownership(uuid, uuid, public.org_role) is
  'Moves ownership to another active member and sets the outgoing owner''s role, in one transaction under an advisory lock.';

-- =============================================================================
-- Provisioning: an invited person does not get an agency of their own
--
-- Sign-up provisions an agency when the sign-up metadata names one. That is
-- right for somebody starting their own business and wrong for somebody who is
-- authenticating in order to join one that already exists — they would end up
-- owning an empty second agency they never asked for, which then appears in
-- their workspace switcher forever.
--
-- The decision is made from a fact in this database, not from a flag the browser
-- sent: does an open invitation exist for the address GoTrue just registered? A
-- client cannot manufacture one, because creating an invitation requires an
-- administrator of some agency to have created it. The dedicated invitation
-- sign-up screen also sends no agency name at all, but that is the courtesy;
-- this is the control.
-- =============================================================================

create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_org_name text;
  v_invited  boolean;
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    left(btrim(coalesce(v_meta ->> 'full_name', '')), 120),
    new.email
  )
  on conflict (id) do nothing;

  v_org_name := btrim(coalesce(v_meta ->> 'organization_name', ''));

  v_invited := exists (
    select 1
    from public.organization_invitations i
    where i.email_normalized = app.normalize_email(new.email)
      and i.accepted_at is null
      and i.revoked_at is null
      and i.expires_at > now()
  );

  if v_invited then
    -- Nothing is provisioned and nothing is accepted. The invitation is still a
    -- pending offer; the person accepts it themselves, from the link, once their
    -- address is confirmed.
    return new;
  end if;

  if char_length(v_org_name) >= 2 then
    begin
      perform app.provision_organization(
        new.id,
        v_org_name,
        v_meta ->> 'country_code',
        v_meta ->> 'default_currency',
        v_meta ->> 'time_zone',
        v_meta ->> 'locale'
      );
    exception
      when others then
        -- Never let agency provisioning block account creation. The application
        -- detects "authenticated but no membership" and offers onboarding, which
        -- calls public.create_organization() directly.
        raise warning 'Agency provisioning failed for user %: %', new.id, sqlerrm;
    end;
  end if;

  return new;
end;
$$;

-- =============================================================================
-- Privileges and Row Level Security
-- =============================================================================

-- Supabase's default privileges grant ALL on every new table in `public` to
-- anon and authenticated. Both new tables are therefore stripped explicitly.
revoke all on table public.organization_invitations from anon, authenticated;
revoke all on table public.organization_team_events from anon, authenticated;

alter table public.organization_invitations enable row level security;
alter table public.organization_team_events enable row level security;

/*
 * Policies with no matching grant.
 *
 * That is not dead code here: Supabase re-applies default privileges in several
 * situations, and a future migration that adds `grant select` without thinking
 * about tenancy would otherwise expose every agency's invitations to every
 * signed-in user. With these in place the worst such a mistake can do is show an
 * administrator their own agency's rows.
 *
 * The tables are read through team_invitations() and team_events(), which are
 * SECURITY DEFINER, check the role explicitly, and never select the digest.
 */
drop policy if exists organization_invitations_select on public.organization_invitations;
create policy organization_invitations_select on public.organization_invitations
  for select to authenticated
  using (app.has_min_role(organization_id, 'admin'));

drop policy if exists organization_team_events_select on public.organization_team_events;
create policy organization_team_events_select on public.organization_team_events
  for select to authenticated
  using (app.has_min_role(organization_id, 'admin'));

/*
 * organization_members: reading stays, writing goes.
 *
 * Every membership change now happens inside a function in this file, each of
 * which performs checks that a row-level policy cannot express — who may grant
 * which role, that nobody edits their own, that an owner survives, and that the
 * change is recorded. Leaving the grants in place would leave all of that
 * optional.
 */
revoke insert, update, delete on table public.organization_members from authenticated;

drop policy if exists organization_members_insert on public.organization_members;
drop policy if exists organization_members_update on public.organization_members;
drop policy if exists organization_members_delete on public.organization_members;

-- -----------------------------------------------------------------------------
-- Execution grants
-- -----------------------------------------------------------------------------

revoke all on function app.invitation_ttl() from public;
revoke all on function app.invitation_resend_cooldown() from public;
revoke all on function app.invitation_hourly_limit() from public;
revoke all on function app.normalize_email(text) from public;
revoke all on function app.may_grant_role(public.org_role, public.org_role) from public;
revoke all on function app.may_act_on_member(public.org_role, public.org_role) from public;
revoke all on function app.lock_and_count_active_owners(uuid) from public;
revoke all on function app.actor_display_name(uuid) from public;
revoke all on function app.record_team_event(uuid, public.team_event, uuid, text, public.org_role, public.org_role, uuid, text, text) from public;
revoke all on function app.invitation_state(timestamptz, timestamptz, timestamptz) from public;
revoke all on function app.new_invitation_token() from public;
revoke all on function app.invitation_token_digest(text) from public;
revoke all on function app.revoke_invitations_beyond_authority(uuid, uuid, text) from public;
revoke all on function app.team_events_are_immutable() from public;

/*
 * The token functions are not reachable from a client at all.
 *
 * `app` is not exposed through PostgREST, and no role is granted EXECUTE on
 * these two. A caller who could run app.new_invitation_token() would learn
 * nothing — it takes no arguments and returns fresh randomness — but
 * app.invitation_token_digest() is an oracle for testing a guessed token
 * offline, and there is no reason for anything but this file to hold it.
 */

revoke all on function public.team_directory(uuid) from public, anon;
revoke all on function public.team_invitations(uuid, boolean, integer, integer) from public, anon;
revoke all on function public.team_events(uuid, integer, integer) from public, anon;
revoke all on function public.team_seat_summary(uuid) from public, anon;
revoke all on function public.create_team_invitation(uuid, text, public.org_role) from public, anon;
revoke all on function public.resend_team_invitation(uuid) from public, anon;
revoke all on function public.revoke_team_invitation(uuid, text) from public, anon;
revoke all on function public.record_invitation_delivery(uuid, public.invitation_delivery, text) from public, anon;
revoke all on function public.team_invitation_message(uuid) from public, anon;
revoke all on function public.accept_team_invitation(text) from public, anon;
revoke all on function public.change_team_member_role(uuid, uuid, public.org_role) from public, anon;
revoke all on function public.remove_team_member(uuid, uuid) from public, anon;
revoke all on function public.leave_organization(uuid) from public, anon;
revoke all on function public.transfer_organization_ownership(uuid, uuid, public.org_role) from public, anon;
revoke all on function public.preview_team_invitation(text) from public, anon, authenticated;

grant execute on function public.team_directory(uuid) to authenticated;
grant execute on function public.team_invitations(uuid, boolean, integer, integer) to authenticated;
grant execute on function public.team_events(uuid, integer, integer) to authenticated;
grant execute on function public.team_seat_summary(uuid) to authenticated;
grant execute on function public.create_team_invitation(uuid, text, public.org_role) to authenticated;
grant execute on function public.resend_team_invitation(uuid) to authenticated;
grant execute on function public.revoke_team_invitation(uuid, text) to authenticated;
grant execute on function public.record_invitation_delivery(uuid, public.invitation_delivery, text) to authenticated;
grant execute on function public.team_invitation_message(uuid) to authenticated;
grant execute on function public.accept_team_invitation(text) to authenticated;
grant execute on function public.change_team_member_role(uuid, uuid, public.org_role) to authenticated;
grant execute on function public.remove_team_member(uuid, uuid) to authenticated;
grant execute on function public.leave_organization(uuid) to authenticated;
grant execute on function public.transfer_organization_ownership(uuid, uuid, public.org_role) to authenticated;

-- The signed-out preview, reachable only through the invitation Edge Function.
grant execute on function public.preview_team_invitation(text) to service_role;

grant execute on function app.may_grant_role(public.org_role, public.org_role) to authenticated, service_role;
grant execute on function app.may_act_on_member(public.org_role, public.org_role) to authenticated, service_role;
grant execute on function app.invitation_state(timestamptz, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function app.normalize_email(text) to authenticated, service_role;

-- =============================================================================
-- Self-checks — these fail the deploy rather than a code review
-- =============================================================================

do $$
declare
  v_offenders text;
begin
  -- 1. No client role may write to organization_members directly.
  select string_agg(privilege_type, ', ' order by privilege_type)
    into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'organization_members'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE');

  if v_offenders is not null then
    raise exception
      'organization_members is still directly writable by a client role (%). Membership changes must go through the Team functions.',
      v_offenders;
  end if;

  -- 2. The invitation and history tables are unreachable by table access.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ')
    into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('organization_invitations', 'organization_team_events')
    and grantee in ('anon', 'authenticated');

  if v_offenders is not null then
    raise exception 'Team tables are directly accessible: %.', v_offenders;
  end if;

  -- 3. Nothing anonymous, anywhere in public.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'The anonymous role can execute these public functions: %.', v_offenders;
  end if;

  -- 4. The preview is not reachable by an ordinary signed-in user; it is the
  --    one function on this surface that answers questions about an invitation
  --    without checking membership at all.
  if has_function_privilege('authenticated', 'public.preview_team_invitation(text)', 'EXECUTE') then
    raise exception 'authenticated can execute preview_team_invitation; only service_role may.';
  end if;

  -- 5. No path other than transfer can produce an owner.
  if exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'organization_invitations'
      and c.conname = 'organization_invitations_never_owner'
  ) is not true then
    raise exception 'The invitation table lost its owner-role constraint.';
  end if;
end
$$;

select app.assert_views_are_security_invoker();
