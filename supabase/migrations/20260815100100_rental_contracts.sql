-- =============================================================================
-- 20260815100100_rental_contracts.sql
--
-- Contracts, terms, condition photographs, and the atomic operations the rental
-- desk performs.
--
-- THE POINT OF THE SNAPSHOT
--
-- A signed contract is a record of what was agreed on a particular day. If the
-- document is rendered by joining live rows, then correcting a customer's
-- surname, renewing their passport, re-plating a vehicle or repricing the fleet
-- silently rewrites history — and last month's signed contract now says
-- something nobody signed.
--
-- So issuing a contract freezes everything legally relevant into a jsonb
-- snapshot, and the document is rendered from that and only that. Amendments
-- create a new version; earlier versions are superseded, never edited.
--
-- WHY THESE FUNCTIONS EXIST
--
-- Checking a vehicle out touches the rental, the vehicle's odometer and the
-- handover record. Doing that as three client writes means a network failure
-- can leave a rental active with no odometer, or a vehicle whose mileage went
-- backwards. Each lifecycle step is therefore one function and one transaction.
--
-- They are SECURITY INVOKER: RLS and the role policies apply to the caller
-- exactly as they would to a direct write, so these add atomicity without
-- adding privilege.
-- =============================================================================

set search_path = public, extensions, pg_temp;

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'contract_status' and typnamespace = 'public'::regnamespace
  ) then
    create type public.contract_status as enum ('issued', 'signed', 'superseded', 'voided');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Agency contract terms
--
-- Every clause is the agency's own text. The product ships no legal wording,
-- because a sentence that is standard in one country is unenforceable in the
-- next, and presenting generated boilerplate as valid terms would be worse than
-- presenting none.
-- -----------------------------------------------------------------------------

alter table public.organization_settings
  add column if not exists contract_terms text check (contract_terms is null or char_length(contract_terms) <= 20000),
  add column if not exists fuel_policy text check (fuel_policy is null or char_length(fuel_policy) <= 2000),
  add column if not exists mileage_policy text check (mileage_policy is null or char_length(mileage_policy) <= 2000),
  add column if not exists late_return_policy text check (late_return_policy is null or char_length(late_return_policy) <= 2000),
  add column if not exists damage_policy text check (damage_policy is null or char_length(damage_policy) <= 2000),
  add column if not exists deposit_policy text check (deposit_policy is null or char_length(deposit_policy) <= 2000),
  add column if not exists contract_footer text check (contract_footer is null or char_length(contract_footer) <= 1000),
  -- Bumped whenever any of the above changes, so a snapshot records which
  -- wording it captured.
  add column if not exists terms_version integer not null default 1 check (terms_version >= 1),
  add column if not exists tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 100000),
  add column if not exists tax_label text check (tax_label is null or char_length(tax_label) <= 40);

comment on column public.organization_settings.terms_version is
  'Incremented automatically when contract wording changes. Issued contracts record the version they used.';
comment on column public.organization_settings.tax_rate_bps is
  'Default tax applied to new contracts, in basis points. 20% is 2000. No jurisdiction is assumed.';

create or replace function app.bump_terms_version()
returns trigger
language plpgsql
as $$
begin
  if (new.contract_terms      is distinct from old.contract_terms)
  or (new.fuel_policy         is distinct from old.fuel_policy)
  or (new.mileage_policy      is distinct from old.mileage_policy)
  or (new.late_return_policy  is distinct from old.late_return_policy)
  or (new.damage_policy       is distinct from old.damage_policy)
  or (new.deposit_policy      is distinct from old.deposit_policy)
  or (new.contract_footer     is distinct from old.contract_footer) then
    new.terms_version := old.terms_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists organization_settings_bump_terms on public.organization_settings;
create trigger organization_settings_bump_terms
  before update on public.organization_settings
  for each row execute function app.bump_terms_version();

-- -----------------------------------------------------------------------------
-- Issued contracts
-- -----------------------------------------------------------------------------

create table if not exists public.rental_contracts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  rental_id       uuid not null,

  version         integer not null check (version >= 1),
  contract_number text not null check (char_length(contract_number) between 3 and 40),

  -- Everything the document says, frozen. Rendered from this alone.
  snapshot jsonb not null,
  terms_version integer not null default 1,

  status public.contract_status not null default 'issued',

  issued_at timestamptz not null default now(),
  issued_by uuid references auth.users (id) on delete set null,

  signed_at              timestamptz,
  renter_signature_path  text check (renter_signature_path is null or char_length(renter_signature_path) <= 512),
  renter_signature_name  text check (renter_signature_name is null or char_length(renter_signature_name) <= 160),
  agency_signature_path  text check (agency_signature_path is null or char_length(agency_signature_path) <= 512),
  agency_signature_name  text check (agency_signature_name is null or char_length(agency_signature_name) <= 160),

  pdf_path         text check (pdf_path is null or char_length(pdf_path) <= 512),
  pdf_generated_at timestamptz,
  pdf_sha256       text check (pdf_sha256 is null or char_length(pdf_sha256) = 64),
  pdf_byte_size    integer check (pdf_byte_size is null or pdf_byte_size > 0),

  superseded_at    timestamptz,
  supersede_reason text check (supersede_reason is null or char_length(supersede_reason) <= 300),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rental_contracts_rental_fkey
    foreign key (rental_id, organization_id)
    references public.rentals (id, organization_id)
    on delete cascade,

  constraint rental_contracts_version_unique unique (rental_id, version),
  constraint rental_contracts_tenant_key unique (id, organization_id)
);

comment on table public.rental_contracts is
  'Issued rental contracts. `snapshot` is the frozen document; amendments create a new version and supersede the previous one.';
comment on column public.rental_contracts.snapshot is
  'The complete contract as issued: agency, vehicle, renter, drivers, pricing, handover and terms. Never rewritten.';

create index if not exists rental_contracts_rental_idx
  on public.rental_contracts (rental_id, version desc);

create index if not exists rental_contracts_organization_idx
  on public.rental_contracts (organization_id, issued_at desc);

drop trigger if exists rental_contracts_set_updated_at on public.rental_contracts;
create trigger rental_contracts_set_updated_at
  before update on public.rental_contracts
  for each row execute function app.set_updated_at();

/**
 * The snapshot is immutable once written.
 *
 * Everything a later step legitimately needs to add — a signature, a generated
 * PDF, being superseded by a newer version — is a separate column. The document
 * itself, its number and its version never change, and no ordinary edit can
 * make an issued contract say something new.
 */
create or replace function app.guard_contract_immutability()
returns trigger
language plpgsql
as $$
begin
  new.snapshot        := old.snapshot;
  new.contract_number := old.contract_number;
  new.version         := old.version;
  new.rental_id       := old.rental_id;
  new.organization_id := old.organization_id;
  new.terms_version   := old.terms_version;
  new.issued_at       := old.issued_at;
  new.issued_by       := old.issued_by;
  new.id              := old.id;
  new.created_at      := old.created_at;

  if old.status = 'signed' and new.status = 'issued' then
    raise exception 'A signed contract cannot be returned to unsigned.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists rental_contracts_immutable on public.rental_contracts;
create trigger rental_contracts_immutable
  before update on public.rental_contracts
  for each row execute function app.guard_contract_immutability();

-- -----------------------------------------------------------------------------
-- Condition photographs
--
-- Evidence of how a vehicle looked at handover and at return. Deliberately a
-- separate table from `vehicle_images`: a marketing photograph of the fleet and
-- a picture of a scratch taken at 8am on a particular contract are different
-- things, and mixing them would let one be mistaken for the other.
-- -----------------------------------------------------------------------------

create table if not exists public.rental_condition_photos (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  rental_id       uuid not null,

  phase        public.rental_condition_phase not null,
  storage_path text not null check (char_length(storage_path) between 1 and 512),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size    integer not null check (byte_size > 0 and byte_size <= 8388608),
  caption      text check (caption is null or char_length(caption) <= 200),

  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_at timestamptz not null default now(),

  constraint rental_condition_photos_path_key unique (storage_path),
  constraint rental_condition_photos_rental_fkey
    foreign key (rental_id, organization_id)
    references public.rentals (id, organization_id)
    on delete cascade
);

create index if not exists rental_condition_photos_rental_idx
  on public.rental_condition_photos (rental_id, phase, uploaded_at);

-- -----------------------------------------------------------------------------
-- Privileges and policies
-- -----------------------------------------------------------------------------

revoke all on table public.rental_contracts, public.rental_condition_photos from anon, authenticated;
-- Contracts are never deleted from the client: an issued document is history.
grant select, insert, update on table public.rental_contracts to authenticated;
grant select, insert, delete on table public.rental_condition_photos to authenticated;

alter table public.rental_contracts enable row level security;
alter table public.rental_condition_photos enable row level security;

drop policy if exists rental_contracts_select on public.rental_contracts;
create policy rental_contracts_select on public.rental_contracts
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists rental_contracts_insert on public.rental_contracts;
create policy rental_contracts_insert on public.rental_contracts
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rental_contracts_update on public.rental_contracts;
create policy rental_contracts_update on public.rental_contracts
  for update to authenticated
  using (app.has_min_role(organization_id, 'staff'))
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rental_condition_photos_select on public.rental_condition_photos;
create policy rental_condition_photos_select on public.rental_condition_photos
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists rental_condition_photos_insert on public.rental_condition_photos;
create policy rental_condition_photos_insert on public.rental_condition_photos
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rental_condition_photos_delete on public.rental_condition_photos;
create policy rental_condition_photos_delete on public.rental_condition_photos
  for delete to authenticated
  using (app.has_min_role(organization_id, 'manager'));

-- -----------------------------------------------------------------------------
-- Private storage for contracts, signatures and condition photographs
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rental-documents',
  'rental-documents',
  false,
  10485760, -- 10 MiB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "rental documents readable by members" on storage.objects;
create policy "rental documents readable by members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'rental-documents'
    and app.is_org_member(app.organization_id_from_storage_path(name))
  );

drop policy if exists "rental documents writable by staff" on storage.objects;
create policy "rental documents writable by staff" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'rental-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'staff')
  );

drop policy if exists "rental documents replaceable by staff" on storage.objects;
create policy "rental documents replaceable by staff" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'rental-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'staff')
  )
  with check (
    bucket_id = 'rental-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'staff')
  );

drop policy if exists "rental documents removable by managers" on storage.objects;
create policy "rental documents removable by managers" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'rental-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

-- =============================================================================
-- Lifecycle operations
-- =============================================================================

/**
 * Confirms a draft into a reservation.
 *
 * The vehicle becomes unavailable at this moment and not before — that is the
 * whole difference between a draft and a reservation. Availability is settled
 * by the rentals_no_vehicle_overlap exclusion constraint, so two staff members
 * confirming the same vehicle at the same instant cannot both succeed however
 * stale either screen was.
 */
create or replace function public.rental_confirm(p_rental_id uuid)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental public.rentals;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status <> 'draft' then
    raise exception 'Only a draft can be confirmed.' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.rental_drivers d
    where d.rental_id = p_rental_id and d.driver_role = 'primary'
  ) then
    raise exception 'Name the primary driver before confirming this reservation.'
      using errcode = '23514';
  end if;

  update public.rentals
     set status = 'reserved',
         confirmed_at = now(),
         original_ends_at = coalesce(original_ends_at, ends_at)
   where id = p_rental_id
  returning * into v_rental;

  return v_rental;
end;
$$;

/**
 * Hands the vehicle over.
 *
 * The odometer may not go backwards: a reading below the vehicle's recorded
 * mileage means somebody has mistyped, and accepting it would corrupt every
 * later distance calculation. The vehicle's own odometer is advanced in the
 * same transaction.
 */
create or replace function public.rental_check_out(
  p_rental_id uuid,
  p_odometer  integer,
  p_fuel_percent smallint default null,
  p_notes     text default null,
  p_picked_up_at timestamptz default null
)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental  public.rentals;
  v_vehicle public.vehicles;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status <> 'reserved' then
    raise exception 'Only a confirmed reservation can be checked out.' using errcode = '23514';
  end if;
  if p_odometer is null or p_odometer < 0 then
    raise exception 'Record the odometer reading at hand-over.' using errcode = '23514';
  end if;

  select * into v_vehicle from public.vehicles where id = v_rental.vehicle_id for update;

  if p_odometer < v_vehicle.odometer then
    raise exception
      'The odometer reading (%) is below the vehicle''s recorded mileage (%). Correct the vehicle''s odometer first if it is wrong.',
      p_odometer, v_vehicle.odometer
      using errcode = '23514';
  end if;

  update public.vehicles
     set odometer = p_odometer,
         odometer_updated_at = now()
   where id = v_rental.vehicle_id;

  update public.rentals
     set status = 'active',
         picked_up_at = coalesce(p_picked_up_at, now()),
         pickup_odometer = p_odometer,
         pickup_fuel_percent = p_fuel_percent,
         pickup_condition_notes = p_notes,
         pickup_recorded_by = (select auth.uid())
   where id = p_rental_id
  returning * into v_rental;

  return v_rental;
end;
$$;

/**
 * Records the return. Does not complete the rental — a returned vehicle and a
 * settled contract are different events, and an agency often needs to add a
 * fuel or damage charge in between.
 */
create or replace function public.rental_check_in(
  p_rental_id uuid,
  p_odometer  integer,
  p_fuel_percent smallint default null,
  p_notes     text default null,
  p_returned_at timestamptz default null
)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental public.rentals;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status <> 'active' then
    raise exception 'Only a rental that is out with a customer can be returned.' using errcode = '23514';
  end if;
  if p_odometer is null or p_odometer < 0 then
    raise exception 'Record the odometer reading at return.' using errcode = '23514';
  end if;
  if p_odometer < v_rental.pickup_odometer then
    raise exception
      'The return reading (%) is below the reading at hand-over (%).',
      p_odometer, v_rental.pickup_odometer
      using errcode = '23514';
  end if;

  update public.vehicles
     set odometer = greatest(odometer, p_odometer),
         odometer_updated_at = now()
   where id = v_rental.vehicle_id;

  update public.rentals
     set returned_at = coalesce(p_returned_at, now()),
         return_odometer = p_odometer,
         return_fuel_percent = p_fuel_percent,
         return_condition_notes = p_notes,
         return_recorded_by = (select auth.uid())
   where id = p_rental_id
  returning * into v_rental;

  return v_rental;
end;
$$;

/**
 * Closes the contract.
 *
 * An outstanding balance does not block completion. Operational completion and
 * financial settlement are different facts, and an agency that has taken the
 * car back needs to say so even when the customer still owes money. The debt
 * stays visible and keeps counting toward receivables.
 */
create or replace function public.rental_complete(p_rental_id uuid)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental public.rentals;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status <> 'active' then
    raise exception 'Only an active rental can be completed.' using errcode = '23514';
  end if;
  if v_rental.returned_at is null or v_rental.return_odometer is null then
    raise exception 'Record the vehicle''s return before completing this rental.'
      using errcode = '23514';
  end if;
  if v_rental.deposit_held_minor > 0 then
    raise exception
      'A deposit of % is still held. Refund or retain it before completing the rental.',
      v_rental.deposit_held_minor
      using errcode = '23514';
  end if;

  update public.rentals
     set status = 'completed',
         completed_at = now()
   where id = p_rental_id
  returning * into v_rental;

  return v_rental;
end;
$$;

create or replace function public.rental_cancel(p_rental_id uuid, p_reason text default null)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental public.rentals;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status not in ('draft', 'reserved') then
    raise exception 'Only a draft or a reservation can be cancelled.' using errcode = '23514';
  end if;

  -- Payments already taken stay exactly where they are. Refunding them is a
  -- separate, deliberate financial act.
  update public.rentals
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = (select auth.uid()),
         cancellation_reason = p_reason
   where id = p_rental_id
  returning * into v_rental;

  return v_rental;
end;
$$;

/**
 * Extends the hire.
 *
 * The new period is written and the exclusion constraint decides: if another
 * reservation already needs the vehicle, the update is refused and the customer
 * keeps the original end date. There is no separate availability opinion to
 * disagree with the constraint.
 */
create or replace function public.rental_extend(
  p_rental_id uuid,
  p_new_ends_at timestamptz,
  p_charge_minor bigint default 0,
  p_charge_description text default null,
  p_additional_days integer default null
)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental public.rentals;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status not in ('reserved', 'active') then
    raise exception 'Only a reservation or an active rental can be extended.' using errcode = '23514';
  end if;
  if p_new_ends_at <= v_rental.ends_at then
    raise exception 'An extension must end after the current return date.' using errcode = '23514';
  end if;

  -- Extending is one event, so the extra days and their charge are one
  -- transaction. Otherwise a failure between the two leaves the vehicle
  -- committed for longer with nothing billed for it.
  update public.rentals
     set ends_at = p_new_ends_at,
         original_ends_at = coalesce(original_ends_at, v_rental.ends_at),
         extension_count = extension_count + 1,
         billable_days = case
           when p_additional_days is null then billable_days
           else coalesce(billable_days, 0) + p_additional_days
         end
   where id = p_rental_id
  returning * into v_rental;

  if coalesce(p_charge_minor, 0) > 0 then
    insert into public.rental_line_items (
      organization_id, rental_id, kind, description, quantity,
      unit_amount_minor, amount_minor, currency, sort_order, created_by
    )
    values (
      v_rental.organization_id, p_rental_id, 'base_rental',
      coalesce(nullif(btrim(p_charge_description), ''), 'Extension'),
      coalesce(p_additional_days, 1),
      case
        when coalesce(p_additional_days, 0) > 0 then p_charge_minor / p_additional_days
        else p_charge_minor
      end,
      p_charge_minor, v_rental.currency,
      (select coalesce(max(sort_order), 0) + 1 from public.rental_line_items where rental_id = p_rental_id),
      (select auth.uid())
    );

    select * into v_rental from public.rentals where id = p_rental_id;
  end if;

  return v_rental;
end;
$$;

/**
 * Replaces the vehicle before hand-over.
 *
 * Only while the contract is a draft or a reservation: once a customer has
 * driven away, the vehicle on the contract is a fact rather than a plan.
 */
create or replace function public.rental_substitute_vehicle(
  p_rental_id  uuid,
  p_vehicle_id uuid
)
returns public.rentals
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental  public.rentals;
  v_vehicle public.vehicles;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status not in ('draft', 'reserved') then
    raise exception 'The vehicle can only be changed before the customer collects it.'
      using errcode = '23514';
  end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id;

  -- RLS already scopes this select; the explicit check turns "invisible" into a
  -- clear message rather than a confusing null.
  if v_vehicle.id is null or v_vehicle.organization_id <> v_rental.organization_id then
    raise exception 'Vehicle not found.' using errcode = 'P0002';
  end if;
  if v_vehicle.archived_at is not null then
    raise exception 'That vehicle has been retired from the fleet.' using errcode = '23514';
  end if;
  if v_vehicle.status <> 'available' then
    raise exception 'That vehicle is not in service.' using errcode = '23514';
  end if;

  update public.rentals
     set vehicle_id = p_vehicle_id
   where id = p_rental_id
  returning * into v_rental;

  return v_rental;
end;
$$;

/**
 * Records money.
 *
 * A payment must be in the contract's currency: a EUR contract settled partly
 * in MAD has no meaningful balance, and the product holds no exchange rate. The
 * settlement trigger recomputes what is paid and what is held.
 */
create or replace function public.rental_record_payment(
  p_rental_id uuid,
  p_amount_minor bigint,
  p_direction public.payment_direction,
  p_purpose public.payment_purpose,
  p_method public.payment_method default 'cash',
  p_paid_at timestamptz default null,
  p_reference text default null,
  p_notes text default null
)
returns public.payments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental  public.rentals;
  v_payment public.payments;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'A payment must be for a positive amount.' using errcode = '23514';
  end if;
  if v_rental.status = 'cancelled' and p_direction = 'inbound' then
    raise exception 'This reservation was cancelled. Record a refund instead.' using errcode = '23514';
  end if;
  if p_direction = 'outbound' and p_purpose = 'deposit'
     and p_amount_minor > v_rental.deposit_held_minor then
    raise exception 'Only % is held as a deposit on this contract.', v_rental.deposit_held_minor
      using errcode = '23514';
  end if;

  insert into public.payments (
    organization_id, rental_id, customer_id, direction, purpose, method,
    amount_minor, currency, paid_at, reference, notes, recorded_by
  )
  values (
    v_rental.organization_id, p_rental_id, v_rental.customer_id, p_direction, p_purpose, p_method,
    p_amount_minor, v_rental.currency, coalesce(p_paid_at, now()), p_reference, p_notes,
    (select auth.uid())
  )
  returning * into v_payment;

  return v_payment;
end;
$$;

/** Reverses a payment without erasing it. */
create or replace function public.rental_void_payment(p_payment_id uuid, p_reason text default null)
returns public.payments
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;

  if v_payment.id is null then
    raise exception 'Payment not found.' using errcode = 'P0002';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'That payment has already been voided.' using errcode = '23514';
  end if;

  update public.payments
     set voided_at = now(),
         voided_by = (select auth.uid()),
         void_reason = p_reason
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

/**
 * Issues a contract: freezes everything the document says into one jsonb value.
 *
 * Reading the live rows at render time would mean a corrected surname or a
 * repriced vehicle silently rewrote a signed agreement. Every previous version
 * is superseded rather than replaced, so the history of what was agreed — and
 * when it changed — survives.
 */
create or replace function public.rental_issue_contract(
  p_rental_id uuid,
  p_reason text default null
)
returns public.rental_contracts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_rental       public.rentals;
  v_organization public.organizations;
  v_settings     public.organization_settings;
  v_vehicle      public.vehicles;
  v_customer     public.customers;
  v_version      integer;
  v_contract     public.rental_contracts;
  v_snapshot     jsonb;
begin
  select * into v_rental from public.rentals where id = p_rental_id for update;

  if v_rental.id is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  if v_rental.status = 'draft' then
    raise exception 'Confirm the reservation before issuing a contract.' using errcode = '23514';
  end if;
  if v_rental.status = 'cancelled' then
    raise exception 'A cancelled reservation has no contract to issue.' using errcode = '23514';
  end if;

  select * into v_organization from public.organizations where id = v_rental.organization_id;
  select * into v_settings from public.organization_settings where organization_id = v_rental.organization_id;
  select * into v_vehicle from public.vehicles where id = v_rental.vehicle_id;
  select * into v_customer from public.customers where id = v_rental.customer_id;

  select coalesce(max(version), 0) + 1 into v_version
  from public.rental_contracts where rental_id = p_rental_id;

  v_snapshot := jsonb_build_object(
    'issued_at', now(),
    'version', v_version,
    'contract_number', v_rental.reference,

    'agency', jsonb_build_object(
      'name', v_organization.name,
      'legal_name', v_organization.legal_name,
      'tax_identifier', v_organization.tax_identifier,
      'email', v_organization.email,
      'phone', v_organization.phone,
      'website', v_organization.website,
      'address_line1', v_organization.address_line1,
      'address_line2', v_organization.address_line2,
      'city', v_organization.city,
      'region', v_organization.region,
      'postal_code', v_organization.postal_code,
      'country_code', v_organization.country_code,
      'logo_path', v_organization.logo_path,
      'time_zone', v_organization.time_zone,
      'locale', v_organization.locale
    ),

    'vehicle', jsonb_build_object(
      'id', v_vehicle.id,
      'make', v_vehicle.make,
      'model', v_vehicle.model,
      'model_year', v_vehicle.model_year,
      'registration_plate', v_vehicle.registration_plate,
      'vin', v_vehicle.vin,
      'color', v_vehicle.color,
      'fuel_type', v_vehicle.fuel_type,
      'transmission', v_vehicle.transmission,
      'seats', v_vehicle.seats
    ),

    'renter', jsonb_build_object(
      'id', v_customer.id,
      'display_name', v_customer.display_name,
      'customer_type', v_customer.customer_type,
      'email', v_customer.email,
      'phone', v_customer.phone,
      'date_of_birth', v_customer.date_of_birth,
      'nationality_country_code', v_customer.nationality_country_code,
      'address_line1', v_customer.address_line1,
      'address_line2', v_customer.address_line2,
      'city', v_customer.city,
      'region', v_customer.region,
      'postal_code', v_customer.postal_code,
      'country_code', v_customer.country_code,
      'identity_documents', coalesce((
        select jsonb_agg(jsonb_build_object(
          'document_type', d.document_type,
          'document_number', d.document_number,
          'issuing_country', d.issuing_country,
          'expires_on', d.expires_on
        ) order by d.document_type)
        from public.customer_documents d
        where d.customer_id = v_customer.id
          and d.document_type <> 'driver_license'
      ), '[]'::jsonb)
    ),

    'drivers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_id', c.id,
        'display_name', c.display_name,
        'role', rd.driver_role,
        'license_number', coalesce(rd.license_number, licence.document_number),
        'license_country', coalesce(rd.license_country, licence.issuing_country),
        'license_expires_on', coalesce(rd.license_expires_on, licence.expires_on),
        'license_classes', licence.license_classes
      ) order by rd.driver_role, c.display_name)
      from public.rental_drivers rd
      join public.customers c on c.id = rd.customer_id
      left join lateral (
        select d.document_number, d.issuing_country, d.expires_on, d.license_classes
        from public.customer_documents d
        where d.customer_id = c.id and d.document_type = 'driver_license'
        order by d.expires_on desc nulls last
        limit 1
      ) licence on true
      where rd.rental_id = p_rental_id
    ), '[]'::jsonb),

    'rental', jsonb_build_object(
      'starts_at', v_rental.starts_at,
      'ends_at', v_rental.ends_at,
      'original_ends_at', v_rental.original_ends_at,
      'pickup_location', v_rental.pickup_location,
      'return_location', v_rental.return_location,
      'billable_days', v_rental.billable_days,
      'daily_rate_minor', v_rental.daily_rate_minor,
      'notes', v_rental.notes
    ),

    'pricing', jsonb_build_object(
      'currency', v_rental.currency,
      'subtotal_minor', v_rental.subtotal_minor,
      'discount_minor', v_rental.discount_minor,
      'tax_minor', v_rental.tax_minor,
      'tax_rate_bps', v_rental.tax_rate_bps,
      'tax_label', v_rental.tax_label,
      'total_minor', v_rental.total_minor,
      'deposit_minor', v_rental.deposit_minor,
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', l.kind,
          'description', l.description,
          'quantity', l.quantity,
          'unit_amount_minor', l.unit_amount_minor,
          'amount_minor', l.amount_minor,
          'is_taxable', l.is_taxable
        ) order by l.sort_order, l.created_at)
        from public.rental_line_items l
        where l.rental_id = p_rental_id
      ), '[]'::jsonb)
    ),

    'handover', jsonb_build_object(
      'picked_up_at', v_rental.picked_up_at,
      'pickup_odometer', v_rental.pickup_odometer,
      'pickup_fuel_percent', v_rental.pickup_fuel_percent,
      'pickup_condition_notes', v_rental.pickup_condition_notes,
      'returned_at', v_rental.returned_at,
      'return_odometer', v_rental.return_odometer,
      'return_fuel_percent', v_rental.return_fuel_percent,
      'return_condition_notes', v_rental.return_condition_notes
    ),

    'terms', jsonb_build_object(
      'version', coalesce(v_settings.terms_version, 1),
      'contract_terms', v_settings.contract_terms,
      'fuel_policy', v_settings.fuel_policy,
      'mileage_policy', v_settings.mileage_policy,
      'late_return_policy', v_settings.late_return_policy,
      'damage_policy', v_settings.damage_policy,
      'deposit_policy', v_settings.deposit_policy,
      'footer', v_settings.contract_footer
    ),

    'units', jsonb_build_object(
      'distance', coalesce(v_settings.distance_unit, 'km'),
      'volume', coalesce(v_settings.volume_unit, 'litre')
    )
  );

  update public.rental_contracts
     set status = 'superseded',
         superseded_at = now(),
         supersede_reason = coalesce(p_reason, 'Replaced by a later version')
   where rental_id = p_rental_id
     and status in ('issued', 'signed');

  insert into public.rental_contracts (
    organization_id, rental_id, version, contract_number, snapshot, terms_version, issued_by
  )
  values (
    v_rental.organization_id, p_rental_id, v_version, v_rental.reference, v_snapshot,
    coalesce(v_settings.terms_version, 1), (select auth.uid())
  )
  returning * into v_contract;

  return v_contract;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants — authenticated only, never anon
-- -----------------------------------------------------------------------------

-- PUBLIC as well as anon: Postgres grants EXECUTE to PUBLIC by default, and
-- Supabase adds an explicit anon grant on top. Both have to go.
revoke all on function public.rental_confirm(uuid) from public, anon;
revoke all on function public.rental_check_out(uuid, integer, smallint, text, timestamptz) from public, anon;
revoke all on function public.rental_check_in(uuid, integer, smallint, text, timestamptz) from public, anon;
revoke all on function public.rental_complete(uuid) from public, anon;
revoke all on function public.rental_cancel(uuid, text) from public, anon;
revoke all on function public.rental_extend(uuid, timestamptz, bigint, text, integer) from public, anon;
revoke all on function public.rental_substitute_vehicle(uuid, uuid) from public, anon;
revoke all on function public.rental_record_payment(
  uuid, bigint, public.payment_direction, public.payment_purpose, public.payment_method,
  timestamptz, text, text
) from public, anon;
revoke all on function public.rental_void_payment(uuid, text) from public, anon;
revoke all on function public.rental_issue_contract(uuid, text) from public, anon;

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

grant execute on function public.rental_confirm(uuid) to authenticated;
grant execute on function public.rental_check_out(uuid, integer, smallint, text, timestamptz) to authenticated;
grant execute on function public.rental_check_in(uuid, integer, smallint, text, timestamptz) to authenticated;
grant execute on function public.rental_complete(uuid) to authenticated;
grant execute on function public.rental_cancel(uuid, text) to authenticated;
grant execute on function public.rental_extend(uuid, timestamptz, bigint, text, integer) to authenticated;
grant execute on function public.rental_substitute_vehicle(uuid, uuid) to authenticated;
grant execute on function public.rental_record_payment(
  uuid, bigint, public.payment_direction, public.payment_purpose, public.payment_method,
  timestamptz, text, text
) to authenticated;
grant execute on function public.rental_void_payment(uuid, text) to authenticated;
grant execute on function public.rental_issue_contract(uuid, text) to authenticated;

grant execute on function public.create_organization(text, text, text, text, text) to authenticated;
grant execute on function public.organization_overview(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.organization_financial_series(uuid, date, date, text) to authenticated;
grant execute on function public.fleet_status_counts(uuid) to authenticated;
grant execute on function public.vehicle_usage(uuid) to authenticated;
grant execute on function public.vehicles_available_between(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.is_valid_time_zone(text) to authenticated, service_role;
grant execute on function public.customer_rental_summary(uuid) to authenticated;
grant execute on function public.customer_financial_summary(uuid) to authenticated;
grant execute on function public.find_customer_duplicates(uuid, text, text, jsonb, uuid) to authenticated;
grant execute on function public.customer_usage(uuid) to authenticated;

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
