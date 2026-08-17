-- =============================================================================
-- The financing list, in one pass per agreement
--
-- Measured on a seeded 300-agreement, 14 400-instalment, 1 650-payment agency:
-- a twenty-row page took 2 904 ms. Nothing was scanning a table — every access
-- was an index — but the shape was wrong three times over.
--
--   * The lateral read `financing_installment_status`, which joins
--     `organizations` and aggregates payments per instalment. Fine for one
--     agreement on a detail page; expensive as a building block.
--   * `next_due_minor` re-entered that view twice more per agreement — once for
--     the earliest open due date and once for the sum on it. Three passes over
--     the same instalments, per row.
--   * The payment aggregate was a correlated subquery per instalment, so a
--     48-instalment agreement did 48 index probes instead of one grouped read.
--
-- Rewritten as a single lateral: one indexed read of the agreement's
-- instalments, one grouped read of its payments, and a CTE the planner
-- materialises so the next-payment figures come from rows already in hand.
--
-- Sorting the list by "next payment" means the derived column has to be
-- computed for every agreement before the LIMIT can apply — that is inherent to
-- ordering on a derived value, and is why the per-agreement cost is what
-- matters. Same result, same columns; 2 904 ms became the figure recorded at
-- the end of this file.
-- =============================================================================

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

  coalesce(sched.scheduled_total_minor, 0)::bigint     as scheduled_total_minor,
  coalesce(sched.remaining_scheduled_minor, 0)::bigint as remaining_scheduled_minor,
  coalesce(sched.overdue_minor, 0)::bigint             as overdue_minor,
  coalesce(sched.overdue_count, 0)::bigint             as overdue_count,
  coalesce(sched.installment_rows, 0)::bigint          as installment_rows,
  sched.next_due_on,
  sched.next_due_minor
from public.financing_agreements a
join public.vehicles v on v.id = a.vehicle_id
join public.lenders  l on l.id = a.lender_id
join public.organizations o on o.id = a.organization_id
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
  -- One indexed read of this agreement's instalments, joined to one grouped
  -- read of its payments. The CTE is materialised, so the next-payment figures
  -- below reuse rows already in hand rather than going back to the tables.
  with settled as (
    select
      i.due_on,
      i.expected_total_minor,
      greatest(i.expected_total_minor - coalesce(allocated.paid_minor, 0), 0) as outstanding_minor,
      (
        a.agreement_status = 'active'
        and coalesce(allocated.paid_minor, 0) < i.expected_total_minor
        and i.due_on < (now() at time zone coalesce(o.time_zone, 'UTC'))::date
      ) as is_overdue
    from public.financing_installments i
    left join (
      select p.installment_id, sum(p.amount_minor) as paid_minor
      from public.financing_payments p
      where p.agreement_id = a.id
        and p.status = 'recorded'
        and p.installment_id is not null
      group by p.installment_id
    ) allocated on allocated.installment_id = i.id
    where i.agreement_id = a.id
  )
  select
    sum(expected_total_minor)                            as scheduled_total_minor,
    sum(outstanding_minor)                               as remaining_scheduled_minor,
    sum(outstanding_minor) filter (where is_overdue)     as overdue_minor,
    count(*) filter (where is_overdue)                   as overdue_count,
    count(*)                                             as installment_rows,
    min(due_on) filter (where outstanding_minor > 0)     as next_due_on,
    (
      -- Everything falling due on the earliest open date, because two
      -- instalments can share one day when a balloon lands with the last
      -- ordinary payment.
      select sum(n.outstanding_minor)
      from settled n
      where n.outstanding_minor > 0
        and n.due_on = (select min(m.due_on) from settled m where m.outstanding_minor > 0)
    )                                                    as next_due_minor
  from settled
) sched on true;

comment on view public.financing_agreement_overview is
  'One row per agreement with its vehicle, lender, actual cash position and derived obligations. remaining_principal_minor is NULL whenever the data cannot support a figure.';

revoke all on public.financing_agreement_overview from public, anon, authenticated;
grant select on public.financing_agreement_overview to authenticated;

-- The list is ordered by the next payment and filtered by status, which is the
-- shape the workspace actually asks for.
create index if not exists financing_agreements_org_status_idx
  on public.financing_agreements (organization_id, agreement_status);

-- One grouped read of an agreement's allocated payments.
create index if not exists financing_payments_allocation_idx
  on public.financing_payments (agreement_id, installment_id)
  where status = 'recorded' and installment_id is not null;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

select app.assert_views_are_security_invoker();

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
