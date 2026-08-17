-- =============================================================================
-- Two more findings from reviewing the module against itself
--
-- 1. A constraint permitted a state the schedule generator refuses. The mode
--    requirements accepted a payment plan that had `ends_on` but no number of
--    payments, while `financing_projected_schedule` needs the count and says
--    so. Nothing in the product produces that shape — the form requires the
--    count — but a constraint that allows a row the rest of the system cannot
--    use is a trap left for whoever writes the next importer.
--
-- 2. `schedule_revision` never moved. It exists so an instalment can be traced
--    to the terms that produced it, and every instalment was stamped revision 1
--    no matter how many times the schedule was regenerated. A marker that never
--    changes marks nothing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A live agreement has everything its schedule needs
-- -----------------------------------------------------------------------------

alter table public.financing_agreements
  drop constraint if exists financing_agreements_mode_requirements;

alter table public.financing_agreements
  add constraint financing_agreements_mode_requirements check (
    agreement_status = 'draft'
    or (
      first_payment_on is not null
      -- Both modes count their payments. `ends_on` is derived from the schedule
      -- rather than typed in beside it, so it cannot stand in for the term.
      and installments_count is not null
      and case mode
            when 'simple'     then installment_amount_minor is not null
            when 'amortizing' then financed_amount_minor is not null and rate_bps is not null
          end
    )
  );

-- -----------------------------------------------------------------------------
-- 2. A revision marker that actually moves
-- -----------------------------------------------------------------------------

create or replace function public.financing_generate_schedule(p_agreement_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.financing_agreements;
  v_existing  integer;
  v_revision  integer;
  v_written   integer;
  v_level     bigint;
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

  select count(*) into v_existing
  from public.financing_installments i
  where i.agreement_id = p_agreement_id;

  -- The first schedule is revision 1; every replacement is the next number, so
  -- an instalment can be traced to the terms it came from.
  v_revision := case when v_existing > 0 then v_agreement.schedule_revision + 1
                     else v_agreement.schedule_revision end;

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
    v_revision
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

  -- The level payment the schedule settled on: the amount every ordinary
  -- instalment shares. The final one differs by the rounding it absorbs, and a
  -- balloon is not an instalment, so both are excluded.
  if v_agreement.installment_amount_minor is null then
    select i.expected_total_minor into v_level
    from public.financing_installments i
    where i.agreement_id = p_agreement_id
      and not i.is_balloon
    group by i.expected_total_minor
    order by count(*) desc, i.expected_total_minor
    limit 1;
  end if;

  update public.financing_agreements
     set ends_on = (select max(i.due_on) from public.financing_installments i where i.agreement_id = p_agreement_id),
         installment_amount_minor = coalesce(installment_amount_minor, v_level),
         schedule_revision = v_revision
   where id = p_agreement_id;

  return v_written;
end;
$$;

revoke all on function public.financing_generate_schedule(uuid) from public, anon;
grant execute on function public.financing_generate_schedule(uuid) to authenticated;

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
