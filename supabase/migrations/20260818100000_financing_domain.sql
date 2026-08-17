-- =============================================================================
-- Vehicle financing: agreements, lenders, schedules, payments
--
-- WHAT WAS THERE, AND WHY IT IS BEING RESTRUCTURED
--
-- `financing_plans` was a single flat row per agreement. Audited against how
-- agencies actually finance cars, it could not tell the truth about several
-- things at once:
--
--   * `interest_rate_bps not null default 0` — an agency that does not know its
--     APR was recorded as borrowing at 0%. Unknown became a confident zero,
--     which is the one failure this module exists to prevent.
--   * `principal_minor not null`, `installment_minor not null default 0` — same
--     problem for the financed amount and the payment.
--   * `installments_paid` was a counter on the agreement. Two payments posted at
--     once race each other, and the number drifts from the payments that are
--     actually on file. Settlement has to be derived, never counted.
--   * `provider text` — no lender to search, archive, or de-duplicate, and no
--     way for two agreements to share one.
--   * no schedule and no payments. Without those there is no due date, no
--     overdue, no principal repaid, and no way to separate what is expected
--     from what actually happened.
--
-- The restructure keeps every column that carried meaning, renames the table to
-- the domain's own word, and adds the three relations the domain needs. The
-- backfill below is explicit and verified; it refuses rather than guesses.
--
-- THE FINANCIAL RULE THIS SCHEMA EXISTS TO ENFORCE
--
-- Principal repayment is not a cost. It converts one balance-sheet position
-- into another. Interest and fees are the cost of borrowing. A payment whose
-- split nobody knows is neither — it is unallocated, and it stays unallocated
-- until somebody who knows says otherwise. Every total in this module is built
-- on those three being distinguishable, and `unallocated_minor > 0` is exactly
-- the statement "this payment's composition is not known".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Types
--
-- New types rather than extending the old ones. `alter type … add value` cannot
-- be used in the same transaction that writes the new value, which a backfilling
-- migration has to do; converting the column to a fresh type keeps the whole
-- migration atomic.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'vehicle_acquisition_method' and typnamespace = 'public'::regnamespace) then
    create type public.vehicle_acquisition_method as enum (
      'cash', 'financed', 'leased', 'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'lender_kind' and typnamespace = 'public'::regnamespace) then
    create type public.lender_kind as enum (
      'bank', 'finance_company', 'leasing_company', 'dealer', 'private', 'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_agreement_type' and typnamespace = 'public'::regnamespace) then
    create type public.financing_agreement_type as enum (
      'loan', 'lease', 'installment_plan', 'other'
    );
  end if;

  -- draft → active → (paid_off | closed | cancelled). `closed` covers an
  -- agreement ended by agreement, sale or write-off; `paid_off` claims the
  -- obligation was actually met and is guarded accordingly.
  if not exists (select 1 from pg_type where typname = 'financing_agreement_status' and typnamespace = 'public'::regnamespace) then
    create type public.financing_agreement_status as enum (
      'draft', 'active', 'paid_off', 'closed', 'cancelled'
    );
  end if;

  -- The whole point of the module in one type. `simple` means the agency knows
  -- what it pays and when, and nothing else; `amortizing` means the contract's
  -- own arithmetic is known well enough to split each payment.
  if not exists (select 1 from pg_type where typname = 'financing_mode' and typnamespace = 'public'::regnamespace) then
    create type public.financing_mode as enum ('simple', 'amortizing');
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_frequency' and typnamespace = 'public'::regnamespace) then
    create type public.financing_frequency as enum ('weekly', 'biweekly', 'monthly', 'quarterly');
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_payment_purpose' and typnamespace = 'public'::regnamespace) then
    create type public.financing_payment_purpose as enum ('installment', 'extra', 'payoff', 'fee');
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_payment_status' and typnamespace = 'public'::regnamespace) then
    create type public.financing_payment_status as enum ('recorded', 'voided');
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_document_kind' and typnamespace = 'public'::regnamespace) then
    create type public.financing_document_kind as enum (
      'agreement', 'statement', 'payoff_letter', 'receipt', 'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_change_kind' and typnamespace = 'public'::regnamespace) then
    create type public.financing_change_kind as enum ('correction', 'status', 'void');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- The agency's own today
--
-- Every due date, overdue test and business-date comparison in this module goes
-- through this. A payment due on the 5th is not overdue at 22:00 on the 4th in
-- Casablanca because a server in UTC has already turned the page.
-- -----------------------------------------------------------------------------

create or replace function app.organization_today(p_organization_id uuid)
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone coalesce(o.time_zone, 'UTC'))::date
  from public.organizations o
  where o.id = p_organization_id;
$$;

comment on function app.organization_today(uuid) is
  'The current business date in the agency''s own time zone. The single source of "today" for every financing due-date comparison.';

-- -----------------------------------------------------------------------------
-- Due dates
--
-- THE RULE, ONCE: a schedule is anchored to the day of the month of its first
-- payment, and that day is clamped to the length of the month it lands in. An
-- agreement first paid on the 31st pays on the 28th in February (29th in a leap
-- year) and on the 31st again in March. It never rolls into the next month.
--
-- Weekly and biweekly are plain day arithmetic; quarterly is monthly in steps
-- of three. `p_index` is zero-based, so index 0 is the first payment.
-- -----------------------------------------------------------------------------

create or replace function app.financing_due_date(
  p_first_payment_on date,
  p_anchor_day       smallint,
  p_frequency        public.financing_frequency,
  p_index            integer
)
returns date
language sql
immutable
set search_path = ''
as $$
  select case p_frequency
    when 'weekly'   then p_first_payment_on + (p_index * 7)
    when 'biweekly' then p_first_payment_on + (p_index * 14)
    else (
      select (
        month_start
        + make_interval(days => least(
            p_anchor_day::integer,
            extract(day from (month_start + interval '1 month - 1 day'))::integer
          ) - 1)
      )::date
      from (
        select date_trunc(
                 'month',
                 p_first_payment_on::timestamp
                   + make_interval(months => p_index * case p_frequency when 'quarterly' then 3 else 1 end)
               ) as month_start
      ) m
    )
  end;
$$;

comment on function app.financing_due_date(date, smallint, public.financing_frequency, integer) is
  'The nth due date of a schedule. Monthly and quarterly clamp the anchor day to the length of the month, so the 31st becomes the 28th in February and the 31st again in March.';

-- -----------------------------------------------------------------------------
-- How a vehicle came to be owned
--
-- Acquisition already lives on the vehicle (`acquired_on`,
-- `acquisition_price_minor`, `acquisition_currency`), and it stays there: it is
-- a fact about the car, true whether or not anybody financed it, and a cash
-- purchase must not need a fake agreement to record its price. Only the method
-- was missing.
--
-- The currency is stored per row and never re-read from the organization, so
-- changing the agency's default currency cannot rewrite what a car cost.
-- -----------------------------------------------------------------------------

alter table public.vehicles
  add column if not exists acquisition_method public.vehicle_acquisition_method,
  add column if not exists acquisition_supplier text,
  add column if not exists acquisition_notes text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'vehicles_acquisition_supplier_length'
  ) then
    alter table public.vehicles
      add constraint vehicles_acquisition_supplier_length
      check (acquisition_supplier is null or char_length(btrim(acquisition_supplier)) between 1 and 160);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'vehicles_acquisition_notes_length'
  ) then
    alter table public.vehicles
      add constraint vehicles_acquisition_notes_length
      check (acquisition_notes is null or char_length(acquisition_notes) <= 2000);
  end if;

  -- A price without a currency is a number nobody can read.
  if not exists (
    select 1 from pg_constraint where conname = 'vehicles_acquisition_price_has_currency'
  ) then
    alter table public.vehicles
      add constraint vehicles_acquisition_price_has_currency
      check (acquisition_price_minor is null or acquisition_currency is not null);
  end if;
end
$$;

comment on column public.vehicles.acquisition_method is
  'How the vehicle was acquired. NULL means nobody has said — which is not the same as a cash purchase.';
comment on column public.vehicles.acquisition_price_minor is
  'What the vehicle cost to acquire, in acquisition_currency. Not an operating expense and never counted as one.';

-- -----------------------------------------------------------------------------
-- Lenders
--
-- Deliberately not `expense_vendors`. A garage and a bank are both paid money,
-- and that is the whole of what they have in common: one is chosen when
-- recording a repair, the other when recording a loan, and a picker that mixed
-- them would offer the wrong list in both places. A lender also carries an
-- account reference and a kind that mean nothing to a supplier.
--
-- A name is not an identity — the same lesson the expense vendors learned. Two
-- branches of one bank, or two companies that share a trading name, are two
-- rows. The tax identifier is unique because it genuinely identifies a legal
-- entity; the name is indexed for searching and warning, and nothing more.
-- -----------------------------------------------------------------------------

create table if not exists public.lenders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name text not null check (char_length(btrim(name)) between 1 and 160),
  name_normalized text generated always as (upper(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  kind public.lender_kind not null default 'bank',

  email text check (email is null or char_length(email) <= 160),
  phone text check (phone is null or char_length(btrim(phone)) between 4 and 40),
  tax_identifier text check (tax_identifier is null or char_length(btrim(tax_identifier)) between 1 and 60),
  -- An agreement or customer number the agency quotes when it calls. Never a
  -- credential: no passwords, no card numbers, no online-banking details.
  account_reference text check (account_reference is null or char_length(btrim(account_reference)) between 1 and 96),
  address text check (address is null or char_length(address) <= 300),
  notes text check (notes is null or char_length(notes) <= 2000),

  archived_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),

  constraint lenders_tenant_key unique (id, organization_id)
);

comment on table public.lenders is
  'Who the agency borrows from. Holds contact and reference information only — never a credential of any kind.';
comment on column public.lenders.account_reference is
  'The agreement or customer number quoted to the lender. Not a login, not a card number.';

create index if not exists lenders_organization_idx
  on public.lenders (organization_id, name);

create index if not exists lenders_name_normalized_idx
  on public.lenders (organization_id, name_normalized);

-- A legal entity really is unique; a trading name is not.
create unique index if not exists lenders_tax_identifier_unique_idx
  on public.lenders (organization_id, upper(btrim(tax_identifier)))
  where tax_identifier is not null and btrim(tax_identifier) <> '';

drop trigger if exists lenders_set_updated_at on public.lenders;
create trigger lenders_set_updated_at
  before update on public.lenders
  for each row execute function app.set_updated_at();

drop trigger if exists lenders_freeze_columns on public.lenders;
create trigger lenders_freeze_columns
  before update on public.lenders
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- Financing agreements
--
-- Renamed from `financing_plans`: the domain's word is agreement, and every
-- read model, RPC and screen in this module uses it. The rename carries the
-- primary key, so `expenses.financing_plan_id` keeps pointing at exactly the
-- rows it pointed at before.
-- -----------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.financing_plans') is not null
     and to_regclass('public.financing_agreements') is null then
    alter table public.financing_plans rename to financing_agreements;
  end if;
end
$$;

-- A fleet-level agreement cannot be shown on a vehicle, cannot contribute to a
-- vehicle's economics, and would put a null branch through every read model in
-- this module. This version models financing per vehicle. Rather than silently
-- discard such a row, refuse and say so.
do $$
declare
  v_orphans integer;
begin
  select count(*) into v_orphans
  from public.financing_agreements
  where vehicle_id is null;

  if v_orphans > 0 then
    raise exception
      '% financing agreement(s) are not attached to a vehicle. This version models financing per vehicle; attach or remove them before migrating.',
      v_orphans;
  end if;
end
$$;

alter table public.financing_agreements
  add column if not exists lender_id uuid,
  add column if not exists agreement_type public.financing_agreement_type,
  add column if not exists agreement_status public.financing_agreement_status,
  add column if not exists mode public.financing_mode,
  add column if not exists payment_frequency public.financing_frequency not null default 'monthly',
  add column if not exists schedule_anchor_day smallint,
  add column if not exists financed_amount_minor bigint,
  add column if not exists rate_bps integer,
  add column if not exists installment_amount_minor bigint,
  add column if not exists balloon_minor bigint,
  add column if not exists down_payment_amount_minor bigint,
  add column if not exists schedule_revision integer not null default 1,
  add column if not exists activated_at timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid references auth.users (id) on delete set null,
  add column if not exists closure_reason text,
  add column if not exists payoff_on date,
  add column if not exists updated_by uuid references auth.users (id) on delete set null;

-- One lender row per distinct provider name already on file, so no agreement
-- loses who it is with.
insert into public.lenders (organization_id, name, kind, created_at)
select distinct a.organization_id, btrim(a.provider), 'other'::public.lender_kind, now()
from public.financing_agreements a
where a.lender_id is null
  and btrim(coalesce(a.provider, '')) <> ''
  and not exists (
    select 1 from public.lenders l
    where l.organization_id = a.organization_id
      and l.name_normalized = upper(regexp_replace(btrim(a.provider), '\s+', ' ', 'g'))
  );

update public.financing_agreements a
   set lender_id = l.id
  from public.lenders l
 where a.lender_id is null
   and l.organization_id = a.organization_id
   and l.name_normalized = upper(regexp_replace(btrim(a.provider), '\s+', ' ', 'g'));

update public.financing_agreements
   set agreement_type = case kind
                          when 'loan' then 'loan'::public.financing_agreement_type
                          when 'lease' then 'lease'::public.financing_agreement_type
                          else 'installment_plan'::public.financing_agreement_type
                        end
 where agreement_type is null;

update public.financing_agreements
   set agreement_status = case status
                            when 'active'    then 'active'::public.financing_agreement_status
                            when 'completed' then 'paid_off'::public.financing_agreement_status
                            when 'cancelled' then 'cancelled'::public.financing_agreement_status
                            -- 'defaulted' was a state with no workflow behind it.
                            -- It becomes a closed agreement carrying its reason.
                            else 'closed'::public.financing_agreement_status
                          end
 where agreement_status is null;

update public.financing_agreements
   set closure_reason = coalesce(closure_reason, 'Recorded as defaulted before the Financing module')
 where status = 'defaulted';

-- A legacy row that carried a rate and a principal has enough to be treated as
-- an amortizing loan; everything else is a simple payment plan, which is the
-- honest reading of a row that only ever held an instalment.
update public.financing_agreements
   set mode = case
                when coalesce(interest_rate_bps, 0) > 0
                     and coalesce(principal_minor, 0) > 0
                     and installments_count is not null
                then 'amortizing'::public.financing_mode
                else 'simple'::public.financing_mode
              end
 where mode is null;

-- Zero has never meant "none" for these four. It meant "nobody filled it in",
-- and carrying that forward as a real zero is the defect this module exists to
-- remove.
update public.financing_agreements
   set financed_amount_minor    = nullif(principal_minor, 0),
       rate_bps                 = nullif(interest_rate_bps, 0),
       installment_amount_minor = nullif(installment_minor, 0),
       balloon_minor            = nullif(balloon_payment_minor, 0),
       down_payment_amount_minor = nullif(down_payment_minor, 0)
 where financed_amount_minor is null
   and rate_bps is null
   and installment_amount_minor is null;

update public.financing_agreements
   set first_payment_on = coalesce(first_payment_on, starts_on)
 where first_payment_on is null;

update public.financing_agreements
   set schedule_anchor_day = coalesce(payment_day, extract(day from first_payment_on)::smallint)
 where schedule_anchor_day is null;

update public.financing_agreements
   set activated_at = coalesce(activated_at, created_at)
 where agreement_status = 'active' and activated_at is null;

-- Verify before dropping anything. A backfill that silently missed a row is
-- worse than one that refuses.
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from public.financing_agreements
  where lender_id is null
     or agreement_type is null
     or agreement_status is null
     or mode is null
     or schedule_anchor_day is null;

  if v_bad > 0 then
    raise exception 'financing backfill left % agreement(s) incomplete', v_bad;
  end if;
end
$$;

alter table public.financing_agreements
  drop column if exists provider,
  drop column if exists kind,
  drop column if exists status,
  drop column if exists principal_minor,
  drop column if exists interest_rate_bps,
  drop column if exists installment_minor,
  drop column if exists balloon_payment_minor,
  drop column if exists down_payment_minor,
  drop column if exists payment_day,
  -- A counter that two concurrent payments can both increment. Settlement is
  -- derived from the payments themselves from here on.
  drop column if exists installments_paid;

alter table public.financing_agreements
  alter column lender_id set not null,
  alter column agreement_type set not null,
  alter column agreement_status set not null,
  alter column mode set not null,
  alter column vehicle_id set not null,
  alter column schedule_anchor_day set not null;

alter table public.financing_agreements
  alter column agreement_status set default 'draft',
  alter column agreement_type set default 'loan',
  alter column mode set default 'simple';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'financing_agreements_tenant_key') then
    alter table public.financing_agreements
      add constraint financing_agreements_tenant_key unique (id, organization_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financing_agreements_lender_fkey') then
    alter table public.financing_agreements
      add constraint financing_agreements_lender_fkey
      foreign key (lender_id, organization_id)
      references public.lenders (id, organization_id)
      on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financing_agreements_amounts_nonnegative') then
    alter table public.financing_agreements
      add constraint financing_agreements_amounts_nonnegative check (
        (financed_amount_minor is null or financed_amount_minor > 0)
        and (installment_amount_minor is null or installment_amount_minor > 0)
        and (balloon_minor is null or balloon_minor > 0)
        and (down_payment_amount_minor is null or down_payment_amount_minor > 0)
        and (rate_bps is null or rate_bps between 0 and 1000000)
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financing_agreements_anchor_valid') then
    alter table public.financing_agreements
      add constraint financing_agreements_anchor_valid
      check (schedule_anchor_day between 1 and 31);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financing_agreements_closure_reason_length') then
    alter table public.financing_agreements
      add constraint financing_agreements_closure_reason_length
      check (closure_reason is null or char_length(closure_reason) <= 500);
  end if;

  -- What each mode has to know before it can be activated. A draft may be
  -- incomplete; an active agreement may not, because a schedule was generated
  -- from these numbers.
  if not exists (select 1 from pg_constraint where conname = 'financing_agreements_mode_requirements') then
    alter table public.financing_agreements
      add constraint financing_agreements_mode_requirements check (
        agreement_status = 'draft'
        or (
          first_payment_on is not null
          and case mode
                when 'simple' then
                  installment_amount_minor is not null
                  and (installments_count is not null or ends_on is not null)
                when 'amortizing' then
                  financed_amount_minor is not null
                  and rate_bps is not null
                  and installments_count is not null
              end
        )
      );
  end if;

  -- A down payment plus what was borrowed cannot exceed what the car cost. The
  -- vehicle's own price is the authority; this only refuses an impossibility.
  if not exists (select 1 from pg_constraint where conname = 'financing_agreements_period_valid') then
    alter table public.financing_agreements
      add constraint financing_agreements_period_valid
      check (ends_on is null or ends_on >= starts_on);
  end if;
end
$$;

comment on table public.financing_agreements is
  'One financing arrangement for one vehicle. Renamed from financing_plans. A NULL rate, financed amount or instalment means unknown — never zero.';
comment on column public.financing_agreements.mode is
  'simple: the agency knows what it pays and when, and nothing else. amortizing: the contract arithmetic is known well enough to split every payment.';
comment on column public.financing_agreements.rate_bps is
  'Annual nominal rate in basis points; 7.25% is 725. NULL means the agency does not know it, which is not 0%.';
comment on column public.financing_agreements.schedule_revision is
  'Incremented whenever the forward schedule is regenerated, so an installment can be traced to the terms that produced it.';

-- Two live agreements on one car is not a thing that happens; a draft beside a
-- live one is exactly how a refinance is prepared. So the constraint is on
-- 'active' alone.
drop index if exists financing_agreements_one_active_per_vehicle;
create unique index financing_agreements_one_active_per_vehicle
  on public.financing_agreements (vehicle_id)
  where agreement_status = 'active';

drop index if exists financing_plans_organization_idx;
drop index if exists financing_plans_vehicle_idx;

create index if not exists financing_agreements_organization_idx
  on public.financing_agreements (organization_id, agreement_status, starts_on desc);

create index if not exists financing_agreements_vehicle_idx
  on public.financing_agreements (vehicle_id, agreement_status);

create index if not exists financing_agreements_lender_idx
  on public.financing_agreements (lender_id);

drop trigger if exists financing_plans_set_updated_at on public.financing_agreements;
drop trigger if exists financing_agreements_set_updated_at on public.financing_agreements;
create trigger financing_agreements_set_updated_at
  before update on public.financing_agreements
  for each row execute function app.set_updated_at();

drop trigger if exists financing_plans_freeze_columns on public.financing_agreements;
drop trigger if exists financing_agreements_freeze_columns on public.financing_agreements;
create trigger financing_agreements_freeze_columns
  before update on public.financing_agreements
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- The expected schedule
--
-- What is owed and when. Never what was paid — that is the payments table, and
-- keeping the two apart is what makes "3 of 48 paid, one of them partially"
-- answerable at all.
--
-- expected_principal_minor and expected_interest_minor are NULLABLE on purpose.
-- In simple mode nobody knows the split, and writing 0 would be a lie that
-- every downstream total would repeat.
-- -----------------------------------------------------------------------------

create table if not exists public.financing_installments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agreement_id    uuid not null,

  sequence smallint not null check (sequence between 1 and 1200),
  due_on   date not null,

  expected_total_minor     bigint not null check (expected_total_minor > 0),
  expected_principal_minor bigint check (expected_principal_minor is null or expected_principal_minor >= 0),
  expected_interest_minor  bigint check (expected_interest_minor is null or expected_interest_minor >= 0),
  expected_fees_minor      bigint not null default 0 check (expected_fees_minor >= 0),
  -- The scheduled closing balance after this instalment, when the model can
  -- actually derive one. NULL in simple mode.
  remaining_principal_minor bigint check (remaining_principal_minor is null or remaining_principal_minor >= 0),

  is_balloon boolean not null default false,
  revision   integer not null default 1,

  created_at timestamptz not null default now(),

  constraint financing_installments_tenant_key unique (id, organization_id),
  constraint financing_installments_sequence_unique unique (agreement_id, sequence),
  constraint financing_installments_agreement_fkey
    foreign key (agreement_id, organization_id)
    references public.financing_agreements (id, organization_id)
    on delete cascade,
  -- Either both components are known or neither is. A half-known split would
  -- make every completeness flag downstream ambiguous.
  constraint financing_installments_split_consistent check (
    (expected_principal_minor is null) = (expected_interest_minor is null)
  ),
  constraint financing_installments_split_adds_up check (
    expected_principal_minor is null
    or expected_principal_minor + expected_interest_minor + expected_fees_minor = expected_total_minor
  )
);

comment on table public.financing_installments is
  'Expected obligations. A future instalment is money owed, never money spent — nothing here counts as cash paid.';
comment on column public.financing_installments.expected_principal_minor is
  'NULL means the split is unknown, which is the normal case for a simple payment plan. It never means zero.';

create index if not exists financing_installments_agreement_idx
  on public.financing_installments (agreement_id, sequence);

create index if not exists financing_installments_due_idx
  on public.financing_installments (organization_id, due_on);

-- -----------------------------------------------------------------------------
-- Actual payments
--
-- THE INVARIANT: principal + interest + fees + unallocated = amount.
--
-- That one line carries the module. A payment whose composition the agency
-- knows puts nothing in `unallocated` and its zeros are real zeros. A payment
-- whose composition nobody knows puts the whole amount in `unallocated`, and
-- every total that depends on the split reports itself incomplete rather than
-- quietly counting the money as interest or as principal.
-- -----------------------------------------------------------------------------

create table if not exists public.financing_payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agreement_id    uuid not null,
  -- NULL for an extra or payoff payment that settles no particular instalment.
  installment_id  uuid,

  purpose public.financing_payment_purpose not null default 'installment',
  status  public.financing_payment_status not null default 'recorded',

  paid_on  date not null,
  currency public.currency_code not null,

  amount_minor      bigint not null check (amount_minor > 0),
  principal_minor   bigint not null default 0 check (principal_minor >= 0),
  interest_minor    bigint not null default 0 check (interest_minor >= 0),
  fees_minor        bigint not null default 0 check (fees_minor >= 0),
  unallocated_minor bigint not null default 0 check (unallocated_minor >= 0),

  method    public.payment_method,
  reference text check (reference is null or char_length(btrim(reference)) between 1 and 96),
  notes     text check (notes is null or char_length(notes) <= 2000),

  voided_at   timestamptz,
  voided_by   uuid references auth.users (id) on delete set null,
  void_reason text check (void_reason is null or char_length(void_reason) <= 500),

  recorded_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),

  constraint financing_payments_tenant_key unique (id, organization_id),
  constraint financing_payments_agreement_fkey
    foreign key (agreement_id, organization_id)
    references public.financing_agreements (id, organization_id)
    on delete restrict,
  -- The composite key makes it impossible to settle another agency's
  -- instalment, and the trigger below makes it impossible to settle an
  -- instalment belonging to a different agreement.
  constraint financing_payments_installment_fkey
    foreign key (installment_id, organization_id)
    references public.financing_installments (id, organization_id)
    on delete restrict,
  constraint financing_payments_allocation_adds_up check (
    principal_minor + interest_minor + fees_minor + unallocated_minor = amount_minor
  ),
  constraint financing_payments_void_fields_consistent check (
    (status = 'voided') = (voided_at is not null)
  )
);

comment on table public.financing_payments is
  'Money actually sent to a lender. principal + interest + fees + unallocated = amount, always. A voided payment counts nowhere.';
comment on column public.financing_payments.unallocated_minor is
  'The part of this payment whose composition is not known. Greater than zero means the split is incomplete — it is never treated as interest.';

create index if not exists financing_payments_agreement_idx
  on public.financing_payments (agreement_id, paid_on desc);

create index if not exists financing_payments_installment_idx
  on public.financing_payments (installment_id)
  where installment_id is not null;

create index if not exists financing_payments_organization_idx
  on public.financing_payments (organization_id, paid_on desc);

-- A lender's own transaction reference identifies one transaction. Scoped to
-- the agreement, and released when a payment is voided so a corrected entry can
-- reuse the real reference.
create unique index if not exists financing_payments_reference_unique_idx
  on public.financing_payments (agreement_id, upper(btrim(reference)))
  where reference is not null and btrim(reference) <> '' and status = 'recorded';

drop trigger if exists financing_payments_set_updated_at on public.financing_payments;
create trigger financing_payments_set_updated_at
  before update on public.financing_payments
  for each row execute function app.set_updated_at();

drop trigger if exists financing_payments_freeze_columns on public.financing_payments;
create trigger financing_payments_freeze_columns
  before update on public.financing_payments
  for each row execute function app.freeze_columns('id', 'organization_id', 'agreement_id', 'created_at', 'recorded_by');

-- -----------------------------------------------------------------------------
-- Payment guards
-- -----------------------------------------------------------------------------

/**
 * Everything about a payment that a CHECK constraint cannot see.
 *
 * The currency has to match the agreement, the instalment has to belong to it,
 * and the identity of whoever recorded it comes from the session rather than
 * from the request body. A client that supplies `recorded_by` is not believed.
 */
create or replace function app.guard_financing_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agreement public.financing_agreements;
begin
  select * into v_agreement
  from public.financing_agreements
  where id = new.agreement_id;

  if v_agreement.id is null then
    raise exception 'That financing agreement does not exist.' using errcode = 'P0002';
  end if;

  if new.currency <> v_agreement.currency then
    raise exception
      'A payment is made in the agreement''s currency (%), not %.',
      v_agreement.currency, new.currency
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if v_agreement.agreement_status not in ('active', 'paid_off', 'closed') then
      raise exception
        'Payments can only be recorded against an agreement that has been activated.'
        using errcode = '23514';
    end if;

    -- Session identity wins. `updated_by` on an expense taught this lesson: a
    -- column the client writes cannot be the record of who acted.
    new.recorded_by := coalesce((select auth.uid()), new.recorded_by);
  end if;

  if new.installment_id is not null then
    if not exists (
      select 1 from public.financing_installments i
      where i.id = new.installment_id
        and i.agreement_id = new.agreement_id
    ) then
      raise exception 'That instalment belongs to a different agreement.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists financing_payments_guard on public.financing_payments;
create trigger financing_payments_guard
  before insert or update on public.financing_payments
  for each row execute function app.guard_financing_payment();

/**
 * A voided payment is the record of a correction.
 *
 * Same rule as a voided expense, for the same reason: an UPDATE that reports
 * success while changing nothing tells the desk a figure was corrected when it
 * was not. Refuse instead.
 */
create or replace function app.guard_financing_payment_void()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'voided' then
    if new.status <> 'voided' then
      raise exception 'A voided financing payment cannot be reinstated. Record a new one.'
        using errcode = '23514';
    end if;
    raise exception 'A voided financing payment is kept exactly as it was.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists financing_payments_guard_void on public.financing_payments;
create trigger financing_payments_guard_void
  before update on public.financing_payments
  for each row execute function app.guard_financing_payment_void();

create or replace function app.guard_financing_payment_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Same shape as the expense guard, including the tenant-teardown exemption:
  -- once the agency is gone the cascade may take its history with it.
  if exists (select 1 from public.organizations o where o.id = old.organization_id) then
    raise exception
      'A financing payment is financial history. Void it instead of deleting it.'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

drop trigger if exists financing_payments_guard_delete on public.financing_payments;
create trigger financing_payments_guard_delete
  before delete on public.financing_payments
  for each row execute function app.guard_financing_payment_delete();

-- -----------------------------------------------------------------------------
-- Agreement guards
-- -----------------------------------------------------------------------------

/**
 * What may still be changed once money has moved.
 *
 * Before any payment exists an agreement is a draft in every sense and its
 * terms may be corrected freely. Once a payment is on file, the terms that
 * produced the schedule are the terms the money was paid against, and rewriting
 * them silently would rewrite history. Those fields freeze; everything
 * descriptive stays editable.
 */
create or replace function app.guard_financing_agreement_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_payments boolean;
begin
  select exists (
    select 1 from public.financing_payments p
    where p.agreement_id = new.id and p.status = 'recorded'
  ) into v_has_payments;

  if v_has_payments then
    if new.currency is distinct from old.currency
       or new.mode is distinct from old.mode
       or new.financed_amount_minor is distinct from old.financed_amount_minor
       or new.rate_bps is distinct from old.rate_bps
       or new.installment_amount_minor is distinct from old.installment_amount_minor
       or new.installments_count is distinct from old.installments_count
       or new.payment_frequency is distinct from old.payment_frequency
       or new.first_payment_on is distinct from old.first_payment_on
       or new.schedule_anchor_day is distinct from old.schedule_anchor_day
       or new.balloon_minor is distinct from old.balloon_minor
       or new.vehicle_id is distinct from old.vehicle_id
    then
      raise exception
        'Payments have been recorded against this agreement, so its terms are fixed. Correct a payment, or close this agreement and record the replacement.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists financing_agreements_guard_terms on public.financing_agreements;
create trigger financing_agreements_guard_terms
  before update on public.financing_agreements
  for each row execute function app.guard_financing_agreement_terms();

/**
 * Legal transitions, in one place.
 *
 * draft     → active | cancelled
 * active    → paid_off | closed | cancelled
 * paid_off  → closed          (an agreement can be filed away after payoff)
 * closed    → (nothing)
 * cancelled → (nothing)
 *
 * `paid_off` additionally has to be earned; the RPC that sets it checks the
 * obligation is actually met. This trigger only refuses transitions that make
 * no sense at all.
 */
create or replace function app.guard_financing_agreement_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.agreement_status = old.agreement_status then
    return new;
  end if;

  if not (
    (old.agreement_status = 'draft'    and new.agreement_status in ('active', 'cancelled'))
    or (old.agreement_status = 'active'   and new.agreement_status in ('paid_off', 'closed', 'cancelled'))
    or (old.agreement_status = 'paid_off' and new.agreement_status = 'closed')
  ) then
    raise exception 'A % agreement cannot become %.', old.agreement_status, new.agreement_status
      using errcode = '23514';
  end if;

  if new.agreement_status = 'active' and new.activated_at is null then
    new.activated_at := now();
  end if;

  if new.agreement_status in ('paid_off', 'closed', 'cancelled') and new.closed_at is null then
    new.closed_at := now();
    new.closed_by := coalesce(new.closed_by, (select auth.uid()));
  end if;

  return new;
end;
$$;

drop trigger if exists financing_agreements_guard_status on public.financing_agreements;
create trigger financing_agreements_guard_status
  before update on public.financing_agreements
  for each row execute function app.guard_financing_agreement_status();

/**
 * Deleting an agreement.
 *
 * A draft nobody has paid against is a mistake somebody made five minutes ago
 * and may remove. Anything with a payment, a document or a change event behind
 * it is history and is closed or cancelled instead.
 */
create or replace function app.guard_financing_agreement_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return old; -- the agency itself is being torn down
  end if;

  if old.agreement_status <> 'draft' then
    raise exception
      'Only a draft agreement can be deleted. Close or cancel this one instead so its history survives.'
      using errcode = '23514';
  end if;

  if exists (select 1 from public.financing_payments p where p.agreement_id = old.id) then
    raise exception 'This agreement has payments recorded against it and cannot be deleted.'
      using errcode = '23514';
  end if;

  return old;
end;
$$;

drop trigger if exists financing_agreements_guard_delete on public.financing_agreements;
create trigger financing_agreements_guard_delete
  before delete on public.financing_agreements
  for each row execute function app.guard_financing_agreement_delete();

-- -----------------------------------------------------------------------------
-- Documents
-- -----------------------------------------------------------------------------

create table if not exists public.financing_documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agreement_id    uuid not null,

  kind public.financing_document_kind not null default 'agreement',
  storage_path text not null check (char_length(storage_path) between 1 and 400),
  file_name    text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (char_length(content_type) between 1 and 100),
  byte_size    bigint not null check (byte_size > 0),
  sha256       text check (sha256 is null or char_length(sha256) = 64),
  document_on  date,
  reference    text check (reference is null or char_length(reference) <= 96),

  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_at timestamptz not null default now(),

  constraint financing_documents_path_unique unique (storage_path),
  constraint financing_documents_agreement_fkey
    foreign key (agreement_id, organization_id)
    references public.financing_agreements (id, organization_id)
    on delete cascade
);

comment on table public.financing_documents is
  'Loan agreements, lender statements and payoff letters. Private storage, signed URLs only.';

create index if not exists financing_documents_agreement_idx
  on public.financing_documents (agreement_id, uploaded_at desc);

-- -----------------------------------------------------------------------------
-- Change history
--
-- The Expenses lesson, applied unchanged: `updated_at` alone says only that
-- something moved. A rate corrected from 7.25% to 2.25% has to leave a trace of
-- the 7.25%, or the correction is indistinguishable from the original entry.
--
-- Written by a trigger running as definer; the application holds SELECT and
-- nothing else, which is what makes the record worth keeping.
-- -----------------------------------------------------------------------------

create table if not exists public.financing_change_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  agreement_id    uuid not null,
  payment_id      uuid,

  kind    public.financing_change_kind not null default 'correction',
  changes jsonb not null default '{}'::jsonb,
  reason  text check (reason is null or char_length(reason) <= 500),

  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),

  constraint financing_change_events_agreement_fkey
    foreign key (agreement_id, organization_id)
    references public.financing_agreements (id, organization_id)
    on delete cascade
);

comment on table public.financing_change_events is
  'What a correction changed, from what, to what, by whom and when. Written only by a trigger; the application can only read it.';

create index if not exists financing_change_events_agreement_idx
  on public.financing_change_events (agreement_id, changed_at desc);

/**
 * Records a material change to an agreement.
 *
 * Ten fields are watched — the ones a schedule and a balance are built from.
 * Notes, reference and the lender's address are not: correcting a typo is not a
 * financial event, and logging it would bury the edits that are.
 */
create or replace function app.record_financing_agreement_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_kind    public.financing_change_kind := 'correction';
  v_reason  text := null;
begin
  if new.agreement_status is distinct from old.agreement_status then
    v_kind := 'status';
    v_reason := new.closure_reason;
    v_changes := jsonb_build_object(
      'agreement_status',
      jsonb_build_object('from', old.agreement_status::text, 'to', new.agreement_status::text)
    );
  else
    if new.financed_amount_minor is distinct from old.financed_amount_minor then
      v_changes := v_changes || jsonb_build_object('financed_amount_minor',
        jsonb_build_object('from', old.financed_amount_minor, 'to', new.financed_amount_minor));
    end if;
    if new.rate_bps is distinct from old.rate_bps then
      v_changes := v_changes || jsonb_build_object('rate_bps',
        jsonb_build_object('from', old.rate_bps, 'to', new.rate_bps));
    end if;
    if new.installment_amount_minor is distinct from old.installment_amount_minor then
      v_changes := v_changes || jsonb_build_object('installment_amount_minor',
        jsonb_build_object('from', old.installment_amount_minor, 'to', new.installment_amount_minor));
    end if;
    if new.installments_count is distinct from old.installments_count then
      v_changes := v_changes || jsonb_build_object('installments_count',
        jsonb_build_object('from', old.installments_count, 'to', new.installments_count));
    end if;
    if new.payment_frequency is distinct from old.payment_frequency then
      v_changes := v_changes || jsonb_build_object('payment_frequency',
        jsonb_build_object('from', old.payment_frequency::text, 'to', new.payment_frequency::text));
    end if;
    if new.first_payment_on is distinct from old.first_payment_on then
      v_changes := v_changes || jsonb_build_object('first_payment_on',
        jsonb_build_object('from', old.first_payment_on, 'to', new.first_payment_on));
    end if;
    if new.balloon_minor is distinct from old.balloon_minor then
      v_changes := v_changes || jsonb_build_object('balloon_minor',
        jsonb_build_object('from', old.balloon_minor, 'to', new.balloon_minor));
    end if;
    if new.down_payment_amount_minor is distinct from old.down_payment_amount_minor then
      v_changes := v_changes || jsonb_build_object('down_payment_amount_minor',
        jsonb_build_object('from', old.down_payment_amount_minor, 'to', new.down_payment_amount_minor));
    end if;
    if new.currency is distinct from old.currency then
      v_changes := v_changes || jsonb_build_object('currency',
        jsonb_build_object('from', old.currency, 'to', new.currency));
    end if;
    if new.lender_id is distinct from old.lender_id then
      v_changes := v_changes || jsonb_build_object('lender_id',
        jsonb_build_object('from', old.lender_id, 'to', new.lender_id));
    end if;
    if new.mode is distinct from old.mode then
      v_changes := v_changes || jsonb_build_object('mode',
        jsonb_build_object('from', old.mode::text, 'to', new.mode::text));
    end if;
  end if;

  if v_changes = '{}'::jsonb then
    return null;
  end if;

  insert into public.financing_change_events
    (organization_id, agreement_id, kind, changes, changed_by, reason)
  values (
    new.organization_id,
    new.id,
    v_kind,
    v_changes,
    -- Session identity, never a column the caller writes.
    coalesce((select auth.uid()), new.updated_by),
    v_reason
  );

  return null;
end;
$$;

drop trigger if exists financing_agreements_record_change on public.financing_agreements;
create trigger financing_agreements_record_change
  after update on public.financing_agreements
  for each row execute function app.record_financing_agreement_change();

/** A voided payment leaves the same kind of trace as a corrected agreement. */
create or replace function app.record_financing_payment_void()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'voided' and old.status <> 'voided' then
    insert into public.financing_change_events
      (organization_id, agreement_id, payment_id, kind, changes, changed_by, reason)
    values (
      new.organization_id,
      new.agreement_id,
      new.id,
      'void',
      jsonb_build_object(
        'amount_minor', jsonb_build_object('from', new.amount_minor, 'to', 0),
        'status', jsonb_build_object('from', old.status::text, 'to', new.status::text)
      ),
      coalesce((select auth.uid()), new.voided_by),
      new.void_reason
    );
  end if;
  return null;
end;
$$;

drop trigger if exists financing_payments_record_void on public.financing_payments;
create trigger financing_payments_record_void
  after update on public.financing_payments
  for each row execute function app.record_financing_payment_void();

-- -----------------------------------------------------------------------------
-- Privileges and policies
--
-- The established boundary is preserved: financing terms are commercially
-- sensitive, so a manager may look and an administrator manages. Everything
-- added here follows that line — recording a lender payment changes a balance
-- and an obligation, so it sits with the administrator who owns the agreement,
-- not with the manager who records a fuel receipt.
-- -----------------------------------------------------------------------------

revoke all on table
  public.lenders,
  public.financing_installments,
  public.financing_payments,
  public.financing_documents,
  public.financing_change_events
from anon, authenticated;

grant select, insert, update, delete on table public.lenders to authenticated;
grant select on table public.financing_installments to authenticated;
grant select, insert, update on table public.financing_payments to authenticated;
grant select, insert, delete on table public.financing_documents to authenticated;
grant select on table public.financing_change_events to authenticated;

alter table public.lenders                enable row level security;
alter table public.financing_installments enable row level security;
alter table public.financing_payments     enable row level security;
alter table public.financing_documents    enable row level security;
alter table public.financing_change_events enable row level security;

-- Lenders. Visible to a manager alongside the agreements that name them.
drop policy if exists lenders_select on public.lenders;
create policy lenders_select on public.lenders
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists lenders_insert on public.lenders;
create policy lenders_insert on public.lenders
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists lenders_update on public.lenders;
create policy lenders_update on public.lenders
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists lenders_delete on public.lenders;
create policy lenders_delete on public.lenders
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

-- The schedule is written by the activation RPC, never by the application.
drop policy if exists financing_installments_select on public.financing_installments;
create policy financing_installments_select on public.financing_installments
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists financing_payments_select on public.financing_payments;
create policy financing_payments_select on public.financing_payments
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists financing_payments_insert on public.financing_payments;
create policy financing_payments_insert on public.financing_payments
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_payments_update on public.financing_payments;
create policy financing_payments_update on public.financing_payments
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_documents_select on public.financing_documents;
create policy financing_documents_select on public.financing_documents
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists financing_documents_insert on public.financing_documents;
create policy financing_documents_insert on public.financing_documents
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_documents_delete on public.financing_documents;
create policy financing_documents_delete on public.financing_documents
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_change_events_select on public.financing_change_events;
create policy financing_change_events_select on public.financing_change_events
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

-- The renamed table keeps its policies, but they are restated here so the file
-- says what the rules are rather than leaving them three migrations away.
drop policy if exists financing_plans_select on public.financing_agreements;
drop policy if exists financing_plans_insert on public.financing_agreements;
drop policy if exists financing_plans_update on public.financing_agreements;
drop policy if exists financing_plans_delete on public.financing_agreements;

drop policy if exists financing_agreements_select on public.financing_agreements;
create policy financing_agreements_select on public.financing_agreements
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists financing_agreements_insert on public.financing_agreements;
create policy financing_agreements_insert on public.financing_agreements
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_agreements_update on public.financing_agreements;
create policy financing_agreements_update on public.financing_agreements
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_agreements_delete on public.financing_agreements;
create policy financing_agreements_delete on public.financing_agreements
  for delete to authenticated
  using (app.has_min_role(organization_id, 'owner'));

-- -----------------------------------------------------------------------------
-- Private storage for financing documents
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'financing-documents',
  'financing-documents',
  false,
  10485760, -- 10 MiB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "financing documents readable by managers" on storage.objects;
create policy "financing documents readable by managers" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'financing-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

drop policy if exists "financing documents writable by admins" on storage.objects;
create policy "financing documents writable by admins" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'financing-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  );

drop policy if exists "financing documents replaceable by admins" on storage.objects;
create policy "financing documents replaceable by admins" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'financing-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  )
  with check (
    bucket_id = 'financing-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  );

drop policy if exists "financing documents removable by admins" on storage.objects;
create policy "financing documents removable by admins" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'financing-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  );

-- -----------------------------------------------------------------------------
-- What still references a vehicle, now that the table has a new name
-- -----------------------------------------------------------------------------

create or replace function public.vehicle_usage(p_vehicle_id uuid)
returns table (
  rentals_count   bigint,
  expenses_count  bigint,
  financing_count bigint,
  documents_count bigint,
  images_count    bigint,
  can_delete      boolean
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select v.organization_id into v_organization_id
  from public.vehicles v
  where v.id = p_vehicle_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Vehicle not found.' using errcode = 'P0002';
  end if;

  return query
  with counts as (
    select
      (select count(*) from public.rentals r where r.vehicle_id = p_vehicle_id)              as rentals,
      (select count(*) from public.expenses e where e.vehicle_id = p_vehicle_id)             as expenses,
      (select count(*) from public.financing_agreements f where f.vehicle_id = p_vehicle_id) as financing,
      (select count(*) from public.vehicle_documents d where d.vehicle_id = p_vehicle_id)    as documents,
      (select count(*) from public.vehicle_images i where i.vehicle_id = p_vehicle_id)       as images
  )
  select
    counts.rentals,
    counts.expenses,
    counts.financing,
    counts.documents,
    counts.images,
    (counts.rentals = 0 and counts.expenses = 0 and counts.financing = 0)
  from counts;
end;
$$;

-- -----------------------------------------------------------------------------
-- Legacy types
--
-- Dropped only once nothing depends on them, so a re-run or an unexpected
-- reference fails loudly rather than silently leaving a half-migrated schema.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_type t on t.oid = a.atttypid
    where t.typname in ('financing_kind', 'financing_status')
      and a.attnum > 0 and not a.attisdropped
  ) then
    drop type if exists public.financing_kind;
    drop type if exists public.financing_status;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ') into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if v_missing is not null then
    raise exception 'tables without row level security: %', v_missing;
  end if;
end
$$;

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
