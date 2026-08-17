-- =============================================================================
-- 20260824100000_rental_usage_not_found.sql
--
-- `rental_usage` answers "not found" with no rows instead of an exception.
--
-- THE DEFECT
--
-- Opening /rentals/<id> for an id that does not exist — a stale bookmark, a
-- mistyped URL, a contract somebody deleted — raised `P0002`, which PostgREST
-- returns as HTTP 500. The interface was never wrong about it: the record's own
-- reads answer PGRST116 and the page says "That record could not be found", and
-- the usage call is a background query whose failure is swallowed. But an
-- ordinary bad URL should not produce a server error in the logs of a product
-- that is otherwise careful to distinguish a failure from an absence.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
--
-- The function is set-returning. "There is no such rental, or none you may see"
-- is expressible in its own return type as zero rows, so that is what it
-- returns. Nothing else moves:
--
--   * A rental that does not exist and a rental belonging to another agency
--     still produce the IDENTICAL answer — zero rows, no message, no code.
--     Indistinguishability was the point of the original raise and it survives:
--     the membership test is unchanged and is still applied before any count is
--     read.
--   * A rental the caller may see is unaffected: one row, the same six columns.
--   * `can_delete` is absent rather than true, so the one control it gates —
--     "Delete draft" — stays hidden. The client already defaults a missing row
--     to `can_delete: false`, so the interface needs no change and fails closed
--     either way.
--   * The grants are restated exactly as they were: revoked from PUBLIC and
--     anon, executable by authenticated only.
--
-- This does not make absence into success anywhere else. Functions that mutate,
-- and functions whose contract is a single row, still raise — an operation that
-- did not happen must never answer 200.
-- =============================================================================

create or replace function public.rental_usage(p_rental_id uuid)
returns table (
  line_item_count   bigint,
  payment_count     bigint,
  contract_count    bigint,
  photo_count       bigint,
  driver_count      bigint,
  can_delete        boolean
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_status public.rental_status;
begin
  select r.organization_id, r.status into v_organization_id, v_status
  from public.rentals r
  where r.id = p_rental_id;

  /*
   * No such rental, or one this caller is not a member of the agency for. The
   * two are answered the same way on purpose: a caller must not be able to
   * learn that an id exists by the shape of the refusal.
   */
  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    return;
  end if;

  return query
  with counts as (
    select
      (select count(*) from public.rental_line_items l where l.rental_id = p_rental_id) as line_items,
      (select count(*) from public.payments p where p.rental_id = p_rental_id)          as payments,
      (select count(*) from public.rental_contracts rc where rc.rental_id = p_rental_id) as contracts,
      (select count(*) from public.rental_condition_photos ph where ph.rental_id = p_rental_id) as photos,
      (select count(*) from public.rental_drivers rd where rd.rental_id = p_rental_id)  as drivers
  )
  select
    counts.line_items,
    counts.payments,
    counts.contracts,
    counts.photos,
    counts.drivers,
    -- Only an untouched draft. Once money has moved or a contract has been
    -- issued, the record is history and cancellation is the honest answer.
    (v_status = 'draft' and counts.payments = 0 and counts.contracts = 0)
  from counts;
end;
$$;

comment on function public.rental_usage(uuid) is
  'What a rental would take with it if deleted. Returns no rows when the rental does not exist or the caller is not a member of its agency — the two are indistinguishable.';

revoke all on function public.rental_usage(uuid) from public, anon;
grant execute on function public.rental_usage(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

do $$
declare
  v_source text;
begin
  select p.prosrc into v_source
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rental_usage';

  -- The membership test is what makes another agency's rental indistinguishable
  -- from one that does not exist. Losing it would turn this function into an
  -- existence oracle for every rental id in the database.
  if v_source not like '%app.is_org_member(v_organization_id)%' then
    raise exception 'rental_usage must test membership before reporting anything.';
  end if;

  -- And it must still answer without raising, which is the whole point of this
  -- migration.
  if v_source like '%P0002%' then
    raise exception 'rental_usage must answer a missing rental with no rows, not an exception.';
  end if;

  if has_function_privilege('anon', 'public.rental_usage(uuid)', 'EXECUTE') then
    raise exception 'The anonymous role can execute rental_usage.';
  end if;

  if not has_function_privilege('authenticated', 'public.rental_usage(uuid)', 'EXECUTE') then
    raise exception 'A signed-in user can no longer execute rental_usage.';
  end if;
end
$$;

select app.assert_views_are_security_invoker();
