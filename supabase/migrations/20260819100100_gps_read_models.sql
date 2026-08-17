-- =============================================================================
-- GPS: the fleet read model, and the writes that are allowed to happen
--
-- Two rules run through this file.
--
--   Provider connectivity, position freshness and synchronisation health are
--   three separate columns, derived separately, and never combined into one
--   status. The interface can then say "online, but we have not had a fix for
--   two hours", which is the sentence that actually helps somebody.
--
--   A newer observation replaces an older one; an older observation never
--   replaces a newer one. Providers answer out of order, and an HTTP response
--   arriving second does not make its contents more recent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The agency's freshness thresholds, resolved once
-- -----------------------------------------------------------------------------

create or replace function app.gps_thresholds(p_organization_id uuid)
returns table (fresh_minutes integer, stale_minutes integer)
language sql
stable
set search_path = ''
as $$
  select
    coalesce(s.gps_fresh_minutes, 10)::integer,
    coalesce(s.gps_stale_minutes, 120)::integer
  from (select 1) one
  left join public.organization_settings s on s.organization_id = p_organization_id;
$$;

-- -----------------------------------------------------------------------------
-- The fleet, as the map and the list read it
--
-- One row per vehicle that has a tracker assigned, carrying everything a marker
-- and a list row need and nothing else. No customer identity: a marker needs a
-- plate, and who is driving is a question the side panel asks separately, of
-- the Rentals domain, when somebody with the right to know opens it.
-- -----------------------------------------------------------------------------

create or replace view public.gps_fleet
with (security_invoker = true) as
select
  v.id                    as vehicle_id,
  v.organization_id,
  v.make                  as vehicle_make,
  v.model                 as vehicle_model,
  v.registration_plate    as vehicle_plate,
  (v.archived_at is not null) as vehicle_archived,

  a.id            as assignment_id,
  a.assigned_at,
  u.id            as unit_id,
  u.external_id   as unit_external_id,
  u.name          as unit_name,
  u.availability  as unit_availability,
  u.capabilities,
  c.id            as connection_id,
  c.label         as connection_label,
  c.provider,
  c.status        as connection_status,

  p.observed_at,
  p.received_at,
  p.latitude,
  p.longitude,
  p.position_valid,
  p.speed_kph,
  p.heading_deg,
  p.altitude_m,
  p.satellites,
  p.ignition,
  p.movement,
  p.odometer_km,
  p.engine_hours,

  /*
   * Fact one: what the provider says about the device's connection. NULL when
   * the provider does not report it, which is not the same as offline.
   */
  p.provider_online,

  /*
   * Fact two: how old the fix is, against the agency's own thresholds.
   *
   * `unknown`  — no position at all
   * `future`   — dated ahead of now beyond two minutes of clock skew; a device
   *              with a wrong clock must not look permanently fresh
   * `fresh` / `stale` / `very_stale` — by age
   */
  case
    when p.observed_at is null then 'unknown'
    when p.observed_at > now() + interval '2 minutes' then 'future'
    when p.observed_at >= now() - make_interval(mins => t.fresh_minutes) then 'fresh'
    when p.observed_at >= now() - make_interval(mins => t.stale_minutes) then 'stale'
    else 'very_stale'
  end as position_freshness,

  /*
   * Fact three: whether our own synchronisation is working. An agency can have
   * a perfectly healthy tracker and a broken integration.
   */
  case
    when c.status = 'disabled' then 'disabled'
    when c.status = 'never_connected' then 'never_synced'
    when c.status = 'healthy' then 'healthy'
    else c.status::text
  end as sync_health,

  extract(epoch from (now() - p.observed_at))::bigint as position_age_seconds,

  -- Rental context, from the Rentals read model that already owns it. GPS never
  -- writes here and never infers occupancy from movement.
  f.current_rental_id,
  f.current_rental_reference,
  f.current_rental_ends_at,
  f.effective_status as vehicle_status
from public.gps_unit_assignments a
join public.gps_units u on u.id = a.unit_id
join public.gps_provider_connections c on c.id = u.connection_id
join public.vehicles v on v.id = a.vehicle_id
join public.vehicle_fleet f on f.vehicle_id = v.id
left join public.gps_positions p on p.unit_id = u.id
cross join lateral app.gps_thresholds(v.organization_id) t
where a.unassigned_at is null
  and a.role = 'primary';

comment on view public.gps_fleet is
  'One row per tracked vehicle for the map and the fleet list. Carries no customer identity: who is driving is asked of Rentals, by somebody entitled to know, when a panel is opened.';

-- -----------------------------------------------------------------------------
-- Device inventory
--
-- Every unit the provider gave us, assigned or not, for the device-management
-- screen. This is the only place a hardware identifier belongs.
-- -----------------------------------------------------------------------------

create or replace view public.gps_unit_inventory
with (security_invoker = true) as
select
  u.id,
  u.organization_id,
  u.connection_id,
  c.label as connection_label,
  c.provider,
  u.external_id,
  u.name,
  u.device_uid,
  u.hardware,
  u.availability,
  u.capabilities,
  u.first_seen_at,
  u.last_seen_at,
  u.missing_since,

  a.id         as assignment_id,
  a.assigned_at,
  a.vehicle_id,
  v.registration_plate as vehicle_plate,
  v.make  as vehicle_make,
  v.model as vehicle_model,

  p.observed_at as last_position_at,
  p.provider_online
from public.gps_units u
join public.gps_provider_connections c on c.id = u.connection_id
left join public.gps_unit_assignments a
  on a.unit_id = u.id and a.unassigned_at is null and a.role = 'primary'
left join public.vehicles v on v.id = a.vehicle_id
left join public.gps_positions p on p.unit_id = u.id;

comment on view public.gps_unit_inventory is
  'Tracking devices with their current assignment. The hardware identifier appears here and nowhere else in the product.';

-- -----------------------------------------------------------------------------
-- Assigning a device
--
-- One transaction: close whatever was there, open the new one. Doing it as two
-- browser writes leaves a window in which a vehicle has no tracker or a device
-- has two homes, and the unique indexes would refuse the second write anyway.
-- -----------------------------------------------------------------------------

create or replace function public.gps_assign_unit(
  p_vehicle_id uuid,
  p_unit_id    uuid,
  p_note       text default null
)
returns public.gps_unit_assignments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_assignment public.gps_unit_assignments;
begin
  -- SECURITY INVOKER: the caller's own RLS decides whether these rows are
  -- theirs. A cross-tenant id is simply not found.
  select u.organization_id into v_organization_id
  from public.gps_units u
  where u.id = p_unit_id;

  if v_organization_id is null then
    raise exception 'Tracking device not found.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.vehicles v
    where v.id = p_vehicle_id and v.organization_id = v_organization_id
  ) then
    raise exception 'Vehicle not found.' using errcode = 'P0002';
  end if;

  -- Whatever this device was on, and whatever was on this vehicle, ends now.
  -- Both are closed rather than deleted: the history is the point.
  update public.gps_unit_assignments
     set unassigned_at = now()
   where unassigned_at is null
     and role = 'primary'
     and (unit_id = p_unit_id or vehicle_id = p_vehicle_id);

  insert into public.gps_unit_assignments
    (organization_id, vehicle_id, unit_id, role, note)
  values (v_organization_id, p_vehicle_id, p_unit_id, 'primary', nullif(btrim(coalesce(p_note, '')), ''))
  returning * into v_assignment;

  return v_assignment;
end;
$$;

comment on function public.gps_assign_unit(uuid, uuid, text) is
  'Moves a tracking device onto a vehicle, closing any assignment either of them had. One transaction, so the unique constraints never see a half-applied state.';

create or replace function public.gps_unassign_unit(p_assignment_id uuid)
returns public.gps_unit_assignments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_assignment public.gps_unit_assignments;
begin
  update public.gps_unit_assignments
     set unassigned_at = now()
   where id = p_assignment_id
     and unassigned_at is null
  returning * into v_assignment;

  if v_assignment.id is null then
    raise exception 'That assignment is not open.' using errcode = 'P0002';
  end if;

  return v_assignment;
end;
$$;

-- -----------------------------------------------------------------------------
-- Resolving a vehicle to a device, server-side
--
-- The history endpoint takes a vehicle id, never an external device id. This is
-- how it turns one into the other, under the caller's own row-level security,
-- so a browser cannot name somebody else's tracker and be handed its track.
-- -----------------------------------------------------------------------------

create or replace function public.gps_resolve_tracked_vehicle(p_vehicle_id uuid)
returns table (
  organization_id  uuid,
  vehicle_id       uuid,
  unit_id          uuid,
  unit_external_id text,
  connection_id    uuid,
  provider         public.gps_provider,
  base_url         text,
  connection_status public.gps_connection_status,
  generation       integer
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    a.organization_id,
    a.vehicle_id,
    u.id,
    u.external_id,
    c.id,
    c.provider,
    c.base_url,
    c.status,
    c.generation
  from public.gps_unit_assignments a
  join public.gps_units u on u.id = a.unit_id
  join public.gps_provider_connections c on c.id = u.connection_id
  where a.vehicle_id = p_vehicle_id
    and a.unassigned_at is null
    and a.role = 'primary';
$$;

comment on function public.gps_resolve_tracked_vehicle(uuid) is
  'Turns a vehicle the caller can see into the device and connection behind it. Runs under the caller''s RLS, which is what makes the history endpoint safe.';

-- -----------------------------------------------------------------------------
-- Applying a synchronisation
--
-- Called only by trusted server-side code. `authenticated` has no privilege on
-- it at all — the browser cannot write a position, which is what stops somebody
-- inventing one.
-- -----------------------------------------------------------------------------

create or replace function public.gps_apply_sync(
  p_connection_id  uuid,
  p_generation     integer,
  p_units          jsonb,
  p_outcome        public.gps_sync_outcome,
  p_started_at     timestamptz,
  p_full_inventory boolean default true,
  p_account_label  text default null,
  p_error_category text default null,
  p_error_message  text default null,
  p_triggered_by   uuid default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_connection public.gps_provider_connections;
  v_unit       jsonb;
  v_unit_id    uuid;
  v_seen       text[] := '{}';
  v_units      integer := 0;
  v_positions  integer := 0;
  v_skipped    integer := 0;
  v_missing    integer := 0;
  v_observed   timestamptz;
  v_applied    boolean;
begin
  select * into v_connection
  from public.gps_provider_connections
  where id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'Connection not found.' using errcode = 'P0002';
  end if;

  /*
   * The generation gate.
   *
   * A synchronisation carries the generation it started under. If the
   * credential has since been replaced, or an administrator has disconnected
   * the provider, this answer was produced by a connection that no longer
   * exists in that form — writing it would report a superseded credential as
   * healthy, or quietly resurrect a connection somebody deliberately switched
   * off. It is refused, and says so.
   */
  if p_generation <> v_connection.generation then
    insert into public.gps_sync_runs
      (organization_id, connection_id, started_at, finished_at, duration_ms,
       outcome, error_category, error_message, triggered_by)
    values (
      v_connection.organization_id, p_connection_id, p_started_at, now(),
      greatest(0, (extract(epoch from (now() - p_started_at)) * 1000)::integer),
      'aborted', 'superseded',
      'The connection changed while this synchronisation was running.', p_triggered_by
    );

    return jsonb_build_object(
      'applied', false,
      'reason', 'superseded',
      'units', 0, 'positions', 0, 'skipped', 0
    );
  end if;

  if v_connection.disabled_at is not null then
    return jsonb_build_object('applied', false, 'reason', 'disabled',
                              'units', 0, 'positions', 0, 'skipped', 0);
  end if;

  -- ------------------------------------------------------------------ units
  for v_unit in select * from jsonb_array_elements(coalesce(p_units, '[]'::jsonb))
  loop
    v_seen := v_seen || (v_unit ->> 'external_id');

    insert into public.gps_units (
      organization_id, connection_id, external_id, name, device_uid, hardware,
      availability, capabilities, metadata, last_seen_at, missing_since
    ) values (
      v_connection.organization_id,
      p_connection_id,
      v_unit ->> 'external_id',
      coalesce(nullif(btrim(v_unit ->> 'name'), ''), v_unit ->> 'external_id'),
      nullif(btrim(coalesce(v_unit ->> 'device_uid', '')), ''),
      nullif(btrim(coalesce(v_unit ->> 'hardware', '')), ''),
      'present',
      coalesce(
        (select array_agg(value #>> '{}') from jsonb_array_elements(v_unit -> 'capabilities')),
        '{}'
      ),
      coalesce(v_unit -> 'metadata', '{}'::jsonb),
      now(),
      null
    )
    on conflict (connection_id, external_id) do update
      set name = excluded.name,
          device_uid = coalesce(excluded.device_uid, public.gps_units.device_uid),
          hardware = coalesce(excluded.hardware, public.gps_units.hardware),
          -- A device that had gone missing and is back is present again.
          availability = case when public.gps_units.availability = 'archived'
                              then 'archived'::public.gps_unit_availability
                              else 'present'::public.gps_unit_availability end,
          missing_since = null,
          capabilities = excluded.capabilities,
          metadata = excluded.metadata,
          last_seen_at = now()
    returning id into v_unit_id;

    v_units := v_units + 1;

    -- -------------------------------------------------------------- position
    if v_unit -> 'position' is not null and jsonb_typeof(v_unit -> 'position') = 'object' then
      v_observed := (v_unit #>> '{position,observed_at}')::timestamptz;

      if v_observed is null then
        v_skipped := v_skipped + 1;
      else
        insert into public.gps_positions (
          unit_id, organization_id, observed_at, received_at,
          latitude, longitude, position_valid, speed_kph, heading_deg, altitude_m,
          satellites, ignition, movement, provider_online, odometer_km, engine_hours, metadata
        ) values (
          v_unit_id,
          v_connection.organization_id,
          v_observed,
          now(),
          (v_unit #>> '{position,latitude}')::double precision,
          (v_unit #>> '{position,longitude}')::double precision,
          coalesce((v_unit #>> '{position,position_valid}')::boolean, true),
          (v_unit #>> '{position,speed_kph}')::double precision,
          (v_unit #>> '{position,heading_deg}')::double precision,
          (v_unit #>> '{position,altitude_m}')::double precision,
          (v_unit #>> '{position,satellites}')::smallint,
          (v_unit #>> '{position,ignition}')::boolean,
          (v_unit #>> '{position,movement}')::public.gps_movement_state,
          (v_unit #>> '{position,provider_online}')::boolean,
          (v_unit #>> '{position,odometer_km}')::double precision,
          (v_unit #>> '{position,engine_hours}')::double precision,
          coalesce(v_unit #> '{position,metadata}', '{}'::jsonb)
        )
        on conflict (unit_id) do update
          set observed_at = excluded.observed_at,
              received_at = excluded.received_at,
              latitude = excluded.latitude,
              longitude = excluded.longitude,
              position_valid = excluded.position_valid,
              speed_kph = excluded.speed_kph,
              heading_deg = excluded.heading_deg,
              altitude_m = excluded.altitude_m,
              satellites = excluded.satellites,
              ignition = excluded.ignition,
              movement = excluded.movement,
              provider_online = excluded.provider_online,
              odometer_km = excluded.odometer_km,
              engine_hours = excluded.engine_hours,
              metadata = excluded.metadata,
              updated_at = now()
          -- Strictly newer only. A response that arrives late carrying an older
          -- observation must not overwrite the fix we already have.
          where excluded.observed_at > public.gps_positions.observed_at;

        get diagnostics v_applied = row_count;
        if v_applied then
          v_positions := v_positions + 1;
        else
          v_skipped := v_skipped + 1;
        end if;
      end if;
    end if;
  end loop;

  /*
   * Devices the provider no longer lists are marked, never deleted — only when
   * this was a complete inventory. A partial answer is not evidence that a
   * device is gone.
   */
  if p_full_inventory and p_outcome in ('success', 'partial') then
    update public.gps_units
       set availability = 'missing', missing_since = coalesce(missing_since, now())
     where connection_id = p_connection_id
       and availability = 'present'
       and not (external_id = any (v_seen));
    get diagnostics v_missing = row_count;
  end if;

  -- --------------------------------------------------------------- the log
  insert into public.gps_sync_runs
    (organization_id, connection_id, started_at, finished_at, duration_ms,
     outcome, unit_count, position_count, skipped_count,
     error_category, error_message, triggered_by)
  values (
    v_connection.organization_id, p_connection_id, p_started_at, now(),
    greatest(0, (extract(epoch from (now() - p_started_at)) * 1000)::integer),
    p_outcome, v_units, v_positions, v_skipped,
    p_error_category, left(p_error_message, 400), p_triggered_by
  );

  update public.gps_provider_connections
     set status = case p_outcome
                    when 'success'        then 'healthy'::public.gps_connection_status
                    when 'partial'        then 'healthy'::public.gps_connection_status
                    when 'auth_error'     then 'auth_error'::public.gps_connection_status
                    when 'unreachable'    then 'unreachable'::public.gps_connection_status
                    when 'rate_limited'   then 'rate_limited'::public.gps_connection_status
                    else 'provider_error'::public.gps_connection_status
                  end,
         account_label = coalesce(p_account_label, account_label),
         unit_count = case when p_outcome in ('success', 'partial') then v_units else unit_count end,
         last_sync_started_at = p_started_at,
         last_sync_success_at = case when p_outcome in ('success', 'partial')
                                     then now() else last_sync_success_at end,
         last_verified_at = case when p_outcome in ('success', 'partial')
                                 then now() else last_verified_at end,
         last_sync_duration_ms = greatest(0, (extract(epoch from (now() - p_started_at)) * 1000)::integer),
         last_error_category = case when p_outcome in ('success', 'partial') then null else p_error_category end,
         last_error_message = case when p_outcome in ('success', 'partial') then null else left(p_error_message, 400) end,
         last_error_at = case when p_outcome in ('success', 'partial') then last_error_at else now() end
   where id = p_connection_id;

  return jsonb_build_object(
    'applied', true,
    'units', v_units,
    'positions', v_positions,
    'skipped', v_skipped,
    'missing', v_missing
  );
end;
$$;

comment on function public.gps_apply_sync is
  'Writes a synchronisation result. Refuses a superseded generation, never lets an older observation replace a newer one, and marks vanished devices rather than deleting them.';

-- -----------------------------------------------------------------------------
-- What needs attention
--
-- A read model, not an alerting system. Nothing here sends anything; it exists
-- so a later Notifications module has one definition of "this tracker has gone
-- quiet" to consume instead of inventing its own.
-- -----------------------------------------------------------------------------

create or replace function public.gps_attention_signals(p_organization_id uuid)
returns table (
  signal        text,
  severity      text,
  vehicle_id    uuid,
  vehicle_plate text,
  unit_id       uuid,
  connection_id uuid,
  detail        text,
  since         timestamptz
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not app.has_min_role(p_organization_id, 'manager') then
    raise exception 'Not permitted to view tracking for this organization.' using errcode = '42501';
  end if;

  return query
  -- A connection that cannot reach the provider.
  select
    'connection_unhealthy'::text,
    case when c.status = 'auth_error' then 'critical' else 'warning' end,
    null::uuid, null::text, null::uuid, c.id,
    coalesce(c.last_error_message, 'The provider connection is not healthy.'),
    c.last_error_at
  from public.gps_provider_connections c
  where c.organization_id = p_organization_id
    and c.status not in ('healthy', 'never_connected', 'disabled')

  union all

  -- A tracked vehicle whose position has gone quiet.
  select
    case when f.position_freshness = 'unknown' then 'no_position' else 'position_stale' end,
    case when f.position_freshness = 'very_stale' then 'warning' else 'info' end,
    f.vehicle_id, f.vehicle_plate, f.unit_id, f.connection_id,
    case
      when f.position_freshness = 'unknown' then 'No position has ever been reported for this device.'
      else 'The last position is older than this agency''s threshold.'
    end,
    f.observed_at
  from public.gps_fleet f
  where f.organization_id = p_organization_id
    and f.connection_status <> 'disabled'
    and f.position_freshness in ('unknown', 'very_stale')

  union all

  -- A device that has disappeared from the provider.
  select
    'device_missing'::text, 'warning'::text,
    i.vehicle_id, i.vehicle_plate, i.id, i.connection_id,
    'This device is no longer listed by the provider.',
    i.missing_since
  from public.gps_unit_inventory i
  where i.organization_id = p_organization_id
    and i.availability = 'missing';
end;
$$;

comment on function public.gps_attention_signals(uuid) is
  'Normalised conditions a later Notifications module can consume. Sends nothing and claims nothing was sent.';

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

revoke all on public.gps_fleet from public, anon, authenticated;
revoke all on public.gps_unit_inventory from public, anon, authenticated;
grant select on public.gps_fleet to authenticated;
grant select on public.gps_unit_inventory to authenticated;

revoke all on function app.gps_thresholds(uuid) from public, anon;
revoke all on function public.gps_assign_unit(uuid, uuid, text) from public, anon;
revoke all on function public.gps_unassign_unit(uuid) from public, anon;
revoke all on function public.gps_resolve_tracked_vehicle(uuid) from public, anon;
revoke all on function public.gps_attention_signals(uuid) from public, anon;
revoke all on function public.gps_apply_sync(uuid, integer, jsonb, public.gps_sync_outcome, timestamptz, boolean, text, text, text, uuid) from public, anon;

grant execute on function app.gps_thresholds(uuid) to authenticated;
grant execute on function public.gps_assign_unit(uuid, uuid, text) to authenticated;
grant execute on function public.gps_unassign_unit(uuid) to authenticated;
grant execute on function public.gps_resolve_tracked_vehicle(uuid) to authenticated;
grant execute on function public.gps_attention_signals(uuid) to authenticated;

-- Deliberately NOT granted to `authenticated`. A position may only be written
-- by trusted server-side code, which is what makes a position on the map
-- evidence of something rather than an assertion by a browser.
revoke all on function public.gps_apply_sync(uuid, integer, jsonb, public.gps_sync_outcome, timestamptz, boolean, text, text, text, uuid) from authenticated;
grant execute on function public.gps_apply_sync(uuid, integer, jsonb, public.gps_sync_outcome, timestamptz, boolean, text, text, text, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

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

do $$
begin
  if has_function_privilege(
       'authenticated',
       'public.gps_apply_sync(uuid, integer, jsonb, public.gps_sync_outcome, timestamptz, boolean, text, text, text, uuid)',
       'EXECUTE') then
    raise exception 'a signed-in user can write GPS positions directly';
  end if;
end
$$;

do $$
declare
  v_grants integer;
begin
  select count(*) into v_grants
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public';

  if v_grants > 0 then
    raise exception 'anon holds % table grant(s) in public', v_grants;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
