-- =============================================================================
-- 20260816100100_reschedule_agreed_period.sql
--
-- Rescheduling renegotiates the period; it does not extend it.
--
-- `original_ends_at` means "the return date first agreed", and it exists so an
-- extension is visible: the rental page shows "Originally 12 March" beside a
-- hire that was lengthened after the customer had already taken the car.
--
-- Moving a booking on the schedule board is a different act. It happens before
-- anybody has collected anything, both ends of the period move, and — when a
-- contract exists — a new version is issued stating the new dates. Leaving the
-- old value in place made a plain move read as though the hire had been
-- extended, which is a claim about the customer that is simply not true.
--
-- The newly agreed return therefore becomes the agreed return. Nothing is lost:
-- the superseded contract version still states, immutably, what was agreed
-- before.
-- =============================================================================

set search_path = public, extensions, pg_temp;

create or replace function public.rental_reschedule(
  p_rental_id uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_vehicle_id uuid default null,
  /**
   * Consent to a new contract version. A booking with a live contract cannot be
   * moved silently: the caller is refused once, told which contract is
   * affected, and has to ask again meaning it.
   */
  p_amend_contract boolean default false
)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental  public.rentals;
  v_vehicle public.vehicles;
  v_target  uuid;
  v_contract public.rental_contracts;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;

  -- A vehicle that is out with a customer cannot be moved on the board: its
  -- period is changed by extending it, and its end by recording the return.
  if v_rental.status not in ('draft', 'reserved') then
    raise exception
      'Only a draft or a confirmed reservation can be rescheduled. Extend or return this rental instead.'
      using errcode = '23514';
  end if;

  if p_starts_at is null or p_ends_at is null then
    raise exception 'A rental needs both a collection and a return time.' using errcode = '22004';
  end if;

  if p_ends_at <= p_starts_at then
    raise exception 'The return must be after the collection.' using errcode = '23514';
  end if;

  v_target := coalesce(p_vehicle_id, v_rental.vehicle_id);

  if v_target <> v_rental.vehicle_id then
    select * into v_vehicle from public.vehicles where id = v_target;

    -- RLS already scopes this select; the explicit check turns "invisible" into
    -- a clear message rather than a confusing null.
    if v_vehicle.id is null or v_vehicle.organization_id <> v_rental.organization_id then
      raise exception 'Vehicle not found.' using errcode = 'P0002';
    end if;
    if v_vehicle.archived_at is not null then
      raise exception 'That vehicle has been retired from the fleet.' using errcode = '23514';
    end if;
    if v_vehicle.status <> 'available' then
      raise exception 'That vehicle is not in service.' using errcode = '23514';
    end if;
  end if;

  select * into v_contract
  from public.rental_contracts
  where rental_id = p_rental_id and status in ('issued', 'signed')
  order by version desc
  limit 1;

  if v_contract.id is not null and not p_amend_contract then
    raise exception
      'Contract % states this booking. Rescheduling it requires issuing a new version.',
      v_contract.contract_number
      using errcode = '23514';
  end if;

  -- The exclusion constraint decides. If the new period collides with another
  -- commitment the whole transaction aborts and the booking keeps the dates it
  -- had — there is no half-applied move.
  update public.rentals
     set starts_at = p_starts_at,
         ends_at   = p_ends_at,
         vehicle_id = v_target,
         -- The renegotiated return is now the agreed return, so the rental does
         -- not present a plain move as an extension of the customer's hire.
         original_ends_at = p_ends_at,
         -- The day count follows the period; the charges deliberately do not.
         -- Repricing somebody's contract because a block was nudged would be a
         -- worse surprise than a day count that no longer matches its lines,
         -- which the interface shows and the desk can correct.
         billable_days = public.rental_billable_days(p_starts_at, p_ends_at)
   where id = p_rental_id
  returning * into v_rental;

  if v_contract.id is not null then
    perform public.rental_issue_contract(p_rental_id, 'Rescheduled');
  end if;

  return v_rental;
end;
$$;

revoke all on function public.rental_reschedule(uuid, timestamptz, timestamptz, uuid, boolean)
  from public, anon;
grant execute on function public.rental_reschedule(uuid, timestamptz, timestamptz, uuid, boolean)
  to authenticated;

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
