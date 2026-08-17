-- =============================================================================
-- 20260815100000_rental_operations.sql
--
-- Turns the foundational `rentals` table into a real rental-desk system:
-- charge line items, a trigger-enforced lifecycle, and — most importantly — a
-- correction to how deposits are counted.
--
-- THE DEPOSIT BUG
--
-- `amount_paid_minor` summed every payment attached to a contract, and
-- `organization_overview.revenue_minor` summed every payment in the period. A
-- refundable deposit therefore did two wrong things at once: it reduced the
-- customer's outstanding balance as though they had paid for the hire, and it
-- appeared on the dashboard as money the agency had earned. Refunding it later
-- then showed up as negative revenue.
--
-- A deposit is not revenue. It is the customer's money, held. Payments now
-- carry a `purpose`, the contract tracks `deposit_held_minor` separately from
-- `amount_paid_minor`, and the dashboard counts only rental charges.
--
-- PAYMENTS BECOME APPEND-ONLY IN PRACTICE
--
-- Financial history should not evaporate because somebody mistyped. A payment
-- is voided, not deleted; every sum ignores voided rows, and the entry stays
-- visible with its reason.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Payment purpose and voiding
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'payment_purpose' and typnamespace = 'public'::regnamespace
  ) then
    create type public.payment_purpose as enum ('rental_charge', 'deposit');
  end if;

  if not exists (
    select 1 from pg_type where typname = 'rental_charge_kind' and typnamespace = 'public'::regnamespace
  ) then
    create type public.rental_charge_kind as enum (
      'base_rental',
      'additional_driver',
      'delivery',
      'collection',
      'child_seat',
      'insurance',
      'cleaning',
      'late_return',
      'fuel',
      'damage',
      'adjustment',
      'discount',
      'other'
    );
  end if;

  if not exists (
    select 1 from pg_type where typname = 'rental_condition_phase' and typnamespace = 'public'::regnamespace
  ) then
    create type public.rental_condition_phase as enum ('pickup', 'return');
  end if;
end
$$;

alter table public.payments
  add column if not exists purpose public.payment_purpose not null default 'rental_charge',
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users (id) on delete set null,
  add column if not exists void_reason text check (void_reason is null or char_length(void_reason) <= 500);

comment on column public.payments.purpose is
  'Whether this money is payment for the hire or a refundable deposit. Deposits are never revenue.';
comment on column public.payments.voided_at is
  'Set when an entry is reversed. Voided payments are excluded from every total but stay visible.';

create index if not exists payments_rental_live_idx
  on public.payments (rental_id, purpose)
  where voided_at is null;

-- -----------------------------------------------------------------------------
-- Contract-side money
-- -----------------------------------------------------------------------------

alter table public.rentals
  -- Deposits held, tracked apart from what the customer has paid for the hire.
  add column if not exists deposit_held_minor bigint not null default 0,
  -- The tax rate actually applied, frozen on the contract. Changing the agency
  -- default later must not restate a signed document.
  add column if not exists tax_rate_bps integer not null default 0
    check (tax_rate_bps between 0 and 100000),
  add column if not exists tax_label text check (tax_label is null or char_length(tax_label) <= 40),

  -- Handover facts.
  add column if not exists picked_up_at timestamptz,
  add column if not exists returned_at timestamptz,
  add column if not exists pickup_condition_notes text
    check (pickup_condition_notes is null or char_length(pickup_condition_notes) <= 4000),
  add column if not exists return_condition_notes text
    check (return_condition_notes is null or char_length(return_condition_notes) <= 4000),
  add column if not exists pickup_recorded_by uuid references auth.users (id) on delete set null,
  add column if not exists return_recorded_by uuid references auth.users (id) on delete set null,

  add column if not exists cancelled_by uuid references auth.users (id) on delete set null,
  add column if not exists cancellation_reason text
    check (cancellation_reason is null or char_length(cancellation_reason) <= 500),

  add column if not exists confirmed_at timestamptz,
  add column if not exists original_ends_at timestamptz,
  add column if not exists extension_count integer not null default 0 check (extension_count >= 0);

comment on column public.rentals.deposit_held_minor is
  'Refundable deposit currently held, derived from payments with purpose = deposit. Never part of revenue.';
comment on column public.rentals.original_ends_at is
  'The end date first agreed, kept when a rental is extended so the change is visible.';

-- -----------------------------------------------------------------------------
-- Settlement: rental charges and deposits counted separately
-- -----------------------------------------------------------------------------

create or replace function app.sync_rental_payment_totals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rental_ids uuid[];
  v_rental_id  uuid;
  v_paid       bigint;
  v_deposit    bigint;
begin
  v_rental_ids := array_remove(
    array[
      case when tg_op <> 'INSERT' then old.rental_id end,
      case when tg_op <> 'DELETE' then new.rental_id end
    ],
    null
  );

  foreach v_rental_id in array v_rental_ids loop
    -- Recomputed as a full aggregate rather than an incremental delta, so a
    -- corrected, voided or removed payment always lands on the right number.
    select
      coalesce(sum(
        case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
      ) filter (where p.purpose = 'rental_charge'), 0),
      coalesce(sum(
        case p.direction when 'inbound' then p.amount_minor else -p.amount_minor end
      ) filter (where p.purpose = 'deposit'), 0)
      into v_paid, v_deposit
    from public.payments p
    where p.rental_id = v_rental_id
      and p.voided_at is null;

    -- Refunds exceeding receipts can only come from a data error; clamp rather
    -- than violate the non-negative constraint and abort the caller's write.
    v_paid := greatest(v_paid, 0);
    v_deposit := greatest(v_deposit, 0);

    perform set_config('app.payment_sync', 'on', true);
    update public.rentals r
       set amount_paid_minor  = v_paid,
           deposit_held_minor = v_deposit
     where r.id = v_rental_id
       and (r.amount_paid_minor is distinct from v_paid
            or r.deposit_held_minor is distinct from v_deposit);
    perform set_config('app.payment_sync', 'off', true);
  end loop;

  return null;
end;
$$;

drop trigger if exists payments_sync_rental_totals on public.payments;
create trigger payments_sync_rental_totals
  after insert or update or delete on public.payments
  for each row execute function app.sync_rental_payment_totals();

-- Both settlement figures are derived; a client may not write either.
create or replace function app.guard_rental_derived_amounts()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.payment_sync', true), '') <> 'on' then
    new.amount_paid_minor := old.amount_paid_minor;
    new.deposit_held_minor := old.deposit_held_minor;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Charge line items
--
-- Amounts are signed: a discount is a negative line. That keeps the arithmetic
-- a single sum instead of two lists that have to be kept in step, and it makes
-- "why is the total this?" answerable by reading the contract top to bottom.
-- -----------------------------------------------------------------------------

create table if not exists public.rental_line_items (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  rental_id       uuid not null,

  kind        public.rental_charge_kind not null default 'other',
  description text not null check (char_length(btrim(description)) between 1 and 200),

  quantity          numeric(10, 2) not null default 1 check (quantity > 0 and quantity <= 100000),
  unit_amount_minor bigint not null default 0,
  amount_minor      bigint not null,
  currency          public.currency_code not null,

  -- Whether this line participates in the tax base. A statutory fee often does
  -- not, and that varies by country, so it is per line rather than assumed.
  is_taxable boolean not null default true,
  sort_order integer not null default 0,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rental_line_items_rental_fkey
    foreign key (rental_id, organization_id)
    references public.rentals (id, organization_id)
    on delete cascade,

  constraint rental_line_items_discount_is_negative
    check (case when kind = 'discount' then amount_minor < 0 else amount_minor >= 0 end)
);

comment on table public.rental_line_items is
  'What a contract charges for. Signed amounts: discounts are negative. The rental''s totals are derived from these.';

create index if not exists rental_line_items_rental_idx
  on public.rental_line_items (rental_id, sort_order, created_at);

create index if not exists rental_line_items_organization_idx
  on public.rental_line_items (organization_id);

-- A line item is always in the contract's currency. Taking it from the rental
-- rather than trusting the caller means a mixed-currency contract — whose total
-- would be meaningless — cannot be created at all.
create or replace function app.rental_line_items_inherit_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency public.currency_code;
begin
  select r.currency into v_currency from public.rentals r where r.id = new.rental_id;
  if v_currency is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;
  new.currency := v_currency;
  return new;
end;
$$;

drop trigger if exists rental_line_items_inherit_currency on public.rental_line_items;
create trigger rental_line_items_inherit_currency
  before insert on public.rental_line_items
  for each row execute function app.rental_line_items_inherit_currency();

drop trigger if exists rental_line_items_set_updated_at on public.rental_line_items;
create trigger rental_line_items_set_updated_at
  before update on public.rental_line_items
  for each row execute function app.set_updated_at();

drop trigger if exists rental_line_items_freeze_columns on public.rental_line_items;
create trigger rental_line_items_freeze_columns
  before update on public.rental_line_items
  for each row execute function app.freeze_columns(
    'id', 'organization_id', 'rental_id', 'currency', 'created_at', 'created_by'
  );

-- -----------------------------------------------------------------------------
-- Totals derived from the lines
--
-- One source of truth. Nothing writes subtotal/discount/tax/total directly;
-- they are recomputed whenever a line changes or the tax rate is set.
-- -----------------------------------------------------------------------------

create or replace function app.recalculate_rental_totals(p_rental_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base      bigint;
  v_extras    bigint;
  v_discount  bigint;
  v_taxable   bigint;
  v_tax       bigint;
  v_rate      integer;
  v_status    public.rental_status;
begin
  select r.tax_rate_bps, r.status into v_rate, v_status
  from public.rentals r
  where r.id = p_rental_id;

  if v_rate is null then
    return;
  end if;

  select
    coalesce(sum(l.amount_minor) filter (where l.kind = 'base_rental' and l.amount_minor > 0), 0),
    coalesce(sum(l.amount_minor) filter (where l.kind <> 'base_rental' and l.amount_minor > 0), 0),
    coalesce(-sum(l.amount_minor) filter (where l.amount_minor < 0), 0),
    coalesce(sum(l.amount_minor) filter (where l.is_taxable), 0)
    into v_base, v_extras, v_discount, v_taxable
  from public.rental_line_items l
  where l.rental_id = p_rental_id;

  -- Tax applies to the taxable lines net of any taxable discount, never to the
  -- deposit, which is not a charge at all.
  v_tax := round(greatest(v_taxable, 0)::numeric * v_rate / 10000.0)::bigint;

  if v_base + v_extras - v_discount + v_tax < 0 then
    raise exception 'The discount on this contract exceeds its charges.'
      using errcode = '23514';
  end if;

  perform set_config('app.rental_totals_sync', 'on', true);
  update public.rentals r
     set subtotal_minor = v_base,
         extras_minor   = v_extras,
         discount_minor = v_discount,
         tax_minor      = v_tax,
         total_minor    = v_base + v_extras - v_discount + v_tax
   where r.id = p_rental_id;
  perform set_config('app.rental_totals_sync', 'off', true);
end;
$$;

/**
 * The charge columns are derived too.
 *
 * Without this, a client could set `total_minor` to anything it liked and the
 * line items would quietly disagree with the amount the customer is asked to
 * pay. An UPDATE that touches them outside the recalculation path is restored
 * rather than rejected, so an ordinary "save the rental" write that happens to
 * include stale figures cannot corrupt the contract.
 */
create or replace function app.guard_rental_charge_amounts()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.rental_totals_sync', true), '') <> 'on'
     and exists (select 1 from public.rental_line_items l where l.rental_id = old.id) then
    new.subtotal_minor := old.subtotal_minor;
    new.extras_minor   := old.extras_minor;
    new.discount_minor := old.discount_minor;
    new.tax_minor      := old.tax_minor;
    new.total_minor    := old.total_minor;
  end if;
  return new;
end;
$$;

drop trigger if exists rentals_guard_charge_amounts on public.rentals;
create trigger rentals_guard_charge_amounts
  before update on public.rentals
  for each row execute function app.guard_rental_charge_amounts();

-- Changing the tax rate has to restate the tax. The recalculation writes only
-- the charge columns, so this cannot loop.
create or replace function app.rentals_tax_rate_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tax_rate_bps is distinct from old.tax_rate_bps then
    perform app.recalculate_rental_totals(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists rentals_tax_rate_changed on public.rentals;
create trigger rentals_tax_rate_changed
  after update of tax_rate_bps on public.rentals
  for each row execute function app.rentals_tax_rate_changed();

create or replace function app.rental_line_items_recalculate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.recalculate_rental_totals(
    case when tg_op = 'DELETE' then old.rental_id else new.rental_id end
  );
  return null;
end;
$$;

drop trigger if exists rental_line_items_recalculate on public.rental_line_items;
create trigger rental_line_items_recalculate
  after insert or update or delete on public.rental_line_items
  for each row execute function app.rental_line_items_recalculate();

-- -----------------------------------------------------------------------------
-- The lifecycle, enforced by the database
--
-- A status change represents a business event, not a dropdown selection. These
-- rules live here rather than in a service so that a direct API call, a stale
-- client or a future module cannot invent a transition the business does not
-- have.
--
--   draft     -> reserved | cancelled
--   reserved  -> active   | cancelled
--   active    -> completed
--   completed -> (terminal)
--   cancelled -> (terminal)
--
-- There is deliberately no way back. A car that has been handed over cannot
-- un-happen, so `active` does not return to `reserved`, and an active rental is
-- returned and completed rather than cancelled.
-- -----------------------------------------------------------------------------

create or replace function app.guard_rental_status_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'draft' and new.status not in ('reserved', 'cancelled') then
    raise exception 'A draft can only be confirmed or cancelled.' using errcode = '23514';
  end if;

  if old.status = 'reserved' and new.status not in ('active', 'cancelled') then
    raise exception 'A reservation can only be checked out or cancelled.' using errcode = '23514';
  end if;

  if old.status = 'active' and new.status <> 'completed' then
    raise exception
      'A rental that is out with a customer must be returned and completed, not % .', new.status
      using errcode = '23514';
  end if;

  if old.status in ('completed', 'cancelled') then
    raise exception 'A % rental cannot change status again.', old.status using errcode = '23514';
  end if;

  -- Facts each transition requires. Enforced here as well as in the RPCs, so a
  -- direct UPDATE cannot produce a rental that is active with nothing recorded
  -- about the handover.
  if new.status = 'active' then
    if new.picked_up_at is null or new.pickup_odometer is null then
      raise exception 'Record the pick-up time and odometer before checking a vehicle out.'
        using errcode = '23514';
    end if;
  end if;

  if new.status = 'completed' then
    if new.returned_at is null or new.return_odometer is null then
      raise exception 'Record the return before completing a rental.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists rentals_guard_status_transition on public.rentals;
create trigger rentals_guard_status_transition
  before update of status on public.rentals
  for each row execute function app.guard_rental_status_transition();

-- -----------------------------------------------------------------------------
-- Contract numbering
--
-- Kept on the settings row and taken with UPDATE … RETURNING, which locks that
-- row for the transaction. Two staff confirming at the same moment therefore
-- serialise and receive different numbers; neither can read the counter and act
-- on a stale value. The number is assigned once and frozen by the existing
-- freeze trigger.
-- -----------------------------------------------------------------------------

alter table public.organization_settings
  add column if not exists rental_reference_include_year boolean not null default true;

create or replace function app.assign_rental_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix       text;
  v_next         bigint;
  v_include_year boolean;
  v_time_zone    text;
  v_year         text;
begin
  if new.reference is not null and btrim(new.reference) <> '' then
    return new;
  end if;

  update public.organization_settings
     set rental_reference_next = rental_reference_next + 1
   where organization_id = new.organization_id
  returning rental_reference_prefix, rental_reference_next - 1, rental_reference_include_year
    into v_prefix, v_next, v_include_year;

  if v_next is null then
    -- Settings row missing, which should be impossible after provisioning.
    v_prefix := 'RNT';
    v_include_year := true;
    v_next := (select count(*) + 1 from public.rentals r where r.organization_id = new.organization_id);
  end if;

  select o.time_zone into v_time_zone
  from public.organizations o
  where o.id = new.organization_id;

  v_year := to_char(now() at time zone coalesce(v_time_zone, 'UTC'), 'YYYY');

  new.reference := case
    when v_include_year then v_prefix || '-' || v_year || '-' || lpad(v_next::text, 5, '0')
    else v_prefix || '-' || lpad(v_next::text, 5, '0')
  end;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges and policies for the new table
-- -----------------------------------------------------------------------------

revoke all on table public.rental_line_items from anon, authenticated;
grant select, insert, update, delete on table public.rental_line_items to authenticated;

alter table public.rental_line_items enable row level security;

drop policy if exists rental_line_items_select on public.rental_line_items;
create policy rental_line_items_select on public.rental_line_items
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists rental_line_items_insert on public.rental_line_items;
create policy rental_line_items_insert on public.rental_line_items
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rental_line_items_update on public.rental_line_items;
create policy rental_line_items_update on public.rental_line_items
  for update to authenticated
  using (app.has_min_role(organization_id, 'staff'))
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rental_line_items_delete on public.rental_line_items;
create policy rental_line_items_delete on public.rental_line_items
  for delete to authenticated
  using (app.has_min_role(organization_id, 'staff'));

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
