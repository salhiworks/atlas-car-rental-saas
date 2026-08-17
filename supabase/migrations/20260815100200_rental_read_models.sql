-- =============================================================================
-- 20260815100200_rental_read_models.sql
--
-- The rental desk's read models, and the analytics correction that follows from
-- deposits no longer being counted as revenue.
--
-- WHAT CHANGED IN THE DASHBOARD, AND WHY
--
-- `revenue_minor` used to be "every payment in the period". That treated a
-- refundable deposit as earned income, and treated returning it as a loss. Both
-- figures moved with money the agency never owned. Revenue now counts payments
-- whose purpose is a rental charge, and voided entries are excluded everywhere.
--
-- `deposits_held_minor` used to report the deposit each contract *agreed*,
-- whether or not it had been taken. It now reports what is actually held.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Billable days
--
-- Rental days are counted from the elapsed period, not from calendar dates: a
-- hire from Friday 18:00 to Sunday 10:00 is two days everywhere in the world,
-- and a calendar-date subtraction would call it two in one time zone and three
-- in another. Any started day is a chargeable day — which is how rental desks
-- price — and a same-hour return still bills one day.
--
-- Because the arithmetic is on an interval rather than on local dates, a
-- daylight-saving change inside the hire cannot add or remove a day.
-- -----------------------------------------------------------------------------

create or replace function public.rental_billable_days(
  p_starts_at timestamptz,
  p_ends_at   timestamptz
)
returns integer
language sql
immutable
parallel safe
as $$
  select greatest(1, ceil(extract(epoch from (p_ends_at - p_starts_at)) / 86400.0)::integer);
$$;

comment on function public.rental_billable_days(timestamptz, timestamptz) is
  'Chargeable days for a period: elapsed time divided into 24-hour days, rounded up, minimum one. Immune to time-zone and DST shifts.';

revoke all on function public.rental_billable_days(timestamptz, timestamptz) from public, anon;
grant execute on function public.rental_billable_days(timestamptz, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- The rentals board
--
-- One row per contract with the few joined facts a list has to show, so the
-- list screen is a single query rather than a fan-out. security_invoker keeps
-- RLS on every underlying table.
-- -----------------------------------------------------------------------------

create or replace view public.rental_board
with (security_invoker = true) as
select
  r.id,
  r.organization_id,
  r.reference,
  r.status,
  r.starts_at,
  r.ends_at,
  r.pickup_location,
  r.return_location,
  r.currency,
  r.total_minor,
  r.amount_paid_minor,
  r.balance_due_minor,
  r.deposit_minor,
  r.deposit_held_minor,
  r.payment_status,
  r.picked_up_at,
  r.returned_at,
  r.extension_count,
  r.created_at,

  r.vehicle_id,
  v.make          as vehicle_make,
  v.model         as vehicle_model,
  v.model_year    as vehicle_model_year,
  v.registration_plate as vehicle_plate,

  r.customer_id,
  c.display_name  as customer_name,
  c.customer_type as customer_type,

  -- The renter pays; the primary driver drives. Usually the same person, and
  -- the list has to make it obvious when they are not.
  primary_driver.customer_id   as primary_driver_id,
  primary_driver.display_name  as primary_driver_name,
  (primary_driver.customer_id is not null and primary_driver.customer_id <> r.customer_id)
    as renter_is_not_driver,

  driver_count.total as driver_count,

  -- Out with a customer and past the agreed return time.
  (r.status = 'active' and r.ends_at < now()) as is_overdue,

  contract.version    as contract_version,
  contract.status     as contract_status,
  contract.pdf_path   as contract_pdf_path,
  contract.signed_at  as contract_signed_at
from public.rentals r
join public.vehicles v on v.id = r.vehicle_id
join public.customers c on c.id = r.customer_id
left join lateral (
  select rd.customer_id, dc.display_name
  from public.rental_drivers rd
  join public.customers dc on dc.id = rd.customer_id
  where rd.rental_id = r.id and rd.driver_role = 'primary'
  limit 1
) primary_driver on true
left join lateral (
  select count(*) as total from public.rental_drivers rd where rd.rental_id = r.id
) driver_count on true
left join lateral (
  select rc.version, rc.status, rc.pdf_path, rc.signed_at
  from public.rental_contracts rc
  where rc.rental_id = r.id
  order by rc.version desc
  limit 1
) contract on true;

comment on view public.rental_board is
  'One row per rental with the joined facts the list screen shows. security_invoker, so RLS applies to every source table.';

revoke all on public.rental_board from anon, authenticated;
grant select on public.rental_board to authenticated;

-- -----------------------------------------------------------------------------
-- Why a vehicle is unavailable
--
-- `vehicles_available_between()` answers whether. When a booking is refused,
-- the desk needs to be able to say which contract holds the vehicle, so the
-- customer can be told something more useful than "unavailable".
-- -----------------------------------------------------------------------------

create or replace function public.rental_period_conflicts(
  p_vehicle_id uuid,
  p_starts_at  timestamptz,
  p_ends_at    timestamptz,
  p_exclude_rental_id uuid default null
)
returns table (
  rental_id  uuid,
  reference  text,
  status     public.rental_status,
  starts_at  timestamptz,
  ends_at    timestamptz,
  customer_name text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.id, r.reference, r.status, r.starts_at, r.ends_at, c.display_name
  from public.rentals r
  join public.customers c on c.id = r.customer_id
  where r.vehicle_id = p_vehicle_id
    and r.status in ('reserved', 'active')
    and (p_exclude_rental_id is null or r.id <> p_exclude_rental_id)
    and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
  order by r.starts_at;
$$;

comment on function public.rental_period_conflicts(uuid, timestamptz, timestamptz, uuid) is
  'The commitments that overlap a proposed period. RLS on rentals confines this to the caller''s agency.';

revoke all on function public.rental_period_conflicts(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.rental_period_conflicts(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Overview, with deposits taken out of revenue
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
      -- What is actually held, not what was agreed. An unpaid deposit is not
      -- money the agency is sitting on.
      coalesce(sum(r.deposit_held_minor) filter (
        where r.currency = v_currency
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
      ) filter (where p.currency = v_currency and p.purpose = 'rental_charge'), 0)::bigint
        as net_minor,
      count(*) filter (where p.currency <> v_currency) as foreign_records
    from public.payments p
    where p.organization_id = p_organization_id
      and p.voided_at is null
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

comment on function public.organization_overview(uuid, timestamptz, timestamptz) is
  'Dashboard aggregates for one agency over a period. Revenue counts rental charges only — deposits are the customer''s money, reported separately as deposits_held_minor.';

-- -----------------------------------------------------------------------------
-- The revenue series, on the same definition
-- -----------------------------------------------------------------------------

create or replace function public.organization_financial_series(
  p_organization_id uuid,
  p_from            date,
  p_to              date,
  p_granularity     text default 'month'
)
returns table (
  bucket_start  date,
  revenue_minor bigint,
  expenses_minor bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_currency  public.currency_code;
  v_time_zone text;
  v_step      interval;
begin
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  if p_to <= p_from then
    raise exception 'The reporting period must end after it starts.' using errcode = '22023';
  end if;

  v_step := case p_granularity
    when 'day'   then interval '1 day'
    when 'week'  then interval '1 week'
    when 'month' then interval '1 month'
  end;

  if v_step is null then
    raise exception 'Unsupported granularity: %', p_granularity using errcode = '22023';
  end if;

  select o.default_currency, o.time_zone
    into v_currency, v_time_zone
  from public.organizations o
  where o.id = p_organization_id;

  if v_currency is null then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;

  return query
  with buckets as (
    select generate_series(
      date_trunc(p_granularity, p_from::timestamp),
      date_trunc(p_granularity, (p_to - 1)::timestamp),
      v_step
    ) as bucket_ts
  ),
  revenue as (
    select
      date_trunc(p_granularity, (p.paid_at at time zone v_time_zone)) as bucket_ts,
      sum(
        case p.direction
          when 'inbound'  then  p.amount_minor
          when 'outbound' then -p.amount_minor
        end
      ) as amount_minor
    from public.payments p
    where p.organization_id = p_organization_id
      and p.currency = v_currency
      and p.purpose = 'rental_charge'
      and p.voided_at is null
      and (p.paid_at at time zone v_time_zone) >= p_from::timestamp
      and (p.paid_at at time zone v_time_zone) <  p_to::timestamp
    group by 1
  ),
  spend as (
    select
      date_trunc(p_granularity, e.incurred_on::timestamp) as bucket_ts,
      sum(e.amount_minor) as amount_minor
    from public.expenses e
    where e.organization_id = p_organization_id
      and e.currency = v_currency
      and e.incurred_on >= p_from
      and e.incurred_on <  p_to
    group by 1
  )
  select
    buckets.bucket_ts::date,
    coalesce(revenue.amount_minor, 0)::bigint,
    coalesce(spend.amount_minor, 0)::bigint
  from buckets
  left join revenue on revenue.bucket_ts = buckets.bucket_ts
  left join spend   on spend.bucket_ts   = buckets.bucket_ts
  order by buckets.bucket_ts;
end;
$$;

-- -----------------------------------------------------------------------------
-- The same correction on the customer summary
-- -----------------------------------------------------------------------------

create or replace function public.customer_financial_summary(p_customer_id uuid)
returns table (
  currency            public.currency_code,
  rental_count        bigint,
  charged_minor       bigint,
  paid_minor          bigint,
  outstanding_minor   bigint,
  deposits_held_minor bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select c.organization_id into v_organization_id
  from public.customers c
  where c.id = p_customer_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  return query
  select
    r.currency,
    count(*),
    coalesce(sum(r.total_minor), 0)::bigint,
    coalesce(sum(r.amount_paid_minor), 0)::bigint,
    coalesce(sum(r.balance_due_minor) filter (
      where r.balance_due_minor > 0 and r.status in ('reserved', 'active', 'completed')
    ), 0)::bigint,
    coalesce(sum(r.deposit_held_minor), 0)::bigint
  from public.rentals r
  where r.customer_id = p_customer_id
    and r.status <> 'draft'
  group by r.currency
  order by r.currency;
end;
$$;

-- -----------------------------------------------------------------------------
-- What references a rental — the cancel-versus-delete decision
-- -----------------------------------------------------------------------------

create or replace function public.rental_usage(p_rental_id uuid)
returns table (
  line_item_count   bigint,
  payment_count     bigint,
  contract_count    bigint,
  photo_count       bigint,
  driver_count      bigint,
  can_delete        boolean
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_status public.rental_status;
begin
  select r.organization_id, r.status into v_organization_id, v_status
  from public.rentals r
  where r.id = p_rental_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;

  return query
  with counts as (
    select
      (select count(*) from public.rental_line_items l where l.rental_id = p_rental_id) as line_items,
      (select count(*) from public.payments p where p.rental_id = p_rental_id)          as payments,
      (select count(*) from public.rental_contracts rc where rc.rental_id = p_rental_id) as contracts,
      (select count(*) from public.rental_condition_photos ph where ph.rental_id = p_rental_id) as photos,
      (select count(*) from public.rental_drivers rd where rd.rental_id = p_rental_id)  as drivers
  )
  select
    counts.line_items,
    counts.payments,
    counts.contracts,
    counts.photos,
    counts.drivers,
    -- Only an untouched draft. Once money has moved or a contract has been
    -- issued, the record is history and cancellation is the honest answer.
    (v_status = 'draft' and counts.payments = 0 and counts.contracts = 0)
  from counts;
end;
$$;

revoke all on function public.rental_usage(uuid) from public, anon;
grant execute on function public.rental_usage(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

do $$
declare
  v_reachable text;
begin
  select string_agg(p.proname, ', ' order by p.proname)
    into v_reachable
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_reachable is not null then
    raise exception 'The anonymous role can execute these public functions: %.', v_reachable;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
