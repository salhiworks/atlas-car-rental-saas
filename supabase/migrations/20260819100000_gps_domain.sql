-- =============================================================================
-- GPS tracking: provider connections, units, assignments, positions
--
-- THE SHAPE
--
--   our product  →  normalised GPS domain  →  provider adapter  →  Wialon
--
-- Nothing in this schema is named after a provider. `gps_units` is not a Wialon
-- units table with a different name: it is our idea of a tracking device, and
-- the Wialon adapter is one thing that can fill it. A second provider is a new
-- adapter, not a new set of tables.
--
-- THE THREE FACTS THAT ARE NOT THE SAME FACT
--
--   1. the provider says the device is online
--   2. the last position we have is recent
--   3. our last synchronisation succeeded
--
-- A device can be online with a stale position, or have a fresh position while
-- the provider reports nothing about connectivity, or be perfectly healthy
-- while our own sync is failing on an expired token. Collapsing those three
-- into one green dot is the single commonest lie a tracking screen tells, so
-- they are stored and derived separately throughout.
--
-- WHAT IS NOT HERE
--
-- No telemetry archive. `gps_positions` holds exactly one row per device — the
-- current snapshot — because a fleet of 200 vehicles reporting every 30 seconds
-- is half a billion rows a year, and the provider already keeps that history
-- and serves it on demand. History is fetched through the adapter for a bounded
-- period, not mirrored.
--
-- No credentials. The provider token lives in Supabase Vault; this schema holds
-- only a reference to it, in a table the application has no grant on at all.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

do $$
begin
  -- Only providers with a real, shipped adapter appear here. A test double is
  -- test infrastructure and must never be selectable in the product.
  if not exists (select 1 from pg_type where typname = 'gps_provider' and typnamespace = 'public'::regnamespace) then
    create type public.gps_provider as enum ('wialon');
  end if;

  if not exists (select 1 from pg_type where typname = 'gps_connection_status' and typnamespace = 'public'::regnamespace) then
    create type public.gps_connection_status as enum (
      'never_connected',  -- saved but never verified
      'healthy',          -- last sync succeeded
      'auth_error',       -- credential rejected or expired
      'unreachable',      -- provider did not answer
      'rate_limited',     -- provider asked us to slow down
      'provider_error',   -- provider answered with something we could not use
      'disabled'          -- deliberately disconnected by an administrator
    );
  end if;

  -- Whether the device is still present at the provider. A unit that vanishes
  -- is marked, never deleted: the assignment history is ours, not the
  -- provider's, and it has to survive the device being retired.
  if not exists (select 1 from pg_type where typname = 'gps_unit_availability' and typnamespace = 'public'::regnamespace) then
    create type public.gps_unit_availability as enum ('present', 'missing', 'archived');
  end if;

  if not exists (select 1 from pg_type where typname = 'gps_movement_state' and typnamespace = 'public'::regnamespace) then
    create type public.gps_movement_state as enum ('moving', 'stopped');
  end if;

  if not exists (select 1 from pg_type where typname = 'gps_assignment_role' and typnamespace = 'public'::regnamespace) then
    create type public.gps_assignment_role as enum ('primary', 'secondary');
  end if;

  if not exists (select 1 from pg_type where typname = 'gps_sync_outcome' and typnamespace = 'public'::regnamespace) then
    create type public.gps_sync_outcome as enum (
      'success', 'partial', 'auth_error', 'unreachable', 'rate_limited', 'provider_error', 'aborted'
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Freshness thresholds
--
-- "Five minutes" is a product decision, not a constant to sprinkle through
-- twelve components. It lives with the agency's other operational preferences
-- so a haulier tracking hourly reports and a rental desk tracking minutes can
-- each say what stale means to them.
-- -----------------------------------------------------------------------------

alter table public.organization_settings
  add column if not exists gps_fresh_minutes smallint not null default 10,
  add column if not exists gps_stale_minutes smallint not null default 120;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organization_settings_gps_thresholds') then
    alter table public.organization_settings
      add constraint organization_settings_gps_thresholds check (
        gps_fresh_minutes between 1 and 1440
        and gps_stale_minutes between 5 and 20160
        and gps_stale_minutes > gps_fresh_minutes
      );
  end if;
end
$$;

comment on column public.organization_settings.gps_fresh_minutes is
  'A position younger than this is current. Beyond it the interface says how old it is rather than presenting it as live.';
comment on column public.organization_settings.gps_stale_minutes is
  'Beyond this a position is no longer operationally useful and is shown as a last-known location.';

-- -----------------------------------------------------------------------------
-- Provider connections
--
-- One row per account an agency has linked. Deliberately not a singleton: an
-- agency running two Wialon accounts, or migrating from one provider to
-- another, needs both live at once for a while.
-- -----------------------------------------------------------------------------

create table if not exists public.gps_provider_connections (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  provider public.gps_provider not null default 'wialon',
  label    text not null check (char_length(btrim(label)) between 1 and 120),

  /*
   * Where the provider lives. Wialon Hosting is hst-api.wialon.com, but the
   * regional deployments (.eu, .us, .org) and every Wialon Local installation
   * are different hosts, so a single hard-coded server would lock out most of
   * the world. Stored per connection, validated as https.
   */
  base_url text not null check (base_url ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'),

  status public.gps_connection_status not null default 'never_connected',

  /*
   * Bumped whenever the credential is replaced or the connection is disabled.
   * A synchronisation started under one generation may not write results under
   * another: the answer it is carrying was produced with a credential that is
   * no longer the connection's, and recording it as healthy would misrepresent
   * the live state.
   */
  generation integer not null default 1 check (generation > 0),

  account_label text check (account_label is null or char_length(account_label) <= 160),
  unit_count    integer check (unit_count is null or unit_count >= 0),

  last_verified_at    timestamptz,
  last_sync_started_at  timestamptz,
  last_sync_success_at  timestamptz,
  last_sync_duration_ms integer check (last_sync_duration_ms is null or last_sync_duration_ms >= 0),
  -- Sanitised. A provider error message is normalised into a category and a
  -- short human sentence; the raw payload is never stored, because raw payloads
  -- are exactly where credentials end up.
  last_error_category text check (last_error_category is null or char_length(last_error_category) <= 60),
  last_error_message  text check (last_error_message is null or char_length(last_error_message) <= 400),
  last_error_at       timestamptz,

  disabled_at timestamptz,
  disabled_by uuid references auth.users (id) on delete set null,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),

  constraint gps_provider_connections_tenant_key unique (id, organization_id),
  constraint gps_provider_connections_label_unique unique (organization_id, label),
  constraint gps_provider_connections_disabled_consistent check (
    (status = 'disabled') = (disabled_at is not null)
  )
);

comment on table public.gps_provider_connections is
  'One linked telematics account. Holds no credential — only a status, a server and the operational metadata an administrator needs to answer "why is the map stale?".';
comment on column public.gps_provider_connections.generation is
  'Incremented on credential rotation and on disconnect. A sync carrying an older generation is refused, so a superseded credential cannot report the connection healthy.';

create index if not exists gps_provider_connections_organization_idx
  on public.gps_provider_connections (organization_id, status);

drop trigger if exists gps_provider_connections_set_updated_at on public.gps_provider_connections;
create trigger gps_provider_connections_set_updated_at
  before update on public.gps_provider_connections
  for each row execute function app.set_updated_at();

drop trigger if exists gps_provider_connections_freeze_columns on public.gps_provider_connections;
create trigger gps_provider_connections_freeze_columns
  before update on public.gps_provider_connections
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- Where the credential is
--
-- A separate table with NO grant to `authenticated` at all — not a column the
-- application is trusted to avoid selecting, but a relation it cannot name.
-- The value it points at lives in Supabase Vault, whose `decrypted_secrets`
-- view is granted only to `postgres` and `service_role`, and whose schema is
-- not among the API-exposed schemas. Three independent barriers, and the test
-- suite proves each of them rather than trusting the arrangement.
-- -----------------------------------------------------------------------------

create table if not exists public.gps_provider_credentials (
  connection_id   uuid primary key references public.gps_provider_connections (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- vault.secrets(id). Useless on its own: reading the secret needs a role the
  -- browser never holds and a schema PostgREST does not expose.
  secret_ref uuid not null,

  credential_set_at timestamptz not null default now(),
  credential_set_by uuid references auth.users (id) on delete set null,
  generation        integer not null default 1,

  constraint gps_provider_credentials_connection_fkey
    foreign key (connection_id, organization_id)
    references public.gps_provider_connections (id, organization_id)
    on delete cascade
);

comment on table public.gps_provider_credentials is
  'The pointer from a connection to its Vault secret. No role used by the application has any privilege on this table; only trusted server-side code reaches it.';

-- -----------------------------------------------------------------------------
-- Tracking units
--
-- Our normalised view of a device at the provider. `external_id` is TEXT and
-- always will be: Wialon happens to return numeric ids today, and a number that
-- round-trips through JSON is a number that can silently lose precision past
-- 2^53. An external identifier is an opaque string.
-- -----------------------------------------------------------------------------

create table if not exists public.gps_units (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_id   uuid not null,

  external_id text not null check (char_length(btrim(external_id)) between 1 and 128),
  name        text not null check (char_length(btrim(name)) between 1 and 200),

  -- The hardware's own identifier (IMEI or equivalent). Operationally useful,
  -- mildly sensitive, and never a secret: it is shown in device management and
  -- masked elsewhere.
  device_uid text check (device_uid is null or char_length(btrim(device_uid)) between 1 and 64),
  hardware   text check (hardware is null or char_length(hardware) <= 120),

  availability public.gps_unit_availability not null default 'present',

  /*
   * What this device is known to report. Presence means observed or declared;
   * absence means UNKNOWN, never "does not support it". The interface says
   * "not reported by this device" rather than showing a confident zero.
   */
  capabilities text[] not null default '{}',

  -- Deliberately small and sanitised. Never a dump of the provider response.
  metadata jsonb not null default '{}'::jsonb,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  missing_since timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gps_units_tenant_key unique (id, organization_id),
  constraint gps_units_external_unique unique (connection_id, external_id),
  constraint gps_units_connection_fkey
    foreign key (connection_id, organization_id)
    references public.gps_provider_connections (id, organization_id)
    on delete cascade,
  constraint gps_units_missing_consistent check (
    (availability = 'missing') = (missing_since is not null)
  ),
  constraint gps_units_metadata_is_object check (jsonb_typeof(metadata) = 'object')
);

comment on table public.gps_units is
  'A tracking device as this product understands it. external_id is an opaque string; a provider that returns integers does not get to impose JavaScript number precision on us.';
comment on column public.gps_units.capabilities is
  'Telemetry this device is known to report. Absence means unknown, never unsupported.';

create index if not exists gps_units_organization_idx
  on public.gps_units (organization_id, availability);

create index if not exists gps_units_connection_idx
  on public.gps_units (connection_id);

drop trigger if exists gps_units_set_updated_at on public.gps_units;
create trigger gps_units_set_updated_at
  before update on public.gps_units
  for each row execute function app.set_updated_at();

-- -----------------------------------------------------------------------------
-- Vehicle ↔ device assignments
--
-- Explicitly a relation with history, not a `wialon_unit_id` column on
-- `vehicles`. Replacing a tracker closes one row and opens another; which
-- device was on which car last March remains answerable, and no rental or
-- expense record is rewritten to pretend the new device was always there.
-- -----------------------------------------------------------------------------

create table if not exists public.gps_unit_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  vehicle_id      uuid not null,
  unit_id         uuid not null,

  role public.gps_assignment_role not null default 'primary',

  assigned_at   timestamptz not null default now(),
  assigned_by   uuid references auth.users (id) on delete set null,
  unassigned_at timestamptz,
  unassigned_by uuid references auth.users (id) on delete set null,
  note          text check (note is null or char_length(note) <= 300),

  constraint gps_unit_assignments_tenant_key unique (id, organization_id),
  constraint gps_unit_assignments_vehicle_fkey
    foreign key (vehicle_id, organization_id)
    references public.vehicles (id, organization_id)
    on delete restrict,
  constraint gps_unit_assignments_unit_fkey
    foreign key (unit_id, organization_id)
    references public.gps_units (id, organization_id)
    on delete restrict,
  constraint gps_unit_assignments_period_valid check (
    unassigned_at is null or unassigned_at >= assigned_at
  )
);

comment on table public.gps_unit_assignments is
  'Which device was on which vehicle, and when. Closed rather than deleted, so replacing a tracker never erases where the old one was.';

-- One device cannot be the primary tracker on two cars at once, and one car
-- cannot have two primary trackers. Enforced by the database rather than by
-- whichever screen happens to be doing the writing.
create unique index if not exists gps_unit_assignments_one_active_unit
  on public.gps_unit_assignments (unit_id)
  where unassigned_at is null and role = 'primary';

create unique index if not exists gps_unit_assignments_one_active_vehicle
  on public.gps_unit_assignments (vehicle_id)
  where unassigned_at is null and role = 'primary';

create index if not exists gps_unit_assignments_vehicle_idx
  on public.gps_unit_assignments (vehicle_id, assigned_at desc);

create index if not exists gps_unit_assignments_organization_idx
  on public.gps_unit_assignments (organization_id)
  where unassigned_at is null;

-- -----------------------------------------------------------------------------
-- Current position
--
-- Exactly one row per device. This is a projection of what the provider holds,
-- kept so a fleet map is one query rather than one provider round trip per
-- marker — not a second source of truth and not an archive.
--
-- Every telemetry column is nullable on purpose. A device that does not report
-- ignition has NULL ignition, not false; one that does not report speed has
-- NULL speed, not zero. Unknown stays unknown all the way to the screen.
-- -----------------------------------------------------------------------------

create table if not exists public.gps_positions (
  unit_id         uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- When the device says it was there. This, never received_at, is what
  -- freshness and ordering are computed from.
  observed_at timestamptz not null,
  -- When we learned it. Useful for diagnosing a lagging integration.
  received_at timestamptz not null default now(),

  latitude  double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  -- The provider's own verdict on whether the fix is usable. A 0,0 coordinate
  -- is not universally invalid; the provider says, and we record what it said.
  position_valid boolean not null default true,

  -- Canonical units throughout: km/h and metres. Whatever the provider uses is
  -- converted in the adapter, so no provider convention reaches a component.
  speed_kph     double precision check (speed_kph is null or (speed_kph >= 0 and speed_kph <= 1000)),
  heading_deg   double precision check (heading_deg is null or (heading_deg >= 0 and heading_deg < 360)),
  altitude_m    double precision check (altitude_m is null or altitude_m between -1000 and 20000),
  satellites    smallint check (satellites is null or satellites between 0 and 64),

  ignition       boolean,
  movement       public.gps_movement_state,
  provider_online boolean,

  -- Provider telemetry, shown as such. It never touches vehicles.odometer:
  -- a tracker's odometer has its own calibration, its own unit and its own
  -- resets, and silently overwriting the fleet's figure with it would corrupt
  -- the record every rental contract is written against.
  odometer_km   double precision check (odometer_km is null or odometer_km >= 0),
  engine_hours  double precision check (engine_hours is null or engine_hours >= 0),

  metadata jsonb not null default '{}'::jsonb,

  updated_at timestamptz not null default now(),

  constraint gps_positions_tenant_key unique (unit_id, organization_id),
  constraint gps_positions_unit_fkey
    foreign key (unit_id, organization_id)
    references public.gps_units (id, organization_id)
    on delete cascade,
  constraint gps_positions_coordinates_paired check (
    (latitude is null) = (longitude is null)
  ),
  constraint gps_positions_metadata_is_object check (jsonb_typeof(metadata) = 'object')
);

comment on table public.gps_positions is
  'The last known position of each device: one row, replaced only by a strictly newer observation. A cache of the provider''s truth, never a telemetry archive.';
comment on column public.gps_positions.odometer_km is
  'Provider telemetry only. Never written to vehicles.odometer — a tracker''s odometer is a different measurement with different calibration.';

create index if not exists gps_positions_organization_idx
  on public.gps_positions (organization_id, observed_at desc);

-- -----------------------------------------------------------------------------
-- Synchronisation log
--
-- Enough for an administrator to answer "why is the map stale?", and bounded so
-- it cannot become the telemetry archive this module refuses to keep.
-- -----------------------------------------------------------------------------

create table if not exists public.gps_sync_runs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_id   uuid not null,

  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  outcome     public.gps_sync_outcome,

  unit_count     integer check (unit_count is null or unit_count >= 0),
  position_count integer check (position_count is null or position_count >= 0),
  skipped_count  integer check (skipped_count is null or skipped_count >= 0),

  error_category text check (error_category is null or char_length(error_category) <= 60),
  error_message  text check (error_message is null or char_length(error_message) <= 400),
  triggered_by   uuid references auth.users (id) on delete set null,

  constraint gps_sync_runs_connection_fkey
    foreign key (connection_id, organization_id)
    references public.gps_provider_connections (id, organization_id)
    on delete cascade
);

comment on table public.gps_sync_runs is
  'Recent synchronisation attempts, capped per connection. Operational metadata only — never a payload, never a credential.';

create index if not exists gps_sync_runs_connection_idx
  on public.gps_sync_runs (connection_id, started_at desc);

/**
 * Keeps the log bounded.
 *
 * Fifty attempts per connection is days of history at any sane refresh rate and
 * cannot grow without limit. A retention rule that exists only in a runbook is
 * a table that grows for three years.
 */
create or replace function app.trim_gps_sync_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.gps_sync_runs r
  where r.connection_id = new.connection_id
    and r.id not in (
      select id from public.gps_sync_runs
      where connection_id = new.connection_id
      order by started_at desc
      limit 50
    );
  return null;
end;
$$;

drop trigger if exists gps_sync_runs_trim on public.gps_sync_runs;
create trigger gps_sync_runs_trim
  after insert on public.gps_sync_runs
  for each statement execute function app.trim_gps_sync_runs();

-- -----------------------------------------------------------------------------
-- Guards
-- -----------------------------------------------------------------------------

/**
 * An assignment stays inside one agency and points at a device that exists.
 *
 * The composite foreign keys already make a cross-tenant reference impossible.
 * What they cannot express is that a device which has been archived should not
 * be newly assigned, or that the vehicle must not be a retired one.
 */
create or replace function app.guard_gps_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_availability public.gps_unit_availability;
begin
  if tg_op = 'INSERT' then
    select u.availability into v_availability
    from public.gps_units u
    where u.id = new.unit_id;

    if v_availability = 'archived' then
      raise exception 'That tracking device has been archived and cannot be assigned.'
        using errcode = '23514';
    end if;

    new.assigned_by := coalesce((select auth.uid()), new.assigned_by);
  end if;

  if tg_op = 'UPDATE' and new.unassigned_at is not null and old.unassigned_at is null then
    new.unassigned_by := coalesce((select auth.uid()), new.unassigned_by);
  end if;

  return new;
end;
$$;

drop trigger if exists gps_unit_assignments_guard on public.gps_unit_assignments;
create trigger gps_unit_assignments_guard
  before insert or update on public.gps_unit_assignments
  for each row execute function app.guard_gps_assignment();

/**
 * A closed assignment is history.
 *
 * Reopening one would rewrite where a device was, so it is refused. Ending one
 * that is already ended is refused too — the same lesson the financing closure
 * race taught, applied before anybody has to learn it twice.
 */
create or replace function app.guard_gps_assignment_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.unassigned_at is not null then
    if new.unassigned_at is null then
      raise exception 'A closed assignment cannot be reopened. Assign the device again instead.'
        using errcode = '23514';
    end if;
    if new.unassigned_at is distinct from old.unassigned_at
       or new.unit_id is distinct from old.unit_id
       or new.vehicle_id is distinct from old.vehicle_id
       or new.assigned_at is distinct from old.assigned_at then
      raise exception 'This assignment has already ended and is part of the record.'
        using errcode = '23514';
    end if;
  end if;

  if new.unit_id is distinct from old.unit_id or new.vehicle_id is distinct from old.vehicle_id then
    raise exception 'Move the device by ending this assignment and creating another.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists gps_unit_assignments_guard_history on public.gps_unit_assignments;
create trigger gps_unit_assignments_guard_history
  before update on public.gps_unit_assignments
  for each row execute function app.guard_gps_assignment_history();

-- -----------------------------------------------------------------------------
-- Privileges and policies
--
-- THE PERMISSION MODEL, AND WHY
--
-- Viewing is a manager's. Where the fleet is right now is operational
-- information the person running the day needs, and it sits at the same level
-- as the financing terms and the cost ledger they already read.
--
-- Administration is an administrator's, matching Financing exactly: linking a
-- provider account means handing this product a credential to somebody else's
-- system, and assigning a device decides whose location the agency is watching.
-- Staff get nothing at all — not the map, not the device list. A front-desk
-- clerk does not need to know where every car is, and vehicle location during
-- an active rental is a customer's movements.
--
-- The credential table has no policy because it has no grant. There is nothing
-- for a policy to permit.
-- -----------------------------------------------------------------------------

revoke all on table
  public.gps_provider_connections,
  public.gps_provider_credentials,
  public.gps_units,
  public.gps_unit_assignments,
  public.gps_positions,
  public.gps_sync_runs
from anon, authenticated;

grant select on table public.gps_provider_connections to authenticated;
grant select on table public.gps_units to authenticated;
grant select, insert, update on table public.gps_unit_assignments to authenticated;
grant select on table public.gps_positions to authenticated;
grant select on table public.gps_sync_runs to authenticated;

-- Writing goes through the transactional functions in the next migration and
-- through the trusted server-side integration, never through the Data API.
grant select, insert, update, delete on table public.gps_provider_credentials to service_role;
grant insert, update, delete on table public.gps_units to service_role;
grant insert, update, delete on table public.gps_positions to service_role;
grant insert, update on table public.gps_provider_connections to service_role;
grant insert on table public.gps_sync_runs to service_role;

alter table public.gps_provider_connections enable row level security;
alter table public.gps_provider_credentials enable row level security;
alter table public.gps_units               enable row level security;
alter table public.gps_unit_assignments    enable row level security;
alter table public.gps_positions           enable row level security;
alter table public.gps_sync_runs           enable row level security;

drop policy if exists gps_provider_connections_select on public.gps_provider_connections;
create policy gps_provider_connections_select on public.gps_provider_connections
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists gps_units_select on public.gps_units;
create policy gps_units_select on public.gps_units
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists gps_unit_assignments_select on public.gps_unit_assignments;
create policy gps_unit_assignments_select on public.gps_unit_assignments
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists gps_positions_select on public.gps_positions;
create policy gps_positions_select on public.gps_positions
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

/*
 * Assignment is the one thing the browser writes directly, through the
 * transactional function in the next migration. It runs as the caller, so this
 * policy is the authorization: an administrator decides which device watches
 * which vehicle, and a manager who can see the map cannot change it.
 */
drop policy if exists gps_unit_assignments_insert on public.gps_unit_assignments;
create policy gps_unit_assignments_insert on public.gps_unit_assignments
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists gps_unit_assignments_update on public.gps_unit_assignments;
create policy gps_unit_assignments_update on public.gps_unit_assignments
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists gps_sync_runs_select on public.gps_sync_runs;
create policy gps_sync_runs_select on public.gps_sync_runs
  for select to authenticated
  using (app.has_min_role(organization_id, 'admin'));

/*
 * A table with no grant still gets a policy, so that a future grant added by
 * accident does not silently open it. Belt as well as braces: the policy
 * permits nobody.
 */
drop policy if exists gps_provider_credentials_none on public.gps_provider_credentials;
create policy gps_provider_credentials_none on public.gps_provider_credentials
  for all to authenticated
  using (false)
  with check (false);

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ') into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if v_missing is not null then
    raise exception 'tables without row level security: %', v_missing;
  end if;
end
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from information_schema.role_table_grants
  where grantee in ('anon', 'authenticated')
    and table_schema = 'public'
    and table_name = 'gps_provider_credentials';

  if v_count > 0 then
    raise exception 'the credential table is reachable by an application role';
  end if;
end
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_count > 0 then
    raise exception 'anon can execute % callable function(s) in public', v_count;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
