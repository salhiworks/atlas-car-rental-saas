-- =============================================================================
-- A voided cost refuses an edit rather than quietly undoing it
--
-- The guard restored the frozen columns and let the UPDATE report success. The
-- data survived, which is the important half — but PostgREST returned the row
-- as though the change had been applied, so a caller was told "saved" about an
-- edit that never happened. On a financial record that is worse than an error:
-- the desk walks away believing a figure was corrected.
--
-- Found by the live smoke suite, which asserted the operation should not appear
-- to succeed. The PGlite test only asserted the value was preserved, so it
-- passed against the weaker behaviour; it now asserts the refusal.
-- =============================================================================

create or replace function app.guard_expense_void()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'voided' then
    if new.status <> 'voided' then
      raise exception 'A voided expense cannot be reinstated. Record a new one.'
        using errcode = '23514';
    end if;

    -- Nothing about a voided cost is editable. It is the record of a
    -- correction, and a record that can be rewritten records nothing.
    raise exception 'A voided expense is kept exactly as it was. Record a new cost instead.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function app.guard_expense_void() is
  'Refuses every update to a voided expense, including reinstatement. The transition into voided is not affected: that update sees a recorded row.';

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

do $$
declare
  v_org      uuid;
  v_category uuid;
  v_expense  uuid;
  v_edited   boolean := false;
begin
  insert into public.organizations (name, slug, default_currency, time_zone)
  values ('Void Guard Probe', 'void-guard-probe-' || substr(md5(random()::text), 1, 12), 'EUR', 'UTC')
  returning id into v_org;

  select id into v_category
  from public.expense_categories
  where organization_id = v_org and system_key = 'office';

  insert into public.expenses
    (organization_id, category_id, allocation, amount_minor, currency, incurred_on, description)
  values (v_org, v_category, 'overhead', 1000, 'EUR', current_date, 'probe')
  returning id into v_expense;

  -- The transition into voided must still work.
  update public.expenses set status = 'voided', voided_at = now() where id = v_expense;

  begin
    update public.expenses set amount_minor = 999999 where id = v_expense;
    v_edited := true;
  exception when others then
    null;
  end;

  delete from public.organizations where id = v_org;

  if v_edited then
    raise exception 'a voided expense still accepted an edit';
  end if;
end
$$;

select app.assert_views_are_security_invoker();
