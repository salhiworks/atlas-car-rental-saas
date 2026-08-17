-- =============================================================================
-- 20260820100000_report_read_models.sql
--
-- Reports & Fleet Analytics: the read layer.
--
-- NOTHING HERE IS A SECOND SOURCE OF TRUTH. Every figure below is composed from
-- the same tables, with the same predicates, that the owning module already
-- uses. Where an existing function answers the question, Reports calls it. These
-- functions exist for two reasons only:
--
--   1. SCALE. `vehicle_operating_summary` is per-vehicle and returns nothing at
--      all for a vehicle with no activity. A fleet report over three hundred
--      cars cannot be three hundred round trips, and a car that earned nothing
--      is exactly the row a manager opened the report to find.
--
--   2. CURRENCY. `organization_overview` is locked to the agency's default
--      currency and reports a single count of what it left out. A reporting
--      workspace has to be able to look at each currency it actually holds, so
--      these return ONE ROW PER CURRENCY and never a total across them.
--
-- THE PREDICATES ARE COPIED, NOT REINVENTED. Three of them decide almost every
-- number in this file, and each is quoted from its owner:
--
--   revenue   payments where purpose = 'rental_charge' and voided_at is null,
--             signed by `direction`, bucketed on paid_at
--             (organization_overview, 20260817100300:160-175)
--   cost      expenses where status = 'recorded' and financing_plan_id is null,
--             dated by incurred_on
--             (organization_overview, 20260817100300:183-191)
--   financing financing_payments where status = 'recorded', dated by paid_on;
--             cost is interest + fees, never principal, never unallocated
--             (organization_financing_summary, 20260818100100:663-774)
--
-- PERIOD vs POSITION. A period figure is a flow through a window; a position is
-- a balance right now. Outstanding receivables, deposits held and remaining
-- principal are positions and are NOT date-filtered — a date picker on the page
-- does not make "money customers owe us" a monthly quantity. They live in their
-- own function so the distinction survives the interface.
--
-- Every function is SECURITY INVOKER, so row-level security applies to each
-- table it touches. The membership assertion on top turns what would otherwise
-- be an empty result for a non-member into an unambiguous refusal, and gives a
-- staff member and a stranger the same answer.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- The guard, written once
--
-- `reports.view` is a manager's permission, so every report asserts the same
-- floor. A staff member and somebody from another agency get an identical
-- message on purpose: the second must not be able to learn that an organization
-- exists by comparing error text.
-- -----------------------------------------------------------------------------

create or replace function app.assert_report_access(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_organization_id is null then
    raise exception 'An organization is required.' using errcode = '22004';
  end if;

  if not app.has_min_role(p_organization_id, 'manager') then
    raise exception 'Not permitted to view reports for this organization.'
      using errcode = '42501';
  end if;
end;
$$;

comment on function app.assert_report_access(uuid) is
  'The single authorization gate for every report read model. Manager and above.';

revoke all on function app.assert_report_access(uuid) from public;
grant execute on function app.assert_report_access(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Period plumbing, written once
--
-- Revenue is timestamped and costs are dated, so a report window has to be
-- expressed on both axes. Resolving the instants in the agency's own zone is
-- what makes "July" mean the agency's July on both halves; a UTC-derived
-- boundary moves money between months for every agency that is not in UTC.
-- -----------------------------------------------------------------------------

create or replace function app.report_window(
  p_organization_id uuid,
  p_from date,
  p_to   date,
  out currency  public.currency_code,
  out time_zone text,
  out from_ts   timestamptz,
  out to_ts     timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_to <= p_from then
    raise exception 'The reporting period must end after it starts.' using errcode = '22023';
  end if;

  select o.default_currency, o.time_zone
    into currency, time_zone
  from public.organizations o
  where o.id = p_organization_id;

  if currency is null then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;

  from_ts := (p_from::timestamp) at time zone coalesce(time_zone, 'UTC');
  to_ts   := (p_to::timestamp)   at time zone coalesce(time_zone, 'UTC');
end;
$$;

comment on function app.report_window(uuid, date, date) is
  'Resolves a report period into the agency time zone and returns its currency. Half-open [from, to).';

revoke all on function app.report_window(uuid, date, date) from public;
grant execute on function app.report_window(uuid, date, date) to authenticated, service_role;

-- =============================================================================
-- 1. Business performance — period flows, one row per currency
-- =============================================================================

create or replace function public.report_business_summary(
  p_organization_id uuid,
  p_from date,
  p_to   date
)
returns table (
  currency                     public.currency_code,
  is_default_currency          boolean,
  -- Rental revenue: cash received against the hire itself, net of refunds.
  rental_revenue_minor         bigint,
  rental_charges_in_minor      bigint,
  rental_refunds_out_minor     bigint,
  -- Deposit movement, reported apart from revenue because it is the customer's
  -- money passing through. Never added to anything above.
  deposit_in_minor             bigint,
  deposit_out_minor            bigint,
  -- Operating cost, gross. The tax inside it is shown, never added to it.
  operating_expense_minor      bigint,
  operating_expense_tax_minor  bigint,
  operating_result_minor       bigint,
  -- Financing cash and its knowable cost. Principal is neither.
  financing_cash_paid_minor    bigint,
  financing_principal_minor    bigint,
  financing_cost_minor         bigint,
  financing_unallocated_minor  bigint,
  financing_cost_complete      boolean,
  after_financing_minor        bigint,
  rental_payment_count         bigint,
  expense_count                bigint,
  financing_payment_count      bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_default  public.currency_code;
  v_zone     text;
  v_from_ts  timestamptz;
  v_to_ts    timestamptz;
begin
  perform app.assert_report_access(p_organization_id);
  select w.currency, w.time_zone, w.from_ts, w.to_ts
    into v_default, v_zone, v_from_ts, v_to_ts
  from app.report_window(p_organization_id, p_from, p_to) w;

  return query
  with rental_cash as (
    /*
     * The revenue predicate, verbatim from organization_overview: only money
     * for the hire itself, only payments that were not voided, and the sign
     * carried by `direction` because `amount_minor` is constrained positive.
     *
     * No rental-status filter, deliberately. A payment taken on a booking that
     * was later cancelled was still money received that day, and cancellation
     * is financially inert in this product.
     */
    select
      p.currency as cur,
      coalesce(sum(p.amount_minor) filter (
        where p.purpose = 'rental_charge' and p.direction = 'inbound'), 0)::bigint as charges_in,
      coalesce(sum(p.amount_minor) filter (
        where p.purpose = 'rental_charge' and p.direction = 'outbound'), 0)::bigint as refunds_out,
      coalesce(sum(p.amount_minor) filter (
        where p.purpose = 'deposit' and p.direction = 'inbound'), 0)::bigint as deposit_in,
      coalesce(sum(p.amount_minor) filter (
        where p.purpose = 'deposit' and p.direction = 'outbound'), 0)::bigint as deposit_out,
      count(*) filter (where p.purpose = 'rental_charge')::bigint as payment_count
    from public.payments p
    where p.organization_id = p_organization_id
      and p.voided_at is null
      and p.paid_at >= v_from_ts
      and p.paid_at <  v_to_ts
    group by p.currency
  ),
  operating_cost as (
    -- A voided cost never happened; financing is not an operating cost.
    select
      e.currency as cur,
      coalesce(sum(e.amount_minor), 0)::bigint     as gross,
      coalesce(sum(e.tax_amount_minor), 0)::bigint as tax,
      count(*)::bigint                              as expense_count
    from public.expenses e
    where e.organization_id = p_organization_id
      and e.status = 'recorded'
      and e.financing_plan_id is null
      and e.incurred_on >= p_from
      and e.incurred_on <  p_to
    group by e.currency
  ),
  financing_cash as (
    /*
     * Cash is the whole payment. Cost is interest and fees alone — principal
     * repayment converts one balance into another and is not a cost of
     * anything, and unallocated money is money nobody has said the composition
     * of, which is not the same as money that cost nothing.
     */
    select
      fp.currency as cur,
      coalesce(sum(fp.amount_minor), 0)::bigint      as cash,
      coalesce(sum(fp.principal_minor), 0)::bigint   as principal,
      coalesce(sum(fp.interest_minor + fp.fees_minor), 0)::bigint as cost,
      coalesce(sum(fp.unallocated_minor), 0)::bigint as unallocated,
      count(*)::bigint                                as payment_count
    from public.financing_payments fp
    where fp.organization_id = p_organization_id
      and fp.status = 'recorded'
      and fp.paid_on >= p_from
      and fp.paid_on <  p_to
    group by fp.currency
  ),
  currencies as (
    select cur from rental_cash
    union
    select cur from operating_cost
    union
    select cur from financing_cash
  )
  select
    c.cur,
    c.cur = v_default,
    (coalesce(rc.charges_in, 0) - coalesce(rc.refunds_out, 0))::bigint,
    coalesce(rc.charges_in, 0)::bigint,
    coalesce(rc.refunds_out, 0)::bigint,
    coalesce(rc.deposit_in, 0)::bigint,
    coalesce(rc.deposit_out, 0)::bigint,
    coalesce(oc.gross, 0)::bigint,
    coalesce(oc.tax, 0)::bigint,
    (coalesce(rc.charges_in, 0) - coalesce(rc.refunds_out, 0) - coalesce(oc.gross, 0))::bigint,
    coalesce(fc.cash, 0)::bigint,
    coalesce(fc.principal, 0)::bigint,
    coalesce(fc.cost, 0)::bigint,
    coalesce(fc.unallocated, 0)::bigint,
    coalesce(fc.unallocated, 0) = 0,
    -- A management cash figure, not a profit: what the operating result leaves
    -- once the lender has been paid. Same currency on both halves by
    -- construction, because the whole row is one currency.
    (coalesce(rc.charges_in, 0) - coalesce(rc.refunds_out, 0)
       - coalesce(oc.gross, 0) - coalesce(fc.cash, 0))::bigint,
    coalesce(rc.payment_count, 0),
    coalesce(oc.expense_count, 0),
    coalesce(fc.payment_count, 0)
  from currencies c
  left join rental_cash    rc on rc.cur = c.cur
  left join operating_cost oc on oc.cur = c.cur
  left join financing_cash fc on fc.cur = c.cur
  order by (c.cur = v_default) desc, c.cur;
end;
$$;

comment on function public.report_business_summary(uuid, date, date) is
  'Period flows for one agency, one row per currency. Revenue is rental-charge cash net of refunds; deposits are reported separately and are never revenue; financing cash and financing cost are distinct.';

-- =============================================================================
-- 2. Current positions — no date filter, deliberately
-- =============================================================================

create or replace function public.report_position_summary(p_organization_id uuid)
returns table (
  currency                    public.currency_code,
  is_default_currency         boolean,
  computed_at                 timestamptz,
  outstanding_minor           bigint,
  outstanding_rental_count    bigint,
  deposits_held_minor         bigint,
  deposits_rental_count       bigint,
  remaining_principal_minor   bigint,
  principal_known_count       bigint,
  principal_unknown_count     bigint,
  financing_overdue_minor     bigint,
  financing_overdue_count     bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_default public.currency_code;
  v_today   date;
begin
  perform app.assert_report_access(p_organization_id);

  select o.default_currency, (now() at time zone coalesce(o.time_zone, 'UTC'))::date
    into v_default, v_today
  from public.organizations o
  where o.id = p_organization_id;

  if v_default is null then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;

  return query
  with receivables as (
    /*
     * The three filters are load-bearing together and are copied from
     * organization_overview and customer_financial_summary: a cancelled
     * booking's balance is not a receivable, and an overpayment is not netted
     * against what other customers owe.
     */
    select
      r.currency as cur,
      coalesce(sum(r.balance_due_minor), 0)::bigint as outstanding,
      count(*)::bigint                              as rentals
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.status in ('reserved', 'active', 'completed')
      and r.balance_due_minor > 0
    group by r.currency
  ),
  deposits as (
    /*
     * No status filter, matching the live definition. Money physically held is
     * money held whatever the contract's state, and the trigger behind
     * deposit_held_minor has already netted refunds and clamped at zero.
     */
    select
      r.currency as cur,
      coalesce(sum(r.deposit_held_minor), 0)::bigint as held,
      count(*)::bigint                                as rentals
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.deposit_held_minor > 0
    group by r.currency
  ),
  debt as (
    /*
     * Active agreements only, one row per agreement, from the overview view —
     * which is the only place a refinanced vehicle does not count twice.
     * A balance nobody can derive stays out of the sum and is counted instead,
     * because a NULL rendered as zero is a lie about money owed.
     */
    select
      o.currency as cur,
      coalesce(sum(o.remaining_principal_minor) filter (where o.principal_known), 0)::bigint as principal,
      count(*) filter (where o.principal_known)::bigint      as known,
      count(*) filter (where not o.principal_known)::bigint  as unknown
    from public.financing_agreement_overview o
    where o.organization_id = p_organization_id
      and o.agreement_status = 'active'
    group by o.currency
  ),
  arrears as (
    select
      s.currency as cur,
      coalesce(sum(s.outstanding_minor), 0)::bigint as overdue,
      count(*)::bigint                              as obligations
    from public.financing_installment_status s
    where s.organization_id = p_organization_id
      and s.agreement_status = 'active'
      and s.outstanding_minor > 0
      and s.due_on < v_today
    group by s.currency
  ),
  currencies as (
    select cur from receivables
    union select cur from deposits
    union select cur from debt
    union select cur from arrears
  )
  select
    c.cur,
    c.cur = v_default,
    now(),
    coalesce(rec.outstanding, 0)::bigint,
    coalesce(rec.rentals, 0),
    coalesce(dep.held, 0)::bigint,
    coalesce(dep.rentals, 0),
    dbt.principal,
    coalesce(dbt.known, 0),
    coalesce(dbt.unknown, 0),
    coalesce(arr.overdue, 0)::bigint,
    coalesce(arr.obligations, 0)
  from currencies c
  left join receivables rec on rec.cur = c.cur
  left join deposits    dep on dep.cur = c.cur
  left join debt        dbt on dbt.cur = c.cur
  left join arrears     arr on arr.cur = c.cur
  order by (c.cur = v_default) desc, c.cur;
end;
$$;

comment on function public.report_position_summary(uuid) is
  'Balances as at now, one row per currency: receivables, deposits held, remaining principal where derivable, and arrears. Deliberately not date-filtered — these are positions, not period flows.';

-- =============================================================================
-- 3. Trend — one currency, bucketed in the agency's own zone
-- =============================================================================

create or replace function public.report_financial_series(
  p_organization_id uuid,
  p_from            date,
  p_to              date,
  p_granularity     text,
  p_currency        public.currency_code
)
returns table (
  bucket_start            date,
  rental_revenue_minor    bigint,
  operating_expense_minor bigint,
  operating_result_minor  bigint,
  financing_cash_minor    bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_zone    text;
  v_step    interval;
  v_default public.currency_code;
begin
  perform app.assert_report_access(p_organization_id);

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

  select o.default_currency, o.time_zone into v_default, v_zone
  from public.organizations o where o.id = p_organization_id;

  if v_default is null then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;

  if p_currency is null then
    raise exception 'A currency is required. Reports never sum across currencies.'
      using errcode = '22004';
  end if;

  return query
  /*
   * Buckets are generated across the whole window so a quiet week returns a
   * real zero rather than a gap the chart has to invent. Zero here means "no
   * activity", which is a fact — it is never used to stand in for a figure
   * nobody knows.
   */
  with buckets as (
    select generate_series(
      date_trunc(p_granularity, p_from::timestamp),
      date_trunc(p_granularity, (p_to - 1)::timestamp),
      v_step
    ) as bucket_ts
  ),
  revenue as (
    select
      date_trunc(p_granularity, (p.paid_at at time zone coalesce(v_zone, 'UTC'))) as bucket_ts,
      sum(case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end) as amount
    from public.payments p
    where p.organization_id = p_organization_id
      and p.currency = p_currency
      and p.purpose = 'rental_charge'
      and p.voided_at is null
      and (p.paid_at at time zone coalesce(v_zone, 'UTC')) >= p_from::timestamp
      and (p.paid_at at time zone coalesce(v_zone, 'UTC')) <  p_to::timestamp
    group by 1
  ),
  spend as (
    select
      date_trunc(p_granularity, e.incurred_on::timestamp) as bucket_ts,
      sum(e.amount_minor) as amount
    from public.expenses e
    where e.organization_id = p_organization_id
      and e.currency = p_currency
      and e.status = 'recorded'
      and e.financing_plan_id is null
      and e.incurred_on >= p_from
      and e.incurred_on <  p_to
    group by 1
  ),
  lender as (
    select
      date_trunc(p_granularity, fp.paid_on::timestamp) as bucket_ts,
      sum(fp.amount_minor) as amount
    from public.financing_payments fp
    where fp.organization_id = p_organization_id
      and fp.currency = p_currency
      and fp.status = 'recorded'
      and fp.paid_on >= p_from
      and fp.paid_on <  p_to
    group by 1
  )
  select
    b.bucket_ts::date,
    coalesce(revenue.amount, 0)::bigint,
    coalesce(spend.amount, 0)::bigint,
    (coalesce(revenue.amount, 0) - coalesce(spend.amount, 0))::bigint,
    coalesce(lender.amount, 0)::bigint
  from buckets b
  left join revenue on revenue.bucket_ts = b.bucket_ts
  left join spend   on spend.bucket_ts   = b.bucket_ts
  left join lender  on lender.bucket_ts  = b.bucket_ts
  order by b.bucket_ts;
end;
$$;

comment on function public.report_financial_series(uuid, date, date, text, public.currency_code) is
  'Revenue, operating cost, operating result and financing cash bucketed over a period, for ONE currency. Buckets are resolved in the agency time zone and zero-filled.';

-- =============================================================================
-- 4. Fleet performance — one row per (vehicle, currency)
-- =============================================================================

create or replace function public.report_fleet_performance(
  p_organization_id uuid,
  p_from date,
  p_to   date
)
returns table (
  vehicle_id                   uuid,
  registration_plate           text,
  make                         text,
  model                        text,
  model_year                   smallint,
  archived_at                  timestamptz,
  acquired_on                  date,
  currency                     public.currency_code,
  rental_revenue_minor         bigint,
  vehicle_expense_minor        bigint,
  rental_expense_minor         bigint,
  direct_expense_minor         bigint,
  operating_contribution_minor bigint,
  currency_conflict            boolean,
  financing_cash_minor         bigint,
  financing_cost_minor         bigint,
  financing_cost_complete      boolean,
  after_financing_minor        bigint,
  hires_started                bigint,
  hires_completed              bigint,
  rented_days                  numeric,
  in_service_days              numeric,
  utilisation_bps              integer,
  distance_units               bigint,
  expense_count                bigint,
  outstanding_minor            bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_default public.currency_code;
  v_zone    text;
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
begin
  perform app.assert_report_access(p_organization_id);
  select w.currency, w.time_zone, w.from_ts, w.to_ts
    into v_default, v_zone, v_from_ts, v_to_ts
  from app.report_window(p_organization_id, p_from, p_to) w;

  return query
  with fleet as (
    /*
     * Every vehicle the agency has ever had, archived ones included. A car sold
     * in March still earned what it earned in February, and a fleet report that
     * quietly dropped it would show a February the agency cannot reconcile.
     */
    select
      v.id, v.registration_plate, v.make, v.model, v.model_year,
      v.archived_at, v.acquired_on,
      /*
       * The denominator: days the vehicle could have been on hire inside the
       * window. Bounded by acquisition and by archiving where those are known,
       * clamped at zero.
       *
       * It is NOT reduced by maintenance or off-road time. The schema keeps no
       * history of vehicle status — there is no status-change log anywhere —
       * so subtracting historical downtime would be inventing it. The metric is
       * therefore calendar availability, and the interface says so.
       */
      greatest(
        0,
        extract(epoch from (
          least(v_to_ts, coalesce(v.archived_at, v_to_ts))
          - greatest(
              v_from_ts,
              coalesce((v.acquired_on::timestamp) at time zone coalesce(v_zone, 'UTC'), v_from_ts)
            )
        )) / 86400.0
      )::numeric as service_days
    from public.vehicles v
    where v.organization_id = p_organization_id
  ),
  revenue as (
    -- The vehicle-revenue predicate, verbatim from vehicle_operating_summary.
    select r.vehicle_id as vid, p.currency as cur,
           coalesce(sum(
             case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
           ), 0)::bigint as amount
    from public.payments p
    join public.rentals r on r.id = p.rental_id
    where r.organization_id = p_organization_id
      and p.purpose = 'rental_charge'
      and p.voided_at is null
      and p.paid_at >= v_from_ts
      and p.paid_at <  v_to_ts
    group by r.vehicle_id, p.currency
  ),
  costs as (
    /*
     * Both kinds of direct cost in one pass over one table, so a cost cannot be
     * counted twice: `allocation` holds a single value per row, and a
     * rental-allocated cost carries no vehicle of its own to be found under.
     */
    select coalesce(e.vehicle_id, r.vehicle_id) as vid, e.currency as cur,
           coalesce(sum(e.amount_minor) filter (where e.allocation = 'vehicle'), 0)::bigint as vehicle_amount,
           coalesce(sum(e.amount_minor) filter (where e.allocation = 'rental'), 0)::bigint  as rental_amount,
           count(*)::bigint as expenses
    from public.expenses e
    left join public.rentals r on r.id = e.rental_id
    where e.organization_id = p_organization_id
      and e.status = 'recorded'
      and e.financing_plan_id is null
      and e.incurred_on >= p_from
      and e.incurred_on <  p_to
      and (
        (e.allocation = 'vehicle' and e.vehicle_id is not null)
        or (e.allocation = 'rental' and r.vehicle_id is not null)
      )
    group by coalesce(e.vehicle_id, r.vehicle_id), e.currency
  ),
  lender as (
    select a.vehicle_id as vid, fp.currency as cur,
           coalesce(sum(fp.amount_minor), 0)::bigint as cash,
           coalesce(sum(fp.interest_minor + fp.fees_minor), 0)::bigint as cost,
           coalesce(sum(fp.unallocated_minor), 0)::bigint as unallocated
    from public.financing_payments fp
    join public.financing_agreements a on a.id = fp.agreement_id
    where fp.organization_id = p_organization_id
      and fp.status = 'recorded'
      and fp.paid_on >= p_from
      and fp.paid_on <  p_to
    group by a.vehicle_id, fp.currency
  ),
  occupancy as (
    /*
     * Exact interval intersection, in one aggregate. A hire that begins before
     * the window and ends inside it contributes only the overlap; one that
     * spans the whole window contributes the whole window.
     *
     * `reserved`, `active` and `completed` are the states that commit a vehicle
     * — they are exactly the states the availability exclusion constraint
     * guards. A draft holds nothing and a cancellation released it.
     */
    select r.vehicle_id as vid,
           sum(
             extract(epoch from (
               least(r.ends_at, v_to_ts) - greatest(r.starts_at, v_from_ts)
             )) / 86400.0
           )::numeric as days
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.status in ('reserved', 'active', 'completed')
      and r.starts_at < v_to_ts
      and r.ends_at   > v_from_ts
    group by r.vehicle_id
  ),
  hires as (
    select v.id as vid,
           count(*) filter (
             where r.starts_at >= v_from_ts and r.starts_at < v_to_ts
               and r.status in ('reserved', 'active', 'completed')
           )::bigint as started,
           count(*) filter (
             where r.status = 'completed'
               and coalesce(r.completed_at, r.ends_at) >= v_from_ts
               and coalesce(r.completed_at, r.ends_at) <  v_to_ts
           )::bigint as completed,
           coalesce(sum(
             case
               when r.status = 'completed'
                 and coalesce(r.completed_at, r.ends_at) >= v_from_ts
                 and coalesce(r.completed_at, r.ends_at) <  v_to_ts
                 and r.return_odometer is not null
                 and r.pickup_odometer is not null
                 and r.return_odometer >= r.pickup_odometer
               then r.return_odometer - r.pickup_odometer
             end
           ), 0)::bigint as distance
    from public.vehicles v
    left join public.rentals r
      on r.vehicle_id = v.id and r.organization_id = p_organization_id
    where v.organization_id = p_organization_id
    group by v.id
  ),
  balances as (
    select r.vehicle_id as vid, r.currency as cur,
           coalesce(sum(r.balance_due_minor), 0)::bigint as outstanding
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.status in ('reserved', 'active', 'completed')
      and r.balance_due_minor > 0
    group by r.vehicle_id, r.currency
  ),
  pairs as (
    -- Every (vehicle, currency) that has any figure at all, plus one row per
    -- vehicle with none, so an idle car is visible rather than absent.
    select f.id as vid, x.cur
    from fleet f
    left join lateral (
      select cur from revenue  where revenue.vid  = f.id
      union select cur from costs    where costs.vid    = f.id
      union select cur from lender   where lender.vid   = f.id
      union select cur from balances where balances.vid = f.id
    ) x on true
  )
  select
    f.id,
    f.registration_plate,
    f.make,
    f.model,
    f.model_year,
    f.archived_at,
    f.acquired_on,
    coalesce(pr.cur, v_default),
    coalesce(rev.amount, 0)::bigint,
    coalesce(cst.vehicle_amount, 0)::bigint,
    coalesce(cst.rental_amount, 0)::bigint,
    (coalesce(cst.vehicle_amount, 0) + coalesce(cst.rental_amount, 0))::bigint,
    (coalesce(rev.amount, 0)
      - coalesce(cst.vehicle_amount, 0)
      - coalesce(cst.rental_amount, 0))::bigint,
    false,
    coalesce(len.cash, 0)::bigint,
    coalesce(len.cost, 0)::bigint,
    coalesce(len.unallocated, 0) = 0,
    (coalesce(rev.amount, 0)
      - coalesce(cst.vehicle_amount, 0)
      - coalesce(cst.rental_amount, 0)
      - coalesce(len.cash, 0))::bigint,
    coalesce(h.started, 0),
    coalesce(h.completed, 0),
    coalesce(occ.days, 0)::numeric,
    f.service_days,
    case
      when f.service_days > 0
        then round(least(coalesce(occ.days, 0) / f.service_days, 1) * 10000)::integer
    end,
    coalesce(h.distance, 0),
    coalesce(cst.expenses, 0),
    coalesce(bal.outstanding, 0)::bigint
  from pairs pr
  join fleet f on f.id = pr.vid
  left join revenue  rev on rev.vid = pr.vid and rev.cur is not distinct from pr.cur
  left join costs    cst on cst.vid = pr.vid and cst.cur is not distinct from pr.cur
  left join lender   len on len.vid = pr.vid and len.cur is not distinct from pr.cur
  left join balances bal on bal.vid = pr.vid and bal.cur is not distinct from pr.cur
  left join occupancy occ on occ.vid = pr.vid
  left join hires    h   on h.vid   = pr.vid
  order by f.registration_plate, coalesce(pr.cur, v_default);
end;
$$;

comment on function public.report_fleet_performance(uuid, date, date) is
  'Per-vehicle economics and occupancy over a period, one row per vehicle and currency. Contribution excludes overhead, financing and acquisition. Utilisation is calendar availability — the schema keeps no vehicle status history, so historical downtime is not subtracted.';

-- =============================================================================
-- 5. Utilisation over time
-- =============================================================================

create or replace function public.report_utilisation_series(
  p_organization_id uuid,
  p_from date,
  p_to   date,
  p_granularity text
)
returns table (
  bucket_start         date,
  vehicle_days_available numeric,
  vehicle_days_rented    numeric,
  hires_started          bigint,
  utilisation_bps        integer
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_zone text;
  v_step interval;
begin
  perform app.assert_report_access(p_organization_id);

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

  select o.time_zone into v_zone from public.organizations o where o.id = p_organization_id;
  if not found then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;

  return query
  with buckets as (
    select
      b.bucket_ts,
      (b.bucket_ts at time zone coalesce(v_zone, 'UTC')) as from_ts,
      (least(b.bucket_ts + v_step, p_to::timestamp) at time zone coalesce(v_zone, 'UTC')) as to_ts
    from generate_series(
      date_trunc(p_granularity, p_from::timestamp),
      date_trunc(p_granularity, (p_to - 1)::timestamp),
      v_step
    ) as b(bucket_ts)
  ),
  available as (
    select bk.bucket_ts,
           coalesce(sum(greatest(
             0,
             extract(epoch from (
               least(bk.to_ts, coalesce(v.archived_at, bk.to_ts))
               - greatest(
                   bk.from_ts,
                   coalesce((v.acquired_on::timestamp) at time zone coalesce(v_zone, 'UTC'), bk.from_ts)
                 )
             )) / 86400.0
           )), 0)::numeric as days
    from buckets bk
    left join public.vehicles v on v.organization_id = p_organization_id
    group by bk.bucket_ts
  ),
  rented as (
    select bk.bucket_ts,
           coalesce(sum(
             extract(epoch from (
               least(r.ends_at, bk.to_ts) - greatest(r.starts_at, bk.from_ts)
             )) / 86400.0
           ), 0)::numeric as days,
           count(*) filter (
             where r.starts_at >= bk.from_ts and r.starts_at < bk.to_ts
           )::bigint as started
    from buckets bk
    left join public.rentals r
      on r.organization_id = p_organization_id
     and r.status in ('reserved', 'active', 'completed')
     and r.starts_at < bk.to_ts
     and r.ends_at   > bk.from_ts
    group by bk.bucket_ts
  )
  select
    bk.bucket_ts::date,
    a.days,
    rt.days,
    rt.started,
    case
      when a.days > 0 then round(least(rt.days / a.days, 1) * 10000)::integer
    end
  from buckets bk
  join available a on a.bucket_ts = bk.bucket_ts
  join rented    rt on rt.bucket_ts = bk.bucket_ts
  order by bk.bucket_ts;
end;
$$;

comment on function public.report_utilisation_series(uuid, date, date, text) is
  'Fleet occupancy bucketed over a period: vehicle-days committed to hires against vehicle-days the fleet existed. Calendar availability, not adjusted for downtime the schema does not record.';

-- =============================================================================
-- 6. Cost analysis — by category, vendor or allocation
-- =============================================================================

create or replace function public.report_expense_breakdown(
  p_organization_id uuid,
  p_from date,
  p_to   date,
  p_dimension text
)
returns table (
  dimension_id       uuid,
  dimension_key      text,
  dimension_label    text,
  dimension_archived boolean,
  currency           public.currency_code,
  gross_minor        bigint,
  tax_minor          bigint,
  net_minor          bigint,
  expense_count      bigint,
  last_incurred_on   date
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  perform app.assert_report_access(p_organization_id);

  if p_to <= p_from then
    raise exception 'The reporting period must end after it starts.' using errcode = '22023';
  end if;

  if p_dimension not in ('category', 'vendor', 'allocation') then
    raise exception 'Unsupported breakdown: %', p_dimension using errcode = '22023';
  end if;

  return query
  /*
   * Grouped by IDENTITY, never by label. Two suppliers may share a name by
   * design, and a category may be renamed at any time — grouping on the text
   * would merge two vendors that are not the same and split one that is.
   * Archived categories and vendors stay in, because the money they account for
   * was really spent; archiving only removes them from pickers.
   */
  select
    case p_dimension when 'category' then e.category_id when 'vendor' then e.vendor_id end,
    case p_dimension
      when 'category'   then c.system_key
      when 'allocation' then e.allocation::text
    end,
    case p_dimension
      when 'category'   then c.name
      when 'vendor'     then coalesce(vn.name, 'No supplier recorded')
      when 'allocation' then
        case e.allocation
          when 'overhead' then 'Agency overhead'
          when 'vehicle'  then 'Vehicle-direct'
          when 'rental'   then 'Rental-direct'
        end
    end,
    case p_dimension
      when 'category' then c.archived_at is not null
      when 'vendor'   then vn.archived_at is not null
      else false
    end,
    e.currency,
    coalesce(sum(e.amount_minor), 0)::bigint,
    coalesce(sum(e.tax_amount_minor), 0)::bigint,
    coalesce(sum(e.amount_minor - e.tax_amount_minor), 0)::bigint,
    count(*)::bigint,
    max(e.incurred_on)
  from public.expenses e
  join public.expense_categories c on c.id = e.category_id
  left join public.expense_vendors vn on vn.id = e.vendor_id
  where e.organization_id = p_organization_id
    -- A voided cost never happened; financing is not an operating cost.
    and e.status = 'recorded'
    and e.financing_plan_id is null
    and e.incurred_on >= p_from
    and e.incurred_on <  p_to
  group by
    case p_dimension when 'category' then e.category_id when 'vendor' then e.vendor_id end,
    case p_dimension
      when 'category'   then c.system_key
      when 'allocation' then e.allocation::text
    end,
    case p_dimension
      when 'category'   then c.name
      when 'vendor'     then coalesce(vn.name, 'No supplier recorded')
      when 'allocation' then
        case e.allocation
          when 'overhead' then 'Agency overhead'
          when 'vehicle'  then 'Vehicle-direct'
          when 'rental'   then 'Rental-direct'
        end
    end,
    case p_dimension
      when 'category' then c.archived_at is not null
      when 'vendor'   then vn.archived_at is not null
      else false
    end,
    e.currency
  order by 6 desc;
end;
$$;

comment on function public.report_expense_breakdown(uuid, date, date, text) is
  'Recorded operating cost grouped by category, supplier or allocation, per currency. Grouped by identity rather than label so renamed categories and same-named suppliers stay correct. Voided and financing rows are excluded.';

-- =============================================================================
-- 7. Rental operations — lifecycle counts, currency-free
-- =============================================================================

create or replace function public.report_rental_operations(
  p_organization_id uuid,
  p_from date,
  p_to   date
)
returns table (
  created            bigint,
  confirmed          bigint,
  started            bigint,
  picked_up          bigint,
  returned           bigint,
  completed          bigint,
  cancelled          bigint,
  returned_late      bigint,
  active_now         bigint,
  reserved_now       bigint,
  avg_billable_days  numeric,
  avg_actual_hours   numeric,
  extensions         bigint,
  cancellation_bps   integer
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
begin
  perform app.assert_report_access(p_organization_id);
  select w.from_ts, w.to_ts into v_from_ts, v_to_ts
  from app.report_window(p_organization_id, p_from, p_to) w;

  return query
  /*
   * Every count below is filtered by ITS OWN date, because they answer
   * different questions. "Rentals created" is data entry; "hires started" is
   * operations; "completed" is settlement. Filtering all of them by created_at
   * would produce four numbers that look comparable and are not.
   */
  with scope as (
    select r.* from public.rentals r where r.organization_id = p_organization_id
  ),
  counted as (
    select
      count(*) filter (where s.created_at >= v_from_ts and s.created_at < v_to_ts)::bigint as created,
      count(*) filter (where s.confirmed_at >= v_from_ts and s.confirmed_at < v_to_ts)::bigint as confirmed,
      count(*) filter (
        where s.starts_at >= v_from_ts and s.starts_at < v_to_ts
          and s.status in ('reserved', 'active', 'completed')
      )::bigint as started,
      count(*) filter (where s.picked_up_at >= v_from_ts and s.picked_up_at < v_to_ts)::bigint as picked_up,
      count(*) filter (where s.returned_at >= v_from_ts and s.returned_at < v_to_ts)::bigint as returned,
      count(*) filter (
        where s.status = 'completed'
          and coalesce(s.completed_at, s.ends_at) >= v_from_ts
          and coalesce(s.completed_at, s.ends_at) <  v_to_ts
      )::bigint as completed,
      count(*) filter (where s.cancelled_at >= v_from_ts and s.cancelled_at < v_to_ts)::bigint as cancelled,
      -- Measured against the agreed return, from the stored timestamps. The
      -- product's own `rental_is_overdue` calls now() and is useless for history.
      count(*) filter (
        where s.returned_at >= v_from_ts and s.returned_at < v_to_ts
          and s.returned_at > s.ends_at
      )::bigint as returned_late,
      count(*) filter (where s.status = 'active')::bigint   as active_now,
      count(*) filter (where s.status = 'reserved')::bigint as reserved_now,
      -- The billable duration the domain defines, recomputed rather than read
      -- from the stored column, which is not kept in step with every extension.
      avg(public.rental_billable_days(s.starts_at, s.ends_at)) filter (
        where s.status = 'completed'
          and coalesce(s.completed_at, s.ends_at) >= v_from_ts
          and coalesce(s.completed_at, s.ends_at) <  v_to_ts
      ) as avg_billable_days,
      -- Actual time the vehicle was out, only where both timestamps exist.
      avg(extract(epoch from (s.returned_at - s.picked_up_at)) / 3600.0) filter (
        where s.returned_at >= v_from_ts and s.returned_at < v_to_ts
          and s.picked_up_at is not null
          and s.returned_at > s.picked_up_at
      ) as avg_actual_hours,
      coalesce(sum(s.extension_count) filter (
        where s.starts_at >= v_from_ts and s.starts_at < v_to_ts
      ), 0)::bigint as extensions
    from scope s
  )
  select
    c.created, c.confirmed, c.started, c.picked_up, c.returned, c.completed,
    c.cancelled, c.returned_late, c.active_now, c.reserved_now,
    round(c.avg_billable_days, 2),
    round(c.avg_actual_hours, 2),
    c.extensions,
    /*
     * Cancellations against real bookings only. The denominator is bookings
     * that reached at least `reserved` and whose defining event falls in the
     * window: a draft that was abandoned was never a booking, and including
     * drafts would let a data-entry habit move the rate.
     */
    case
      when (c.confirmed + c.cancelled) > 0
        then round(c.cancelled::numeric / (c.confirmed + c.cancelled) * 10000)::integer
    end
  from counted c;
end;
$$;

comment on function public.report_rental_operations(uuid, date, date) is
  'Rental lifecycle counts over a period. Each count is filtered by its own business date; the cancellation rate counts confirmed bookings only, never abandoned drafts.';

-- =============================================================================
-- 8. Rental values — per currency
-- =============================================================================

create or replace function public.report_rental_values(
  p_organization_id uuid,
  p_from date,
  p_to   date
)
returns table (
  currency                 public.currency_code,
  completed_count          bigint,
  completed_total_minor    bigint,
  avg_completed_value_minor bigint,
  avg_daily_value_minor    bigint,
  revenue_minor            bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
begin
  perform app.assert_report_access(p_organization_id);
  select w.from_ts, w.to_ts into v_from_ts, v_to_ts
  from app.report_window(p_organization_id, p_from, p_to) w;

  return query
  with completed as (
    /*
     * The contracted value of hires that finished in the window. This is what
     * the customer was charged, not what they paid — the two are different
     * questions and both are shown. Deposits are not part of it: the domain
     * keeps them out of `total_minor` by construction.
     */
    select
      r.currency as cur,
      count(*)::bigint as n,
      coalesce(sum(r.total_minor), 0)::bigint as total,
      coalesce(sum(public.rental_billable_days(r.starts_at, r.ends_at)), 0)::bigint as days
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.status = 'completed'
      and coalesce(r.completed_at, r.ends_at) >= v_from_ts
      and coalesce(r.completed_at, r.ends_at) <  v_to_ts
    group by r.currency
  ),
  cash as (
    select p.currency as cur,
           coalesce(sum(
             case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
           ), 0)::bigint as amount
    from public.payments p
    where p.organization_id = p_organization_id
      and p.purpose = 'rental_charge'
      and p.voided_at is null
      and p.paid_at >= v_from_ts
      and p.paid_at <  v_to_ts
    group by p.currency
  ),
  currencies as (select cur from completed union select cur from cash)
  select
    c.cur,
    coalesce(cp.n, 0),
    coalesce(cp.total, 0)::bigint,
    case when coalesce(cp.n, 0) > 0 then round(cp.total::numeric / cp.n)::bigint end,
    case when coalesce(cp.days, 0) > 0 then round(cp.total::numeric / cp.days)::bigint end,
    coalesce(ch.amount, 0)::bigint
  from currencies c
  left join completed cp on cp.cur = c.cur
  left join cash      ch on ch.cur = c.cur
  order by c.cur;
end;
$$;

comment on function public.report_rental_values(uuid, date, date) is
  'Contracted value of hires completed in the period, and rental cash received in it, per currency. Averages are computed inside one currency only.';

-- =============================================================================
-- 9. Customers — cohorts and balances
-- =============================================================================

create or replace function public.report_customer_cohorts(
  p_organization_id uuid,
  p_from date,
  p_to   date
)
returns table (
  renters_in_period   bigint,
  first_time_renters  bigint,
  returning_renters   bigint,
  repeat_rate_bps     integer,
  rentals_in_period   bigint,
  rentals_per_renter  numeric,
  customers_total     bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
begin
  perform app.assert_report_access(p_organization_id);
  select w.from_ts, w.to_ts into v_from_ts, v_to_ts
  from app.report_window(p_organization_id, p_from, p_to) w;

  return query
  /*
   * "First-time renter" is an event, not a record-creation date. A customer
   * entered on the system last March who hires for the first time today is a
   * first-time renter today — `customers.created_at` answers a different
   * question and the product's existing `first_rental_at` columns count drafts
   * and cancellations, which never established that anybody hired anything.
   *
   * The qualifying set is therefore hires that actually happened: `active` and
   * `completed`. A reservation is a commitment, not a rental, and folding it in
   * would let a booking that is later cancelled create a permanent renter.
   */
  with qualifying as (
    select r.customer_id, r.starts_at
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.status in ('active', 'completed')
  ),
  first_ever as (
    -- Computed over ALL history and only then compared to the window. Deriving
    -- it inside the window would make every customer look new.
    select q.customer_id, min(q.starts_at) as first_starts_at
    from qualifying q
    group by q.customer_id
  ),
  in_period as (
    select distinct q.customer_id
    from qualifying q
    where q.starts_at >= v_from_ts and q.starts_at < v_to_ts
  ),
  cohorts as (
    select
      count(*)::bigint as renters,
      count(*) filter (
        where fe.first_starts_at >= v_from_ts and fe.first_starts_at < v_to_ts
      )::bigint as first_time,
      count(*) filter (where fe.first_starts_at < v_from_ts)::bigint as returning
    from in_period ip
    join first_ever fe on fe.customer_id = ip.customer_id
  ),
  volume as (
    select count(*)::bigint as rentals
    from qualifying q
    where q.starts_at >= v_from_ts and q.starts_at < v_to_ts
  ),
  book as (
    select count(*)::bigint as total
    from public.customers c
    where c.organization_id = p_organization_id
      and c.archived_at is null
  )
  select
    ch.renters,
    ch.first_time,
    ch.returning,
    case when ch.renters > 0 then round(ch.returning::numeric / ch.renters * 10000)::integer end,
    v.rentals,
    case when ch.renters > 0 then round(v.rentals::numeric / ch.renters, 2) end,
    b.total
  from cohorts ch, volume v, book b;
end;
$$;

comment on function public.report_customer_cohorts(uuid, date, date) is
  'First-time and returning renters in a period. A renter is somebody whose hire reached active or completed; the first-ever hire is found across all history before the window is applied.';

create or replace function public.report_customer_balances(
  p_organization_id uuid,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  customer_id       uuid,
  display_name      text,
  customer_type     public.customer_type,
  archived_at       timestamptz,
  currency          public.currency_code,
  rental_count      bigint,
  charged_minor     bigint,
  paid_minor        bigint,
  outstanding_minor bigint,
  deposits_held_minor bigint,
  last_rental_starts_at timestamptz,
  total_rows        bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 25), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform app.assert_report_access(p_organization_id);

  return query
  /*
   * Reporting projection, not the customer record. It carries a display name
   * because a balances list without one cannot be acted on, and it carries
   * nothing else about the person: no email, no telephone, no address, no date
   * of birth, no identity document. Those exist on the customer page, behind
   * the permission that governs them.
   *
   * The predicates reproduce customer_financial_summary exactly so a figure
   * here and a figure on the customer's own page cannot disagree.
   */
  with balances as (
    select
      r.customer_id as cid,
      r.currency    as cur,
      count(*)::bigint as rentals,
      coalesce(sum(r.total_minor), 0)::bigint as charged,
      coalesce(sum(r.amount_paid_minor), 0)::bigint as paid,
      coalesce(sum(r.balance_due_minor) filter (
        where r.status in ('reserved', 'active', 'completed') and r.balance_due_minor > 0
      ), 0)::bigint as outstanding,
      coalesce(sum(r.deposit_held_minor), 0)::bigint as deposits,
      max(r.starts_at) as last_starts_at
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.status <> 'draft'
    group by r.customer_id, r.currency
  ),
  ranked as (
    select b.*, count(*) over () as total
    from balances b
    where b.outstanding > 0
  )
  select
    rk.cid,
    c.display_name,
    c.customer_type,
    c.archived_at,
    rk.cur,
    rk.rentals,
    rk.charged,
    rk.paid,
    rk.outstanding,
    rk.deposits,
    rk.last_starts_at,
    rk.total
  from ranked rk
  join public.customers c on c.id = rk.cid
  order by rk.outstanding desc, c.display_name
  limit v_limit offset v_offset;
end;
$$;

comment on function public.report_customer_balances(uuid, integer, integer) is
  'Customers with money outstanding, per currency, paginated. Carries a display name and financial totals only — no contact details, no identity documents.';

create or replace function public.report_customer_revenue(
  p_organization_id uuid,
  p_from date,
  p_to   date,
  p_limit integer default 10
)
returns table (
  customer_id   uuid,
  display_name  text,
  customer_type public.customer_type,
  currency      public.currency_code,
  rental_count  bigint,
  revenue_minor bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
  v_limit   integer := least(greatest(coalesce(p_limit, 10), 1), 100);
begin
  perform app.assert_report_access(p_organization_id);
  select w.from_ts, w.to_ts into v_from_ts, v_to_ts
  from app.report_window(p_organization_id, p_from, p_to) w;

  return query
  -- Rental cash received from each customer in the window, per currency. Ranked
  -- inside one currency by the caller; never across.
  select
    p.customer_id,
    c.display_name,
    c.customer_type,
    p.currency,
    count(distinct p.rental_id)::bigint,
    coalesce(sum(
      case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
    ), 0)::bigint
  from public.payments p
  join public.customers c on c.id = p.customer_id
  where p.organization_id = p_organization_id
    and p.customer_id is not null
    and p.purpose = 'rental_charge'
    and p.voided_at is null
    and p.paid_at >= v_from_ts
    and p.paid_at <  v_to_ts
  group by p.customer_id, c.display_name, c.customer_type, p.currency
  having coalesce(sum(
    case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
  ), 0) <> 0
  order by 6 desc
  limit v_limit;
end;
$$;

comment on function public.report_customer_revenue(uuid, date, date, integer) is
  'Rental cash received from each customer in a period, per currency. Name and totals only.';

-- =============================================================================
-- 10. Financing position, per active agreement
-- =============================================================================

create or replace function public.report_financing_position(p_organization_id uuid)
returns table (
  agreement_id              uuid,
  reference                 text,
  vehicle_id                uuid,
  registration_plate        text,
  vehicle_archived          boolean,
  lender_id                 uuid,
  lender_name               text,
  agreement_type            public.financing_agreement_type,
  mode                      public.financing_mode,
  currency                  public.currency_code,
  cash_paid_minor           bigint,
  principal_paid_minor      bigint,
  financing_cost_minor      bigint,
  unallocated_minor         bigint,
  cost_complete             boolean,
  remaining_principal_minor bigint,
  principal_known           boolean,
  overdue_minor             bigint,
  overdue_count             bigint,
  next_due_on               date,
  next_due_minor            bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  perform app.assert_report_access(p_organization_id);

  return query
  /*
   * One row per ACTIVE agreement, taken from the overview view. Summing per
   * vehicle instead would double-count a car that has been refinanced, because
   * its closed agreement carries a balance too.
   *
   * Archived vehicles are included on purpose: a debt does not stop existing
   * because the car left the fleet.
   */
  select
    o.id,
    o.reference,
    o.vehicle_id,
    o.vehicle_plate,
    o.vehicle_archived,
    o.lender_id,
    o.lender_name,
    o.agreement_type,
    o.mode,
    o.currency,
    coalesce(o.cash_paid_minor, 0)::bigint,
    coalesce(o.principal_paid_minor, 0)::bigint,
    coalesce(o.financing_cost_minor, 0)::bigint,
    coalesce(o.unallocated_minor, 0)::bigint,
    o.cost_complete,
    o.remaining_principal_minor,
    o.principal_known,
    coalesce(o.overdue_minor, 0)::bigint,
    coalesce(o.overdue_count, 0)::bigint,
    o.next_due_on,
    -- The view aggregates this as numeric; the report speaks in minor units.
    o.next_due_minor::bigint
  from public.financing_agreement_overview o
  where o.organization_id = p_organization_id
    and o.agreement_status = 'active'
  order by coalesce(o.overdue_minor, 0) desc, o.next_due_on nulls last, o.vehicle_plate;
end;
$$;

comment on function public.report_financing_position(uuid) is
  'Every active financing agreement with its cash, cost, derivable principal and arrears. One row per agreement so a refinanced vehicle is never counted twice.';

-- =============================================================================
-- 11. Tracking coverage — a stamped snapshot, never a history
-- =============================================================================

create or replace function public.report_gps_coverage(p_organization_id uuid)
returns table (
  computed_at              timestamptz,
  fresh_minutes            smallint,
  stale_minutes            smallint,
  vehicles_total           bigint,
  vehicles_tracked         bigint,
  vehicles_untracked       bigint,
  positions_fresh          bigint,
  positions_stale          bigint,
  positions_very_stale     bigint,
  positions_future         bigint,
  positions_unknown        bigint,
  link_online              bigint,
  link_offline             bigint,
  link_unreported          bigint,
  devices_total            bigint,
  devices_assigned         bigint,
  devices_spare            bigint,
  devices_missing          bigint,
  connections_total        bigint,
  connections_healthy      bigint,
  last_sync_success_at     timestamptz
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_fresh smallint;
  v_stale smallint;
begin
  perform app.assert_report_access(p_organization_id);

  select s.gps_fresh_minutes, s.gps_stale_minutes into v_fresh, v_stale
  from public.organization_settings s
  where s.organization_id = p_organization_id;

  return query
  /*
   * A SNAPSHOT, stamped with the moment it was taken.
   *
   * Nothing on this deployment runs while nobody is looking: positions refresh
   * while somebody has the tracking workspace open, and there is no scheduler.
   * So there is no such thing here as tracker uptime, an average position age
   * for a month, or how many vehicles went offline overnight — those sentences
   * would describe data that was never collected. What can be said honestly is
   * what is true at this instant, and `computed_at` is returned so the report
   * can say when this instant was.
   */
  with fleet as (
    select count(*)::bigint as total
    from public.vehicles v
    where v.organization_id = p_organization_id
      and v.archived_at is null
  ),
  tracked as (
    select
      count(*)::bigint as total,
      count(*) filter (where g.position_freshness = 'fresh')::bigint      as fresh,
      count(*) filter (where g.position_freshness = 'stale')::bigint      as stale,
      count(*) filter (where g.position_freshness = 'very_stale')::bigint as very_stale,
      count(*) filter (where g.position_freshness = 'future')::bigint     as future,
      count(*) filter (where g.position_freshness = 'unknown')::bigint    as unknown,
      -- Three buckets. A provider that does not report a link state has not
      -- said the tracker is offline, and counting NULL as offline would send
      -- somebody out to look for a van that is parked where it should be.
      count(*) filter (where g.provider_online is true)::bigint  as online,
      count(*) filter (where g.provider_online is false)::bigint as offline,
      count(*) filter (where g.provider_online is null)::bigint  as unreported
    from public.gps_fleet g
    where g.organization_id = p_organization_id
      and g.vehicle_archived = false
  ),
  devices as (
    select
      count(*)::bigint as total,
      count(*) filter (where i.vehicle_id is not null)::bigint as assigned,
      count(*) filter (where i.vehicle_id is null)::bigint     as spare,
      count(*) filter (where i.availability = 'missing')::bigint as missing
    from public.gps_unit_inventory i
    where i.organization_id = p_organization_id
  ),
  connections as (
    -- Counted per CONNECTION, not per vehicle: one broken credential is one
    -- problem, not one problem multiplied by the size of the fleet.
    select
      count(*)::bigint as total,
      count(*) filter (where c.status = 'healthy')::bigint as healthy,
      max(c.last_sync_success_at) as last_success
    from public.gps_provider_connections c
    where c.organization_id = p_organization_id
  )
  select
    now(),
    coalesce(v_fresh, 10::smallint),
    coalesce(v_stale, 120::smallint),
    f.total,
    t.total,
    greatest(f.total - t.total, 0),
    t.fresh, t.stale, t.very_stale, t.future, t.unknown,
    t.online, t.offline, t.unreported,
    d.total, d.assigned, d.spare, d.missing,
    cn.total, cn.healthy, cn.last_success
  from fleet f, tracked t, devices d, connections cn;
end;
$$;

comment on function public.report_gps_coverage(uuid) is
  'Tracking coverage as at now, stamped with computed_at. A snapshot only — this deployment has no background scheduler, so no historical uptime or connectivity trend exists to report.';

-- =============================================================================
-- 12. Compliance — the fleet's documents, using the agency's own threshold
-- =============================================================================

create or replace function public.report_compliance_summary(
  p_organization_id uuid,
  p_lead_days integer default null
)
returns table (
  document_kind text,
  lead_days     integer,
  expired       bigint,
  due_soon      bigint,
  valid         bigint,
  unrecorded    bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_today date;
  v_lead  integer;
begin
  perform app.assert_report_access(p_organization_id);

  select (now() at time zone coalesce(o.time_zone, 'UTC'))::date into v_today
  from public.organizations o where o.id = p_organization_id;

  if v_today is null then
    raise exception 'Organization not found.' using errcode = 'P0002';
  end if;

  -- The agency's own reminder threshold, never a number invented here. The
  -- fleet list and the vehicle page use exactly this setting.
  select coalesce(p_lead_days, s.compliance_reminder_lead_days, 30) into v_lead
  from public.organization_settings s
  where s.organization_id = p_organization_id;

  v_lead := greatest(coalesce(v_lead, 30), 0);

  return query
  /*
   * The three date columns on `vehicles` are the authoritative compliance
   * store; `vehicle_documents.expires_on` is a separate register that is not
   * kept in step with them. Reading the other one would produce a report that
   * contradicts every other screen.
   *
   * "Unrecorded" is counted apart from "expired" on purpose: a vehicle whose
   * insurance date nobody has entered is not a vehicle driving uninsured, and
   * merging the two would turn a data-entry gap into an alarm.
   */
  with live as (
    select v.insurance_expires_on, v.inspection_expires_on, v.registration_expires_on
    from public.vehicles v
    where v.organization_id = p_organization_id
      and v.archived_at is null
  ),
  kinds as (
    select 'insurance'::text as kind, l.insurance_expires_on as expires_on from live l
    union all
    select 'inspection', l.inspection_expires_on from live l
    union all
    select 'registration', l.registration_expires_on from live l
  )
  select
    k.kind,
    v_lead,
    count(*) filter (where k.expires_on is not null and k.expires_on < v_today)::bigint,
    count(*) filter (
      where k.expires_on is not null
        and k.expires_on >= v_today
        and k.expires_on <= v_today + v_lead
    )::bigint,
    count(*) filter (where k.expires_on is not null and k.expires_on > v_today + v_lead)::bigint,
    count(*) filter (where k.expires_on is null)::bigint
  from kinds k
  group by k.kind
  order by k.kind;
end;
$$;

comment on function public.report_compliance_summary(uuid, integer) is
  'Fleet compliance by document kind, using the agency''s own reminder threshold. Unrecorded is counted separately from expired: a missing date is a data gap, not a breach.';

-- -----------------------------------------------------------------------------
-- Privileges
--
-- A new function is granted to PUBLIC by default and `anon` is a member of
-- PUBLIC, so revoking from the role alone would leave the inherited grant in
-- place. Both are named.
-- -----------------------------------------------------------------------------

revoke all on function public.report_business_summary(uuid, date, date) from public, anon;
grant execute on function public.report_business_summary(uuid, date, date) to authenticated;

revoke all on function public.report_position_summary(uuid) from public, anon;
grant execute on function public.report_position_summary(uuid) to authenticated;

revoke all on function public.report_financial_series(uuid, date, date, text, public.currency_code) from public, anon;
grant execute on function public.report_financial_series(uuid, date, date, text, public.currency_code) to authenticated;

revoke all on function public.report_fleet_performance(uuid, date, date) from public, anon;
grant execute on function public.report_fleet_performance(uuid, date, date) to authenticated;

revoke all on function public.report_utilisation_series(uuid, date, date, text) from public, anon;
grant execute on function public.report_utilisation_series(uuid, date, date, text) to authenticated;

revoke all on function public.report_expense_breakdown(uuid, date, date, text) from public, anon;
grant execute on function public.report_expense_breakdown(uuid, date, date, text) to authenticated;

revoke all on function public.report_rental_operations(uuid, date, date) from public, anon;
grant execute on function public.report_rental_operations(uuid, date, date) to authenticated;

revoke all on function public.report_rental_values(uuid, date, date) from public, anon;
grant execute on function public.report_rental_values(uuid, date, date) to authenticated;

revoke all on function public.report_customer_cohorts(uuid, date, date) from public, anon;
grant execute on function public.report_customer_cohorts(uuid, date, date) to authenticated;

revoke all on function public.report_customer_balances(uuid, integer, integer) from public, anon;
grant execute on function public.report_customer_balances(uuid, integer, integer) to authenticated;

revoke all on function public.report_customer_revenue(uuid, date, date, integer) from public, anon;
grant execute on function public.report_customer_revenue(uuid, date, date, integer) to authenticated;

revoke all on function public.report_financing_position(uuid) from public, anon;
grant execute on function public.report_financing_position(uuid) to authenticated;

revoke all on function public.report_gps_coverage(uuid) from public, anon;
grant execute on function public.report_gps_coverage(uuid) to authenticated;

revoke all on function public.report_compliance_summary(uuid, integer) from public, anon;
grant execute on function public.report_compliance_summary(uuid, integer) to authenticated;

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

-- Every report function must be SECURITY INVOKER, so that row-level security
-- decides what each one can see rather than the definer's privileges.
do $$
declare
  v_definers text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_definers
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like 'report\_%'
    and p.prosecdef;

  if v_definers is not null then
    raise exception 'report functions must be security invoker: %', v_definers;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
