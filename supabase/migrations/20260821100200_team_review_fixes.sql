-- =============================================================================
-- 20260821100200_team_review_fixes.sql
--
-- What a six-lens adversarial review of the Team module found, and how each
-- confirmed defect is closed. Every finding below survived two independent
-- verifiers whose instruction was to refute it.
--
--   1. SPENT TOKENS COULD BE REPLAYED.
--      accept_team_invitation() checked for an existing membership BEFORE it
--      checked whether the invitation had already been used. A member who
--      accepted, was later suspended, and still had the original email could
--      replay the link and reinstate themselves at the invited role. The state
--      of the invitation is now decided before any membership branch runs.
--
--   2. THE AUTHORITY RACE GUARD REVOKED NOTHING.
--      When acceptance found that the inviter had lost the authority to grant
--      the role, it wrote a revocation and then raised — and the RAISE rolled
--      its own UPDATE back. The link stayed live, and became acceptable again
--      the moment the inviter was restored. Closed at the source instead: the
--      creation and the demotion now serialise on one per-agency lock, so the
--      sweep in app.revoke_invitations_beyond_authority cannot miss an
--      invitation inserted a moment earlier. Acceptance still re-checks, and
--      now simply refuses rather than pretending to persist anything.
--
--   3. AN AGENCY'S OWN MEMBERS COULD FORGE THE ADDRESSES TEAM READS.
--      `profiles.email` is documented as a mirror of auth.users, but the client
--      holds UPDATE on `profiles` and the freeze trigger did not cover it. Any
--      member could set it to a colleague's address — making two roster rows
--      identical in name, address and role — or to an address the agency was
--      about to invite, which made create_team_invitation answer
--      "already_member" and silently swallow the invitation. Two fixes: the
--      mirror is now recomputed from auth.users on every update, so it cannot
--      be forged by anyone; and every Team function reads auth.users directly
--      rather than trusting the mirror at all.
--
--   4. THE HOURLY CEILING DID NOT COVER RESENDS.
--      create_team_invitation counted issuances; resend_team_invitation minted
--      a token and asked a provider to send mail with no ceiling at all. With
--      enough open invitations that is a mail relay. Both paths now count.
--
--   5. REISSUING SOMEBODY ELSE'S INVITATION LEFT THEIR NAME ON IT.
--      `invited_by` was not moved by reissue or resend, so the authority
--      cascade watched the wrong person: demoting the original author revoked
--      an invitation a higher-authority administrator had since taken over, and
--      demoting the administrator who actually reissued it revoked nothing.
--
--   6. A DEMOTED ADMINISTRATOR GOT ONE MORE WRITE.
--      change_team_member_role() and remove_team_member() read the caller's own
--      role before taking the per-agency lock, so a request already in flight
--      when its author was demoted completed anyway. The caller's authority is
--      now established under the lock.
--
--   7. HANDING AN ADMINISTRATOR A ONE-TIME LINK WAS NOT AUDITED.
--      `manual_link` and the `invitation_link_revealed` event existed and
--      nothing ever wrote them, because the delivery function reports what the
--      PROVIDER did and the disclosure happens later, in the browser. The
--      application now records it when the link is actually shown, and this
--      migration makes that call safe to make more than once.
--
-- ONE FINDING IS DELIBERATELY NOT "FIXED", because both available behaviours
-- are wrong and this one is wrong in the recoverable direction:
-- app.handle_new_user() suppresses agency provisioning for any address with an
-- open invitation ANYWHERE, so an administrator of an unrelated agency can
-- invite someone and thereby stop that person's own sign-up from creating their
-- agency. The alternative is to trust the browser's sign-up metadata, which is
-- exactly the spoofable flag this module refuses to rely on. The cost of the
-- choice made is one click on /welcome, which now says in as many words what to
-- do; the cost of the other is an unwanted agency the person permanently owns.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- One lock for every membership decision in one agency
-- -----------------------------------------------------------------------------

create or replace function app.lock_organization_membership(p_organization_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtext('app.organization_owners'),
    hashtext(p_organization_id::text)
  );
$$;

comment on function app.lock_organization_membership(uuid) is
  'Serialises every membership and invitation decision for one agency for the rest of the transaction. Held by role changes, removals, departures, transfers, and by invitation creation and reissue — so an invitation cannot be created in the window where its author is being demoted.';

revoke all on function app.lock_organization_membership(uuid) from public;

create or replace function app.lock_and_count_active_owners(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.lock_organization_membership(p_organization_id);

  -- Two statements because Postgres refuses FOR UPDATE alongside an aggregate:
  -- the first takes the row locks, the second counts what is now pinned.
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

-- -----------------------------------------------------------------------------
-- The profile email mirror cannot be forged
--
-- `profiles` is writable by its owner so people can set their own name, and the
-- email column sat inside that grant even though it is a mirror of auth.users
-- maintained by a trigger. Rather than freezing it — which the existing
-- on_auth_user_email_updated trigger would then fight — every update recomputes
-- it from the authority. A client that sends a different address simply gets
-- the real one back, and the auth trigger's own update lands on the same value.
-- -----------------------------------------------------------------------------

create or replace function app.mirror_profile_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.email := (select u.email from auth.users u where u.id = new.id);
  return new;
end;
$$;

comment on function app.mirror_profile_email() is
  'Recomputes profiles.email from auth.users on every update. The column is a mirror, and a mirror a member can point somewhere else is worse than no mirror at all.';

drop trigger if exists profiles_mirror_email on public.profiles;
create trigger profiles_mirror_email
  before update on public.profiles
  for each row execute function app.mirror_profile_email();

revoke all on function app.mirror_profile_email() from public;

-- Anything already forged goes back to the truth.
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;

-- -----------------------------------------------------------------------------
-- Display names, read from the authority
-- -----------------------------------------------------------------------------

create or replace function app.actor_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- The address comes from auth.users, never from the mirror: this string is
  -- snapshotted into immutable team history, and history that records a forged
  -- address is worse than history that records none.
  select coalesce(
    nullif(btrim(p.full_name), ''),
    (select u.email from auth.users u where u.id = p_user_id),
    ''
  )
  from public.profiles p
  where p.id = p_user_id;
$$;

/**
 * The roster.
 *
 * The address is read from auth.users. It was read from the profile mirror,
 * which every member could write — so two rows could be made identical in name,
 * address and role, and an owner choosing who to promote (or who to hand the
 * agency to) had nothing on screen that distinguished them. The display name is
 * still self-asserted, as a display name is in every product; the address beside
 * it is now the one GoTrue holds and cannot be edited by its owner.
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
         coalesce(
           nullif(btrim(p.full_name), ''),
           split_part(coalesce(u.email, ''), '@', 1),
           'Member'
         ),
         u.email::text,
         m.role,
         m.joined_at,
         m.job_title,
         m.user_id = v_actor
  from public.organization_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.organization_id = p_organization_id
    and m.status = 'active'
  order by app.role_rank(m.role) desc, m.joined_at, m.user_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Invitation creation: locked, ceilinged, and reading the authority
-- -----------------------------------------------------------------------------

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

  /*
   * The agency lock comes FIRST, before the caller's own authority is read.
   *
   * Without it, an invitation could be inserted in the window between a
   * demotion's authority sweep taking its snapshot and the demotion committing
   * — leaving a live grant of a role its author could no longer make. Taking
   * the same lock the role-change path takes means the two serialise: either
   * this call runs first and the sweep sees the invitation, or the demotion
   * runs first and the role check below refuses.
   */
  perform app.lock_organization_membership(p_organization_id);

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
  if v_normalized !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'That is not a valid email address.' using errcode = '22023';
  end if;

  if (
    select count(*) from public.organization_invitations i
    where i.organization_id = p_organization_id
      and i.last_issued_at > now() - interval '1 hour'
  ) >= app.invitation_hourly_limit() then
    raise exception 'This agency has sent a lot of invitations in the last hour. Try again shortly.'
      using errcode = '55006';
  end if;

  /*
   * Already in the agency? Matched against auth.users, not the profile mirror.
   *
   * The mirror used to be client-writable, so any member could set their own
   * profile email to an address the agency was about to invite and make this
   * check answer "already_member" — an invitation silently swallowed, reported
   * to the administrator as success, with no row, no token and no event. The
   * mirror is fixed above; this reads the authority regardless, because a check
   * that decides whether an invitation happens should not depend on a
   * denormalisation being in step.
   */
  select m.user_id into v_target_user
  from public.organization_members m
  join auth.users u on u.id = m.user_id
  where m.organization_id = p_organization_id
    and m.status = 'active'
    and app.normalize_email(u.email) = v_normalized
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
    if v_existing.last_issued_at + app.invitation_resend_cooldown() > now() then
      raise exception 'That invitation was issued moments ago. Try again shortly.'
        using errcode = '55006';
    end if;

    /*
     * `invited_by` moves to whoever reissued it.
     *
     * It did not, and the authority cascade keys on that column: demoting the
     * original author revoked an invitation a higher-authority administrator
     * had since taken over, while demoting the administrator who actually
     * rotated the token and chose the role revoked nothing. The person who last
     * issued a capability is the person whose authority it rests on.
     */
    update public.organization_invitations
       set email          = v_email,
           role           = p_role,
           invited_by     = v_actor,
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

-- -----------------------------------------------------------------------------
-- Resend: the same lock, the same ceiling, the same ownership of authority
-- -----------------------------------------------------------------------------

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
  v_actor        uuid := (select auth.uid());
  v_actor_role   public.org_role;
  v_invitation   public.organization_invitations;
  v_organization uuid;
  v_token        text;
  v_expires      timestamptz;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  /*
   * The agency lock is taken BEFORE the row lock, in the same order as
   * create_team_invitation — advisory first, then the row.
   *
   * Taking them the other way round is a lock-order inversion: a create and a
   * resend racing on the same agency would each hold what the other wanted and
   * PostgreSQL would abort one with a deadlock. So the row is read once
   * unlocked purely to learn which agency it belongs to, and everything the
   * decision rests on is re-read afterwards under both locks.
   */
  select i.organization_id into v_organization
  from public.organization_invitations i
  where i.id = p_invitation_id;

  if v_organization is null or not app.is_org_member(v_organization) then
    raise exception 'That invitation was not found.' using errcode = 'P0002';
  end if;

  perform app.lock_organization_membership(v_organization);

  select * into v_invitation
  from public.organization_invitations i
  where i.id = p_invitation_id
  for update;

  if not found then
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

  if v_invitation.last_issued_at + app.invitation_resend_cooldown() > now() then
    raise exception 'That invitation was sent moments ago. Try again shortly.'
      using errcode = '55006';
  end if;

  /*
   * The agency ceiling applies here too.
   *
   * It used to sit only on creation, and it counted rows. Resend mints a token
   * and asks a provider to send mail, so an agency with enough open invitations
   * could loop resends and use the product's mail reputation as a relay while
   * every individual call respected its two-minute floor.
   */
  if (
    select count(*) from public.organization_invitations i
    where i.organization_id = v_invitation.organization_id
      and i.last_issued_at > now() - interval '1 hour'
  ) >= app.invitation_hourly_limit() then
    raise exception 'This agency has sent a lot of invitations in the last hour. Try again shortly.'
      using errcode = '55006';
  end if;

  v_token := app.new_invitation_token();
  v_expires := now() + app.invitation_ttl();

  update public.organization_invitations
     set invited_by      = v_actor,
         token_digest    = app.invitation_token_digest(v_token),
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

-- -----------------------------------------------------------------------------
-- Acceptance: the invitation's state is settled before any membership is read
-- -----------------------------------------------------------------------------

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
  v_organization uuid;
  v_invited_email text;
begin
  if v_actor is null then
    raise exception 'Sign in to accept this invitation.' using errcode = '42501';
  end if;

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

  /*
   * Advisory lock first, then the row — the same order every other function in
   * this module uses. Reversing it here would let an acceptance and a reissue
   * on one agency each hold what the other is waiting for.
   *
   * The unlocked read establishes only which agency is involved. The address is
   * still checked before any state is reported, so a stranger holding a stale
   * token learns nothing, and everything the decision rests on is read again
   * under the locks.
   */
  select i.organization_id, i.email_normalized
    into v_organization, v_invited_email
  from public.organization_invitations i
  where i.token_digest = app.invitation_token_digest(p_token);

  if v_organization is null then
    raise exception 'That invitation link is not valid.' using errcode = 'P0002';
  end if;

  if v_invited_email <> v_email then
    raise exception 'This invitation was sent to a different account.' using errcode = '42501';
  end if;

  perform app.lock_organization_membership(v_organization);

  select * into v_invitation
  from public.organization_invitations i
  where i.token_digest = app.invitation_token_digest(p_token)
  for update;

  if not found then
    raise exception 'That invitation link is not valid.' using errcode = 'P0002';
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

  select m.role, m.status into v_existing, v_status
  from public.organization_members m
  where m.organization_id = v_invitation.organization_id
    and m.user_id = v_actor
  for update;

  /*
   * A SPENT INVITATION IS SETTLED HERE, BEFORE ANY MEMBERSHIP BRANCH.
   *
   * It used to be settled after them, and that was a replay: somebody who
   * accepted, was later suspended, and still had the original email could open
   * the same link and reinstate themselves at the invited role — which may be
   * higher than the role they were suspended at — leaving an ordinary
   * "invitation_accepted" event as the only trace.
   *
   * The one thing a used token may still do is answer the second of two tabs,
   * and only for the account that used it and only while that membership is
   * live. That is why the token is not rotated on acceptance: rotating it would
   * make the second tab read "this link is not valid" to somebody who has just
   * successfully joined. It grants nothing either way.
   */
  if v_state = 'accepted' then
    if v_invitation.accepted_by = v_actor and v_existing is not null and v_status = 'active' then
      return query select v_invitation.organization_id, v_org_name, v_existing, 'already_member'::text;
      return;
    end if;

    raise exception 'That invitation has already been used.' using errcode = '42501';
  end if;

  -- Already a member: close the invitation rather than failing on the unique
  -- constraint, and never create a second membership row.
  if v_existing is not null and v_status = 'active' then
    update public.organization_invitations
       set accepted_at = now(), accepted_by = v_actor
     where id = v_invitation.id;

    perform app.record_team_event(
      v_invitation.organization_id, 'invitation_accepted', v_actor, v_invitation.email,
      null, v_existing, v_invitation.id, 'Already a member; the invitation was closed.'
    );

    return query select v_invitation.organization_id, v_org_name, v_existing, 'already_member'::text;
    return;
  end if;

  -- A suspended member holding a PENDING invitation is being readmitted. The
  -- row is unique on (organization, user), so this is a reinstatement rather
  -- than an insert.
  if v_existing is not null then
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

  /*
   * Does the person who sent this still have the authority to send it?
   *
   * A refusal and nothing else. The earlier version wrote a revocation here and
   * then raised — and the RAISE rolled its own UPDATE back, so the link stayed
   * live and became acceptable again the moment its author was restored. The
   * durable revocation belongs to the demotion, which performs it under the
   * same per-agency lock this function now takes, so the race that made an
   * acceptance-time revocation seem necessary cannot happen.
   */
  if v_invitation.invited_by is not null then
    select m.role into v_inviter_role
    from public.organization_members m
    where m.organization_id = v_invitation.organization_id
      and m.user_id = v_invitation.invited_by
      and m.status = 'active';

    if not app.may_grant_role(v_inviter_role, v_invitation.role) then
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

-- -----------------------------------------------------------------------------
-- Role change and removal: the caller's authority is read under the lock
-- -----------------------------------------------------------------------------

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

  if p_user_id = v_actor then
    raise exception 'You cannot change your own role.' using errcode = '42501';
  end if;

  if p_role = 'owner' then
    raise exception 'Ownership is transferred, not assigned.' using errcode = '42501';
  end if;

  /*
   * The lock precedes every read the decision rests on — including the reader's
   * own role. It did not, and a request already in flight when its author was
   * demoted completed one more privileged write with the authority it no longer
   * had.
   */
  v_owners := app.lock_and_count_active_owners(p_organization_id);

  v_actor_role := app.current_role_in(p_organization_id);
  if v_actor_role is null then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

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

  perform app.revoke_invitations_beyond_authority(
    p_organization_id, p_user_id,
    'The person who sent it no longer has authority to grant this role.'
  );
end;
$$;

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

  if p_user_id = v_actor then
    raise exception 'Use Leave organization to remove yourself.' using errcode = '42501';
  end if;

  v_owners := app.lock_and_count_active_owners(p_organization_id);

  v_actor_role := app.current_role_in(p_organization_id);
  if v_actor_role is null then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

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

  -- Snapshot before the membership disappears; the address comes from the
  -- authority rather than the mirror.
  select coalesce(nullif(btrim(p.full_name), ''), u.email, ''), u.email
    into v_name, v_email
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id = p_user_id;

  perform set_config('app.membership_operation', 'on', true);

  delete from public.organization_members
   where organization_id = p_organization_id
     and user_id = p_user_id;

  perform set_config('app.membership_operation', 'off', true);

  perform app.record_team_event(
    p_organization_id, 'member_removed', p_user_id, v_email, v_target.role, null, null, null, v_name
  );

  perform app.revoke_invitations_beyond_authority(
    p_organization_id, p_user_id, 'The person who sent it is no longer a member.'
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Recording that a one-time link was handed over
--
-- The disclosure happens in the browser, after the delivery function has already
-- reported what the provider did, so this may be called on an invitation whose
-- delivery state is already `not_configured` or `failed`. It stays idempotent:
-- the event is written once per issued token, not once per click.
-- -----------------------------------------------------------------------------

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
  v_already    boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.id = p_invitation_id
  for update;

  if not found or not app.has_min_role(v_invitation.organization_id, 'admin') then
    raise exception 'That invitation was not found.' using errcode = 'P0002';
  end if;

  -- Has this token's disclosure already been recorded? Keyed on the version, so
  -- a reissued token is a new disclosure and a second click is not.
  v_already := p_state = 'manual_link'
    and exists (
      select 1 from public.organization_team_events e
      where e.invitation_id = p_invitation_id
        and e.event = 'invitation_link_revealed'
        and e.occurred_at >= v_invitation.last_issued_at
    );

  update public.organization_invitations
     set delivery_state  = p_state,
         delivery_detail = left(btrim(p_detail), 300),
         last_sent_at    = case when p_state in ('accepted_by_provider', 'manual_link')
                                then now() else last_sent_at end,
         send_count      = case when p_state in ('accepted_by_provider', 'manual_link')
                                then send_count + 1 else send_count end
   where id = p_invitation_id;

  if p_state = 'manual_link' and not v_already then
    perform app.record_team_event(
      v_invitation.organization_id, 'invitation_link_revealed', null, v_invitation.email,
      null, v_invitation.role, p_invitation_id,
      'A one-time invitation link was shown for manual delivery.'
    );
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

do $$
declare
  v_user  uuid;
  v_org   uuid;
  v_email text;
begin
  -- The profile mirror cannot be pointed anywhere.
  insert into auth.users (id, email) values (gen_random_uuid(), 'mirror-probe@example.invalid')
  returning id into v_user;

  insert into public.profiles (id, full_name, email)
  values (v_user, 'Mirror Probe', 'mirror-probe@example.invalid')
  on conflict (id) do nothing;

  update public.profiles set email = 'someone.else@example.invalid' where id = v_user;

  select email into v_email from public.profiles where id = v_user;
  if v_email is distinct from 'mirror-probe@example.invalid' then
    raise exception 'profiles.email can still be forged: it is now %', v_email;
  end if;

  insert into public.organizations (name, slug, default_currency, time_zone)
  values ('Mirror Probe Agency', 'mirror-probe-' || substr(md5(random()::text), 1, 12), 'EUR', 'UTC')
  returning id into v_org;

  delete from public.organizations where id = v_org;
  delete from auth.users where id = v_user;
end
$$;
