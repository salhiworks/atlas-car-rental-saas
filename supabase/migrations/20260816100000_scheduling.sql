-- =============================================================================
-- 20260816100000_scheduling.sql
--
-- The read model and the one new domain operation the Calendar needs.
--
-- The Calendar is a view over the rentals domain, not a second copy of it. It
-- introduces no booking table, no availability state and no status of its own:
-- `rentals_no_vehicle_overlap` remains the single authority on whether a vehicle
-- is free, and every change the Calendar initiates goes through a transactional
-- function in this schema.
--
-- Three things genuinely belong here rather than in the browser:
--
--   1. OVERDUE. It was defined in two places and they disagreed — the board
--      called a rental overdue whenever an active contract passed its end time,
--      even if the vehicle had already been brought back and was simply waiting
--      to be closed. One definition now, used by every read model.
--
--   2. THE NEXT COMMITMENT. "This car is due back at 14:00 and the next customer
--      arrives at 15:00" is the single most useful thing a rental desk can be
--      told, and computing it in the browser would mean shipping the whole
--      schedule to work it out per row.
--
--   3. RESCHEDULING. Moving a booking touches the period, possibly the vehicle,
--      the day count, and — if a contract has been issued — the contract itself.
--      As separate client writes that is four chances to leave a contract
--      describing something that never happened.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Overdue, defined once
--
-- Operationally overdue means: out with a customer, past the agreed return, and
-- nobody has recorded it coming back. It is derived, never stored — a late
-- rental is not a different kind of contract, and giving it its own status
-- would make "late" something that has to be set and unset correctly.
-- -----------------------------------------------------------------------------

create or replace function public.rental_is_overdue(
  p_status      public.rental_status,
  p_ends_at     timestamptz,
  p_returned_at timestamptz
)
returns boolean
language sql
stable
parallel safe
as $$
  select p_status = 'active' and p_ends_at < now() and p_returned_at is null;
$$;

comment on function public.rental_is_overdue(public.rental_status, timestamptz, timestamptz) is
  'The single definition of an operationally overdue rental: active, past its return time, and not yet returned.';

revoke all on function public.rental_is_overdue(public.rental_status, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.rental_is_overdue(public.rental_status, timestamptz, timestamptz)
  to authenticated;

-- -----------------------------------------------------------------------------
-- The scheduling read model
--
-- One row per rental, carrying what a schedule block has to show and the two
-- derived facts a timeline cannot work out for itself: whether the rental is
-- late, and what is booked on that vehicle next.
--
-- Deliberately narrower than `rental_board`: no contract PDF paths, no charge
-- breakdown. A month of a hundred-vehicle fleet is a lot of rows, and a
-- schedule block cannot display any of that.
-- -----------------------------------------------------------------------------

create or replace view public.rental_schedule
with (security_invoker = true) as
select
  r.id,
  r.organization_id,
  r.reference,
  r.status,
  r.starts_at,
  r.ends_at,
  r.original_ends_at,
  r.pickup_location,
  r.return_location,
  r.picked_up_at,
  r.returned_at,
  r.extension_count,

  r.currency,
  r.total_minor,
  r.balance_due_minor,
  r.deposit_held_minor,
  r.payment_status,

  r.vehicle_id,
  v.make          as vehicle_make,
  v.model         as vehicle_model,
  v.registration_plate as vehicle_plate,

  r.customer_id,
  c.display_name  as customer_name,

  -- The renter pays; the primary driver drives. Usually one person, and the
  -- schedule has to make it obvious when they are not.
  primary_driver.customer_id  as primary_driver_id,
  primary_driver.display_name as primary_driver_name,
  (primary_driver.customer_id is not null and primary_driver.customer_id <> r.customer_id)
    as renter_is_not_driver,
  driver_count.total as driver_count,

  public.rental_is_overdue(r.status, r.ends_at, r.returned_at) as is_overdue,

  -- What this vehicle is committed to next. Only live commitments count: a
  -- draft holds nothing, and a cancelled booking is not a turnaround.
  next_booking.id        as next_rental_id,
  next_booking.reference as next_rental_reference,
  next_booking.starts_at as next_rental_starts_at,
  case
    when next_booking.starts_at is null then null
    else greatest(
      0,
      floor(extract(epoch from (next_booking.starts_at - greatest(r.ends_at, now()))) / 60)
    )::integer
  end as turnaround_minutes,

  -- A contract exists and has not been superseded, so a material change to this
  -- booking has to amend it rather than quietly contradict it.
  live_contract.version  as contract_version,
  live_contract.status   as contract_status,
  (live_contract.id is not null) as has_live_contract
from public.rentals r
join public.vehicles v on v.id = r.vehicle_id
join public.customers c on c.id = r.customer_id
left join lateral (
  select rd.customer_id, dc.display_name
  from public.rental_drivers rd
  join public.customers dc on dc.id = rd.customer_id
  where rd.rental_id = r.id and rd.driver_role = 'primary'
  limit 1
) primary_driver on true
left join lateral (
  select count(*) as total from public.rental_drivers rd where rd.rental_id = r.id
) driver_count on true
left join lateral (
  select n.id, n.reference, n.starts_at
  from public.rentals n
  where n.vehicle_id = r.vehicle_id
    and n.id <> r.id
    and n.status in ('reserved', 'active')
    and n.starts_at >= r.ends_at
  order by n.starts_at
  limit 1
) next_booking on true
left join lateral (
  select rc.id, rc.version, rc.status
  from public.rental_contracts rc
  where rc.rental_id = r.id and rc.status in ('issued', 'signed')
  order by rc.version desc
  limit 1
) live_contract on true;

comment on view public.rental_schedule is
  'One row per rental for the fleet timeline: the block''s facts plus the two derived ones — whether it is overdue, and what that vehicle is committed to next. security_invoker, so RLS applies to every source table.';

revoke all on public.rental_schedule from anon, authenticated;
grant select on public.rental_schedule to authenticated;

-- -----------------------------------------------------------------------------
-- The board's overdue column now uses the shared definition
--
-- It previously called any active rental past its end time overdue, including
-- one whose vehicle was already back and simply waiting to be closed off. The
-- Calendar and the Rentals list must not disagree about what "late" means.
-- -----------------------------------------------------------------------------

create or replace view public.rental_board
with (security_invoker = true) as
select
  r.id,
  r.organization_id,
  r.reference,
  r.status,
  r.starts_at,
  r.ends_at,
  r.pickup_location,
  r.return_location,
  r.currency,
  r.total_minor,
  r.amount_paid_minor,
  r.balance_due_minor,
  r.deposit_minor,
  r.deposit_held_minor,
  r.payment_status,
  r.picked_up_at,
  r.returned_at,
  r.extension_count,
  r.created_at,

  r.vehicle_id,
  v.make          as vehicle_make,
  v.model         as vehicle_model,
  v.model_year    as vehicle_model_year,
  v.registration_plate as vehicle_plate,

  r.customer_id,
  c.display_name  as customer_name,
  c.customer_type as customer_type,

  primary_driver.customer_id   as primary_driver_id,
  primary_driver.display_name  as primary_driver_name,
  (primary_driver.customer_id is not null and primary_driver.customer_id <> r.customer_id)
    as renter_is_not_driver,

  driver_count.total as driver_count,

  public.rental_is_overdue(r.status, r.ends_at, r.returned_at) as is_overdue,

  contract.version    as contract_version,
  contract.status     as contract_status,
  contract.pdf_path   as contract_pdf_path,
  contract.signed_at  as contract_signed_at
from public.rentals r
join public.vehicles v on v.id = r.vehicle_id
join public.customers c on c.id = r.customer_id
left join lateral (
  select rd.customer_id, dc.display_name
  from public.rental_drivers rd
  join public.customers dc on dc.id = rd.customer_id
  where rd.rental_id = r.id and rd.driver_role = 'primary'
  limit 1
) primary_driver on true
left join lateral (
  select count(*) as total from public.rental_drivers rd where rd.rental_id = r.id
) driver_count on true
left join lateral (
  select rc.version, rc.status, rc.pdf_path, rc.signed_at
  from public.rental_contracts rc
  where rc.rental_id = r.id
  order by rc.version desc
  limit 1
) contract on true;

comment on view public.rental_board is
  'One row per rental with the joined facts the list screen shows. security_invoker, so RLS applies to every source table.';

revoke all on public.rental_board from anon, authenticated;
grant select on public.rental_board to authenticated;

-- -----------------------------------------------------------------------------
-- Rescheduling
--
-- The one genuinely new domain operation the Calendar needs. Dragging a block
-- can change three things at once — when it starts, when it ends, and which
-- vehicle it is on — and a contract may already have been issued describing all
-- three. As separate writes that is several chances to leave a signed document
-- describing a booking that no longer exists.
--
-- SECURITY INVOKER, so RLS and the role policies apply to the caller exactly as
-- they would to a direct write. Somebody who cannot update a rental does not
-- gain the ability by dragging it.
-- -----------------------------------------------------------------------------

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

comment on function public.rental_reschedule(uuid, timestamptz, timestamptz, uuid, boolean) is
  'Moves a draft or reserved booking in time and/or onto another vehicle, in one transaction. Refuses a booking with a live contract unless amendment is consented to, and then issues a new contract version.';

revoke all on function public.rental_reschedule(uuid, timestamptz, timestamptz, uuid, boolean)
  from public, anon;
grant execute on function public.rental_reschedule(uuid, timestamptz, timestamptz, uuid, boolean)
  to authenticated;

-- -----------------------------------------------------------------------------
-- Range index
--
-- The schedule query is "everything overlapping this window", which is
-- `starts_at < window_end and ends_at > window_start`. The existing
-- (organization_id, starts_at, ends_at) index handles the first half; this one
-- makes the second half a range-index probe rather than a filter, which is what
-- keeps a month of a large fleet cheap.
-- -----------------------------------------------------------------------------

create index if not exists rentals_schedule_range_idx
  on public.rentals using gist (organization_id, tstzrange(starts_at, ends_at, '[)'));

comment on index public.rentals_schedule_range_idx is
  'Supports the Calendar''s "everything overlapping this window" query.';

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

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

do $$
declare
  v_unprotected text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and (not c.relrowsecurity
         or not exists (select 1 from pg_policy p where p.polrelid = c.oid));

  if v_unprotected is not null then
    raise exception 'Row Level Security is missing or unpoliced on: %', v_unprotected;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
