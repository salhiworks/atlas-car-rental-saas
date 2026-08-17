-- =============================================================================
-- Notifications: corrections found by reviewing the deployed module
--
-- Three findings, each reproduced against a real PostgreSQL before being fixed
-- here, and none of them a change of design:
--
--   1. PRESENTATION STATE COULD BE WRITTEN FOR NOTIFICATIONS THAT DO NOT EXIST.
--      notification_mark_read, notification_dismiss and notification_snooze
--      wrote a row for whatever fingerprint they were handed. A signed-in member
--      could therefore add rows to notification_states indefinitely — fifty in a
--      loop, in the probe — none of which corresponds to anything the product
--      would ever show. Every other write in this schema has a domain fact
--      behind it; this one did not.
--
--   2. AN EVENT COULD NAME A RECIPIENT WHO COULD NEVER READ IT. The audience for
--      a team event was "the administrators, plus the person it was about". A
--      member demoted to staff is the person it was about and is no longer an
--      administrator, so the row said "this was for you" while the permission
--      model said otherwise. Reproduced: one recipient row, nothing visible.
--
--   3. THE BADGE STOPS COUNTING AT 200, which was true but undocumented.
--
-- Fixes 1 and 2 tighten what can be written. Neither can hide a notification
-- that should be shown: the feed is derived from domain records on every call
-- and joins state onto it, so it is unchanged by both.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- 1. State belongs to a notification that exists
-- -----------------------------------------------------------------------------

/**
 * Whether this caller currently has the notification named by `p_fingerprint`.
 *
 * The candidate helpers each check the caller's own role and return nothing when
 * they may not, so this answers false for a financing fingerprint handed to a
 * staff member — the same answer they get from the feed.
 *
 * Deliberately NOT notification_feed(): the feed is paged, and a person with
 * three hundred expiring documents must still be able to dismiss the last one.
 */
create or replace function app.notification_exists(
  p_organization_id uuid,
  p_fingerprint     text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from (
      select * from app.notification_candidates_rentals(p_organization_id)
      union all select * from app.notification_candidates_compliance(p_organization_id)
      union all select * from app.notification_candidates_financing(p_organization_id)
      union all select * from app.notification_candidates_gps(p_organization_id)
      union all select * from app.notification_candidates_events(p_organization_id)
    ) c
    where c.fingerprint = p_fingerprint
  );
$$;

comment on function app.notification_exists(uuid, text) is
  'Whether the calling member currently has this notification. Used to keep presentation state tied to something real.';

revoke all on function app.notification_exists(uuid, text) from public, anon;

/*
 * The three state writes now share one shape:
 *
 *   authenticated → a member of this agency → a fingerprint of a sane length →
 *   a notification that actually exists → write.
 *
 * The last step is a QUIET no-op rather than an error. A person clicking dismiss
 * at the moment a colleague marks the car returned is not making a mistake, and
 * an error toast for a notification that resolved itself would be a lie about
 * what went wrong. Nothing is written, the next read shows it gone, and the
 * table stays bounded by the number of conditions that are genuinely true.
 */

create or replace function public.notification_mark_read(
  p_organization_id uuid,
  p_fingerprint     text
)
returns void
language plpgsql
volatile
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
  if p_fingerprint is null or char_length(p_fingerprint) not between 1 and 200 then
    raise exception 'A notification is required.' using errcode = '22004';
  end if;
  if not app.notification_exists(p_organization_id, p_fingerprint) then
    return;
  end if;

  insert into public.notification_states (organization_id, user_id, fingerprint, read_at)
  values (p_organization_id, v_actor, p_fingerprint, now())
  on conflict (organization_id, user_id, fingerprint)
  do update set read_at = coalesce(public.notification_states.read_at, now());
end;
$$;

create or replace function public.notification_dismiss(
  p_organization_id uuid,
  p_fingerprint     text
)
returns void
language plpgsql
volatile
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
  if p_fingerprint is null or char_length(p_fingerprint) not between 1 and 200 then
    raise exception 'A notification is required.' using errcode = '22004';
  end if;
  if not app.notification_exists(p_organization_id, p_fingerprint) then
    return;
  end if;

  /*
   * Dismiss hides one episode for one person. It does not resolve anything: the
   * rental is still out, the instalment is still late. When the condition
   * escalates it becomes a different episode with a different fingerprint, so
   * dismissing "due soon" cannot silence "overdue" later.
   */
  insert into public.notification_states
    (organization_id, user_id, fingerprint, read_at, dismissed_at)
  values (p_organization_id, v_actor, p_fingerprint, now(), now())
  on conflict (organization_id, user_id, fingerprint)
  do update set dismissed_at = now(),
                read_at = coalesce(public.notification_states.read_at, now());
end;
$$;

create or replace function public.notification_snooze(
  p_organization_id uuid,
  p_fingerprint     text,
  p_until           timestamptz
)
returns void
language plpgsql
volatile
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
  if p_fingerprint is null or char_length(p_fingerprint) not between 1 and 200 then
    raise exception 'A notification is required.' using errcode = '22004';
  end if;
  if p_until is null or p_until <= now() then
    raise exception 'Choose a time in the future.' using errcode = '22023';
  end if;
  -- A month is the longest anything here is worth hiding; beyond that, dismiss.
  if p_until > now() + interval '31 days' then
    raise exception 'Notifications cannot be snoozed that far ahead.' using errcode = '22023';
  end if;
  if not app.notification_exists(p_organization_id, p_fingerprint) then
    return;
  end if;

  insert into public.notification_states
    (organization_id, user_id, fingerprint, snoozed_until)
  values (p_organization_id, v_actor, p_fingerprint, p_until)
  on conflict (organization_id, user_id, fingerprint)
  do update set snoozed_until = p_until;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. An event names only people who can receive it
-- -----------------------------------------------------------------------------

create or replace function app.notification_from_team_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind     public.notification_kind;
  v_severity public.notification_severity;
  v_event    uuid;
begin
  v_kind := case new.event
    when 'invitation_accepted'    then 'team_invitation_accepted'
    when 'ownership_transferred'  then 'team_ownership_transferred'
    when 'role_changed'           then 'team_role_changed'
    when 'member_removed'         then 'team_member_removed'
  end::public.notification_kind;

  if v_kind is null then
    return new;
  end if;

  v_severity := case when new.event = 'ownership_transferred' then 'attention' else 'info' end;

  insert into public.notification_events (
    organization_id, kind, severity, occurred_at,
    actor_user_id, actor_label, subject_user_id, subject_label,
    context, source_table, source_id
  ) values (
    new.organization_id, v_kind, v_severity, new.occurred_at,
    new.actor_user_id, new.actor_name, new.target_user_id, new.target_name,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_role', new.previous_role,
      'new_role', new.new_role
    )),
    'organization_team_events', new.id
  )
  -- The same audit row twice is the same notification once.
  on conflict (organization_id, source_table, source_id) do nothing
  returning id into v_event;

  if v_event is null then
    return new;
  end if;

  /*
   * The audience, decided now: everyone who administers the agency at this
   * moment, except whoever did it.
   *
   * The person the event is ABOUT is included exactly when they are one of
   * those administrators — a promotion, or a transfer of ownership — and not
   * otherwise. Naming a demoted member as a recipient of an administrators-only
   * notification recorded an audience that could never read it, which is a row
   * that says something untrue about who was told.
   *
   * Team history remains complete and readable in the Team module itself; this
   * decides who gets an inbox item, not who may see the record.
   */
  insert into public.notification_event_recipients (event_id, user_id)
  select v_event, m.user_id
  from public.organization_members m
  where m.organization_id = new.organization_id
    and m.status = 'active'
    and app.role_rank(m.role) >= app.role_rank('admin')
    and m.user_id is distinct from new.actor_user_id
  on conflict do nothing;

  return new;
end;
$$;

revoke all on function app.notification_from_team_event() from public, anon;

-- -----------------------------------------------------------------------------
-- 3. Say what the badge does at the top of its range
-- -----------------------------------------------------------------------------

comment on function public.notification_unread_count(uuid) is
  'Unread, undismissed, unsnoozed, permission-visible episodes, counted through notification_feed so the badge and the drawer cannot disagree. Counts at most 200: the interface renders anything above 99 as "99+", so the ceiling is never visible, and an exact number in the thousands would be a slower query answering a question nobody asked.';

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

do $$
declare
  v_offenders text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app')
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'The anonymous role can execute: %.', v_offenders;
  end if;

  -- The three state writes must all bind to a real notification. A future
  -- rewrite that drops the check would put the unbounded write back.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('notification_mark_read', 'notification_dismiss', 'notification_snooze')
    and p.prosrc not like '%app.notification_exists%';

  if v_offenders is not null then
    raise exception 'These write presentation state without checking it exists: %.', v_offenders;
  end if;
end
$$;
