-- =============================================================================
-- An agreement ends once
--
-- Two administrators pressing "End agreement" at the same moment both
-- succeeded. The status trigger only refuses a *change* of status, and the
-- second call was not changing one — it set `closed` on an agreement that was
-- already closed — so it fell through and quietly overwrote the first
-- administrator's reason with its own.
--
-- Nothing was corrupted, but the record said the wrong thing about why an
-- agreement ended, and the documented lifecycle says `closed → nothing`. The
-- RPC now refuses a status the agreement already has, which makes the race
-- resolve the way it reads: exactly one closure applies and the other is told
-- why it did not.
--
-- Found by the live smoke suite running the two calls concurrently. The PGlite
-- suite had only ever closed an agreement once.
-- =============================================================================

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

  -- Ended once. The lock above serialises two callers; this is what the second
  -- one is told, rather than being allowed to rewrite the first one's reason.
  if v_agreement.agreement_status = p_status then
    raise exception 'This agreement is already %.', p_status using errcode = '23514';
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
  'Ends an agreement, once. Paid off has to be earned: the schedule must be settled and any derivable principal balance must be zero.';

revoke all on function public.financing_close_agreement(uuid, public.financing_agreement_status, text, date) from public, anon;
grant execute on function public.financing_close_agreement(uuid, public.financing_agreement_status, text, date) to authenticated;

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
