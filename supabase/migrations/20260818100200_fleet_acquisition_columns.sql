-- =============================================================================
-- Acquisition on the fleet read model
--
-- The vehicle page shows how a car was acquired beside what is owed on it, and
-- it reads `vehicle_fleet` rather than `vehicles`. Appending the columns keeps
-- every existing consumer working — a replace can add at the end but not in the
-- middle, and dropping the view would take the four read models that depend on
-- it with it.
-- =============================================================================

create or replace view public.vehicle_fleet
with (security_invoker = true)
as
select
  v.id                       as vehicle_id,
  v.organization_id,
  v.make,
  v.model,
  v.model_year,
  v.registration_plate,
  v.vin,
  v.color,
  v.category,
  v.fuel_type,
  v.transmission,
  v.seats,
  v.odometer,
  v.daily_rate_minor,
  v.currency,
  v.insurance_expires_on,
  v.inspection_expires_on,
  v.registration_expires_on,
  v.next_service_on,
  v.notes,
  v.created_at,
  v.updated_at,
  v.archived_at,
  v.status                   as operational_status,

  current_rental.id          as current_rental_id,
  current_rental.reference   as current_rental_reference,
  current_rental.customer_id as current_customer_id,
  current_rental.ends_at     as current_rental_ends_at,

  next_rental.id             as next_rental_id,
  next_rental.reference      as next_rental_reference,
  next_rental.customer_id    as next_customer_id,
  next_rental.starts_at      as next_rental_starts_at,

  case
    when v.archived_at is not null      then 'unavailable'::public.vehicle_status
    when v.status <> 'available'        then v.status
    when current_rental.id is not null  then 'rented'::public.vehicle_status
    when next_rental.id is not null
     and next_rental.starts_at <= now() then 'reserved'::public.vehicle_status
    else 'available'::public.vehicle_status
  end                        as effective_status,

  -- True when the vehicle can be handed to a customer right now.
  (
    v.archived_at is null
    and v.status = 'available'
    and current_rental.id is null
    and (next_rental.id is null or next_rental.starts_at > now())
  )                          as is_available_now,

  -- Acquisition. A fact about the car, true whether or not anybody financed it,
  -- and stored with its own currency so changing the agency default cannot
  -- rewrite what a vehicle cost.
  v.acquisition_method,
  v.acquired_on,
  v.acquisition_price_minor,
  v.acquisition_currency,
  v.acquisition_supplier,
  v.acquisition_notes
from public.vehicles v

-- The contract the vehicle is out on at this moment.
left join lateral (
  select r.id, r.reference, r.customer_id, r.ends_at
  from public.rentals r
  where r.vehicle_id = v.id
    and r.status = 'active'
    and r.starts_at <= now()
    and r.ends_at > now()
  order by r.starts_at
  limit 1
) current_rental on true

-- The soonest commitment that has not finished yet.
left join lateral (
  select r.id, r.reference, r.customer_id, r.starts_at
  from public.rentals r
  where r.vehicle_id = v.id
    and r.status = 'reserved'
    and r.ends_at > now()
  order by r.starts_at
  limit 1
) next_rental on true;

comment on view public.vehicle_fleet is
  'The fleet as the product reads it: a vehicle''s own columns, how it was acquired, and its derived occupancy. SECURITY INVOKER, so RLS applies to whoever queries it.';

revoke all on public.vehicle_fleet from anon, authenticated;
grant select on public.vehicle_fleet to authenticated;

select app.assert_views_are_security_invoker();
