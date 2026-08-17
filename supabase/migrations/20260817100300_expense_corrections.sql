-- =============================================================================
-- Expenses: four corrections found by reviewing the module against itself
--
-- 1. A voided cost made its agency undeletable. The guard that protects a
--    correction from being erased also blocked the cascade from
--    `delete from organizations`, so an agency that had ever voided one cost
--    could never be removed. The guard now refuses only while the agency it
--    belongs to still exists.
--
-- 2. The dashboard counted financing as an operating cost. `organization_overview`
--    documents profit_minor as "before financing and depreciation" and
--    `vehicle_operating_summary` excludes financed rows by construction — but
--    the dashboard did not, so the same instalment would be counted twice the
--    day the Financing module reports it. Both dashboard functions now apply
--    the same boundary.
--
-- 3. Who made a change could be forged. `changed_by` was taken from the row's
--    own `updated_by` column, which the client supplies. An immutable history
--    whose "who" can be dictated by the caller is not a history. The session's
--    own identity now wins; `updated_by` survives only as the fallback for a
--    server-side backfill running without a session.
--
-- 4. `app.seed_expense_categories` was executable by `authenticated`. It is
--    SECURITY DEFINER and takes an organization id with no membership check.
--    Nothing could reach it — the `app` schema is not exposed through
--    PostgREST — but a SECURITY DEFINER function with a tenant id parameter
--    should not carry a grant it does not need.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A voided cost must not outlive its agency
-- -----------------------------------------------------------------------------

create or replace function app.guard_expense_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Deleting the agency deletes its parent row first, so by the time the
  -- cascade reaches here the organization is already gone. That is a tenant
  -- being torn down, not somebody erasing an inconvenient correction.
  if old.status = 'voided'
     and exists (select 1 from public.organizations o where o.id = old.organization_id)
  then
    raise exception
      'A voided expense is the record of a correction and cannot be deleted.'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

comment on function app.guard_expense_delete() is
  'Keeps a voided cost for as long as the agency exists. Lets the tenant cascade take it when the agency itself is deleted.';

-- -----------------------------------------------------------------------------
-- 2. The dashboard reports the operating result it claims to report
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
      -- Gross recorded cost: the money that left the agency, tax included.
      coalesce(sum(e.amount_minor) filter (where e.currency = v_currency), 0)::bigint as total_minor,
      count(*) filter (where e.currency <> v_currency) as foreign_records
    from public.expenses e
    where e.organization_id = p_organization_id
      -- A voided cost never happened.
      and e.status = 'recorded'
      -- Financing is not an operating cost. Excluded here for the same reason
      -- it is excluded from a vehicle's contribution: once the Financing
      -- module reports instalments, counting them here too would count the
      -- same money twice.
      and e.financing_plan_id is null
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
  'Dashboard aggregates for one agency over a period. profit_minor is an operating result: rental revenue less recorded operating costs, before financing and depreciation. Voided records count nowhere; deposits are never revenue.';
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
      -- Bucketed on the business date. A receipt typed in August for a cost
      -- incurred in July belongs to July.
      date_trunc(p_granularity, e.incurred_on::timestamp) as bucket_ts,
      sum(e.amount_minor) as amount_minor
    from public.expenses e
    where e.organization_id = p_organization_id
      and e.currency = v_currency
      and e.status = 'recorded'
      -- The chart draws the same definition the tiles above it report.
      and e.financing_plan_id is null
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
-- 3. The history says who, and the client does not get a vote
-- -----------------------------------------------------------------------------

create or replace function app.record_expense_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_kind    public.expense_change_kind := 'correction';
begin
  if new.status = 'voided' and old.status <> 'voided' then
    v_kind := 'void';
    v_changes := jsonb_build_object(
      'status', jsonb_build_object('from', old.status::text, 'to', new.status::text)
    );
  else
    if new.amount_minor is distinct from old.amount_minor then
      v_changes := v_changes || jsonb_build_object(
        'amount_minor', jsonb_build_object('from', old.amount_minor, 'to', new.amount_minor));
    end if;
    if new.tax_amount_minor is distinct from old.tax_amount_minor then
      v_changes := v_changes || jsonb_build_object(
        'tax_amount_minor', jsonb_build_object('from', old.tax_amount_minor, 'to', new.tax_amount_minor));
    end if;
    if new.currency is distinct from old.currency then
      v_changes := v_changes || jsonb_build_object(
        'currency', jsonb_build_object('from', old.currency, 'to', new.currency));
    end if;
    if new.incurred_on is distinct from old.incurred_on then
      v_changes := v_changes || jsonb_build_object(
        'incurred_on', jsonb_build_object('from', old.incurred_on, 'to', new.incurred_on));
    end if;
    if new.allocation is distinct from old.allocation then
      v_changes := v_changes || jsonb_build_object(
        'allocation', jsonb_build_object('from', old.allocation::text, 'to', new.allocation::text));
    end if;
    if new.vehicle_id is distinct from old.vehicle_id then
      v_changes := v_changes || jsonb_build_object(
        'vehicle_id', jsonb_build_object('from', old.vehicle_id, 'to', new.vehicle_id));
    end if;
    if new.rental_id is distinct from old.rental_id then
      v_changes := v_changes || jsonb_build_object(
        'rental_id', jsonb_build_object('from', old.rental_id, 'to', new.rental_id));
    end if;
    if new.category_id is distinct from old.category_id then
      v_changes := v_changes || jsonb_build_object(
        'category_id', jsonb_build_object('from', old.category_id, 'to', new.category_id));
    end if;
    if new.vendor_id is distinct from old.vendor_id then
      v_changes := v_changes || jsonb_build_object(
        'vendor_id', jsonb_build_object('from', old.vendor_id, 'to', new.vendor_id));
    end if;
  end if;

  -- Nothing material moved, so there is nothing worth recording.
  if v_changes = '{}'::jsonb then
    return null;
  end if;

  insert into public.expense_change_events
    (organization_id, expense_id, kind, changes, changed_by, reason)
  values (
    new.organization_id,
    new.id,
    v_kind,
    v_changes,
    -- The session's own identity first. `updated_by` is a column the client
    -- writes, so trusting it would let one person file a correction under
    -- somebody else's name.
    coalesce((select auth.uid()), new.updated_by),
    case when v_kind = 'void' then new.void_reason else null end
  );

  return null;
end;
$$;

comment on function app.record_expense_change() is
  'Writes one immutable change event per material edit. Attribution comes from the session, never from a column the caller supplies.';

-- -----------------------------------------------------------------------------
-- 4. A definer function keeps only the grants it needs
-- -----------------------------------------------------------------------------

revoke all on function app.seed_expense_categories(uuid) from public, anon, authenticated;

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
  if has_function_privilege('authenticated', 'app.seed_expense_categories(uuid)', 'EXECUTE') then
    raise exception 'authenticated still holds EXECUTE on app.seed_expense_categories';
  end if;
end
$$;

do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ') into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if v_missing is not null then
    raise exception 'tables without row level security: %', v_missing;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
