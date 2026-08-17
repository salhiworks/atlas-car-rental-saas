-- =============================================================================
-- 20260813090800_analytics.sql
--
-- Read models for the Overview dashboard.
--
-- Both functions are SECURITY INVOKER (the default) on purpose: they run under
-- the caller's privileges, so RLS applies to every table they touch and the
-- tenant boundary is enforced by the same policies as any other query. The
-- explicit membership assertion on top turns a would-be empty result for a
-- non-member into an unambiguous error.
--
-- On mixed currencies: an agency may hold records in more than one currency,
-- and this schema has no exchange-rate source. Summing across currencies would
-- produce a confident, wrong number. These functions therefore aggregate only
-- records denominated in the agency's default currency and report how many
-- records were excluded, so the interface can say so plainly.
-- =============================================================================

set search_path = public, extensions, pg_temp;

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

  -- Expenses are calendar-dated; resolve the window in the agency's own zone so
  -- "this month" means what the agency means by it.
  v_from_date := (p_from at time zone v_time_zone)::date;
  v_to_date   := (p_to   at time zone v_time_zone)::date;

  return query
  with fleet as (
    select
      count(*)                                            as total,
      count(*) filter (where v.status = 'available')      as available,
      count(*) filter (where v.status = 'rented')         as rented,
      count(*) filter (where v.status = 'reserved')       as reserved,
      count(*) filter (where v.status = 'maintenance')    as maintenance,
      count(*) filter (where v.status = 'unavailable')    as unavailable
    from public.vehicles v
    where v.organization_id = p_organization_id
      and v.archived_at is null
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
      -- sum() over bigint yields numeric; the declared result columns are
      -- bigint, so every aggregate is cast back explicitly.
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

comment on function public.organization_overview(uuid, timestamptz, timestamptz) is
  'Dashboard aggregates for one agency over a period. Financial figures cover the agency default currency only; excluded_currency_records reports what was left out.';

-- -----------------------------------------------------------------------------
-- Time series behind the revenue / expenses chart.
--
-- Buckets are generated for the whole window, so a period with no activity
-- returns real zero-valued buckets rather than a gap the client has to invent.
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

comment on function public.organization_financial_series(uuid, date, date, text) is
  'Revenue and expense totals bucketed by day, week or month, in the agency default currency.';

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

revoke all on function public.organization_overview(uuid, timestamptz, timestamptz) from public;
grant execute on function public.organization_overview(uuid, timestamptz, timestamptz) to authenticated;

revoke all on function public.organization_financial_series(uuid, date, date, text) from public;
grant execute on function public.organization_financial_series(uuid, date, date, text) to authenticated;
