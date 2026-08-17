-- =============================================================================
-- 20260817100100_expense_read_models.sql
--
-- What the money questions are answered from.
--
-- THREE RULES HOLD EVERYWHERE IN THIS FILE
--
--   1. A VOIDED COST COUNTS NOWHERE. Not in a total, not in a breakdown, not in
--      a vehicle's contribution. It stays visible as history and contributes to
--      nothing.
--
--   2. CURRENCIES ARE NEVER ADDED TOGETHER. Every figure is per currency, or it
--      is the agency's own currency with the excluded records counted and
--      reported. No rate is invented anywhere in this product.
--
--   3. ONE COST CONTRIBUTES ONCE. A cost attached to a hire belongs to that
--      hire's vehicle *through the hire*, never separately, because the schema
--      does not let it carry a vehicle of its own.
--
-- AND ONE MORE, ABOUT A WORD
--
-- The dashboard used to say "Profit". It was revenue less expenses at a time
-- when expenses were barely recordable; now that they are real, the word is
-- still wrong, because vehicle financing is not in the figure and neither is
-- depreciation. It is renamed to an operating result, which is what the
-- arithmetic actually supports.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- The ledger
--
-- One row per cost with the names a list has to show, so a page of fifty costs
-- is one request rather than fifty for categories and fifty more for vendors.
--
-- A rental cost reads its vehicle through the contract. That is the only place
-- the relationship exists, which is what makes it impossible for the two to
-- disagree.
-- -----------------------------------------------------------------------------

create or replace view public.expense_ledger
with (security_invoker = true) as
select
  e.id,
  e.organization_id,
  e.incurred_on,
  e.description,
  e.amount_minor,
  e.tax_amount_minor,
  (e.amount_minor - e.tax_amount_minor) as net_amount_minor,
  e.tax_rate_bps,
  e.tax_label,
  e.currency,
  e.status,
  e.source,
  e.allocation,
  e.payment_method,
  e.reference,
  e.notes,
  e.odometer,

  e.category_id,
  c.name        as category_name,
  c.system_key  as category_system_key,
  (c.archived_at is not null) as category_archived,

  e.vendor_id,
  v.name as vendor_name,
  (v.archived_at is not null) as vendor_archived,

  -- The vehicle this cost belongs to: named directly for a vehicle cost, read
  -- through the contract for a rental cost, absent for overhead.
  coalesce(e.vehicle_id, r.vehicle_id) as effective_vehicle_id,
  coalesce(direct_vehicle.registration_plate, rental_vehicle.registration_plate) as vehicle_plate,
  coalesce(direct_vehicle.make, rental_vehicle.make) as vehicle_make,
  coalesce(direct_vehicle.model, rental_vehicle.model) as vehicle_model,
  (coalesce(direct_vehicle.archived_at, rental_vehicle.archived_at) is not null) as vehicle_archived,

  e.rental_id,
  r.reference as rental_reference,

  attachments.total as attachment_count,

  e.voided_at,
  e.void_reason,
  e.created_by,
  e.created_at,
  e.updated_by,
  e.updated_at
from public.expenses e
join public.expense_categories c on c.id = e.category_id
left join public.expense_vendors v on v.id = e.vendor_id
left join public.rentals r on r.id = e.rental_id
left join public.vehicles direct_vehicle on direct_vehicle.id = e.vehicle_id
left join public.vehicles rental_vehicle on rental_vehicle.id = r.vehicle_id
left join lateral (
  select count(*) as total
  from public.expense_attachments a
  where a.expense_id = e.id
) attachments on true;

comment on view public.expense_ledger is
  'One row per cost with its category, vendor, vehicle and contract already resolved. A rental cost reads its vehicle through the contract, so the two can never disagree. security_invoker, so RLS applies to every source table.';

revoke all on public.expense_ledger from anon, authenticated;
grant select on public.expense_ledger to authenticated;

-- -----------------------------------------------------------------------------
-- What the agency spent, by currency
--
-- Returns a row per currency rather than one total. An agency that buys tyres
-- in euros and fuel in dirhams has two facts, not one, and adding them would
-- require a rate this product deliberately does not have.
-- -----------------------------------------------------------------------------

create or replace function public.organization_expense_summary(
  p_organization_id uuid,
  p_from date,
  p_to   date
)
returns table (
  currency          public.currency_code,
  total_minor       bigint,
  overhead_minor    bigint,
  vehicle_minor     bigint,
  rental_minor      bigint,
  tax_minor         bigint,
  expense_count     bigint,
  voided_count      bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  if p_to <= p_from then
    raise exception 'The reporting period must end after it starts.' using errcode = '22023';
  end if;

  return query
  select
    e.currency,
    coalesce(sum(e.amount_minor) filter (where e.status = 'recorded'), 0)::bigint,
    coalesce(sum(e.amount_minor) filter (where e.status = 'recorded' and e.allocation = 'overhead'), 0)::bigint,
    coalesce(sum(e.amount_minor) filter (where e.status = 'recorded' and e.allocation = 'vehicle'), 0)::bigint,
    coalesce(sum(e.amount_minor) filter (where e.status = 'recorded' and e.allocation = 'rental'), 0)::bigint,
    coalesce(sum(e.tax_amount_minor) filter (where e.status = 'recorded'), 0)::bigint,
    count(*) filter (where e.status = 'recorded'),
    count(*) filter (where e.status = 'voided')
  from public.expenses e
  where e.organization_id = p_organization_id
    -- The business date, never the day the receipt was typed in.
    and e.incurred_on >= p_from
    and e.incurred_on <  p_to
  group by e.currency
  order by e.currency;
end;
$$;

comment on function public.organization_expense_summary(uuid, date, date) is
  'Spend for a period, split by allocation, one row per currency. Voided costs are counted separately and included in no total.';

-- -----------------------------------------------------------------------------
-- Where the money went
--
-- Percentages are the caller's business and are only meaningful inside one
-- currency, so this returns amounts per category per currency and lets the
-- interface divide within a currency it has chosen.
-- -----------------------------------------------------------------------------

create or replace function public.expense_category_breakdown(
  p_organization_id uuid,
  p_from date,
  p_to   date
)
returns table (
  category_id   uuid,
  category_name text,
  currency      public.currency_code,
  total_minor   bigint,
  expense_count bigint
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
  select c.id, c.name, e.currency,
         coalesce(sum(e.amount_minor), 0)::bigint,
         count(*)
  from public.expenses e
  join public.expense_categories c on c.id = e.category_id
  where e.organization_id = p_organization_id
    and e.status = 'recorded'
    and e.incurred_on >= p_from
    and e.incurred_on <  p_to
  group by c.id, c.name, e.currency
  order by 4 desc, c.name;
end;
$$;

-- -----------------------------------------------------------------------------
-- A vehicle's operating economics
--
-- Revenue attributable to the car, less the costs that genuinely belong to it,
-- for one currency at a time.
--
-- WHAT IS DELIBERATELY NOT IN IT
--
--   Agency overhead. Dividing the office rent across the fleet would require an
--   allocation rule nobody has agreed to, and inventing one would make every
--   vehicle look worse by an arbitrary amount.
--
--   Financing. The Financing module does not exist yet; a figure that silently
--   omitted the loan on the car would be worse than one that says so.
--
--   Depreciation. Not modelled anywhere in this product.
--
-- Which is why the result is called an operating contribution and not a profit.
-- -----------------------------------------------------------------------------

create or replace function public.vehicle_operating_summary(
  p_vehicle_id uuid,
  p_from date,
  p_to   date
)
returns table (
  currency                    public.currency_code,
  rental_revenue_minor        bigint,
  direct_expense_minor        bigint,
  vehicle_expense_minor       bigint,
  rental_expense_minor        bigint,
  operating_contribution_minor bigint,
  rental_count                bigint,
  expense_count               bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_time_zone       text;
  v_from_ts         timestamptz;
  v_to_ts           timestamptz;
begin
  select v.organization_id into v_organization_id
  from public.vehicles v
  where v.id = p_vehicle_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Vehicle not found.' using errcode = 'P0002';
  end if;

  select o.time_zone into v_time_zone
  from public.organizations o
  where o.id = v_organization_id;

  -- Revenue is timestamped; costs are dated. The period is resolved in the
  -- agency's own zone so both halves mean the same days.
  v_from_ts := (p_from::timestamp) at time zone coalesce(v_time_zone, 'UTC');
  v_to_ts   := (p_to::timestamp)   at time zone coalesce(v_time_zone, 'UTC');

  return query
  with revenue as (
    -- Only money for the hire itself: a deposit is the customer's, and a voided
    -- payment never happened.
    select p.currency, coalesce(sum(
             case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
           ), 0)::bigint as amount,
           count(distinct p.rental_id) as rentals
    from public.payments p
    join public.rentals r on r.id = p.rental_id
    where r.vehicle_id = p_vehicle_id
      and p.purpose = 'rental_charge'
      and p.voided_at is null
      and p.paid_at >= v_from_ts
      and p.paid_at <  v_to_ts
    group by p.currency
  ),
  costs as (
    -- Both kinds of direct cost in one pass over one table, so a cost cannot be
    -- picked up twice: `allocation` is a single value per row, and a rental
    -- cost carries no vehicle of its own to be counted under.
    select e.currency,
           coalesce(sum(e.amount_minor) filter (where e.allocation = 'vehicle'), 0)::bigint as vehicle_amount,
           coalesce(sum(e.amount_minor) filter (where e.allocation = 'rental'), 0)::bigint as rental_amount,
           count(*) as expenses
    from public.expenses e
    left join public.rentals r on r.id = e.rental_id
    where e.status = 'recorded'
      -- Reserved for the Financing module; excluded by construction rather than
      -- by hoping nobody names a category "loan".
      and e.financing_plan_id is null
      and e.incurred_on >= p_from
      and e.incurred_on <  p_to
      and (
        (e.allocation = 'vehicle' and e.vehicle_id = p_vehicle_id)
        or (e.allocation = 'rental' and r.vehicle_id = p_vehicle_id)
      )
    group by e.currency
  )
  select
    coalesce(revenue.currency, costs.currency),
    coalesce(revenue.amount, 0)::bigint,
    (coalesce(costs.vehicle_amount, 0) + coalesce(costs.rental_amount, 0))::bigint,
    coalesce(costs.vehicle_amount, 0)::bigint,
    coalesce(costs.rental_amount, 0)::bigint,
    (coalesce(revenue.amount, 0)
      - coalesce(costs.vehicle_amount, 0)
      - coalesce(costs.rental_amount, 0))::bigint,
    coalesce(revenue.rentals, 0),
    coalesce(costs.expenses, 0)
  from revenue
  full outer join costs on costs.currency = revenue.currency
  order by 1;
end;
$$;

comment on function public.vehicle_operating_summary(uuid, date, date) is
  'Rental revenue less the costs directly attributable to one vehicle, per currency. Excludes agency overhead, financing and depreciation — which is why it is a contribution and not a profit.';

-- -----------------------------------------------------------------------------
-- What a hire cost the agency
--
-- Kept firmly apart from what the customer was charged. A cleaning cost of
-- forty euros is money the agency spent; whether the renter pays for it is a
-- separate decision, taken by adding a line item to their contract.
-- -----------------------------------------------------------------------------

create or replace function public.rental_expense_summary(p_rental_id uuid)
returns table (
  currency      public.currency_code,
  total_minor   bigint,
  expense_count bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select r.organization_id into v_organization_id
  from public.rentals r
  where r.id = p_rental_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;

  return query
  select e.currency, coalesce(sum(e.amount_minor), 0)::bigint, count(*)
  from public.expenses e
  where e.rental_id = p_rental_id
    and e.status = 'recorded'
  group by e.currency
  order by e.currency;
end;
$$;

-- -----------------------------------------------------------------------------
-- Voiding
--
-- One transaction, one authority, and the reason recorded with the correction.
-- SECURITY INVOKER, so the role policies apply to the caller exactly as they
-- would to a direct write.
-- -----------------------------------------------------------------------------

create or replace function public.expense_void(p_expense_id uuid, p_reason text default null)
returns public.expenses
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expense public.expenses;
begin
  select * into v_expense from public.expenses where id = p_expense_id for update;

  if v_expense.id is null then
    raise exception 'Expense not found.' using errcode = 'P0002';
  end if;
  if v_expense.status = 'voided' then
    raise exception 'That expense has already been voided.' using errcode = '23514';
  end if;

  update public.expenses
     set status = 'voided',
         voided_at = now(),
         voided_by = (select auth.uid()),
         void_reason = p_reason,
         updated_by = (select auth.uid())
   where id = p_expense_id
  returning * into v_expense;

  return v_expense;
end;
$$;

comment on function public.expense_void(uuid, text) is
  'Reverses a cost without destroying it. The row stays visible with its reason and counts towards nothing.';

-- -----------------------------------------------------------------------------
-- Costs that look like the same receipt twice
--
-- Warns, never blocks. Agencies legitimately buy the same thing twice on the
-- same day from the same supplier, and refusing that would be worse than
-- letting a duplicate through with a question attached.
-- -----------------------------------------------------------------------------

create or replace function public.find_duplicate_expenses(
  p_organization_id uuid,
  p_vendor_id uuid default null,
  p_reference text default null,
  p_amount_minor bigint default null,
  p_currency text default null,
  p_incurred_on date default null,
  p_exclude_expense_id uuid default null
)
returns table (
  expense_id   uuid,
  incurred_on  date,
  description  text,
  amount_minor bigint,
  currency     public.currency_code,
  vendor_name  text,
  match_reason text,
  match_strength text
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
  with candidates as (
    -- The same document number from the same supplier is very nearly decisive.
    select e.id, e.incurred_on, e.description, e.amount_minor, e.currency, v.name,
           'Same invoice number from the same supplier' as reason,
           'strong' as strength
    from public.expenses e
    left join public.expense_vendors v on v.id = e.vendor_id
    where e.organization_id = p_organization_id
      and e.status = 'recorded'
      and p_reference is not null and btrim(p_reference) <> ''
      and upper(btrim(e.reference)) = upper(btrim(p_reference))
      and p_vendor_id is not null
      and e.vendor_id = p_vendor_id

    union all

    -- Same supplier, same day, same amount: worth a second look, not a refusal.
    select e.id, e.incurred_on, e.description, e.amount_minor, e.currency, v.name,
           'Same supplier, date and amount', 'weak'
    from public.expenses e
    left join public.expense_vendors v on v.id = e.vendor_id
    where e.organization_id = p_organization_id
      and e.status = 'recorded'
      and p_vendor_id is not null and e.vendor_id = p_vendor_id
      and p_incurred_on is not null and e.incurred_on = p_incurred_on
      and p_amount_minor is not null and e.amount_minor = p_amount_minor
      and p_currency is not null and e.currency = p_currency::public.currency_code
  )
  select candidates.id, candidates.incurred_on, candidates.description,
         candidates.amount_minor, candidates.currency, candidates.name,
         string_agg(distinct candidates.reason, ', '),
         case when bool_or(candidates.strength = 'strong') then 'strong' else 'weak' end
  from candidates
  where p_exclude_expense_id is null or candidates.id <> p_exclude_expense_id
  group by 1, 2, 3, 4, 5, 6
  order by 2 desc
  limit 10;
end;
$$;

-- -----------------------------------------------------------------------------
-- The dashboard, corrected
--
-- Two changes: voided costs stop counting, and the profit column becomes an
-- operating result. The column keeps its name so nothing downstream breaks —
-- the honesty belongs in what the interface calls it, which is changed to match.
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

-- -----------------------------------------------------------------------------
-- The series behind the chart, on the same definition
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
      -- Bucketed on the business date. A receipt typed in August for a cost
      -- incurred in July belongs to July.
      date_trunc(p_granularity, e.incurred_on::timestamp) as bucket_ts,
      sum(e.amount_minor) as amount_minor
    from public.expenses e
    where e.organization_id = p_organization_id
      and e.currency = v_currency
      and e.status = 'recorded'
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
-- What references an expense, and what references a category or vendor
-- -----------------------------------------------------------------------------

create or replace function public.expense_category_usage(p_category_id uuid)
returns table (expense_count bigint, can_delete boolean)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select c.organization_id into v_organization_id
  from public.expense_categories c
  where c.id = p_category_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Category not found.' using errcode = 'P0002';
  end if;

  return query
  select count(*), count(*) = 0
  from public.expenses e
  where e.category_id = p_category_id;
end;
$$;

create or replace function public.expense_vendor_usage(p_vendor_id uuid)
returns table (expense_count bigint, can_delete boolean)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select v.organization_id into v_organization_id
  from public.expense_vendors v
  where v.id = p_vendor_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Vendor not found.' using errcode = 'P0002';
  end if;

  return query
  select count(*), count(*) = 0
  from public.expenses e
  where e.vendor_id = p_vendor_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges — authenticated only, never anon
-- -----------------------------------------------------------------------------

revoke all on function public.organization_expense_summary(uuid, date, date) from public, anon;
revoke all on function public.expense_category_breakdown(uuid, date, date) from public, anon;
revoke all on function public.vehicle_operating_summary(uuid, date, date) from public, anon;
revoke all on function public.rental_expense_summary(uuid) from public, anon;
revoke all on function public.expense_void(uuid, text) from public, anon;
revoke all on function public.find_duplicate_expenses(uuid, uuid, text, bigint, text, date, uuid) from public, anon;
revoke all on function public.expense_category_usage(uuid) from public, anon;
revoke all on function public.expense_vendor_usage(uuid) from public, anon;

grant execute on function public.organization_expense_summary(uuid, date, date) to authenticated;
grant execute on function public.expense_category_breakdown(uuid, date, date) to authenticated;
grant execute on function public.vehicle_operating_summary(uuid, date, date) to authenticated;
grant execute on function public.rental_expense_summary(uuid) to authenticated;
grant execute on function public.expense_void(uuid, text) to authenticated;
grant execute on function public.find_duplicate_expenses(uuid, uuid, text, bigint, text, date, uuid) to authenticated;
grant execute on function public.expense_category_usage(uuid) to authenticated;
grant execute on function public.expense_vendor_usage(uuid) to authenticated;

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
