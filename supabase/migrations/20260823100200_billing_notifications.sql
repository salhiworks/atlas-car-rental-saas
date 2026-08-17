-- =============================================================================
-- Billing, in the notification feed
--
-- Two additions, and they are different kinds of thing:
--
--   * A CONDITION. "This subscription needs an owner's attention" is derived
--     from live billing state on every read, exactly like an overdue rental or
--     an expired policy. Nobody closes it; it stops being true and therefore
--     stops appearing. Today it never appears, because Billing is unconfigured
--     and an unconfigured platform is a deployment fact, not a delinquent
--     tenant.
--
--   * EVENTS. A payment that failed, a subscription that started, a
--     cancellation that was scheduled. Each is a moment, each is written by the
--     billing service through a trigger on billing_events, and each is
--     addressed to the people who were owners when it happened.
--
-- BOTH ARE OWNER-ONLY. A manager cannot receive either, and cannot construct
-- one: there is no client-reachable way to write a billing_events row, so there
-- is no client-reachable way to forge `billing_payment_failed`.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- 1. Which categories a member may receive
-- -----------------------------------------------------------------------------

/**
 * The categories the calling member is entitled to receive.
 *
 * Mirrors src/lib/authz/permissions.ts one for one, now including
 * 'billing.manage' = 'owner'. Billing is the first category above `admin`, and
 * deliberately so: everything in it is money.
 */
create or replace function app.notification_categories_for(p_organization_id uuid)
returns public.notification_category[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    case when app.has_min_role(p_organization_id, 'staff')   then 'rentals'    end,
    case when app.has_min_role(p_organization_id, 'staff')   then 'compliance' end,
    case when app.has_min_role(p_organization_id, 'manager') then 'financing'  end,
    case when app.has_min_role(p_organization_id, 'manager') then 'gps'        end,
    case when app.has_min_role(p_organization_id, 'admin')   then 'team'       end,
    case when app.has_min_role(p_organization_id, 'owner')   then 'billing'    end
  ]::public.notification_category[], null);
$$;

-- -----------------------------------------------------------------------------
-- 2. The team event helper stops claiming billing events
--
-- app.notification_candidates_events selects every event this person received
-- and labels the lot 'team'. Left alone it would hand an owner a billing
-- payment failure filed under Team, pointing at /team. It now takes only the
-- team kinds, and the billing helper below takes only the billing ones.
-- -----------------------------------------------------------------------------

create or replace function app.notification_candidates_events(p_organization_id uuid)
returns setof app.notification_candidate
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if not app.has_min_role(p_organization_id, 'admin') then
    return;
  end if;

  return query
  /*
   * Only events this person was a recipient of when they happened, and only
   * while they are still a member. The recipient row decides the audience; the
   * membership check decides access, so leaving the agency ends it whatever the
   * recipient rows say.
   */
  select
    'event:' || e.id::text,
    e.kind, 'team'::public.notification_category, e.severity,
    e.subject_user_id, e.subject_label, e.actor_user_id, e.actor_label,
    e.occurred_at, null::date, null::bigint, null::public.currency_code,
    '/team',
    e.context
  from public.notification_events e
  join public.notification_event_recipients r on r.event_id = e.id
  where e.organization_id = p_organization_id
    and r.user_id = v_actor
    and e.kind in (
      'team_invitation_accepted', 'team_ownership_transferred',
      'team_role_changed', 'team_member_removed'
    );
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Billing events, for the owners who were there
-- -----------------------------------------------------------------------------

create or replace function app.notification_candidates_billing_events(p_organization_id uuid)
returns setof app.notification_candidate
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  -- An early return, never a raise: a raise propagates through the feed's union
  -- and would break every member's notifications rather than hiding one row.
  if not app.has_min_role(p_organization_id, 'owner') then
    return;
  end if;

  return query
  select
    'event:' || e.id::text,
    e.kind, 'billing'::public.notification_category, e.severity,
    e.subject_user_id, e.subject_label, e.actor_user_id, e.actor_label,
    e.occurred_at, null::date, null::bigint, null::public.currency_code,
    '/billing',
    e.context
  from public.notification_events e
  join public.notification_event_recipients r on r.event_id = e.id
  where e.organization_id = p_organization_id
    and r.user_id = v_actor
    and e.kind in (
      'billing_subscription_activated', 'billing_payment_failed',
      'billing_payment_recovered', 'billing_cancellation_scheduled',
      'billing_subscription_ended', 'billing_plan_changed'
    );
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The current condition
-- -----------------------------------------------------------------------------

/**
 * "This subscription needs attention", while it does.
 *
 * Derived from app.billing_access_state_of, which is the one place Stripe's
 * vocabulary becomes ours — so this cannot disagree with the Billing page, and
 * a subscription that recovers makes the notification disappear without anybody
 * dismissing anything.
 *
 * It carries no amount, no invoice and no plan. The detail belongs on the
 * Billing page behind the owner check; a notification list is not the place to
 * put an agency's payment history, even the owner's.
 *
 * Returns nothing at all in this deployment: platform_unconfigured is not
 * attention, and telling an agency its subscription is in trouble when we have
 * never sold them one would be the single worst thing this module could say.
 */
create or replace function app.notification_candidates_billing(p_organization_id uuid)
returns setof app.notification_candidate
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state public.billing_access_state;
begin
  if not app.has_min_role(p_organization_id, 'owner') then
    return;
  end if;

  v_state := app.billing_access_state_of(p_organization_id);

  if v_state not in ('attention', 'restricted') then
    return;
  end if;

  return query
  select
    -- The fingerprint changes when the reason changes, so an owner who put away
    -- "payment failed" is still told when it becomes "subscription ended".
    'billing_attention:' || p_organization_id::text || ':' ||
      coalesce((select s.status::text from app.billing_effective_subscription(p_organization_id) s), 'none'),
    'billing_attention_required'::public.notification_kind,
    'billing'::public.notification_category,
    case when v_state = 'restricted' then 'urgent' else 'attention' end::public.notification_severity,
    null::uuid,
    (select o.name from public.organizations o where o.id = p_organization_id),
    null::uuid, null::text,
    null::timestamptz, null::date, null::bigint, null::public.currency_code,
    '/billing',
    jsonb_build_object(
      'state', v_state::text,
      'status', (select s.status::text from app.billing_effective_subscription(p_organization_id) s)
    );
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Both helpers into BOTH unions
--
-- The feed and app.notification_exists must agree about what exists. Adding a
-- helper to the feed alone makes billing rows appear and then makes mark-read,
-- dismiss and snooze silent no-ops on them.
-- -----------------------------------------------------------------------------

create or replace function public.notification_feed(
  p_organization_id uuid,
  p_scope           text default 'active',
  p_limit           integer default 50,
  p_offset          integer default 0
)
returns table (
  fingerprint     text,
  kind            public.notification_kind,
  category        public.notification_category,
  severity        public.notification_severity,
  subject_id      uuid,
  subject_label   text,
  secondary_id    uuid,
  secondary_label text,
  occurred_at     timestamptz,
  due_on          date,
  amount_minor    bigint,
  currency        public.currency_code,
  action_path     text,
  context         jsonb,
  read_at         timestamptz,
  dismissed_at    timestamptz,
  snoozed_until   timestamptz,
  total_count     bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_limit      integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset     integer := greatest(coalesce(p_offset, 0), 0);
  v_scope      text := coalesce(p_scope, 'active');
  v_categories public.notification_category[];
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;
  if v_scope not in ('active', 'unread', 'attention', 'all') then
    raise exception 'Unknown notification scope: %.', v_scope using errcode = '22023';
  end if;

  v_categories := app.notification_categories_for(p_organization_id);

  return query
  with candidates as (
    select * from app.notification_candidates_rentals(p_organization_id)
    union all select * from app.notification_candidates_compliance(p_organization_id)
    union all select * from app.notification_candidates_financing(p_organization_id)
    union all select * from app.notification_candidates_gps(p_organization_id)
    union all select * from app.notification_candidates_events(p_organization_id)
    union all select * from app.notification_candidates_billing(p_organization_id)
    union all select * from app.notification_candidates_billing_events(p_organization_id)
  ),
  allowed as (
    select c.*
    from candidates c
    where c.category = any(v_categories)
      -- A muted category is this person's choice and nobody else's.
      and not exists (
        select 1 from public.notification_preferences p
        where p.organization_id = p_organization_id
          and p.user_id = v_actor
          and p.category = c.category
          and p.muted
      )
  ),
  joined as (
    select a.*, s.read_at as st_read, s.dismissed_at as st_dismissed,
           s.snoozed_until as st_snoozed
    from allowed a
    left join public.notification_states s
      on s.organization_id = p_organization_id
     and s.user_id = v_actor
     and s.fingerprint = a.fingerprint
  ),
  scoped as (
    select j.* from joined j
    where case v_scope
      when 'all' then true
      when 'unread' then j.st_read is null and j.st_dismissed is null
                     and (j.st_snoozed is null or j.st_snoozed <= now())
      when 'attention' then j.st_dismissed is null and j.severity <> 'info'
                     and (j.st_snoozed is null or j.st_snoozed <= now())
      else j.st_dismissed is null
           and (j.st_snoozed is null or j.st_snoozed <= now())
    end
  ),
  counted as (select count(*) as total from scoped)
  select
    s.fingerprint, s.kind, s.category, s.severity,
    s.subject_id, s.subject_label, s.secondary_id, s.secondary_label,
    s.occurred_at, s.due_on, s.amount_minor, s.currency, s.action_path, s.context,
    s.st_read, s.st_dismissed, s.st_snoozed,
    counted.total
  from scoped s
  cross join counted
  order by
    case s.severity when 'urgent' then 0 when 'attention' then 1 else 2 end,
    -- Then by when it matters: a due date if it has one, otherwise the instant.
    coalesce(s.due_on, (s.occurred_at at time zone 'UTC')::date) nulls last,
    s.occurred_at nulls last,
    s.fingerprint
  limit v_limit offset v_offset;
end;
$$;

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
      union all select * from app.notification_candidates_billing(p_organization_id)
      union all select * from app.notification_candidates_billing_events(p_organization_id)
    ) c
    where c.fingerprint = p_fingerprint
  );
$$;

-- -----------------------------------------------------------------------------
-- 6. Turning a billing event into a notification
--
-- The same shape as app.notification_from_team_event, for the same reasons: one
-- notification per authoritative row, an audience fixed at the moment it
-- happened, and the actor excluded from being told what they just did.
-- -----------------------------------------------------------------------------

create or replace function app.notification_from_billing_event()
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
  /*
   * Six of thirteen billing event kinds. The rest — a customer being created, a
   * checkout being started, a reconciliation running, an anomaly for support —
   * are operational facts that an owner either just caused themselves or cannot
   * act on, and an inbox that reports every one of them is an inbox nobody
   * reads.
   */
  v_kind := case new.kind
    when 'subscription_activated' then 'billing_subscription_activated'
    when 'payment_failed'         then 'billing_payment_failed'
    when 'payment_recovered'      then 'billing_payment_recovered'
    when 'cancellation_scheduled' then 'billing_cancellation_scheduled'
    when 'subscription_ended'     then 'billing_subscription_ended'
    when 'plan_changed'           then 'billing_plan_changed'
  end::public.notification_kind;

  if v_kind is null then
    return new;
  end if;

  v_severity := case new.kind
    when 'payment_failed'         then 'urgent'
    when 'subscription_ended'     then 'urgent'
    when 'cancellation_scheduled' then 'attention'
    else 'info'
  end::public.notification_severity;

  insert into public.notification_events (
    organization_id, kind, severity, occurred_at,
    actor_user_id, actor_label, subject_user_id, subject_label,
    context, source_table, source_id
  ) values (
    new.organization_id, v_kind, v_severity, new.occurred_at,
    new.actor_user_id, new.actor_label, null, coalesce(new.plan_key, ''),
    jsonb_strip_nulls(jsonb_build_object(
      'plan_key', new.plan_key,
      'previous_plan_key', new.previous_plan_key,
      'summary', new.summary
    )),
    'billing_events', new.id
  )
  -- The same authoritative row twice is the same notification once. Stripe
  -- retries webhooks for three days; this is what makes that harmless.
  on conflict (organization_id, source_table, source_id) do nothing
  returning id into v_event;

  if v_event is null then
    return new;
  end if;

  /*
   * The audience: whoever owns the agency at this moment, except whoever caused
   * it. Owners only, because `billing` is an owner's category — a recipient who
   * cannot pass the category threshold would be a row claiming somebody was
   * told something they can never see, which is the defect 20260822100100
   * corrected for Team.
   */
  insert into public.notification_event_recipients (event_id, user_id)
  select v_event, m.user_id
  from public.organization_members m
  where m.organization_id = new.organization_id
    and m.status = 'active'
    and m.role = 'owner'
    and m.user_id is distinct from new.actor_user_id
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists billing_events_notify on public.billing_events;
create trigger billing_events_notify
  after insert on public.billing_events
  for each row execute function app.notification_from_billing_event();

-- -----------------------------------------------------------------------------
-- 7. Privileges
-- -----------------------------------------------------------------------------

revoke all on function app.notification_candidates_billing(uuid) from public, anon;
revoke all on function app.notification_candidates_billing_events(uuid) from public, anon;
revoke all on function app.notification_from_billing_event() from public, anon;
revoke all on function app.notification_categories_for(uuid) from public, anon;
revoke all on function app.notification_candidates_events(uuid) from public, anon;
revoke all on function app.notification_exists(uuid, text) from public, anon;
revoke all on function public.notification_feed(uuid, text, integer, integer) from public, anon;
grant execute on function public.notification_feed(uuid, text, integer, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Self-checks
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

  -- The three presentation-state writes must still bind to a real notification;
  -- replacing app.notification_exists is exactly where that could be lost.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('notification_mark_read', 'notification_dismiss', 'notification_snooze')
    and p.prosrc not like '%app.notification_exists%';

  if v_offenders is not null then
    raise exception 'These write presentation state without checking it exists: %.', v_offenders;
  end if;

  -- The feed and the existence check must read the same seven sources. A helper
  -- added to one and not the other is invisible until somebody cannot dismiss
  -- a notification they can see.
  if (select count(*) from regexp_matches(
        (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'notification_feed'),
        'app\.notification_candidates_', 'g')) <> 7
     or (select count(*) from regexp_matches(
        (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'notification_exists'),
        'app\.notification_candidates_', 'g')) <> 7
  then
    raise exception 'notification_feed and app.notification_exists must union the same seven candidate helpers.';
  end if;

  -- Billing is an owner's category in the database, exactly as it is in
  -- src/lib/authz/permissions.ts.
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'notification_categories_for')
     not like '%''owner''%' then
    raise exception 'The billing notification category must be gated on owner.';
  end if;
end
$$;
