-- =============================================================================
-- 20260820100100_report_review_fixes.sql
--
-- Seven defects found by an adversarial review of the reporting layer. Each one
-- produced a confident, wrong number rather than an error, which is the way an
-- analytics module actually fails.
--
--   1. OCCUPANCY DOUBLE COUNTED an early return followed by a re-hire. The
--      availability constraint only guards `reserved` and `active`, and
--      completing a hire does not pull its `ends_at` back to the actual return —
--      so a completed contract keeps its whole original interval AND frees the
--      car for a new booking. Summing the two intervals reported 28 days of
--      occupancy in a 31-day month for a vehicle that was committed for 19.
--
--   2. REMAINING PRINCIPAL had its two answers exactly inverted. A currency in
--      which no balance is derivable was reported as zero — "you owe nothing" —
--      while a currency with no financing at all was reported as "not
--      derivable". The Financing tab and the Business tab disagreed about the
--      same agreement on the same screen.
--
--   3. THE CANCELLATION RATE counted a booking twice in its own denominator when
--      it was confirmed and cancelled in the same window, so a month in which
--      every booking was cancelled reported 50%.
--
--   4. THE UTILISATION SERIES clamped each bucket's end to the period but not
--      its start, so the first bar of a weekly or monthly chart measured days
--      before the report began. Every quarter reaches this, because a quarter is
--      charted weekly and quarters do not start on Mondays.
--
--   5. THE UTILISATION SERIES invented a vehicle for an agency that owns none,
--      because a LEFT JOIN's all-NULL row coalesced into a full bucket.
--
--   6. TOP CUSTOMERS were ranked and truncated ACROSS currencies before the
--      caller could scope them, so a currency's panel could come back empty
--      while the same screen reported revenue in it.
--
--   7. OUTSTANDING BALANCES were paginated across currencies and then filtered
--      in the browser, so page one could be empty for the selected currency
--      while the pager said "page 1 of 12".
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- 1 + 2 + 3 + 4 + 5: rewritten function bodies
-- -----------------------------------------------------------------------------

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
       * window, bounded by acquisition and by archiving where those are known,
       * clamped at zero.
       *
       * It is NOT reduced by maintenance or off-road time. The schema keeps no
       * history of vehicle status, so subtracting historical downtime would be
       * inventing it. The metric is calendar availability, and the interface
       * says so.
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
  merged as (
    /*
     * FIX 1: the intervals are UNIONED before they are measured.
     *
     * Summing each hire's overlap separately double counts a vehicle that was
     * returned early and hired again. The availability constraint only guards
     * `reserved` and `active`, and completing a contract does not pull its
     * `ends_at` back to the actual return — so a completed hire keeps its whole
     * original interval while the car is legitimately re-booked underneath it.
     * That is the ordinary early-return path, not an anomaly, and it reported a
     * car as 90% utilised when it was committed for 61% of the month.
     *
     * `range_agg` merges the overlaps; the total is then the measure of the
     * union, which is the number of days the vehicle was actually spoken for.
     */
    select r.vehicle_id as vid,
           range_agg(tstzrange(
             greatest(r.starts_at, v_from_ts),
             least(r.ends_at, v_to_ts),
             '[)'
           )) as spans
    from public.rentals r
    where r.organization_id = p_organization_id
      and r.status in ('reserved', 'active', 'completed')
      and r.starts_at < v_to_ts
      and r.ends_at   > v_from_ts
    group by r.vehicle_id
  ),
  occupancy as (
    select m.vid,
           sum(extract(epoch from (upper(span) - lower(span))) / 86400.0)::numeric as days
    from merged m
    cross join lateral unnest(m.spans) as span
    group by m.vid
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
  'Per-vehicle economics and occupancy over a period, one row per vehicle and currency. Occupancy is the union of committed intervals, so an early return followed by a re-hire counts once. Contribution excludes overhead, financing and acquisition.';

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
      /*
       * FIX 4: the first bucket is clamped to the period, not only the last.
       *
       * `generate_series` starts at date_trunc(granularity, p_from), which
       * precedes p_from whenever the period does not begin on a bucket
       * boundary. Every quarter reaches this: a quarter is charted weekly and
       * quarters do not start on Mondays, so the first bar was measuring days
       * from the previous quarter.
       */
      (greatest(b.bucket_ts, p_from::timestamp) at time zone coalesce(v_zone, 'UTC')) as from_ts,
      (least(b.bucket_ts + v_step, p_to::timestamp) at time zone coalesce(v_zone, 'UTC')) as to_ts
    from generate_series(
      date_trunc(p_granularity, p_from::timestamp),
      date_trunc(p_granularity, (p_to - 1)::timestamp),
      v_step
    ) as b(bucket_ts)
  ),
  available as (
    select bk.bucket_ts,
           -- FIX 5: an agency with no vehicles has no vehicle-days. Without the
           -- filter, the LEFT JOIN's all-NULL row coalesced into a full bucket
           -- and reported a fleet of one that does not exist.
           coalesce(sum(greatest(
             0,
             extract(epoch from (
               least(bk.to_ts, coalesce(v.archived_at, bk.to_ts))
               - greatest(
                   bk.from_ts,
                   coalesce((v.acquired_on::timestamp) at time zone coalesce(v_zone, 'UTC'), bk.from_ts)
                 )
             )) / 86400.0
           )) filter (where v.id is not null), 0)::numeric as days
    from buckets bk
    left join public.vehicles v on v.organization_id = p_organization_id
    group by bk.bucket_ts
  ),
  merged as (
    -- FIX 1, again: the union of each vehicle's committed intervals inside the
    -- bucket, so an early return followed by a re-hire is one occupancy.
    select bk.bucket_ts, r.vehicle_id,
           range_agg(tstzrange(
             greatest(r.starts_at, bk.from_ts),
             least(r.ends_at, bk.to_ts),
             '[)'
           )) as spans
    from buckets bk
    join public.rentals r
      on r.organization_id = p_organization_id
     and r.status in ('reserved', 'active', 'completed')
     and r.starts_at < bk.to_ts
     and r.ends_at   > bk.from_ts
    group by bk.bucket_ts, r.vehicle_id
  ),
  rented as (
    select bk.bucket_ts,
           coalesce((
             select sum(extract(epoch from (upper(span) - lower(span))) / 86400.0)
             from merged m
             cross join lateral unnest(m.spans) as span
             where m.bucket_ts = bk.bucket_ts
           ), 0)::numeric as days,
           coalesce((
             select count(*)
             from public.rentals r
             where r.organization_id = p_organization_id
               and r.status in ('reserved', 'active', 'completed')
               and r.starts_at >= bk.from_ts
               and r.starts_at <  bk.to_ts
           ), 0)::bigint as started
    from buckets bk
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
  'Fleet occupancy bucketed over a period. Buckets are clamped to the period at both ends; occupancy is the union of committed intervals per vehicle. Calendar availability, not adjusted for downtime the schema does not record.';

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
     * FIX 2: the two answers were inverted.
     *
     * A currency in which NO active agreement has a derivable balance is not a
     * currency in which nothing is owed — it is a currency whose balance nobody
     * can compute, and the coalesce here turned that into the number zero.
     * Meanwhile a currency with no financing at all fell through the LEFT JOIN
     * as NULL and was rendered "not derivable", which is exactly backwards: an
     * agency with no loans owes no principal, and that is a fact.
     *
     * So the sum stays NULL when nothing is knowable, and the final select
     * substitutes a real zero only where there is genuinely no debt.
     */
    select
      o.currency as cur,
      sum(o.remaining_principal_minor) filter (where o.principal_known)::bigint as principal,
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
    -- No agreement at all in this currency: nothing is owed, and that is a
    -- figure. Otherwise the sum speaks for itself, NULL included.
    case
      when coalesce(dbt.known, 0) = 0 and coalesce(dbt.unknown, 0) = 0 then 0::bigint
      else dbt.principal
    end,
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
  'Balances as at now, one row per currency. Remaining principal is NULL when no active agreement in that currency has a derivable balance, and 0 when there is no financing at all — the two are different answers.';

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
      count(*) filter (
        where s.returned_at >= v_from_ts and s.returned_at < v_to_ts
          and s.returned_at > s.ends_at
      )::bigint as returned_late,
      count(*) filter (where s.status = 'active')::bigint   as active_now,
      count(*) filter (where s.status = 'reserved')::bigint as reserved_now,
      avg(public.rental_billable_days(s.starts_at, s.ends_at)) filter (
        where s.status = 'completed'
          and coalesce(s.completed_at, s.ends_at) >= v_from_ts
          and coalesce(s.completed_at, s.ends_at) <  v_to_ts
      ) as avg_billable_days,
      avg(extract(epoch from (s.returned_at - s.picked_up_at)) / 3600.0) filter (
        where s.returned_at >= v_from_ts and s.returned_at < v_to_ts
          and s.picked_up_at is not null
          and s.returned_at > s.picked_up_at
      ) as avg_actual_hours,
      coalesce(sum(s.extension_count) filter (
        where s.starts_at >= v_from_ts and s.starts_at < v_to_ts
      ), 0)::bigint as extensions,
      /*
       * FIX 3: one booking, counted once.
       *
       * Cancelling leaves `confirmed_at` in place, so a booking confirmed and
       * then cancelled inside the same window was in the numerator once and in
       * the denominator twice. The rate could never exceed 50%, and a month in
       * which every booking was cancelled reported exactly that.
       *
       * The denominator is now a headcount of distinct bookings that either
       * were confirmed in the window or were cancelled in it — real bookings
       * only, so an abandoned draft still cannot move the rate.
       */
      count(*) filter (
        where (s.confirmed_at >= v_from_ts and s.confirmed_at < v_to_ts)
           or (s.status = 'cancelled' and s.cancelled_at >= v_from_ts and s.cancelled_at < v_to_ts)
      )::bigint as bookings
    from scope s
  )
  select
    c.created, c.confirmed, c.started, c.picked_up, c.returned, c.completed,
    c.cancelled, c.returned_late, c.active_now, c.reserved_now,
    round(c.avg_billable_days, 2),
    round(c.avg_actual_hours, 2),
    c.extensions,
    case
      when c.bookings > 0 then round(c.cancelled::numeric / c.bookings * 10000)::integer
    end
  from counted c;
end;
$$;

comment on function public.report_rental_operations(uuid, date, date) is
  'Rental lifecycle counts over a period, each on its own business date. The cancellation rate divides cancellations by distinct real bookings, so a booking confirmed and cancelled in the same window is counted once.';

-- -----------------------------------------------------------------------------
-- 6: top customers, ranked inside each currency
-- -----------------------------------------------------------------------------

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
  /*
   * FIX 6: ranked WITHIN each currency, never across.
   *
   * A single `order by revenue desc limit 10` compares euro cents against
   * dirham centimes and truncates before the caller can scope the result, so a
   * currency's panel could come back empty on a screen that had just reported
   * revenue in it. Each currency now gets its own top N.
   */
  with by_customer as (
    select
      p.customer_id as cid,
      c.display_name,
      c.customer_type,
      p.currency as cur,
      count(distinct p.rental_id)::bigint as rentals,
      coalesce(sum(
        case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
      ), 0)::bigint as amount
    from public.payments p
    join public.customers c on c.id = p.customer_id
    where p.organization_id = p_organization_id
      and p.customer_id is not null
      and p.purpose = 'rental_charge'
      and p.voided_at is null
      and p.paid_at >= v_from_ts
      and p.paid_at <  v_to_ts
    group by p.customer_id, c.display_name, c.customer_type, p.currency
  ),
  ranked as (
    select b.*, row_number() over (partition by b.cur order by b.amount desc, b.display_name) as rank
    from by_customer b
    where b.amount <> 0
  )
  select r.cid, r.display_name, r.customer_type, r.cur, r.rentals, r.amount
  from ranked r
  where r.rank <= v_limit
  order by r.cur, r.amount desc;
end;
$$;

comment on function public.report_customer_revenue(uuid, date, date, integer) is
  'Rental cash received from each customer in a period, ranked within each currency and never across them. Name and totals only.';

-- -----------------------------------------------------------------------------
-- 7: balances paginated inside one currency
-- -----------------------------------------------------------------------------

drop function if exists public.report_customer_balances(uuid, integer, integer);

create or replace function public.report_customer_balances(
  p_organization_id uuid,
  p_currency public.currency_code default null,
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
   * FIX 7: the page and its count are scoped to ONE currency.
   *
   * Ranking every currency together compares raw minor units across them, and
   * paginating that list then filtering in the browser produced an empty first
   * page beside a pager reading "page 1 of 12". With a currency supplied, the
   * ordering, the count and the slice all describe the same population.
   *
   * Reporting projection, not the customer record: a display name because a
   * balances list without one cannot be acted on, and nothing else about the
   * person. The predicates reproduce customer_financial_summary exactly, so a
   * figure here and a figure on the customer's own page cannot disagree.
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
      and (p_currency is null or r.currency = p_currency)
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

comment on function public.report_customer_balances(uuid, public.currency_code, integer, integer) is
  'Customers with money outstanding, scoped to one currency and paginated inside it. Carries a display name and financial totals only — no contact details, no identity documents.';

-- -----------------------------------------------------------------------------
-- Privileges for the replaced signature
-- -----------------------------------------------------------------------------

revoke all on function public.report_customer_balances(uuid, public.currency_code, integer, integer) from public, anon;
grant execute on function public.report_customer_balances(uuid, public.currency_code, integer, integer) to authenticated;

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

-- The old three-argument balances signature must be gone, not merely shadowed:
-- an overload would let a caller reach the cross-currency version by accident.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'report_customer_balances'
      and pg_get_function_identity_arguments(p.oid) = 'uuid, integer, integer'
  ) then
    raise exception 'the cross-currency report_customer_balances signature still exists';
  end if;
end
$$;

select app.assert_views_are_security_invoker();
