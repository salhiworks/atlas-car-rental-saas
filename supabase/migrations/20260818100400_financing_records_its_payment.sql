-- =============================================================================
-- An amortising loan records the payment it actually has
--
-- When the agency does not type a contract instalment, the schedule computes
-- the level payment from the amount financed, the rate and the term — and every
-- ordinary instalment in the schedule is that number. But the agreement row
-- kept `installment_amount_minor` NULL, so the Terms panel and the financing
-- list both showed "—" for a loan whose payment is on screen twelve times
-- immediately below.
--
-- NULL was the right thing to store while the agreement was a draft: nobody had
-- said what the payment was. Once a schedule exists the payment is no longer
-- unknown — it is derived and it is definite — so it is recorded.
--
-- The rule about the contract winning is untouched: a stated instalment is
-- never overwritten. This only fills in what was blank.
--
-- Found by looking at the page in a browser.
-- =============================================================================

create or replace function public.financing_generate_schedule(p_agreement_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.financing_agreements;
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
         installment_amount_minor = coalesce(installment_amount_minor, v_level)
   where id = p_agreement_id;

  return v_written;
end;
$$;

comment on function public.financing_generate_schedule(uuid) is
  'Replaces an agreement''s expected schedule from its current terms, and records the level payment when the terms did not state one. Refuses once any payment has been recorded.';

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
