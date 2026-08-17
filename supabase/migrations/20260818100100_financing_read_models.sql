-- =============================================================================
-- Financing: schedules, settlement, and what the agency is actually asked
--
-- Three rules run through every function in this file.
--
--   1. Expected is not actual. An instalment due next month is an obligation,
--      never money spent. Nothing here lets a scheduled figure reach a total
--      that claims to be cash paid.
--
--   2. Unknown is not zero. `expected_principal_minor` and the split on a
--      payment are NULL or unallocated when nobody knows them, and every total
--      that depends on them carries a completeness flag rather than quietly
--      reporting a confident number.
--
--   3. Principal is not a cost. It moves money from one place to another. Only
--      interest and fees are the price of borrowing, and only those two are
--      ever called a financing cost.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- How many periods a year
-- -----------------------------------------------------------------------------

create or replace function app.financing_periods_per_year(p_frequency public.financing_frequency)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'weekly'    then 52
    when 'biweekly'  then 26
    when 'monthly'   then 12
    when 'quarterly' then 4
  end;
$$;

-- -----------------------------------------------------------------------------
-- The level payment an annuity implies
--
-- Support, not authority. If the contract states an instalment, that number is
-- what the agency pays and this one is only used to say whether the two agree.
--
-- payment = i·(P·f − B) / (f − 1)   where f = (1+i)^n
--
-- Computed in `numeric`, which is arbitrary-precision decimal. Binary floating
-- point is never used for money anywhere in this product, and a rate is money's
-- close relative.
-- -----------------------------------------------------------------------------

create or replace function public.financing_annuity_payment(
  p_financed_minor bigint,
  p_rate_bps       integer,
  p_installments   integer,
  p_frequency      public.financing_frequency,
  p_balloon_minor  bigint default 0
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_rate    numeric;
  v_factor  numeric;
  v_balloon bigint := coalesce(p_balloon_minor, 0);
begin
  if p_financed_minor is null or p_rate_bps is null or p_installments is null
     or p_installments < 1 or p_financed_minor <= 0 then
    return null;
  end if;

  if v_balloon >= p_financed_minor then
    raise exception 'A balloon of % cannot be as large as the amount financed (%).',
      v_balloon, p_financed_minor using errcode = '22023';
  end if;

  v_rate := p_rate_bps::numeric / (10000::numeric * app.financing_periods_per_year(p_frequency));

  if v_rate = 0 then
    -- Rounded up, so no instalment is short and the last one absorbs the rest.
    return ceil((p_financed_minor - v_balloon)::numeric / p_installments)::bigint;
  end if;

  v_factor := power(1 + v_rate, p_installments::numeric);

  return round(
    v_rate * (p_financed_minor::numeric * v_factor - v_balloon::numeric) / (v_factor - 1)
  )::bigint;
end;
$$;

comment on function public.financing_annuity_payment(bigint, integer, integer, public.financing_frequency, bigint) is
  'The level payment an annuity implies. Support for the agreement''s own stated instalment, never a replacement for it.';

-- -----------------------------------------------------------------------------
-- The projected schedule
--
-- Pure: it takes terms and returns rows, touches no table, and is used both by
-- the wizard's preview and by the RPC that writes a real schedule — so what an
-- agency is shown before saving is what gets saved.
--
-- In simple mode the principal and interest columns come back NULL. That is the
-- whole point: the agency knows it pays 4,300 a month for 48 months, and this
-- function refuses to invent the half of the contract nobody told it about.
-- -----------------------------------------------------------------------------

create or replace function public.financing_projected_schedule(
  p_mode              public.financing_mode,
  p_financed_minor    bigint,
  p_rate_bps          integer,
  p_installments      integer,
  p_installment_minor bigint,
  p_first_payment_on  date,
  p_anchor_day        smallint,
  p_frequency         public.financing_frequency,
  p_balloon_minor     bigint default 0
)
returns table (
  sequence                  smallint,
  due_on                    date,
  expected_total_minor      bigint,
  expected_principal_minor  bigint,
  expected_interest_minor   bigint,
  remaining_principal_minor bigint,
  is_balloon                boolean
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_balloon   bigint := coalesce(p_balloon_minor, 0);
  v_anchor    smallint := coalesce(p_anchor_day, extract(day from p_first_payment_on)::smallint);
  v_rate      numeric;
  v_payment   bigint;
  v_balance   bigint;
  v_interest  bigint;
  v_principal bigint;
  v_total     bigint;
  k           integer;
  v_count     integer;
begin
  if p_first_payment_on is null then
    raise exception 'A schedule needs a first payment date.' using errcode = '22004';
  end if;

  -- --------------------------------------------------------------- simple
  if p_mode = 'simple' then
    if p_installment_minor is null or p_installment_minor <= 0 then
      raise exception 'A payment plan needs the amount of each payment.' using errcode = '22004';
    end if;
    if p_installments is null or p_installments < 1 then
      raise exception 'A payment plan needs the number of payments.' using errcode = '22004';
    end if;

    for k in 1 .. p_installments loop
      sequence                  := k::smallint;
      due_on                    := app.financing_due_date(p_first_payment_on, v_anchor, p_frequency, k - 1);
      expected_total_minor      := p_installment_minor;
      -- Unknown, and it stays unknown.
      expected_principal_minor  := null;
      expected_interest_minor   := null;
      remaining_principal_minor := null;
      is_balloon                := false;
      return next;
    end loop;

    if v_balloon > 0 then
      sequence                  := (p_installments + 1)::smallint;
      due_on                    := app.financing_due_date(p_first_payment_on, v_anchor, p_frequency, p_installments - 1);
      expected_total_minor      := v_balloon;
      expected_principal_minor  := null;
      expected_interest_minor   := null;
      remaining_principal_minor := null;
      is_balloon                := true;
      return next;
    end if;

    return;
  end if;

  -- ---------------------------------------------------------- amortizing
  if p_financed_minor is null or p_financed_minor <= 0 then
    raise exception 'An amortising loan needs the amount financed.' using errcode = '22004';
  end if;
  if p_rate_bps is null then
    raise exception 'An amortising loan needs a rate. Record a payment plan instead if the rate is unknown.'
      using errcode = '22004';
  end if;
  if p_installments is null or p_installments < 1 then
    raise exception 'An amortising loan needs a term.' using errcode = '22004';
  end if;
  if v_balloon >= p_financed_minor then
    raise exception 'A balloon of % cannot be as large as the amount financed (%).',
      v_balloon, p_financed_minor using errcode = '22023';
  end if;

  v_rate := p_rate_bps::numeric / (10000::numeric * app.financing_periods_per_year(p_frequency));

  -- The contract wins. A lender's stated instalment differs from the textbook
  -- figure for entirely ordinary reasons — their rounding convention, a fee
  -- folded in, an irregular first period — and overwriting it with ours would
  -- replace what the agency actually pays with what we think it should.
  v_payment := coalesce(
    nullif(p_installment_minor, 0),
    public.financing_annuity_payment(p_financed_minor, p_rate_bps, p_installments, p_frequency, v_balloon)
  );

  v_balance := p_financed_minor;

  -- A payment that does not even cover the first period's interest never repays
  -- anything. Say so rather than emitting a schedule that grows forever.
  if p_installments > 1 and v_payment <= round(v_balance::numeric * v_rate)::bigint then
    raise exception
      'An instalment of % does not cover the interest on % at this rate, so the balance would never fall. Check the rate, the term or the instalment.',
      v_payment, p_financed_minor
      using errcode = '22023';
  end if;

  for k in 1 .. p_installments loop
    v_interest := round(v_balance::numeric * v_rate)::bigint;

    if k = p_installments then
      -- The last instalment closes the balance onto the balloon exactly. Every
      -- rounding remainder accumulated above lands here deliberately, which is
      -- why the schedule always ends at zero and never at a stray centime.
      v_principal := v_balance - v_balloon;
    else
      v_principal := least(v_payment - v_interest, v_balance - v_balloon);
      if v_principal < 0 then
        v_principal := 0;
      end if;
    end if;

    v_total   := v_principal + v_interest;
    v_balance := v_balance - v_principal;

    sequence                  := k::smallint;
    due_on                    := app.financing_due_date(p_first_payment_on, v_anchor, p_frequency, k - 1);
    expected_total_minor      := v_total;
    expected_principal_minor  := v_principal;
    expected_interest_minor   := v_interest;
    remaining_principal_minor := v_balance;
    is_balloon                := false;
    return next;
  end loop;

  if v_balloon > 0 then
    -- Its own row, on the same day as the final instalment. A balloon hidden
    -- inside the last ordinary payment is a surprise nobody can plan for.
    sequence                  := (p_installments + 1)::smallint;
    due_on                    := app.financing_due_date(p_first_payment_on, v_anchor, p_frequency, p_installments - 1);
    expected_total_minor      := v_balloon;
    expected_principal_minor  := v_balloon;
    expected_interest_minor   := 0;
    remaining_principal_minor := 0;
    is_balloon                := true;
    return next;
  end if;

  get diagnostics v_count = row_count;
  return;
end;
$$;

comment on function public.financing_projected_schedule is
  'The expected obligations a set of terms implies. Simple mode returns NULL for principal and interest because nobody knows them; amortising mode closes to exactly zero.';

-- -----------------------------------------------------------------------------
-- Instalments, with what has actually been paid against them
--
-- Settlement is derived here and nowhere else. There is no `is_paid` column to
-- fall out of step with the payments, and two payments posted at the same
-- moment both count because both are rows.
-- -----------------------------------------------------------------------------

create or replace view public.financing_installment_status
with (security_invoker = true) as
select
  i.id,
  i.organization_id,
  i.agreement_id,
  i.sequence,
  i.due_on,
  i.expected_total_minor,
  i.expected_principal_minor,
  i.expected_interest_minor,
  i.expected_fees_minor,
  i.remaining_principal_minor,
  i.is_balloon,
  i.revision,
  a.currency,
  a.agreement_status,

  coalesce(paid.paid_minor, 0)::bigint        as paid_minor,
  coalesce(paid.principal_minor, 0)::bigint   as principal_paid_minor,
  coalesce(paid.interest_minor, 0)::bigint    as interest_paid_minor,
  coalesce(paid.fees_minor, 0)::bigint        as fees_paid_minor,
  coalesce(paid.unallocated_minor, 0)::bigint as unallocated_paid_minor,
  coalesce(paid.payment_count, 0)::bigint     as payment_count,

  greatest(i.expected_total_minor - coalesce(paid.paid_minor, 0), 0)::bigint as outstanding_minor,

  -- One overdue definition for the whole product, in the agency's own date.
  (
    a.agreement_status = 'active'
    and coalesce(paid.paid_minor, 0) < i.expected_total_minor
    and i.due_on < (now() at time zone coalesce(o.time_zone, 'UTC'))::date
  ) as is_overdue,

  case
    when a.agreement_status in ('cancelled', 'closed') then 'closed'
    when coalesce(paid.paid_minor, 0) >= i.expected_total_minor then 'paid'
    when i.due_on < (now() at time zone coalesce(o.time_zone, 'UTC'))::date then 'overdue'
    when coalesce(paid.paid_minor, 0) > 0 then 'partially_paid'
    when i.due_on = (now() at time zone coalesce(o.time_zone, 'UTC'))::date then 'due_today'
    else 'upcoming'
  end as state
from public.financing_installments i
join public.financing_agreements a on a.id = i.agreement_id
join public.organizations o on o.id = i.organization_id
left join lateral (
  select
    sum(p.amount_minor)      as paid_minor,
    sum(p.principal_minor)   as principal_minor,
    sum(p.interest_minor)    as interest_minor,
    sum(p.fees_minor)        as fees_minor,
    sum(p.unallocated_minor) as unallocated_minor,
    count(*)                 as payment_count
  from public.financing_payments p
  where p.installment_id = i.id
    and p.status = 'recorded'
) paid on true;

comment on view public.financing_installment_status is
  'Each expected obligation with what has actually been allocated to it. Settlement is derived from payments, never stored.';

-- -----------------------------------------------------------------------------
-- The agreement, as a manager reads it
--
-- One row per agreement carrying everything the list and the header need, so a
-- page of twenty-five agreements is one query rather than seventy-six.
-- -----------------------------------------------------------------------------

create or replace view public.financing_agreement_overview
with (security_invoker = true) as
select
  a.id,
  a.organization_id,
  a.vehicle_id,
  a.lender_id,
  a.agreement_type,
  a.agreement_status,
  a.mode,
  a.reference,
  a.currency,
  a.financed_amount_minor,
  a.down_payment_amount_minor,
  a.rate_bps,
  a.installment_amount_minor,
  a.installments_count,
  a.payment_frequency,
  a.schedule_anchor_day,
  a.balloon_minor,
  a.starts_on,
  a.ends_on,
  a.first_payment_on,
  a.payoff_on,
  a.closure_reason,
  a.schedule_revision,
  a.notes,
  a.activated_at,
  a.closed_at,
  a.created_at,
  a.updated_at,

  v.registration_plate as vehicle_plate,
  v.make               as vehicle_make,
  v.model              as vehicle_model,
  (v.archived_at is not null) as vehicle_archived,

  l.name       as lender_name,
  l.kind       as lender_kind,
  (l.archived_at is not null) as lender_archived,

  -- Actual cash, split the way the payments were actually recorded.
  coalesce(pay.cash_minor, 0)::bigint        as cash_paid_minor,
  coalesce(pay.principal_minor, 0)::bigint   as principal_paid_minor,
  coalesce(pay.interest_minor, 0)::bigint    as interest_paid_minor,
  coalesce(pay.fees_minor, 0)::bigint        as fees_paid_minor,
  coalesce(pay.unallocated_minor, 0)::bigint as unallocated_minor,
  coalesce(pay.payment_count, 0)::bigint     as payment_count,

  -- Interest plus fees. Never principal, and never the unallocated part.
  (coalesce(pay.interest_minor, 0) + coalesce(pay.fees_minor, 0))::bigint as financing_cost_minor,
  -- False when some payment's composition is unknown, so a caller can say
  -- "at least this much" instead of stating a figure it cannot support.
  (coalesce(pay.unallocated_minor, 0) = 0) as cost_complete,

  /*
   * Remaining principal exists only when the arithmetic actually supports it:
   * the amount financed has to be known, and every payment on file has to be
   * fully allocated. Otherwise it is NULL — never the remaining instalments
   * multiplied by the payment, which is not a principal balance at all.
   */
  case
    when a.financed_amount_minor is not null and coalesce(pay.unallocated_minor, 0) = 0
    then greatest(a.financed_amount_minor - coalesce(pay.principal_minor, 0), 0)::bigint
  end as remaining_principal_minor,

  (a.financed_amount_minor is not null and coalesce(pay.unallocated_minor, 0) = 0) as principal_known,

  coalesce(sched.scheduled_total_minor, 0)::bigint    as scheduled_total_minor,
  coalesce(sched.remaining_scheduled_minor, 0)::bigint as remaining_scheduled_minor,
  coalesce(sched.overdue_minor, 0)::bigint            as overdue_minor,
  coalesce(sched.overdue_count, 0)::bigint            as overdue_count,
  coalesce(sched.installment_rows, 0)::bigint         as installment_rows,
  sched.next_due_on,
  sched.next_due_minor
from public.financing_agreements a
join public.vehicles v on v.id = a.vehicle_id
join public.lenders  l on l.id = a.lender_id
left join lateral (
  select
    sum(p.amount_minor)      as cash_minor,
    sum(p.principal_minor)   as principal_minor,
    sum(p.interest_minor)    as interest_minor,
    sum(p.fees_minor)        as fees_minor,
    sum(p.unallocated_minor) as unallocated_minor,
    count(*)                 as payment_count
  from public.financing_payments p
  where p.agreement_id = a.id
    and p.status = 'recorded'
) pay on true
left join lateral (
  select
    sum(s.expected_total_minor)                             as scheduled_total_minor,
    sum(s.outstanding_minor)                                as remaining_scheduled_minor,
    sum(s.outstanding_minor) filter (where s.is_overdue)     as overdue_minor,
    count(*) filter (where s.is_overdue)                     as overdue_count,
    count(*)                                                 as installment_rows,
    min(s.due_on) filter (where s.outstanding_minor > 0)     as next_due_on,
    (
      select sum(n.outstanding_minor)
      from public.financing_installment_status n
      where n.agreement_id = a.id
        and n.outstanding_minor > 0
        and n.due_on = (
          select min(m.due_on)
          from public.financing_installment_status m
          where m.agreement_id = a.id and m.outstanding_minor > 0
        )
    )                                                        as next_due_minor
  from public.financing_installment_status s
  where s.agreement_id = a.id
) sched on true;

comment on view public.financing_agreement_overview is
  'One row per agreement with its vehicle, lender, actual cash position and derived obligations. remaining_principal_minor is NULL whenever the data cannot support a figure.';

-- -----------------------------------------------------------------------------
-- What is due, and what is late
--
-- The reminder foundation. It answers the question; it does not send anything,
-- and nothing in this module pretends a message was delivered.
-- -----------------------------------------------------------------------------

create or replace function public.financing_due_obligations(
  p_organization_id uuid,
  p_within_days     integer default 30
)
returns table (
  installment_id   uuid,
  agreement_id     uuid,
  vehicle_id       uuid,
  vehicle_plate    text,
  vehicle_make     text,
  vehicle_model    text,
  lender_name      text,
  reference        text,
  currency         public.currency_code,
  sequence         smallint,
  due_on           date,
  expected_total_minor bigint,
  outstanding_minor    bigint,
  is_balloon       boolean,
  is_overdue       boolean,
  days_until_due   integer,
  state            text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_today date;
begin
  if p_organization_id is null then
    raise exception 'An organization is required.' using errcode = '22004';
  end if;
  if not app.has_min_role(p_organization_id, 'manager') then
    raise exception 'Not permitted to view financing for this organization.' using errcode = '42501';
  end if;

  v_today := app.organization_today(p_organization_id);

  return query
  select
    s.id,
    s.agreement_id,
    a.vehicle_id,
    v.registration_plate,
    v.make,
    v.model,
    l.name,
    a.reference,
    s.currency,
    s.sequence,
    s.due_on,
    s.expected_total_minor,
    s.outstanding_minor,
    s.is_balloon,
    s.is_overdue,
    (s.due_on - v_today)::integer,
    s.state
  from public.financing_installment_status s
  join public.financing_agreements a on a.id = s.agreement_id
  join public.vehicles v on v.id = a.vehicle_id
  join public.lenders  l on l.id = a.lender_id
  where s.organization_id = p_organization_id
    and a.agreement_status = 'active'
    and s.outstanding_minor > 0
    -- Everything already late, plus everything falling due inside the window.
    and s.due_on <= v_today + greatest(coalesce(p_within_days, 30), 0)
  order by s.due_on, v.registration_plate;
end;
$$;

comment on function public.financing_due_obligations(uuid, integer) is
  'Obligations already overdue or falling due within the window, in the agency''s own business date. A read model for reminders — it sends nothing.';

-- -----------------------------------------------------------------------------
-- One vehicle's financing position
--
-- Deliberately separate from vehicle_operating_summary. That function answers
-- "did running this car pay for itself"; this one answers "what is the car's
-- debt doing". Combining them would produce a number that is neither.
-- -----------------------------------------------------------------------------

create or replace function public.vehicle_financing_summary(
  p_vehicle_id uuid,
  p_from       date,
  p_to         date
)
returns table (
  currency                 public.currency_code,
  agreement_count          bigint,
  active_agreement_count   bigint,
  cash_paid_minor          bigint,
  principal_paid_minor     bigint,
  interest_paid_minor      bigint,
  fees_paid_minor          bigint,
  unallocated_minor        bigint,
  financing_cost_minor     bigint,
  cost_complete            boolean,
  remaining_principal_minor bigint,
  principal_known          boolean,
  overdue_minor            bigint,
  next_due_on              date,
  next_due_minor           bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select v.organization_id into v_organization_id
  from public.vehicles v
  where v.id = p_vehicle_id;

  if v_organization_id is null or not app.has_min_role(v_organization_id, 'manager') then
    raise exception 'Vehicle not found.' using errcode = 'P0002';
  end if;

  return query
  with agreements as (
    select * from public.financing_agreement_overview o
    where o.vehicle_id = p_vehicle_id
  ),
  -- Cash inside the requested period, which is a different question from the
  -- lifetime position an agreement carries.
  period_payments as (
    select
      p.currency,
      sum(p.amount_minor)      as cash_minor,
      sum(p.principal_minor)   as principal_minor,
      sum(p.interest_minor)    as interest_minor,
      sum(p.fees_minor)        as fees_minor,
      sum(p.unallocated_minor) as unallocated_minor
    from public.financing_payments p
    join public.financing_agreements a on a.id = p.agreement_id
    where a.vehicle_id = p_vehicle_id
      and p.status = 'recorded'
      and p.paid_on >= p_from
      and p.paid_on <  p_to
    group by p.currency
  ),
  positions as (
    select
      a.currency,
      count(*)                                          as agreements,
      count(*) filter (where a.agreement_status = 'active') as active_agreements,
      -- NULL the moment any agreement in this currency cannot support a figure,
      -- because a partial sum of principal balances is not a principal balance.
      case when bool_and(a.principal_known)
           then sum(a.remaining_principal_minor)::bigint end as remaining_principal,
      bool_and(a.principal_known)                       as principal_known,
      sum(a.overdue_minor)::bigint                      as overdue,
      min(a.next_due_on) filter (where a.agreement_status = 'active') as next_due
    from agreements a
    group by a.currency
  )
  select
    coalesce(positions.currency, period_payments.currency),
    coalesce(positions.agreements, 0),
    coalesce(positions.active_agreements, 0),
    coalesce(period_payments.cash_minor, 0)::bigint,
    coalesce(period_payments.principal_minor, 0)::bigint,
    coalesce(period_payments.interest_minor, 0)::bigint,
    coalesce(period_payments.fees_minor, 0)::bigint,
    coalesce(period_payments.unallocated_minor, 0)::bigint,
    (coalesce(period_payments.interest_minor, 0) + coalesce(period_payments.fees_minor, 0))::bigint,
    (coalesce(period_payments.unallocated_minor, 0) = 0),
    positions.remaining_principal,
    coalesce(positions.principal_known, true),
    coalesce(positions.overdue, 0)::bigint,
    positions.next_due,
    (
      select sum(s.outstanding_minor)::bigint
      from public.financing_installment_status s
      join public.financing_agreements a2 on a2.id = s.agreement_id
      where a2.vehicle_id = p_vehicle_id
        and a2.agreement_status = 'active'
        and s.outstanding_minor > 0
        and s.due_on = positions.next_due
    )
  from positions
  full outer join period_payments on period_payments.currency = positions.currency
  order by 1;
end;
$$;

comment on function public.vehicle_financing_summary(uuid, date, date) is
  'One vehicle''s financing position by currency. Cash figures are for the period; the principal balance is the lifetime position and is NULL when it cannot be derived.';

-- -----------------------------------------------------------------------------
-- The agency's financing position
-- -----------------------------------------------------------------------------

create or replace function public.organization_financing_summary(
  p_organization_id uuid,
  p_from            date,
  p_to              date
)
returns table (
  currency                  public.currency_code,
  agreement_count           bigint,
  active_agreement_count    bigint,
  draft_agreement_count     bigint,
  cash_paid_minor           bigint,
  principal_paid_minor      bigint,
  interest_paid_minor       bigint,
  fees_paid_minor           bigint,
  unallocated_minor         bigint,
  financing_cost_minor      bigint,
  cost_complete             boolean,
  remaining_principal_minor bigint,
  unknown_principal_count   bigint,
  overdue_minor             bigint,
  overdue_count             bigint,
  due_soon_minor            bigint,
  due_soon_count            bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_today date;
begin
  if p_organization_id is null then
    raise exception 'An organization is required.' using errcode = '22004';
  end if;
  if not app.has_min_role(p_organization_id, 'manager') then
    raise exception 'Not permitted to view financing for this organization.' using errcode = '42501';
  end if;

  v_today := app.organization_today(p_organization_id);

  return query
  with agreements as (
    select * from public.financing_agreement_overview o
    where o.organization_id = p_organization_id
  ),
  period_payments as (
    select
      p.currency,
      sum(p.amount_minor)      as cash_minor,
      sum(p.principal_minor)   as principal_minor,
      sum(p.interest_minor)    as interest_minor,
      sum(p.fees_minor)        as fees_minor,
      sum(p.unallocated_minor) as unallocated_minor
    from public.financing_payments p
    where p.organization_id = p_organization_id
      and p.status = 'recorded'
      and p.paid_on >= p_from
      and p.paid_on <  p_to
    group by p.currency
  ),
  upcoming as (
    select
      s.currency,
      sum(s.outstanding_minor) filter (where s.due_on between v_today and v_today + 30) as due_soon_minor,
      count(*) filter (where s.due_on between v_today and v_today + 30)                 as due_soon_count
    from public.financing_installment_status s
    join public.financing_agreements a on a.id = s.agreement_id
    where s.organization_id = p_organization_id
      and a.agreement_status = 'active'
      and s.outstanding_minor > 0
    group by s.currency
  ),
  positions as (
    select
      a.currency,
      count(*)                                                   as agreements,
      count(*) filter (where a.agreement_status = 'active')       as active_agreements,
      count(*) filter (where a.agreement_status = 'draft')        as draft_agreements,
      -- Only agreements whose balance is actually derivable are summed, and the
      -- rest are counted so the interface can say how many are missing.
      sum(a.remaining_principal_minor) filter (where a.principal_known
                                                 and a.agreement_status = 'active')::bigint as remaining_principal,
      count(*) filter (where not a.principal_known and a.agreement_status = 'active')        as unknown_principal,
      sum(a.overdue_minor)::bigint                               as overdue_minor,
      sum(a.overdue_count)::bigint                               as overdue_count
    from agreements a
    group by a.currency
  )
  select
    coalesce(positions.currency, period_payments.currency, upcoming.currency),
    coalesce(positions.agreements, 0),
    coalesce(positions.active_agreements, 0),
    coalesce(positions.draft_agreements, 0),
    coalesce(period_payments.cash_minor, 0)::bigint,
    coalesce(period_payments.principal_minor, 0)::bigint,
    coalesce(period_payments.interest_minor, 0)::bigint,
    coalesce(period_payments.fees_minor, 0)::bigint,
    coalesce(period_payments.unallocated_minor, 0)::bigint,
    (coalesce(period_payments.interest_minor, 0) + coalesce(period_payments.fees_minor, 0))::bigint,
    (coalesce(period_payments.unallocated_minor, 0) = 0),
    positions.remaining_principal,
    coalesce(positions.unknown_principal, 0),
    coalesce(positions.overdue_minor, 0)::bigint,
    coalesce(positions.overdue_count, 0),
    coalesce(upcoming.due_soon_minor, 0)::bigint,
    coalesce(upcoming.due_soon_count, 0)
  from positions
  full outer join period_payments on period_payments.currency = positions.currency
  full outer join upcoming on upcoming.currency = coalesce(positions.currency, period_payments.currency)
  order by 1;
end;
$$;

comment on function public.organization_financing_summary(uuid, date, date) is
  'The agency''s financing position, one row per currency. Two currencies are never added; an underivable principal balance is excluded and counted rather than treated as zero.';

-- -----------------------------------------------------------------------------
-- Writing a schedule
--
-- Transactional by construction: an agreement and the obligations it implies
-- become true together or not at all.
-- -----------------------------------------------------------------------------

/*
 * SECURITY DEFINER, deliberately and narrowly.
 *
 * The schedule is derived data. The application holds SELECT on
 * `financing_installments` and nothing else, precisely so that an obligation
 * can only ever come from these terms — there is no path by which a browser
 * writes a due date. That makes this one of the few places where a definer
 * function is the right answer rather than a shortcut, so it carries its own
 * membership and role check, an empty search_path, and fully qualified names.
 */
create or replace function public.financing_generate_schedule(p_agreement_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.financing_agreements;
  v_written   integer;
begin
  select * into v_agreement
  from public.financing_agreements
  where id = p_agreement_id
  for update;

  -- A cross-tenant id and an id that never existed answer identically.
  if v_agreement.id is null or not app.has_min_role(v_agreement.organization_id, 'admin') then
    raise exception 'Financing agreement not found.' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.financing_payments p
    where p.agreement_id = p_agreement_id and p.status = 'recorded'
  ) then
    raise exception
      'Payments have been recorded against this agreement, so its schedule can no longer be regenerated.'
      using errcode = '23514';
  end if;

  delete from public.financing_installments where agreement_id = p_agreement_id;

  insert into public.financing_installments (
    organization_id, agreement_id, sequence, due_on,
    expected_total_minor, expected_principal_minor, expected_interest_minor,
    remaining_principal_minor, is_balloon, revision
  )
  select
    v_agreement.organization_id,
    v_agreement.id,
    s.sequence,
    s.due_on,
    s.expected_total_minor,
    s.expected_principal_minor,
    s.expected_interest_minor,
    s.remaining_principal_minor,
    s.is_balloon,
    v_agreement.schedule_revision
  from public.financing_projected_schedule(
    v_agreement.mode,
    v_agreement.financed_amount_minor,
    v_agreement.rate_bps,
    v_agreement.installments_count::integer,
    v_agreement.installment_amount_minor,
    v_agreement.first_payment_on,
    v_agreement.schedule_anchor_day,
    v_agreement.payment_frequency,
    coalesce(v_agreement.balloon_minor, 0)
  ) s;

  get diagnostics v_written = row_count;

  -- The scheduled end date follows from the schedule rather than being typed in
  -- twice and allowed to disagree with it.
  update public.financing_agreements
     set ends_on = (select max(i.due_on) from public.financing_installments i where i.agreement_id = p_agreement_id)
   where id = p_agreement_id;

  return v_written;
end;
$$;

comment on function public.financing_generate_schedule(uuid) is
  'Replaces an agreement''s expected schedule from its current terms. Refuses once any payment has been recorded.';

/* Definer for the same reason, and with the same check: it writes a schedule. */
create or replace function public.financing_activate_agreement(p_agreement_id uuid)
returns public.financing_agreements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.financing_agreements;
begin
  select * into v_agreement
  from public.financing_agreements
  where id = p_agreement_id
  for update;

  if v_agreement.id is null or not app.has_min_role(v_agreement.organization_id, 'admin') then
    raise exception 'Financing agreement not found.' using errcode = 'P0002';
  end if;

  if v_agreement.agreement_status <> 'draft' then
    raise exception 'Only a draft agreement can be activated.' using errcode = '23514';
  end if;

  perform public.financing_generate_schedule(p_agreement_id);

  update public.financing_agreements
     set agreement_status = 'active',
         activated_at = now(),
         updated_by = (select auth.uid())
   where id = p_agreement_id
  returning * into v_agreement;

  return v_agreement;
end;
$$;

comment on function public.financing_activate_agreement(uuid) is
  'Turns a draft into a live agreement and writes its schedule in the same transaction.';

-- -----------------------------------------------------------------------------
-- Recording what was actually paid
-- -----------------------------------------------------------------------------

create or replace function public.financing_record_payment(
  p_agreement_id    uuid,
  p_paid_on         date,
  p_amount_minor    bigint,
  p_installment_id  uuid default null,
  p_principal_minor bigint default null,
  p_interest_minor  bigint default null,
  p_fees_minor      bigint default null,
  p_purpose         public.financing_payment_purpose default 'installment',
  p_method          public.payment_method default null,
  p_reference       text default null,
  p_notes           text default null
)
returns public.financing_payments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_agreement   public.financing_agreements;
  v_principal   bigint := coalesce(p_principal_minor, 0);
  v_interest    bigint := coalesce(p_interest_minor, 0);
  v_fees        bigint := coalesce(p_fees_minor, 0);
  v_unallocated bigint;
  v_payment     public.financing_payments;
begin
  -- Read, not locked. A locking clause makes PostgreSQL apply the UPDATE policy
  -- as well, so a manager — who may read an agreement but not change one —
  -- would be told it does not exist instead of being told they may not record a
  -- payment. The insert below is where the permission belongs, and the payment's
  -- own foreign key already holds the agreement against a concurrent delete.
  select * into v_agreement
  from public.financing_agreements
  where id = p_agreement_id;

  if v_agreement.id is null then
    raise exception 'Financing agreement not found.' using errcode = 'P0002';
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'A payment has to be more than nothing.' using errcode = '22023';
  end if;

  /*
   * Whatever the components do not explain stays unallocated. The desk is never
   * asked to invent a principal/interest split in order to save a payment it
   * genuinely made, and nothing downstream treats the remainder as interest.
   */
  v_unallocated := p_amount_minor - (v_principal + v_interest + v_fees);

  if v_unallocated < 0 then
    raise exception
      'The principal, interest and fees add up to more than the payment itself.'
      using errcode = '23514';
  end if;

  insert into public.financing_payments (
    organization_id, agreement_id, installment_id, purpose,
    paid_on, currency, amount_minor,
    principal_minor, interest_minor, fees_minor, unallocated_minor,
    method, reference, notes
  ) values (
    v_agreement.organization_id, p_agreement_id, p_installment_id, p_purpose,
    p_paid_on, v_agreement.currency, p_amount_minor,
    v_principal, v_interest, v_fees, v_unallocated,
    p_method, nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning * into v_payment;

  return v_payment;
end;
$$;

comment on function public.financing_record_payment is
  'Records a lender payment and allocates it. Anything the components do not explain becomes unallocated, which is honest rather than a guessed split.';

create or replace function public.financing_void_payment(
  p_payment_id uuid,
  p_reason     text default null
)
returns public.financing_payments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_payment public.financing_payments;
begin
  select * into v_payment
  from public.financing_payments
  where id = p_payment_id
  for update;

  if v_payment.id is null then
    raise exception 'Financing payment not found.' using errcode = 'P0002';
  end if;

  if v_payment.status = 'voided' then
    raise exception 'That payment has already been voided.' using errcode = '23514';
  end if;

  update public.financing_payments
     set status = 'voided',
         voided_at = now(),
         voided_by = (select auth.uid()),
         void_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         updated_by = (select auth.uid())
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

comment on function public.financing_void_payment(uuid, text) is
  'Reverses a lender payment without destroying it. The instalment it settled reopens by exactly the amount voided.';

-- -----------------------------------------------------------------------------
-- Ending an agreement
-- -----------------------------------------------------------------------------

create or replace function public.financing_close_agreement(
  p_agreement_id uuid,
  p_status       public.financing_agreement_status,
  p_reason       text default null,
  p_payoff_on    date default null
)
returns public.financing_agreements
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_agreement public.financing_agreements;
  v_position  record;
begin
  select * into v_agreement
  from public.financing_agreements
  where id = p_agreement_id
  for update;

  if v_agreement.id is null then
    raise exception 'Financing agreement not found.' using errcode = 'P0002';
  end if;

  if p_status not in ('paid_off', 'closed', 'cancelled') then
    raise exception 'An agreement is ended as paid off, closed or cancelled.' using errcode = '22023';
  end if;

  /*
   * Paid off is a claim about the world, not a dropdown value. It is allowed
   * only when the obligation has actually been met: every scheduled instalment
   * settled, and — where a principal balance can be derived at all — nothing
   * left on it. An agreement that is merely being ended for another reason is
   * closed, with the reason recorded.
   */
  if p_status = 'paid_off' then
    select
      coalesce(sum(s.outstanding_minor), 0) as outstanding,
      count(*)                              as rows_total
    into v_position
    from public.financing_installment_status s
    where s.agreement_id = p_agreement_id;

    if coalesce(v_position.rows_total, 0) = 0 then
      raise exception
        'This agreement has no schedule, so there is nothing to say it has been paid off. Close it with a reason instead.'
        using errcode = '23514';
    end if;

    if v_position.outstanding > 0 then
      raise exception
        'This agreement still has % outstanding on its schedule. Record the remaining payments, or close it with a reason.',
        v_position.outstanding
        using errcode = '23514';
    end if;

    if v_agreement.financed_amount_minor is not null then
      declare
        v_unallocated bigint;
        v_principal   bigint;
      begin
        select coalesce(sum(p.unallocated_minor), 0), coalesce(sum(p.principal_minor), 0)
          into v_unallocated, v_principal
        from public.financing_payments p
        where p.agreement_id = p_agreement_id and p.status = 'recorded';

        -- Only refuse when the balance is actually knowable and actually unpaid.
        -- An agreement whose payments were never split cannot be contradicted.
        if v_unallocated = 0 and v_principal < v_agreement.financed_amount_minor then
          raise exception
            'Principal of % is still outstanding under this agreement''s own figures. Record the payoff, or close it with a reason.',
            v_agreement.financed_amount_minor - v_principal
            using errcode = '23514';
        end if;
      end;
    end if;
  end if;

  if p_status in ('closed', 'cancelled') and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why this agreement is being ended.' using errcode = '22004';
  end if;

  update public.financing_agreements
     set agreement_status = p_status,
         closure_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         payoff_on = case when p_status = 'paid_off' then coalesce(p_payoff_on, app.organization_today(organization_id)) end,
         closed_at = now(),
         closed_by = (select auth.uid()),
         updated_by = (select auth.uid())
   where id = p_agreement_id
  returning * into v_agreement;

  return v_agreement;
end;
$$;

comment on function public.financing_close_agreement is
  'Ends an agreement. Paid off has to be earned: the schedule must be settled and any derivable principal balance must be zero.';

-- -----------------------------------------------------------------------------
-- Duplicates, warned about and never merged
-- -----------------------------------------------------------------------------

create or replace function public.find_duplicate_lenders(
  p_organization_id  uuid,
  p_name             text,
  p_tax_identifier   text default null,
  p_exclude_lender_id uuid default null
)
returns table (
  lender_id     uuid,
  name          text,
  archived_at   timestamptz,
  match_reason  text,
  match_strength text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if not app.has_min_role(p_organization_id, 'manager') then
    raise exception 'Not permitted to view lenders for this organization.' using errcode = '42501';
  end if;

  return query
  select
    l.id,
    l.name,
    l.archived_at,
    case
      when p_tax_identifier is not null
           and btrim(p_tax_identifier) <> ''
           and upper(btrim(l.tax_identifier)) = upper(btrim(p_tax_identifier))
      then 'Same tax identifier'
      when l.archived_at is not null then 'Same name, currently retired'
      else 'Same name'
    end,
    case
      when p_tax_identifier is not null
           and btrim(p_tax_identifier) <> ''
           and upper(btrim(l.tax_identifier)) = upper(btrim(p_tax_identifier))
      then 'strong'
      else 'weak'
    end
  from public.lenders l
  where l.organization_id = p_organization_id
    and (p_exclude_lender_id is null or l.id <> p_exclude_lender_id)
    and (
      l.name_normalized = upper(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
      or (
        p_tax_identifier is not null and btrim(p_tax_identifier) <> ''
        and upper(btrim(l.tax_identifier)) = upper(btrim(p_tax_identifier))
      )
    )
  order by 5 desc, l.name
  limit 10;
end;
$$;

comment on function public.find_duplicate_lenders(uuid, text, text, uuid) is
  'Lenders resembling the one being entered. A shared tax identifier is a strong signal; a shared name is not. Nothing is ever merged.';

create or replace function public.find_duplicate_financing_payments(
  p_agreement_id  uuid,
  p_paid_on       date,
  p_amount_minor  bigint,
  p_reference     text default null,
  p_exclude_payment_id uuid default null
)
returns table (
  payment_id    uuid,
  paid_on       date,
  amount_minor  bigint,
  reference     text,
  match_reason  text,
  match_strength text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select a.organization_id into v_organization_id
  from public.financing_agreements a
  where a.id = p_agreement_id;

  -- Indistinguishable from a missing agreement, on purpose.
  if v_organization_id is null or not app.has_min_role(v_organization_id, 'manager') then
    return;
  end if;

  return query
  select
    p.id,
    p.paid_on,
    p.amount_minor,
    p.reference,
    case
      when p_reference is not null and btrim(p_reference) <> ''
           and upper(btrim(p.reference)) = upper(btrim(p_reference))
      then 'Same lender reference'
      else 'Same amount on the same day'
    end,
    case
      when p_reference is not null and btrim(p_reference) <> ''
           and upper(btrim(p.reference)) = upper(btrim(p_reference))
      then 'strong'
      else 'weak'
    end
  from public.financing_payments p
  where p.agreement_id = p_agreement_id
    and p.status = 'recorded'
    and (p_exclude_payment_id is null or p.id <> p_exclude_payment_id)
    and (
      (p_reference is not null and btrim(p_reference) <> ''
        and upper(btrim(p.reference)) = upper(btrim(p_reference)))
      or (p.paid_on = p_paid_on and p.amount_minor = p_amount_minor)
    )
  order by 6 desc, p.paid_on desc
  limit 5;
end;
$$;

comment on function public.find_duplicate_financing_payments is
  'Payments resembling the one being entered. Warns; never blocks and never merges — a lender really can be paid the same amount twice in a day.';

create or replace function public.lender_usage(p_lender_id uuid)
returns table (agreement_count bigint, can_delete boolean)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_count bigint;
begin
  select l.organization_id into v_organization_id
  from public.lenders l where l.id = p_lender_id;

  if v_organization_id is null or not app.has_min_role(v_organization_id, 'manager') then
    raise exception 'Lender not found.' using errcode = 'P0002';
  end if;

  select count(*) into v_count
  from public.financing_agreements a
  where a.lender_id = p_lender_id;

  return query select v_count, (v_count = 0);
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

-- A new function is granted to PUBLIC by default, and `anon` is a member of
-- PUBLIC. Revoking from the role alone would leave that inherited grant behind,
-- which is exactly the defect 20260814110000 was written to close.
revoke all on function public.financing_annuity_payment(bigint, integer, integer, public.financing_frequency, bigint) from public, anon;
revoke all on function public.financing_projected_schedule(public.financing_mode, bigint, integer, integer, bigint, date, smallint, public.financing_frequency, bigint) from public, anon;
revoke all on function public.financing_due_obligations(uuid, integer) from public, anon;
revoke all on function public.vehicle_financing_summary(uuid, date, date) from public, anon;
revoke all on function public.organization_financing_summary(uuid, date, date) from public, anon;
revoke all on function public.financing_generate_schedule(uuid) from public, anon;
revoke all on function public.financing_activate_agreement(uuid) from public, anon;
revoke all on function public.financing_record_payment(uuid, date, bigint, uuid, bigint, bigint, bigint, public.financing_payment_purpose, public.payment_method, text, text) from public, anon;
revoke all on function public.financing_void_payment(uuid, text) from public, anon;
revoke all on function public.financing_close_agreement(uuid, public.financing_agreement_status, text, date) from public, anon;
revoke all on function public.find_duplicate_lenders(uuid, text, text, uuid) from public, anon;
revoke all on function public.find_duplicate_financing_payments(uuid, date, bigint, text, uuid) from public, anon;
revoke all on function public.lender_usage(uuid) from public, anon;

grant execute on function public.financing_annuity_payment(bigint, integer, integer, public.financing_frequency, bigint) to authenticated;
grant execute on function public.financing_projected_schedule(public.financing_mode, bigint, integer, integer, bigint, date, smallint, public.financing_frequency, bigint) to authenticated;
grant execute on function public.financing_due_obligations(uuid, integer) to authenticated;
grant execute on function public.vehicle_financing_summary(uuid, date, date) to authenticated;
grant execute on function public.organization_financing_summary(uuid, date, date) to authenticated;
grant execute on function public.financing_generate_schedule(uuid) to authenticated;
grant execute on function public.financing_activate_agreement(uuid) to authenticated;
grant execute on function public.financing_record_payment(uuid, date, bigint, uuid, bigint, bigint, bigint, public.financing_payment_purpose, public.payment_method, text, text) to authenticated;
grant execute on function public.financing_void_payment(uuid, text) to authenticated;
grant execute on function public.financing_close_agreement(uuid, public.financing_agreement_status, text, date) to authenticated;
grant execute on function public.find_duplicate_lenders(uuid, text, text, uuid) to authenticated;
grant execute on function public.find_duplicate_financing_payments(uuid, date, bigint, text, uuid) to authenticated;
grant execute on function public.lender_usage(uuid) to authenticated;

-- A view is created with a PUBLIC grant, and `anon` is a member of PUBLIC, so
-- the grant has to be taken away before the one the application needs is given.
-- Both are SECURITY INVOKER, so RLS would still have refused — but the boundary
-- belongs where it was designed to be, not one layer further in.
revoke all on public.financing_installment_status from public, anon, authenticated;
revoke all on public.financing_agreement_overview from public, anon, authenticated;

grant select on public.financing_installment_status to authenticated;
grant select on public.financing_agreement_overview to authenticated;

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

select app.assert_views_are_security_invoker();

-- An amortising schedule has to close to exactly zero. Asserted here so a
-- rounding regression fails the migration rather than a customer's balance.
do $$
declare
  v_last record;
  v_sum  bigint;
begin
  select * into v_last
  from public.financing_projected_schedule(
    'amortizing', 15000000, 725, 48, null, date '2027-01-31', 31::smallint, 'monthly', 0
  )
  order by sequence desc limit 1;

  if v_last.remaining_principal_minor <> 0 then
    raise exception 'amortising schedule closed at % rather than zero', v_last.remaining_principal_minor;
  end if;

  select sum(expected_principal_minor) into v_sum
  from public.financing_projected_schedule(
    'amortizing', 15000000, 725, 48, null, date '2027-01-31', 31::smallint, 'monthly', 0
  );

  if v_sum <> 15000000 then
    raise exception 'amortising principal summed to % rather than the amount financed', v_sum;
  end if;
end
$$;
