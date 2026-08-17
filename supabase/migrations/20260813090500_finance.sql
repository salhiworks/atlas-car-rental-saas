-- =============================================================================
-- 20260813090500_finance.sql
--
-- Payments, expenses and vehicle financing.
--
-- Every amount is a BIGINT in minor units with an explicit currency alongside
-- it. Records are never converted between currencies at rest — an agency that
-- changes its default currency does not retroactively rewrite its books.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- payments
--
-- `direction` distinguishes money received (inbound) from money returned
-- (outbound: refunds, deposit releases). Amounts are always positive; sign is a
-- presentation concern derived from direction.
-- -----------------------------------------------------------------------------

create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  rental_id       uuid,
  customer_id     uuid,

  direction     public.payment_direction not null default 'inbound',
  method        public.payment_method    not null default 'cash',
  amount_minor  bigint not null check (amount_minor > 0),
  currency      public.currency_code not null,
  paid_at       timestamptz not null default now(),

  reference   text check (reference is null or char_length(reference) <= 96),
  notes       text check (notes is null or char_length(notes) <= 2000),
  recorded_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint payments_rental_fkey
    foreign key (rental_id, organization_id)
    references public.rentals (id, organization_id)
    on delete cascade,

  constraint payments_customer_fkey
    foreign key (customer_id, organization_id)
    references public.customers (id, organization_id)
    on delete restrict
);

comment on table public.payments is
  'Money received from or returned to a customer. Amounts are positive; `direction` carries the sign.';

create index if not exists payments_organization_paid_at_idx
  on public.payments (organization_id, paid_at desc);

create index if not exists payments_rental_idx on public.payments (rental_id) where rental_id is not null;
create index if not exists payments_customer_idx on public.payments (customer_id) where customer_id is not null;

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function app.set_updated_at();

drop trigger if exists payments_freeze_columns on public.payments;
create trigger payments_freeze_columns
  before update on public.payments
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'recorded_by');

-- -----------------------------------------------------------------------------
-- Rental settlement
--
-- A payment attached to a contract must be denominated in that contract's
-- currency; anything else would make `amount_paid_minor` meaningless.
-- -----------------------------------------------------------------------------

create or replace function app.assert_payment_currency_matches_rental()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency public.currency_code;
begin
  if new.rental_id is null then
    return new;
  end if;

  select r.currency into v_currency
  from public.rentals r
  where r.id = new.rental_id;

  if v_currency is not null and v_currency <> new.currency then
    raise exception 'Payment currency % does not match the contract currency %.', new.currency, v_currency
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists payments_assert_currency on public.payments;
create trigger payments_assert_currency
  before insert or update of currency, rental_id, amount_minor on public.payments
  for each row execute function app.assert_payment_currency_matches_rental();

-- Recomputes the contract's settled total from its payments. Runs as a single
-- aggregate rather than an incremental delta so it is self-healing: a corrected
-- or deleted payment always lands on the right number.
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
begin
  v_rental_ids := array_remove(
    array[
      case when tg_op <> 'INSERT' then old.rental_id end,
      case when tg_op <> 'DELETE' then new.rental_id end
    ],
    null
  );

  foreach v_rental_id in array v_rental_ids loop
    select coalesce(sum(
             case p.direction
               when 'inbound'  then p.amount_minor
               when 'outbound' then -p.amount_minor
             end
           ), 0)
      into v_paid
    from public.payments p
    where p.rental_id = v_rental_id;

    -- Refunds can exceed receipts only through a data error; clamp rather than
    -- violate the non-negative check constraint and abort the caller's write.
    v_paid := greatest(v_paid, 0);

    perform set_config('app.payment_sync', 'on', true);
    update public.rentals r
       set amount_paid_minor = v_paid
     where r.id = v_rental_id
       and r.amount_paid_minor is distinct from v_paid;
    perform set_config('app.payment_sync', 'off', true);
  end loop;

  return null;
end;
$$;

drop trigger if exists payments_sync_rental_totals on public.payments;
create trigger payments_sync_rental_totals
  after insert or update or delete on public.payments
  for each row execute function app.sync_rental_payment_totals();

-- `amount_paid_minor` is derived state. Clients may not set it; only the
-- payment-sync path above may, and it announces itself with a transaction-local flag.
create or replace function app.guard_rental_derived_amounts()
returns trigger
language plpgsql
as $$
begin
  if new.amount_paid_minor is distinct from old.amount_paid_minor
     and coalesce(current_setting('app.payment_sync', true), '') <> 'on' then
    new.amount_paid_minor := old.amount_paid_minor;
  end if;
  return new;
end;
$$;

drop trigger if exists rentals_guard_derived_amounts on public.rentals;
create trigger rentals_guard_derived_amounts
  before update on public.rentals
  for each row execute function app.guard_rental_derived_amounts();

-- -----------------------------------------------------------------------------
-- expenses
-- -----------------------------------------------------------------------------

create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  vehicle_id      uuid,
  rental_id       uuid,

  category     public.expense_category not null default 'other',
  description  text check (description is null or char_length(description) <= 500),
  vendor       text check (vendor is null or char_length(vendor) <= 120),
  amount_minor bigint not null check (amount_minor > 0),
  currency     public.currency_code not null,
  incurred_on  date not null,
  odometer     integer check (odometer is null or odometer >= 0),
  -- Object key inside the private `expense-receipts` storage bucket.
  receipt_path text check (receipt_path is null or char_length(receipt_path) <= 512),

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint expenses_vehicle_fkey
    foreign key (vehicle_id, organization_id)
    references public.vehicles (id, organization_id)
    on delete restrict,

  constraint expenses_rental_fkey
    foreign key (rental_id, organization_id)
    references public.rentals (id, organization_id)
    on delete set null
);

comment on table public.expenses is 'Operating costs, optionally attributed to a vehicle or a specific contract.';

create index if not exists expenses_organization_date_idx
  on public.expenses (organization_id, incurred_on desc);

create index if not exists expenses_vehicle_idx
  on public.expenses (vehicle_id, incurred_on desc)
  where vehicle_id is not null;

create index if not exists expenses_category_idx on public.expenses (organization_id, category, incurred_on desc);

drop trigger if exists expenses_set_updated_at on public.expenses;
create trigger expenses_set_updated_at
  before update on public.expenses
  for each row execute function app.set_updated_at();

drop trigger if exists expenses_freeze_columns on public.expenses;
create trigger expenses_freeze_columns
  before update on public.expenses
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- financing_plans
--
-- Interest is stored in integer basis points. A rate is a number the business
-- reports on; it does not get to be a float.
-- -----------------------------------------------------------------------------

create table if not exists public.financing_plans (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  vehicle_id      uuid,

  kind      public.financing_kind   not null default 'loan',
  status    public.financing_status not null default 'active',
  provider  text not null check (char_length(btrim(provider)) between 1 and 120),
  reference text check (reference is null or char_length(reference) <= 96),

  currency                public.currency_code not null,
  principal_minor         bigint not null check (principal_minor >= 0),
  down_payment_minor      bigint not null default 0 check (down_payment_minor >= 0),
  installment_minor       bigint not null default 0 check (installment_minor >= 0),
  installments_count      smallint check (installments_count is null or installments_count between 1 and 600),
  installments_paid       smallint not null default 0 check (installments_paid >= 0),
  interest_rate_bps       integer not null default 0 check (interest_rate_bps between 0 and 1000000),
  balloon_payment_minor   bigint not null default 0 check (balloon_payment_minor >= 0),

  starts_on         date not null,
  ends_on           date,
  first_payment_on  date,
  payment_day       smallint check (payment_day is null or payment_day between 1 and 31),

  notes      text check (notes is null or char_length(notes) <= 2000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint financing_plans_period_valid check (ends_on is null or ends_on >= starts_on),
  constraint financing_plans_installments_consistent check (
    installments_count is null or installments_paid <= installments_count
  ),

  constraint financing_plans_vehicle_fkey
    foreign key (vehicle_id, organization_id)
    references public.vehicles (id, organization_id)
    on delete restrict
);

comment on table public.financing_plans is 'Loan, lease or instalment agreement funding a vehicle or the fleet.';
comment on column public.financing_plans.interest_rate_bps is 'Annual nominal rate in basis points. 7.25% is stored as 725.';

create index if not exists financing_plans_organization_idx
  on public.financing_plans (organization_id, status, starts_on desc);

create index if not exists financing_plans_vehicle_idx
  on public.financing_plans (vehicle_id)
  where vehicle_id is not null;

drop trigger if exists financing_plans_set_updated_at on public.financing_plans;
create trigger financing_plans_set_updated_at
  before update on public.financing_plans
  for each row execute function app.set_updated_at();

drop trigger if exists financing_plans_freeze_columns on public.financing_plans;
create trigger financing_plans_freeze_columns
  before update on public.financing_plans
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- notifications — reminders surfaced in the product
--
-- `user_id IS NULL` addresses the whole agency; a value targets one member.
-- `resource_type`/`resource_id` are a deliberately loose pointer so new modules
-- can raise reminders without a schema change.
-- -----------------------------------------------------------------------------

create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid references auth.users (id) on delete cascade,

  category  public.notification_category not null default 'system',
  severity  public.notification_severity not null default 'info',
  title     text not null check (char_length(btrim(title)) between 1 and 160),
  body      text check (body is null or char_length(body) <= 2000),

  resource_type text check (resource_type is null or char_length(resource_type) <= 60),
  resource_id   uuid,
  action_path   text check (action_path is null or char_length(action_path) <= 255),

  -- Set when the reminder stops being actionable, so re-runs stay idempotent.
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 200),
  due_at     timestamptz,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.notifications is 'In-product reminders and alerts, scoped to an agency and optionally to one member.';

create unique index if not exists notifications_dedupe_idx
  on public.notifications (organization_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists notifications_inbox_idx
  on public.notifications (organization_id, created_at desc);

create index if not exists notifications_unread_idx
  on public.notifications (organization_id, user_id)
  where read_at is null;
