-- =============================================================================
-- 20260813090400_rentals.sql
--
-- Rental contracts and their authorized drivers.
--
-- Two things here are worth reading closely:
--
--   1. `rentals_no_vehicle_overlap` is a GiST exclusion constraint. A vehicle
--      cannot be committed to two overlapping periods, full stop — not "unless
--      there is a race", not "unless someone calls the API directly". Availability
--      is a database invariant, which is what a booking system requires.
--
--   2. Money is never recomputed from a rate at read time. Totals are stored in
--      minor units alongside the currency they were agreed in, so a contract
--      signed last year still reads correctly after the agency switches currency.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- Per-agency contract numbering counter. Lives on the settings row rather than
-- in a separate table because it is a setting: agencies choose the prefix.
alter table public.organization_settings
  add column if not exists rental_reference_next bigint not null default 1
    check (rental_reference_next >= 1);

-- -----------------------------------------------------------------------------
-- rentals
-- -----------------------------------------------------------------------------

create table if not exists public.rentals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  reference       text not null check (char_length(reference) between 3 and 40),

  vehicle_id      uuid not null,
  customer_id     uuid not null,

  status          public.rental_status not null default 'draft',

  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  pickup_location text check (pickup_location is null or char_length(pickup_location) <= 160),
  return_location text check (return_location is null or char_length(return_location) <= 160),

  -- Pricing, all in `currency`, all integer minor units.
  currency          public.currency_code not null,
  daily_rate_minor  bigint not null default 0 check (daily_rate_minor >= 0),
  billable_days     integer check (billable_days is null or billable_days >= 0),
  subtotal_minor    bigint not null default 0 check (subtotal_minor >= 0),
  extras_minor      bigint not null default 0 check (extras_minor >= 0),
  discount_minor    bigint not null default 0 check (discount_minor >= 0),
  tax_minor         bigint not null default 0 check (tax_minor >= 0),
  total_minor       bigint not null default 0 check (total_minor >= 0),
  deposit_minor     bigint not null default 0 check (deposit_minor >= 0),

  -- Maintained by the payments trigger; never written directly by clients.
  amount_paid_minor bigint not null default 0 check (amount_paid_minor >= 0),

  balance_due_minor bigint generated always as (total_minor - amount_paid_minor) stored,

  -- Each branch is cast individually. Casting the CASE *result* instead would
  -- leave a runtime text->enum conversion in the expression, and enum input is
  -- only STABLE, which a generated column may not use.
  payment_status public.rental_payment_status generated always as (
    case
      when amount_paid_minor = 0           then 'unpaid'::public.rental_payment_status
      when amount_paid_minor < total_minor then 'partially_paid'::public.rental_payment_status
      when amount_paid_minor = total_minor then 'paid'::public.rental_payment_status
      else                                      'overpaid'::public.rental_payment_status
    end
  ) stored,

  -- Condition capture at handover.
  pickup_odometer     integer check (pickup_odometer is null or pickup_odometer >= 0),
  return_odometer     integer check (return_odometer is null or return_odometer >= 0),
  pickup_fuel_percent smallint check (pickup_fuel_percent is null or pickup_fuel_percent between 0 and 100),
  return_fuel_percent smallint check (return_fuel_percent is null or return_fuel_percent between 0 and 100),

  notes         text check (notes is null or char_length(notes) <= 4000),
  cancelled_at  timestamptz,
  completed_at  timestamptz,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint rentals_tenant_key unique (id, organization_id),
  constraint rentals_reference_unique unique (organization_id, reference),
  constraint rentals_period_valid check (ends_at > starts_at),
  constraint rentals_odometer_progression check (
    return_odometer is null or pickup_odometer is null or return_odometer >= pickup_odometer
  ),
  constraint rentals_discount_within_charges check (
    discount_minor <= subtotal_minor + extras_minor
  ),

  constraint rentals_vehicle_fkey
    foreign key (vehicle_id, organization_id)
    references public.vehicles (id, organization_id)
    on delete restrict,

  constraint rentals_customer_fkey
    foreign key (customer_id, organization_id)
    references public.customers (id, organization_id)
    on delete restrict,

  -- The core availability invariant. Only commitments block the vehicle:
  -- drafts, cancellations and completed contracts do not.
  constraint rentals_no_vehicle_overlap exclude using gist (
    vehicle_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('reserved', 'active'))
);

comment on table public.rentals is 'A rental contract. Availability is enforced by the rentals_no_vehicle_overlap exclusion constraint.';
comment on column public.rentals.amount_paid_minor is
  'Denormalised sum of settled payments. Maintained by app.sync_rental_payment_totals(); do not write directly.';
comment on constraint rentals_no_vehicle_overlap on public.rentals is
  'Prevents double-booking a vehicle across reserved/active contracts.';

create index if not exists rentals_organization_status_idx
  on public.rentals (organization_id, status, starts_at desc);

create index if not exists rentals_period_idx
  on public.rentals (organization_id, starts_at, ends_at);

create index if not exists rentals_vehicle_idx on public.rentals (vehicle_id, starts_at desc);
create index if not exists rentals_customer_idx on public.rentals (customer_id, starts_at desc);

create index if not exists rentals_outstanding_idx
  on public.rentals (organization_id)
  where status in ('reserved', 'active', 'completed');

drop trigger if exists rentals_set_updated_at on public.rentals;
create trigger rentals_set_updated_at
  before update on public.rentals
  for each row execute function app.set_updated_at();

drop trigger if exists rentals_freeze_columns on public.rentals;
create trigger rentals_freeze_columns
  before update on public.rentals
  -- `amount_paid_minor` is deliberately absent here: it is not immutable, it is
  -- *derived*. The payments migration installs a dedicated guard that lets only
  -- the payment-sync path write it.
  for each row execute function app.freeze_columns(
    'id', 'organization_id', 'reference', 'created_at', 'created_by'
  );

-- -----------------------------------------------------------------------------
-- Contract numbering
--
-- Serialised per organization by taking the settings row's lock, so concurrent
-- contract creation cannot mint the same reference twice.
-- -----------------------------------------------------------------------------

create or replace function app.assign_rental_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_next   bigint;
begin
  if new.reference is not null and btrim(new.reference) <> '' then
    return new;
  end if;

  update public.organization_settings
     set rental_reference_next = rental_reference_next + 1
   where organization_id = new.organization_id
  returning rental_reference_prefix, rental_reference_next - 1
    into v_prefix, v_next;

  if v_next is null then
    -- Settings row missing (should be impossible after provisioning).
    v_prefix := 'RNT';
    v_next := (
      select count(*) + 1
      from public.rentals r
      where r.organization_id = new.organization_id
    );
  end if;

  new.reference := v_prefix || '-' || lpad(v_next::text, 5, '0');
  return new;
end;
$$;

drop trigger if exists rentals_assign_reference on public.rentals;
create trigger rentals_assign_reference
  before insert on public.rentals
  for each row execute function app.assign_rental_reference();

-- -----------------------------------------------------------------------------
-- rental_drivers — authorized drivers on a contract
-- -----------------------------------------------------------------------------

create table if not exists public.rental_drivers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  rental_id       uuid not null,
  customer_id     uuid not null,
  driver_role     public.rental_driver_role not null default 'additional',

  -- Licence details are snapshotted at signature time: the contract must remain
  -- an accurate record even if the customer record is edited afterwards.
  license_number      text check (license_number is null or char_length(license_number) <= 64),
  license_country     public.country_code,
  license_expires_on  date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rental_drivers_unique_per_rental unique (rental_id, customer_id),

  constraint rental_drivers_rental_fkey
    foreign key (rental_id, organization_id)
    references public.rentals (id, organization_id)
    on delete cascade,

  constraint rental_drivers_customer_fkey
    foreign key (customer_id, organization_id)
    references public.customers (id, organization_id)
    on delete restrict
);

comment on table public.rental_drivers is
  'Drivers authorised on a contract, including the primary renter. Licence fields are a snapshot taken at signature.';

create unique index if not exists rental_drivers_single_primary_idx
  on public.rental_drivers (rental_id)
  where driver_role = 'primary';

create index if not exists rental_drivers_customer_idx on public.rental_drivers (customer_id);

drop trigger if exists rental_drivers_set_updated_at on public.rental_drivers;
create trigger rental_drivers_set_updated_at
  before update on public.rental_drivers
  for each row execute function app.set_updated_at();

drop trigger if exists rental_drivers_freeze_columns on public.rental_drivers;
create trigger rental_drivers_freeze_columns
  before update on public.rental_drivers
  for each row execute function app.freeze_columns('id', 'organization_id', 'rental_id', 'created_at');
