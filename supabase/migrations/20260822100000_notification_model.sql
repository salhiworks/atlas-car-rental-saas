-- =============================================================================
-- 20260822100000_notification_model.sql
--
-- Notifications & Reminders: the data model.
--
-- REPLACING THE FOUNDATIONAL TABLE
--
-- `public.notifications` was created in 20260813090500_finance.sql and never
-- used: no application code, no test, no view, no trigger and no foreign key
-- references it, and the production table holds zero rows. It is replaced
-- rather than extended, because three of its decisions cannot be repaired in
-- place:
--
--   1. A row addressed to the whole agency (`user_id is null`) carries ONE
--      `read_at`. The first person to read an agency-wide alert reads it for
--      everybody. Per-user read state is not expressible in that shape.
--   2. `notifications_insert` granted INSERT to any manager, with free-text
--      `title` and `body`. That is a generic "send a message as the system"
--      surface — spam, phishing and impersonation in one policy.
--   3. The canonical stored form was a rendered English sentence, which cannot
--      be re-worded, re-ordered or translated later without rewriting history.
--
-- THREE LAYERS, KEPT APART
--
--   A. DERIVED CONDITIONS are computed from the authoritative domains every
--      time they are asked for. Nothing here stores "this rental is overdue" —
--      it asks public.rental_is_overdue(). A condition that stops being true
--      stops appearing, with nobody closing anything.
--
--   B. EVENTS are things that happened, and are persisted with the audience
--      fixed AT THE MOMENT THEY HAPPENED. An administrator who joins in March
--      does not receive January's ownership transfer as news.
--
--   C. PER-USER STATE — read, dismissed, snoozed — is a separate row keyed by
--      (organization, user, fingerprint). One person dismissing an alert cannot
--      affect another's.
--
-- WHAT THIS MODULE DOES NOT CLAIM
--
-- No autonomous background processing runs in this deployment. pg_cron and
-- pg_net are available on the project and are deliberately NOT installed here.
-- Conditions are evaluated when somebody asks, which is what makes them
-- truthful: the feed cannot be stale because it is not stored. The candidate
-- helpers are shaped so a future worker can call exactly the same functions
-- rather than reimplement a single due-date rule.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Out with the old
-- -----------------------------------------------------------------------------

do $$
declare
  v_rows bigint;
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;

  -- Refuse to drop anything that turned out to hold data after all. A migration
  -- that quietly destroys rows because an audit said it would not is worse than
  -- a migration that fails.
  execute 'select count(*) from public.notifications' into v_rows;
  if v_rows > 0 then
    raise exception
      'public.notifications holds % rows. The replacement in this migration assumes it is unused; migrate the data deliberately instead.',
      v_rows;
  end if;
end
$$;

drop table if exists public.notifications;
drop type if exists public.notification_category;
drop type if exists public.notification_severity;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'notification_category' and typnamespace = 'public'::regnamespace
  ) then
    -- One category per source domain, because that is also the unit a person
    -- mutes. "payment" and "maintenance" from the old enum named neither a
    -- domain nor a permission.
    create type public.notification_category as enum ('rentals', 'compliance', 'financing', 'gps', 'team');
  end if;

  if not exists (
    select 1 from pg_type where typname = 'notification_severity' and typnamespace = 'public'::regnamespace
  ) then
    /*
     * Three levels, and they mean operational urgency rather than colour.
     *   info      — worth knowing, nothing to do
     *   attention — do something in the ordinary course of the day
     *   urgent    — a vehicle is out past its return time, money is late
     */
    create type public.notification_severity as enum ('info', 'attention', 'urgent');
  end if;

  if not exists (
    select 1 from pg_type where typname = 'notification_kind' and typnamespace = 'public'::regnamespace
  ) then
    /*
     * The canonical form of a notification. The interface renders a sentence
     * from the kind and the structured facts beside it; the sentence is never
     * what is stored, so wording can change and a second language can be added
     * without rewriting anything.
     */
    create type public.notification_kind as enum (
      'rental_pickup_due',
      'rental_return_due',
      'rental_return_overdue',
      'rental_balance_outstanding',
      'vehicle_compliance_due',
      'vehicle_compliance_expired',
      'financing_due',
      'financing_overdue',
      'gps_connection_unhealthy',
      'gps_position_stale',
      'team_invitation_accepted',
      'team_ownership_transferred',
      'team_role_changed',
      'team_member_removed'
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The shape every candidate takes
--
-- One composite type, so each source helper returns the same thing and the feed
-- is a plain union that can be ordered as a whole.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'notification_candidate' and typnamespace = 'app'::regnamespace
  ) then
    create type app.notification_candidate as (
      fingerprint     text,
      kind            public.notification_kind,
      category        public.notification_category,
      severity        public.notification_severity,
      -- What the notification is about, and how to name it on screen.
      subject_id      uuid,
      subject_label   text,
      secondary_id    uuid,
      secondary_label text,
      -- The business instant the alert is about: a pickup time, an expiry, an
      -- event. Never "when this row was generated", because nothing is stored.
      occurred_at     timestamptz,
      due_on          date,
      amount_minor    bigint,
      currency        public.currency_code,
      action_path     text,
      -- Extra typed facts the interface needs. Never markup, never a sentence.
      context         jsonb
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- How far ahead the operational reminders look
--
-- Compliance and financing already have authoritative thresholds and this file
-- does not invent a second one for either. Rentals have none — the Calendar
-- shows a window rather than warning about one — so this is the module's own
-- number, defined once and named, not a 48 scattered through six queries.
-- -----------------------------------------------------------------------------

create or replace function app.notification_rental_window()
returns interval language sql immutable parallel safe as $$ select interval '48 hours' $$;

comment on function app.notification_rental_window() is
  'How far ahead a pickup or return is worth mentioning. The one definition; compliance and financing use their own domains'' thresholds instead.';

create or replace function app.notification_financing_window_days()
returns integer language sql immutable parallel safe as $$ select 30 $$;

comment on function app.notification_financing_window_days() is
  'Window passed to public.financing_due_obligations(). Financing decides what "due" means; this only says how far ahead to ask.';

-- -----------------------------------------------------------------------------
-- Which categories this caller may receive
--
-- The permission gate lives here rather than in the interface, so a category a
-- person cannot see is never generated, never counted and never returned —
-- rather than generated and then hidden.
-- -----------------------------------------------------------------------------

create or replace function app.notification_categories_for(p_organization_id uuid)
returns public.notification_category[]
language sql
stable
security definer
set search_path = ''
as $$
  select array_remove(array[
    -- Mirrors src/lib/authz/permissions.ts one for one.
    case when app.has_min_role(p_organization_id, 'staff')   then 'rentals'    end,
    case when app.has_min_role(p_organization_id, 'staff')   then 'compliance' end,
    case when app.has_min_role(p_organization_id, 'manager') then 'financing'  end,
    case when app.has_min_role(p_organization_id, 'manager') then 'gps'        end,
    case when app.has_min_role(p_organization_id, 'admin')   then 'team'       end
  ]::public.notification_category[], null);
$$;

comment on function app.notification_categories_for(uuid) is
  'The notification categories the calling member is entitled to receive, derived from the same role thresholds the modules themselves use.';

-- =============================================================================
-- Per-user presentation state
-- =============================================================================

create table if not exists public.notification_states (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  /*
   * The episode this state belongs to.
   *
   * Deterministic and derived from the source facts, so the same condition
   * produces the same fingerprint on every evaluation and read state survives a
   * refresh. It changes when a materially different episode begins — a
   * rescheduled pickup, a corrected expiry, an escalation from due to overdue —
   * which is exactly when somebody should be told again.
   */
  fingerprint     text not null check (char_length(fingerprint) between 1 and 200),

  read_at         timestamptz,
  dismissed_at    timestamptz,
  snoozed_until   timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (organization_id, user_id, fingerprint)
);

comment on table public.notification_states is
  'One person''s relationship with one notification episode. Never business truth: marking a financing reminder read does not pay anything.';

create index if not exists notification_states_user_idx
  on public.notification_states (organization_id, user_id)
  where dismissed_at is null;

drop trigger if exists notification_states_set_updated_at on public.notification_states;
create trigger notification_states_set_updated_at
  before update on public.notification_states
  for each row execute function app.set_updated_at();

-- =============================================================================
-- Per-user category preferences
-- =============================================================================

create table if not exists public.notification_preferences (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  category        public.notification_category not null,
  muted           boolean not null default false,
  updated_at      timestamptz not null default now(),

  primary key (organization_id, user_id, category)
);

comment on table public.notification_preferences is
  'A person''s own muting, per agency. Absent row means the category is on: notifications work before anybody configures anything.';

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function app.set_updated_at();

-- =============================================================================
-- Persisted events
--
-- The audience is written when the event happens. Recomputing it later from
-- today's roles would mean an administrator who joined this week waking up to
-- "Ownership transferred" from three months ago, presented as news.
-- =============================================================================

create table if not exists public.notification_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            public.notification_kind not null,
  severity        public.notification_severity not null default 'info',
  occurred_at     timestamptz not null default now(),

  /*
   * What the event was about, as structured facts. `actor_label` and
   * `subject_label` are snapshots taken at the time, for the same reason Team
   * history snapshots them: the people they name may be gone by the time
   * anybody reads it.
   */
  actor_user_id   uuid references auth.users (id) on delete set null,
  actor_label     text not null default '' check (char_length(actor_label) <= 200),
  subject_user_id uuid references auth.users (id) on delete set null,
  subject_label   text not null default '' check (char_length(subject_label) <= 200),
  context         jsonb not null default '{}'::jsonb,

  /*
   * The authoritative row this event was derived from. Unique per agency, so a
   * retried transaction produces one logical notification rather than two.
   */
  source_table    text not null check (char_length(source_table) <= 64),
  source_id       uuid not null,

  created_at      timestamptz not null default now(),

  constraint notification_events_source_unique unique (organization_id, source_table, source_id)
);

comment on table public.notification_events is
  'Typed notification events with the audience fixed at creation. Written by triggers on authoritative tables; no client may insert one.';

create index if not exists notification_events_organization_idx
  on public.notification_events (organization_id, occurred_at desc);

create table if not exists public.notification_event_recipients (
  event_id        uuid not null references public.notification_events (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  primary key (event_id, user_id)
);

comment on table public.notification_event_recipients is
  'Who an event was for, decided when it happened. Membership is still checked at read time, so leaving the agency ends access regardless of this row.';

create index if not exists notification_event_recipients_user_idx
  on public.notification_event_recipients (user_id);

-- -----------------------------------------------------------------------------
-- Events are written by the domain, never by a client
-- -----------------------------------------------------------------------------

create or replace function app.notification_events_are_server_written()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    /*
     * Only as part of the agency disappearing.
     *
     * `organization_id` references organizations ON DELETE CASCADE, and the
     * cascade reaches this table after the parent row has already left this
     * transaction's view — so "the owning organization is gone" is a reliable
     * discriminator, and one no client can manufacture: nothing grants DELETE on
     * organizations to any browser role. The same reasoning, and the same shape,
     * as the Team audit log next door; refusing the cascade would not protect
     * the history, it would make an agency undeletable.
     */
    if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
      return old;
    end if;

    raise exception 'Notification events are written by the domain, not by clients.'
      using errcode = '42501';
  end if;

  /*
   * The one update: a foreign key nulling a reference to an Auth account that
   * has been deleted. Both columns are ON DELETE SET NULL, and refusing the
   * action does not protect anything — it makes the account undeletable.
   *
   * What the event SAYS is snapshotted text (`actor_label`, `subject_label`),
   * captured precisely so the record outlives the accounts it names. Compared as
   * a whole row minus those two references, so a column added to this table
   * later cannot quietly become editable.
   */
  if (to_jsonb(new) - 'actor_user_id' - 'subject_user_id')
       = (to_jsonb(old) - 'actor_user_id' - 'subject_user_id')
     and (new.actor_user_id   is null or new.actor_user_id   is not distinct from old.actor_user_id)
     and (new.subject_user_id is null or new.subject_user_id is not distinct from old.subject_user_id)
     and (new.actor_user_id, new.subject_user_id)
           is distinct from (old.actor_user_id, old.subject_user_id)
  then
    return new;
  end if;

  raise exception 'Notification events are written by the domain, not by clients.'
    using errcode = '42501';
end;
$$;

drop trigger if exists notification_events_no_client_write on public.notification_events;
create trigger notification_events_no_client_write
  before update or delete on public.notification_events
  for each row execute function app.notification_events_are_server_written();

/**
 * Turns a Team audit event into a notification, for the people it concerned at
 * the time.
 *
 * Only four of the nine Team event kinds are here. An invitation being created,
 * resent, revoked or a link being revealed are things an administrator did on
 * purpose seconds ago and does not need told about; duplicating the whole audit
 * log into an inbox is how an inbox stops being read.
 */
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
   * The audience, decided now.
   *
   * Everyone who administers the agency at this moment, plus the person the
   * event is about — who may be about to stop being a member, which is why they
   * are added explicitly rather than found by a role query. Nobody is told
   * about their own action.
   */
  insert into public.notification_event_recipients (event_id, user_id)
  select v_event, m.user_id
  from public.organization_members m
  where m.organization_id = new.organization_id
    and m.status = 'active'
    and app.role_rank(m.role) >= app.role_rank('admin')
    and m.user_id is distinct from new.actor_user_id
  on conflict do nothing;

  if new.target_user_id is not null and new.target_user_id is distinct from new.actor_user_id then
    insert into public.notification_event_recipients (event_id, user_id)
    values (v_event, new.target_user_id)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists organization_team_events_notify on public.organization_team_events;
create trigger organization_team_events_notify
  after insert on public.organization_team_events
  for each row execute function app.notification_from_team_event();

-- =============================================================================
-- Candidate helpers, one per source
--
-- Each decides for itself whether the caller may see it and returns nothing if
-- not, so the feed can union them freely and sort the result as a whole. A
-- future scheduler calls exactly these.
-- =============================================================================

create or replace function app.notification_candidates_rentals(p_organization_id uuid)
returns setof app.notification_candidate
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_window interval := app.notification_rental_window();
begin
  if not app.has_min_role(p_organization_id, 'staff') then
    return;
  end if;

  return query
  -- A booking that has been confirmed and is about to be collected. Drafts are
  -- not commitments and cancelled bookings are not happening.
  select
    'rental_pickup_due:' || r.id::text || ':' || extract(epoch from r.starts_at)::bigint::text,
    'rental_pickup_due'::public.notification_kind,
    'rentals'::public.notification_category,
    'attention'::public.notification_severity,
    r.id, r.reference, r.vehicle_id, v.registration_plate,
    r.starts_at, null::date, null::bigint, null::public.currency_code,
    '/rentals/' || r.id::text,
    jsonb_build_object('vehicle', v.make || ' ' || v.model)
  from public.rentals r
  join public.vehicles v on v.id = r.vehicle_id
  where r.organization_id = p_organization_id
    and r.status = 'reserved'
    and r.starts_at >= now()
    and r.starts_at <= now() + v_window

  union all

  -- Out with a customer and due back shortly.
  select
    'rental_return_due:' || r.id::text || ':' || extract(epoch from r.ends_at)::bigint::text,
    'rental_return_due', 'rentals', 'attention',
    r.id, r.reference, r.vehicle_id, v.registration_plate,
    r.ends_at, null::date, null::bigint, null::public.currency_code,
    '/rentals/' || r.id::text,
    jsonb_build_object('vehicle', v.make || ' ' || v.model)
  from public.rentals r
  join public.vehicles v on v.id = r.vehicle_id
  where r.organization_id = p_organization_id
    and r.status = 'active'
    and r.returned_at is null
    and r.ends_at >= now()
    and r.ends_at <= now() + v_window

  union all

  /*
   * Past its return time and not back. The condition is
   * public.rental_is_overdue() and nothing else — the Calendar, the rental
   * board and this feed must never disagree about what overdue means.
   */
  select
    'rental_return_overdue:' || r.id::text || ':' || extract(epoch from r.ends_at)::bigint::text,
    'rental_return_overdue', 'rentals', 'urgent',
    r.id, r.reference, r.vehicle_id, v.registration_plate,
    r.ends_at, null::date, null::bigint, null::public.currency_code,
    '/rentals/' || r.id::text,
    jsonb_build_object('vehicle', v.make || ' ' || v.model)
  from public.rentals r
  join public.vehicles v on v.id = r.vehicle_id
  where r.organization_id = p_organization_id
    and public.rental_is_overdue(r.status, r.ends_at, r.returned_at)

  union all

  /*
   * A finished hire that was not fully paid.
   *
   * `balance_due_minor` is the contract's own settlement figure and excludes
   * the deposit entirely — a deposit is the customer's money being held, never
   * revenue outstanding, and a "deposit still held" alert on every active hire
   * would be noise on every screen.
   *
   * Deliberately not called an overdue invoice: this product has no invoice due
   * date, so it cannot say how late anything is.
   */
  select
    'rental_balance_outstanding:' || r.id::text,
    'rental_balance_outstanding', 'rentals', 'attention',
    r.id, r.reference, r.customer_id,
    coalesce(nullif(btrim(c.company_name), ''), btrim(c.first_name || ' ' || c.last_name)),
    r.completed_at, null::date, r.balance_due_minor, r.currency,
    '/rentals/' || r.id::text,
    '{}'::jsonb
  from public.rentals r
  join public.customers c on c.id = r.customer_id
  where r.organization_id = p_organization_id
    and r.status = 'completed'
    and r.balance_due_minor > 0;
end;
$$;

create or replace function app.notification_candidates_compliance(p_organization_id uuid)
returns setof app.notification_candidate
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_lead  integer;
begin
  if not app.has_min_role(p_organization_id, 'staff') then
    return;
  end if;

  v_today := app.organization_today(p_organization_id);

  -- The agency's own threshold, exactly as the fleet list and the reports use.
  select greatest(coalesce(s.compliance_reminder_lead_days, 30), 0) into v_lead
  from public.organization_settings s
  where s.organization_id = p_organization_id;
  v_lead := coalesce(v_lead, 30);

  return query
  /*
   * The three date columns on `vehicles` are the authoritative compliance
   * store. `vehicle_documents.expires_on` is a separate register that is not
   * kept in step with them, and reading it here would produce alerts that
   * contradict every other screen in the product.
   *
   * A vehicle with no date recorded produces nothing. Nobody having entered an
   * insurance date is a data-entry gap, not a vehicle driving uninsured, and
   * turning one into the other is how an alert list stops being believed.
   */
  with expiries as (
    select v.id, v.registration_plate, v.make, v.model, k.kind, k.expires_on
    from public.vehicles v
    cross join lateral (values
      ('insurance',    v.insurance_expires_on),
      ('inspection',   v.inspection_expires_on),
      ('registration', v.registration_expires_on)
    ) as k(kind, expires_on)
    where v.organization_id = p_organization_id
      and v.archived_at is null
      and k.expires_on is not null
  )
  select
    'vehicle_compliance_expired:' || e.id::text || ':' || e.kind || ':' || e.expires_on::text,
    'vehicle_compliance_expired'::public.notification_kind,
    'compliance'::public.notification_category,
    'urgent'::public.notification_severity,
    e.id, e.registration_plate, null::uuid, null::text,
    null::timestamptz, e.expires_on, null::bigint, null::public.currency_code,
    '/vehicles/' || e.id::text,
    jsonb_build_object('document', e.kind, 'vehicle', e.make || ' ' || e.model)
  from expiries e
  where e.expires_on < v_today

  union all

  select
    'vehicle_compliance_due:' || e.id::text || ':' || e.kind || ':' || e.expires_on::text,
    'vehicle_compliance_due', 'compliance', 'attention',
    e.id, e.registration_plate, null::uuid, null::text,
    null::timestamptz, e.expires_on, null::bigint, null::public.currency_code,
    '/vehicles/' || e.id::text,
    jsonb_build_object('document', e.kind, 'vehicle', e.make || ' ' || e.model)
  from expiries e
  where e.expires_on >= v_today
    and e.expires_on <= v_today + v_lead;
end;
$$;

create or replace function app.notification_candidates_financing(p_organization_id uuid)
returns setof app.notification_candidate
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  /*
   * Financing terms are commercially sensitive, so this returns nothing at all
   * below manager — not a redacted row, not a count. The early return also
   * matters mechanically: public.financing_due_obligations() raises for an
   * unauthorised caller, and reaching it would turn a quiet "no financing
   * notifications" into an error that breaks the whole feed for staff.
   */
  if not app.has_min_role(p_organization_id, 'manager') then
    return;
  end if;

  return query
  select
    case when o.is_overdue then 'financing_overdue:' else 'financing_due:' end
      || o.installment_id::text || ':' || o.due_on::text,
    case when o.is_overdue then 'financing_overdue' else 'financing_due' end::public.notification_kind,
    'financing'::public.notification_category,
    case when o.is_overdue then 'urgent' else 'attention' end::public.notification_severity,
    o.agreement_id, o.reference, o.vehicle_id, o.vehicle_plate,
    null::timestamptz, o.due_on, o.outstanding_minor, o.currency,
    '/financing/' || o.agreement_id::text,
    jsonb_build_object('lender', o.lender_name, 'sequence', o.sequence)
  from public.financing_due_obligations(
         p_organization_id, app.notification_financing_window_days()
       ) o;
end;
$$;

create or replace function app.notification_candidates_gps(p_organization_id uuid)
returns setof app.notification_candidate
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.has_min_role(p_organization_id, 'manager') then
    return;
  end if;

  return query
  /*
   * public.gps_attention_signals() is consumed rather than reimplemented — it
   * was written for this module, and it keeps the three facts the GPS module
   * insists on apart: whether the PROVIDER is reachable, whether the last
   * POSITION is recent, and whether SYNCHRONISATION is working. None of them is
   * "the vehicle is offline", and this feed does not claim otherwise.
   *
   * Nothing here says how long anything has been wrong. Positions arrive when
   * somebody opens the product, so a gap in the data is a gap in the looking,
   * not evidence of an outage.
   */
  select
    case
      when s.signal = 'connection_unhealthy'
        then 'gps_connection_unhealthy:' || s.connection_id::text || ':' || s.signal
      else 'gps_position_stale:' || coalesce(s.unit_id, s.vehicle_id)::text || ':' || s.signal
    end,
    case when s.signal = 'connection_unhealthy' then 'gps_connection_unhealthy'
         else 'gps_position_stale' end::public.notification_kind,
    'gps'::public.notification_category,
    case when s.severity = 'critical' then 'urgent'
         when s.severity = 'warning'  then 'attention'
         else 'info' end::public.notification_severity,
    coalesce(s.vehicle_id, s.connection_id),
    coalesce(s.vehicle_plate, 'Tracking'),
    s.connection_id, null::text,
    s.since, null::date, null::bigint, null::public.currency_code,
    '/gps-tracking',
    jsonb_build_object('signal', s.signal, 'detail', s.detail)
  from public.gps_attention_signals(p_organization_id) s;
end;
$$;

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
    and r.user_id = v_actor;
end;
$$;

-- =============================================================================
-- The feed
-- =============================================================================

/**
 * Everything currently worth this person's attention in one agency.
 *
 * `p_scope`:
 *   'active'    the bell and the drawer — unread or read, not dismissed, not
 *               snoozed into the future
 *   'unread'    only what has not been read
 *   'attention' only what is actionable now: attention and urgent
 *   'all'       the inbox, including dismissed, for looking back
 *
 * Sorting is deterministic and boring on purpose: urgency, then time. There is
 * no ranking model, and no notification is promoted for being new.
 */
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

comment on function public.notification_feed(uuid, text, integer, integer) is
  'Current attention items and received events for the calling member, permission-filtered at the source. Derived on every call, so a resolved condition simply stops appearing.';

/**
 * The number on the bell.
 *
 * Deliberately built from notification_feed() rather than from a second query,
 * so the badge and the drawer cannot disagree. If this ever needs to be
 * cheaper, the fix is to make the feed cheaper.
 */
create or replace function public.notification_unread_count(p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.notification_feed(p_organization_id, 'unread', 200, 0);
$$;

comment on function public.notification_unread_count(uuid) is
  'Unread, undismissed, unsnoozed, permission-visible episodes. The same definition the drawer uses, by construction.';

-- =============================================================================
-- Presentation-state mutations
--
-- Narrow and typed. There is no "create a notification" surface at all: a
-- client can say it has read something, and nothing else.
-- =============================================================================

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

  insert into public.notification_states (organization_id, user_id, fingerprint, read_at)
  values (p_organization_id, v_actor, p_fingerprint, now())
  on conflict (organization_id, user_id, fingerprint)
  do update set read_at = coalesce(public.notification_states.read_at, now());
end;
$$;

create or replace function public.notification_mark_all_read(p_organization_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_count integer;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  -- Only what this person can actually see right now gets marked.
  with unread as (
    select f.fingerprint
    from public.notification_feed(p_organization_id, 'unread', 200, 0) f
  ), written as (
    insert into public.notification_states (organization_id, user_id, fingerprint, read_at)
    select p_organization_id, v_actor, u.fingerprint, now() from unread u
    on conflict (organization_id, user_id, fingerprint)
    do update set read_at = coalesce(public.notification_states.read_at, now())
    returning 1
  )
  select count(*)::integer into v_count from written;

  return coalesce(v_count, 0);
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
  if p_until is null or p_until <= now() then
    raise exception 'Choose a time in the future.' using errcode = '22023';
  end if;
  -- A week is the longest anything here is worth hiding; beyond that, dismiss.
  if p_until > now() + interval '31 days' then
    raise exception 'Notifications cannot be snoozed that far ahead.' using errcode = '22023';
  end if;

  insert into public.notification_states
    (organization_id, user_id, fingerprint, snoozed_until)
  values (p_organization_id, v_actor, p_fingerprint, p_until)
  on conflict (organization_id, user_id, fingerprint)
  do update set snoozed_until = p_until;
end;
$$;

-- =============================================================================
-- Preferences
-- =============================================================================

create or replace function public.notification_preferences_for(p_organization_id uuid)
returns table (category public.notification_category, muted boolean, available boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_categories public.notification_category[];
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  v_categories := app.notification_categories_for(p_organization_id);

  -- Only categories this person could ever receive. A toggle for something they
  -- will never be sent is a control that does nothing.
  return query
  select c.value, coalesce(p.muted, false), true
  from unnest(v_categories) as c(value)
  left join public.notification_preferences p
    on p.organization_id = p_organization_id
   and p.user_id = v_actor
   and p.category = c.value
  order by c.value;
end;
$$;

create or replace function public.notification_preference_set(
  p_organization_id uuid,
  p_category        public.notification_category,
  p_muted           boolean
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
  -- Muting something you cannot receive is meaningless; refusing makes the
  -- preference surface honest about what it controls.
  if not (p_category = any(app.notification_categories_for(p_organization_id))) then
    raise exception 'You do not receive % notifications.', p_category using errcode = '42501';
  end if;

  insert into public.notification_preferences (organization_id, user_id, category, muted)
  values (p_organization_id, v_actor, p_category, coalesce(p_muted, false))
  on conflict (organization_id, user_id, category) do update set muted = excluded.muted;
end;
$$;

-- =============================================================================
-- Privileges and Row Level Security
-- =============================================================================

revoke all on table public.notification_states from anon, authenticated;
revoke all on table public.notification_preferences from anon, authenticated;
revoke all on table public.notification_events from anon, authenticated;
revoke all on table public.notification_event_recipients from anon, authenticated;

alter table public.notification_states enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_events enable row level security;
alter table public.notification_event_recipients enable row level security;

/*
 * Policies without grants, as with the Team tables: everything goes through the
 * functions above, and these are the backstop if a future migration or a
 * re-applied Supabase default ever hands a client role a table privilege.
 */
drop policy if exists notification_states_select on public.notification_states;
create policy notification_states_select on public.notification_states
  for select to authenticated
  using (user_id = (select auth.uid()) and app.is_org_member(organization_id));

drop policy if exists notification_preferences_select on public.notification_preferences;
create policy notification_preferences_select on public.notification_preferences
  for select to authenticated
  using (user_id = (select auth.uid()) and app.is_org_member(organization_id));

drop policy if exists notification_events_select on public.notification_events;
create policy notification_events_select on public.notification_events
  for select to authenticated
  using (
    app.has_min_role(organization_id, 'admin')
    and exists (
      select 1 from public.notification_event_recipients r
      where r.event_id = id and r.user_id = (select auth.uid())
    )
  );

drop policy if exists notification_event_recipients_select on public.notification_event_recipients;
create policy notification_event_recipients_select on public.notification_event_recipients
  for select to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Execution grants
--
-- Every app helper is revoked from PUBLIC explicitly: PostgreSQL's default ACL
-- grants EXECUTE to PUBLIC, and 20260821100500 exists because that accumulated
-- unnoticed across nine modules.
-- -----------------------------------------------------------------------------

revoke all on function app.notification_rental_window() from public, anon;
revoke all on function app.notification_financing_window_days() from public, anon;
revoke all on function app.notification_categories_for(uuid) from public, anon;
revoke all on function app.notification_candidates_rentals(uuid) from public, anon;
revoke all on function app.notification_candidates_compliance(uuid) from public, anon;
revoke all on function app.notification_candidates_financing(uuid) from public, anon;
revoke all on function app.notification_candidates_gps(uuid) from public, anon;
revoke all on function app.notification_candidates_events(uuid) from public, anon;
revoke all on function app.notification_from_team_event() from public, anon;
revoke all on function app.notification_events_are_server_written() from public, anon;

revoke all on function public.notification_feed(uuid, text, integer, integer) from public, anon;
revoke all on function public.notification_unread_count(uuid) from public, anon;
revoke all on function public.notification_mark_read(uuid, text) from public, anon;
revoke all on function public.notification_mark_all_read(uuid) from public, anon;
revoke all on function public.notification_dismiss(uuid, text) from public, anon;
revoke all on function public.notification_snooze(uuid, text, timestamptz) from public, anon;
revoke all on function public.notification_preferences_for(uuid) from public, anon;
revoke all on function public.notification_preference_set(uuid, public.notification_category, boolean) from public, anon;

grant execute on function public.notification_feed(uuid, text, integer, integer) to authenticated;
grant execute on function public.notification_unread_count(uuid) to authenticated;
grant execute on function public.notification_mark_read(uuid, text) to authenticated;
grant execute on function public.notification_mark_all_read(uuid) to authenticated;
grant execute on function public.notification_dismiss(uuid, text) to authenticated;
grant execute on function public.notification_snooze(uuid, text, timestamptz) to authenticated;
grant execute on function public.notification_preferences_for(uuid) to authenticated;
grant execute on function public.notification_preference_set(uuid, public.notification_category, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Indexes for the candidate queries
--
-- Each one exists because a candidate query filters on exactly it. Nothing
-- speculative.
-- -----------------------------------------------------------------------------

create index if not exists rentals_pickup_window_idx
  on public.rentals (organization_id, starts_at)
  where status = 'reserved';

create index if not exists rentals_return_window_idx
  on public.rentals (organization_id, ends_at)
  where status = 'active' and returned_at is null;

create index if not exists rentals_outstanding_balance_idx
  on public.rentals (organization_id)
  where status = 'completed' and balance_due_minor > 0;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

do $$
declare
  v_offenders text;
begin
  -- 1. Nothing anonymous, in either schema.
  select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app')
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'The anonymous role can execute: %.', v_offenders;
  end if;

  -- 2. No client role may touch a notification table directly.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ')
    into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name like 'notification%'
    and grantee in ('anon', 'authenticated');

  if v_offenders is not null then
    raise exception 'Notification tables are directly accessible: %.', v_offenders;
  end if;

  -- 3. There is no generic notification-creation surface.
  select string_agg(p.proname, ', ')
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('create_notification', 'notification_create', 'send_notification')
    and has_function_privilege('authenticated', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'A generic notification creation function is reachable: %.', v_offenders;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
