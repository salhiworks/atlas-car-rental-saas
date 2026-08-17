-- =============================================================================
-- 20260814100100_vehicle_fleet_model.sql
--
-- Separates what an agency *decides* about a vehicle from what its contracts
-- *imply* about it.
--
-- The original schema let `vehicles.status` hold both, which meant 'rented' and
-- 'reserved' were duplicated state: something would have had to write them when
-- a contract began and unwrite them when it ended, and any missed write would
-- leave a car marked rented forever or bookable while a customer was driving it.
--
-- The correction:
--
--   * `vehicles.status` is now constrained to the three states a person actually
--     decides — available (in service), maintenance, unavailable (off the road).
--   * Occupancy is derived from `rentals`, whose overlap exclusion constraint is
--     already the authority on what a vehicle is committed to.
--   * `vehicle_availability` combines them into one effective status. Nothing
--     synchronises anything; a contradiction is not representable.
--
-- The `vehicle_status` enum keeps all five values: 'rented' and 'reserved' are
-- still meaningful, now as derived output rather than stored state.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Stored status is operational only
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vehicles_status_is_operational'
      and conrelid = 'public.vehicles'::regclass
  ) then
    alter table public.vehicles
      add constraint vehicles_status_is_operational
      check (status in ('available', 'maintenance', 'unavailable'));
  end if;
end
$$;

comment on column public.vehicles.status is
  'Operational state the agency sets: available, maintenance or unavailable. Rental occupancy is NOT stored here — read public.vehicle_availability for effective status.';

-- -----------------------------------------------------------------------------
-- Archiving safety
--
-- Archiving is how a vehicle leaves the fleet without destroying the contracts,
-- payments and expenses that reference it. A vehicle still committed to a
-- contract cannot be archived out from under it.
-- -----------------------------------------------------------------------------

create or replace function app.guard_vehicle_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    if exists (
      select 1
      from public.rentals r
      where r.vehicle_id = new.id
        and r.status in ('reserved', 'active')
    ) then
      raise exception
        'This vehicle is committed to an active or upcoming contract and cannot be archived yet.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists vehicles_guard_archive on public.vehicles;
create trigger vehicles_guard_archive
  before update of archived_at on public.vehicles
  for each row execute function app.guard_vehicle_archive();

-- -----------------------------------------------------------------------------
-- The fleet read model
--
-- One relation the fleet list, the vehicle page and the dashboard all read, so
-- "what state is this car in" is answered in exactly one place. It carries the
-- vehicle's own columns plus derived occupancy, which is what makes the list
-- filterable and sortable by effective status in a single query rather than by
-- re-deriving status in the browser after fetching everything.
--
-- SECURITY INVOKER, so the RLS policies on vehicles and rentals apply to
-- whoever queries it — the view adds no privilege of its own.
-- -----------------------------------------------------------------------------

drop view if exists public.vehicle_availability;
drop view if exists public.vehicle_fleet;

create view public.vehicle_fleet
with (security_invoker = true)
as
select
  v.id                       as vehicle_id,
  v.organization_id,
  v.make,
  v.model,
  v.model_year,
  v.registration_plate,
  v.vin,
  v.color,
  v.category,
  v.fuel_type,
  v.transmission,
  v.seats,
  v.odometer,
  v.daily_rate_minor,
  v.currency,
  v.insurance_expires_on,
  v.inspection_expires_on,
  v.registration_expires_on,
  v.next_service_on,
  v.notes,
  v.created_at,
  v.updated_at,
  v.archived_at,
  v.status                   as operational_status,

  current_rental.id          as current_rental_id,
  current_rental.reference   as current_rental_reference,
  current_rental.customer_id as current_customer_id,
  current_rental.ends_at     as current_rental_ends_at,

  next_rental.id             as next_rental_id,
  next_rental.reference      as next_rental_reference,
  next_rental.customer_id    as next_customer_id,
  next_rental.starts_at      as next_rental_starts_at,

  case
    when v.archived_at is not null      then 'unavailable'::public.vehicle_status
    when v.status <> 'available'        then v.status
    when current_rental.id is not null  then 'rented'::public.vehicle_status
    when next_rental.id is not null
     and next_rental.starts_at <= now() then 'reserved'::public.vehicle_status
    else 'available'::public.vehicle_status
  end                        as effective_status,

  -- True when the vehicle can be handed to a customer right now.
  (
    v.archived_at is null
    and v.status = 'available'
    and current_rental.id is null
    and (next_rental.id is null or next_rental.starts_at > now())
  )                          as is_available_now
from public.vehicles v

-- The contract the vehicle is out on at this moment.
left join lateral (
  select r.id, r.reference, r.customer_id, r.ends_at
  from public.rentals r
  where r.vehicle_id = v.id
    and r.status = 'active'
    and r.starts_at <= now()
    and r.ends_at > now()
  order by r.starts_at
  limit 1
) current_rental on true

-- The soonest commitment that has not finished yet.
left join lateral (
  select r.id, r.reference, r.customer_id, r.starts_at
  from public.rentals r
  where r.vehicle_id = v.id
    and r.status = 'reserved'
    and r.ends_at > now()
  order by r.starts_at
  limit 1
) next_rental on true;

comment on view public.vehicle_fleet is
  'Fleet read model: vehicle columns plus occupancy derived from contracts. Operational state and occupancy cannot contradict each other because neither is copied.';

revoke all on public.vehicle_fleet from anon, authenticated;
grant select on public.vehicle_fleet to authenticated;

-- -----------------------------------------------------------------------------
-- Fleet summary counts
--
-- One round trip for the figures above the fleet list, instead of pulling every
-- vehicle down to count them in the browser.
-- -----------------------------------------------------------------------------

create or replace function public.fleet_status_counts(p_organization_id uuid)
returns table (
  total       bigint,
  available   bigint,
  rented      bigint,
  reserved    bigint,
  maintenance bigint,
  unavailable bigint,
  archived    bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  return query
  select
    count(*) filter (where f.archived_at is null),
    count(*) filter (where f.archived_at is null and f.effective_status = 'available'),
    count(*) filter (where f.archived_at is null and f.effective_status = 'rented'),
    count(*) filter (where f.archived_at is null and f.effective_status = 'reserved'),
    count(*) filter (where f.archived_at is null and f.effective_status = 'maintenance'),
    count(*) filter (where f.archived_at is null and f.effective_status = 'unavailable'),
    count(*) filter (where f.archived_at is not null)
  from public.vehicle_fleet f
  where f.organization_id = p_organization_id;
end;
$$;

comment on function public.fleet_status_counts(uuid) is
  'Fleet composition by effective status for one agency, plus the archived count.';

revoke all on function public.fleet_status_counts(uuid) from public;
grant execute on function public.fleet_status_counts(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Availability search — the query the Rentals module will book against
-- -----------------------------------------------------------------------------

create or replace function public.vehicles_available_between(
  p_organization_id   uuid,
  p_from              timestamptz,
  p_to                timestamptz,
  p_exclude_rental_id uuid default null
)
returns setof uuid
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  if p_to <= p_from then
    raise exception 'The period must end after it starts.' using errcode = '22023';
  end if;

  return query
  select v.id
  from public.vehicles v
  where v.organization_id = p_organization_id
    and v.archived_at is null
    and v.status = 'available'
    -- Mirrors the rentals_no_vehicle_overlap exclusion constraint exactly, so a
    -- vehicle offered here is one the database will actually accept a booking
    -- for. The constraint remains the authority; this only avoids offering
    -- choices that would be rejected.
    and not exists (
      select 1
      from public.rentals r
      where r.vehicle_id = v.id
        and r.status in ('reserved', 'active')
        and (p_exclude_rental_id is null or r.id <> p_exclude_rental_id)
        and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_from, p_to, '[)')
    )
  order by v.id;
end;
$$;

comment on function public.vehicles_available_between(uuid, timestamptz, timestamptz, uuid) is
  'Vehicles bookable for a period. p_exclude_rental_id lets an existing contract be rescheduled without conflicting with itself.';

revoke all on function public.vehicles_available_between(uuid, timestamptz, timestamptz, uuid) from public;
grant execute on function public.vehicles_available_between(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Overview now reads occupancy from contracts rather than from a stored column
-- -----------------------------------------------------------------------------

create or replace function public.organization_overview(
  p_organization_id uuid,
  p_from            timestamptz,
  p_to              timestamptz
)
returns table (
  currency                    public.currency_code,
  time_zone                   text,
  fleet_total                 bigint,
  fleet_available             bigint,
  fleet_rented                bigint,
  fleet_reserved              bigint,
  fleet_maintenance           bigint,
  fleet_unavailable           bigint,
  customers_total             bigint,
  rentals_total               bigint,
  rentals_active              bigint,
  rentals_upcoming            bigint,
  rentals_completed_in_period bigint,
  revenue_minor               bigint,
  expenses_minor              bigint,
  profit_minor                bigint,
  outstanding_minor           bigint,
  deposits_held_minor         bigint,
  excluded_currency_records   bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_currency  public.currency_code;
  v_time_zone text;
  v_from_date date;
  v_to_date   date;
begin
  if p_organization_id is null then
    raise exception 'An organization is required.' using errcode = '22004';
  end if;

  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  if p_to <= p_from then
    raise exception 'The reporting period must end after it starts.' using errcode = '22023';
  end if;

  select o.default_currency, o.time_zone
    into v_currency, v_time_zone
  from public.organizations o
  where o.id = p_organization_id;

  if v_currency is null then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;

  v_from_date := (p_from at time zone v_time_zone)::date;
  v_to_date   := (p_to   at time zone v_time_zone)::date;

  return query
  with fleet as (
    select
      count(*)                                                  as total,
      count(*) filter (where a.effective_status = 'available')   as available,
      count(*) filter (where a.effective_status = 'rented')      as rented,
      count(*) filter (where a.effective_status = 'reserved')    as reserved,
      count(*) filter (where a.effective_status = 'maintenance') as maintenance,
      count(*) filter (where a.effective_status = 'unavailable') as unavailable
    from public.vehicle_fleet a
    where a.organization_id = p_organization_id
      and a.archived_at is null
  ),
  people as (
    select count(*) as total
    from public.customers c
    where c.organization_id = p_organization_id
      and c.archived_at is null
  ),
  contracts as (
    select
      count(*)                                                    as total,
      count(*) filter (where r.status = 'active')                 as active,
      count(*) filter (where r.status = 'reserved'
                         and r.starts_at >= now())                as upcoming,
      count(*) filter (where r.status = 'completed'
                         and coalesce(r.completed_at, r.ends_at) >= p_from
                         and coalesce(r.completed_at, r.ends_at) <  p_to)  as completed_in_period,
      coalesce(sum(r.balance_due_minor) filter (
        where r.currency = v_currency
          and r.status in ('reserved', 'active', 'completed')
          and r.balance_due_minor > 0
      ), 0)::bigint                                               as outstanding,
      coalesce(sum(r.deposit_minor) filter (
        where r.currency = v_currency
          and r.status in ('reserved', 'active')
      ), 0)::bigint                                               as deposits_held
    from public.rentals r
    where r.organization_id = p_organization_id
  ),
  cash_in as (
    select
      coalesce(sum(
        case p.direction
          when 'inbound'  then  p.amount_minor
          when 'outbound' then -p.amount_minor
        end
      ) filter (where p.currency = v_currency), 0)::bigint as net_minor,
      count(*) filter (where p.currency <> v_currency) as foreign_records
    from public.payments p
    where p.organization_id = p_organization_id
      and p.paid_at >= p_from
      and p.paid_at <  p_to
  ),
  cash_out as (
    select
      coalesce(sum(e.amount_minor) filter (where e.currency = v_currency), 0)::bigint as total_minor,
      count(*) filter (where e.currency <> v_currency) as foreign_records
    from public.expenses e
    where e.organization_id = p_organization_id
      and e.incurred_on >= v_from_date
      and e.incurred_on <  v_to_date
  )
  select
    v_currency,
    v_time_zone,
    fleet.total,
    fleet.available,
    fleet.rented,
    fleet.reserved,
    fleet.maintenance,
    fleet.unavailable,
    people.total,
    contracts.total,
    contracts.active,
    contracts.upcoming,
    contracts.completed_in_period,
    cash_in.net_minor,
    cash_out.total_minor,
    cash_in.net_minor - cash_out.total_minor,
    contracts.outstanding,
    contracts.deposits_held,
    cash_in.foreign_records + cash_out.foreign_records
  from fleet, people, contracts, cash_in, cash_out;
end;
$$;

revoke all on function public.organization_overview(uuid, timestamptz, timestamptz) from public;
grant execute on function public.organization_overview(uuid, timestamptz, timestamptz) to authenticated;

select app.assert_views_are_security_invoker();
