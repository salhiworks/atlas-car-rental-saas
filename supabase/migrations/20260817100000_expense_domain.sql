-- =============================================================================
-- 20260817100000_expense_domain.sql
--
-- Turns the foundational `expenses` table into real cost management.
--
-- WHAT WAS WRONG WITH IT
--
--   1. ALLOCATION WAS GUESSWORK. `vehicle_id` and `rental_id` were both
--      nullable with nothing relating them, so a row could name a vehicle and a
--      rental belonging to different cars, and nothing said whether a cost with
--      neither was overhead or simply unattributed. Every per-vehicle figure
--      would have been a guess.
--
--   2. CATEGORIES WERE A GLOBAL ENUM. Sixteen values, the same in every country,
--      changeable only by migration — and one of them was `financing`, which is
--      precisely the cost that must not be recorded as ordinary operating spend.
--
--   3. VENDORS WERE FREE TEXT. "Garage Atlas", "garage atlas" and "Garage
--      Atlas " were three suppliers, and no question about spend per vendor
--      could be answered.
--
--   4. RECEIPTS POINTED NOWHERE. `receipt_path` was documented as a key in the
--      `expense-receipts` bucket. That bucket was never created, so every
--      receipt path was a reference to nothing.
--
--   5. A MISTAKE COULD ONLY BE DELETED. There was no correction model, so the
--      only way to fix a mistyped amount was to destroy the record of it.
--
-- Historical rows are preserved throughout: categories and vendors are
-- backfilled into real records, every backfill is asserted before the old
-- column is dropped, and nothing is discarded that a row still depends on.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Domain vocabulary
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'expense_allocation' and typnamespace = 'public'::regnamespace
  ) then
    /**
     * Who owns the cost.
     *
     * Three cases, mutually exclusive, checked by the database rather than
     * inferred from a category name:
     *   overhead — the agency as a whole. Rent, software, marketing.
     *   vehicle  — one car. Tyres, a service, its insurance.
     *   rental   — one hire. A delivery, a toll, cleaning that hire caused.
     */
    create type public.expense_allocation as enum ('overhead', 'vehicle', 'rental');
  end if;

  if not exists (
    select 1 from pg_type where typname = 'expense_status' and typnamespace = 'public'::regnamespace
  ) then
    create type public.expense_status as enum ('recorded', 'voided');
  end if;

  if not exists (
    select 1 from pg_type where typname = 'expense_source' and typnamespace = 'public'::regnamespace
  ) then
    /**
     * Where the row came from. `financing` is reserved for the module that
     * comes next and is never written by hand — see the boundary note below.
     */
    create type public.expense_source as enum ('manual', 'import', 'financing');
  end if;

  if not exists (
    select 1 from pg_type where typname = 'expense_document_kind' and typnamespace = 'public'::regnamespace
  ) then
    create type public.expense_document_kind as enum ('receipt', 'invoice', 'supporting', 'other');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Categories
--
-- Per agency, not per deployment. A rental desk in Marrakesh and one in Lisbon
-- do not classify their costs identically, and neither should have to wait for
-- a migration to add "Car wash".
--
-- Every agency is seeded with a sensible set, marked `is_system` so the
-- interface can explain where they came from. Renaming one is free: expenses
-- reference the row, never the name.
-- -----------------------------------------------------------------------------

create table if not exists public.expense_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name        text not null check (char_length(btrim(name)) between 1 and 60),
  description text check (description is null or char_length(description) <= 300),

  /** Stable handle for the seeded set, so a rename cannot break the seeding. */
  system_key text check (system_key is null or char_length(system_key) <= 40),
  is_system  boolean not null default false,

  /** What this kind of cost usually is; the form offers it and the desk may override. */
  default_allocation public.expense_allocation,

  sort_order  integer not null default 100,
  archived_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint expense_categories_tenant_key unique (id, organization_id),
  constraint expense_categories_name_unique unique (organization_id, name),
  constraint expense_categories_system_key_unique unique (organization_id, system_key)
);

comment on table public.expense_categories is
  'How an agency classifies its costs. Per organization, renameable, and archived rather than deleted once anything references them.';

create index if not exists expense_categories_organization_idx
  on public.expense_categories (organization_id, sort_order, name);

drop trigger if exists expense_categories_set_updated_at on public.expense_categories;
create trigger expense_categories_set_updated_at
  before update on public.expense_categories
  for each row execute function app.set_updated_at();

drop trigger if exists expense_categories_freeze_columns on public.expense_categories;
create trigger expense_categories_freeze_columns
  before update on public.expense_categories
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at');

-- -----------------------------------------------------------------------------
-- Vendors
--
-- Enough to answer "who do we pay the most", and no more. This is not accounts
-- payable: there are no terms, no ageing and no balances, because the agency
-- settles at the counter and records what it spent.
-- -----------------------------------------------------------------------------

create table if not exists public.expense_vendors (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name  text not null check (char_length(btrim(name)) between 1 and 120),
  /** Case- and spacing-insensitive form, for duplicate warnings and matching. */
  name_normalized text generated always as (upper(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,

  email          public.email_address,
  phone          text check (phone is null or char_length(phone) between 4 and 32),
  tax_identifier text check (tax_identifier is null or char_length(tax_identifier) <= 60),
  address        text check (address is null or char_length(address) <= 300),
  notes          text check (notes is null or char_length(notes) <= 2000),

  archived_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint expense_vendors_tenant_key unique (id, organization_id)
);

comment on table public.expense_vendors is
  'Suppliers an agency pays. Deliberately light: enough to answer "who receives the most spend", not an accounts-payable ledger.';

-- Two suppliers cannot share a name within an agency, however it was typed.
create unique index if not exists expense_vendors_name_unique_idx
  on public.expense_vendors (organization_id, name_normalized);

create index if not exists expense_vendors_organization_idx
  on public.expense_vendors (organization_id, name);

drop trigger if exists expense_vendors_set_updated_at on public.expense_vendors;
create trigger expense_vendors_set_updated_at
  before update on public.expense_vendors
  for each row execute function app.set_updated_at();

drop trigger if exists expense_vendors_freeze_columns on public.expense_vendors;
create trigger expense_vendors_freeze_columns
  before update on public.expense_vendors
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- Seeding an agency's starting categories
--
-- Deliberately absent: anything for loan or lease payments. A financing
-- instalment is principal plus interest plus fees, and recording it here would
-- be counted again the moment the Financing module derives cost from the
-- agreement itself. There is therefore no obvious place to put one, which is
-- the point.
-- -----------------------------------------------------------------------------

create or replace function app.seed_expense_categories(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.expense_categories
    (organization_id, name, system_key, is_system, default_allocation, sort_order)
  values
    (p_organization_id, 'Fuel',                  'fuel',                  true, 'vehicle',  10),
    (p_organization_id, 'Maintenance',           'maintenance',           true, 'vehicle',  20),
    (p_organization_id, 'Repairs',               'repair',                true, 'vehicle',  30),
    (p_organization_id, 'Tyres',                 'tyres',                 true, 'vehicle',  40),
    (p_organization_id, 'Cleaning',              'cleaning',              true, null,       50),
    (p_organization_id, 'Insurance',             'insurance',             true, 'vehicle',  60),
    (p_organization_id, 'Registration and road fees', 'registration',     true, 'vehicle',  70),
    (p_organization_id, 'Parking',               'parking',               true, null,       80),
    (p_organization_id, 'Tolls',                 'tolls',                 true, null,       90),
    (p_organization_id, 'Delivery and collection', 'delivery',            true, 'rental',  100),
    (p_organization_id, 'Fines',                 'fines',                 true, 'vehicle', 110),
    (p_organization_id, 'Office',                'office',                true, 'overhead',120),
    (p_organization_id, 'Utilities',             'utilities',             true, 'overhead',130),
    (p_organization_id, 'Software',              'software',              true, 'overhead',140),
    (p_organization_id, 'Marketing',             'marketing',             true, 'overhead',150),
    (p_organization_id, 'Professional services', 'professional_services', true, 'overhead',160),
    (p_organization_id, 'Payroll',               'payroll',               true, 'overhead',170),
    (p_organization_id, 'Other',                 'other',                 true, null,      900)
  on conflict (organization_id, system_key) do nothing;
end;
$$;

comment on function app.seed_expense_categories(uuid) is
  'The categories a new agency starts with. Nothing for financing: an instalment is not an operating cost and would be counted twice once Financing exists.';

-- Every agency that already exists gets the same starting set.
do $$
declare
  v_organization record;
begin
  for v_organization in select id from public.organizations loop
    perform app.seed_expense_categories(v_organization.id);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Restructuring `expenses`
-- -----------------------------------------------------------------------------

alter table public.expenses
  add column if not exists category_id uuid,
  add column if not exists vendor_id uuid,
  add column if not exists allocation public.expense_allocation,
  add column if not exists status public.expense_status not null default 'recorded',
  add column if not exists source public.expense_source not null default 'manual',

  -- Tax recorded as it appeared on the document. `amount_minor` stays the gross
  -- total — the money that actually left the agency — and the tax is the part
  -- of it that was tax. Reporting on gross is then a single figure that cannot
  -- double count, and no claim is made about whether any of it is recoverable.
  add column if not exists tax_amount_minor bigint not null default 0 check (tax_amount_minor >= 0),
  add column if not exists tax_rate_bps integer check (tax_rate_bps is null or tax_rate_bps between 0 and 100000),
  add column if not exists tax_label text check (tax_label is null or char_length(tax_label) <= 40),

  add column if not exists payment_method public.payment_method,
  add column if not exists reference text check (reference is null or char_length(reference) <= 96),
  add column if not exists notes text check (notes is null or char_length(notes) <= 2000),

  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users (id) on delete set null,
  add column if not exists void_reason text check (void_reason is null or char_length(void_reason) <= 500),

  add column if not exists updated_by uuid references auth.users (id) on delete set null,

  /**
   * Reserved for the Financing module.
   *
   * Nothing writes it today and the interface offers no way to. It exists so
   * that when Financing begins deriving cost from an agreement it can mark and
   * recognise its own rows, and so operating analytics can exclude them by
   * construction rather than by naming convention.
   */
  add column if not exists financing_plan_id uuid;

comment on column public.expenses.amount_minor is
  'Gross total paid, in minor units. Tax is included in it; tax_amount_minor says how much of it was tax.';
comment on column public.expenses.financing_plan_id is
  'Reserved for the Financing module. Always null for a manually recorded cost, and operating analytics exclude any row that sets it.';

-- ---------------------------------------------------- backfill: categories --

do $$
declare
  v_mapped bigint;
  v_total  bigint;
begin
  -- The legacy enum maps onto the seeded set. `financing` is the exception: it
  -- gets its own archived category so the historical rows keep their meaning
  -- and stay out of both the new-expense picker and operating analytics.
  update public.expenses e
     set category_id = c.id
    from public.expense_categories c
   where c.organization_id = e.organization_id
     and e.category_id is null
     and c.system_key = case e.category::text
       when 'fuel'         then 'fuel'
       when 'maintenance'  then 'maintenance'
       when 'repair'       then 'repair'
       when 'insurance'    then 'insurance'
       when 'registration' then 'registration'
       when 'tax'          then 'registration'
       when 'fine'         then 'fines'
       when 'cleaning'     then 'cleaning'
       when 'tolls'        then 'tolls'
       when 'parking'      then 'parking'
       when 'accessories'  then 'other'
       when 'salary'       then 'payroll'
       when 'rent'         then 'office'
       when 'marketing'    then 'marketing'
       else                     'other'
     end;

  -- Anything that was recorded as financing keeps a home of its own.
  insert into public.expense_categories
    (organization_id, name, system_key, is_system, sort_order, archived_at, description)
  select distinct e.organization_id,
         'Financing (recorded before the Financing module)',
         'financing_legacy', true, 950, now(),
         'Kept so historical rows stay meaningful. Financing cost belongs to the Financing module, not to operating expenses.'
  from public.expenses e
  where e.category = 'financing'
  on conflict (organization_id, system_key) do nothing;

  update public.expenses e
     set category_id = c.id, source = 'financing'
    from public.expense_categories c
   where c.organization_id = e.organization_id
     and c.system_key = 'financing_legacy'
     and e.category = 'financing'
     and e.category_id is null;

  select count(*) filter (where category_id is not null), count(*)
    into v_mapped, v_total
  from public.expenses;

  if v_mapped <> v_total then
    raise exception
      'Category backfill incomplete: % of % expenses mapped. Refusing to drop the old column.',
      v_mapped, v_total;
  end if;
end
$$;

-- --------------------------------------------------------- backfill: vendors --

do $$
declare
  v_unmapped bigint;
begin
  insert into public.expense_vendors (organization_id, name)
  select distinct e.organization_id, btrim(e.vendor)
  from public.expenses e
  where e.vendor is not null and btrim(e.vendor) <> ''
  on conflict do nothing;

  update public.expenses e
     set vendor_id = v.id
    from public.expense_vendors v
   where v.organization_id = e.organization_id
     and v.name_normalized = upper(regexp_replace(btrim(e.vendor), '\s+', ' ', 'g'))
     and e.vendor is not null
     and btrim(e.vendor) <> ''
     and e.vendor_id is null;

  select count(*) into v_unmapped
  from public.expenses e
  where e.vendor is not null and btrim(e.vendor) <> '' and e.vendor_id is null;

  if v_unmapped > 0 then
    raise exception 'Vendor backfill incomplete: % expenses still unmatched.', v_unmapped;
  end if;
end
$$;

-- ------------------------------------------------------ backfill: allocation --

-- What the row already said about itself decides. A cost naming a rental is a
-- rental cost, one naming only a vehicle is a vehicle cost, and one naming
-- neither was overhead all along.
update public.expenses
   set allocation = case
     when rental_id is not null  then 'rental'::public.expense_allocation
     when vehicle_id is not null then 'vehicle'::public.expense_allocation
     else                             'overhead'::public.expense_allocation
   end
 where allocation is null;

-- A rental cost derives its vehicle through the rental; storing both would be
-- two sources of truth that could disagree.
update public.expenses set vehicle_id = null where allocation = 'rental';

alter table public.expenses
  alter column allocation set not null,
  alter column category_id set not null;

-- ------------------------------------------------------------ new integrity --

alter table public.expenses
  drop constraint if exists expenses_allocation_consistent;

alter table public.expenses
  add constraint expenses_allocation_consistent check (
    case allocation
      when 'overhead' then vehicle_id is null and rental_id is null
      when 'vehicle'  then vehicle_id is not null and rental_id is null
      -- No vehicle column: the car is whichever one the contract is for, read
      -- through the rental. Two columns could contradict each other; one cannot.
      when 'rental'   then rental_id is not null and vehicle_id is null
    end
  );

alter table public.expenses
  drop constraint if exists expenses_tax_within_amount;

alter table public.expenses
  add constraint expenses_tax_within_amount check (tax_amount_minor <= amount_minor);

alter table public.expenses
  drop constraint if exists expenses_void_fields_consistent;

alter table public.expenses
  add constraint expenses_void_fields_consistent check (
    (status = 'voided') = (voided_at is not null)
  );

alter table public.expenses
  drop constraint if exists expenses_category_fkey,
  drop constraint if exists expenses_vendor_fkey,
  drop constraint if exists expenses_rental_fkey;

alter table public.expenses
  add constraint expenses_category_fkey
    foreign key (category_id, organization_id)
    references public.expense_categories (id, organization_id)
    on delete restrict,

  add constraint expenses_vendor_fkey
    foreign key (vendor_id, organization_id)
    references public.expense_vendors (id, organization_id)
    on delete restrict,

  -- Restrict rather than set null: an allocated cost may not quietly become an
  -- orphan, and the allocation check would refuse the resulting row anyway.
  -- This turns a confusing constraint violation into a clear refusal.
  add constraint expenses_rental_fkey
    foreign key (rental_id, organization_id)
    references public.rentals (id, organization_id)
    on delete restrict;

-- The old columns are gone only now that every row has been moved across and
-- the counts asserted above.
alter table public.expenses
  drop column if exists category,
  drop column if exists vendor,
  drop column if exists receipt_path;

create index if not exists expenses_category_id_idx
  on public.expenses (organization_id, category_id, incurred_on desc);

create index if not exists expenses_vendor_id_idx
  on public.expenses (organization_id, vendor_id, incurred_on desc)
  where vendor_id is not null;

create index if not exists expenses_rental_idx
  on public.expenses (rental_id, incurred_on desc)
  where rental_id is not null;

create index if not exists expenses_allocation_idx
  on public.expenses (organization_id, allocation, incurred_on desc);

drop index if exists public.expenses_category_idx;

-- Only the void path may set the void columns, and it may not un-void.
create or replace function app.guard_expense_void()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'voided' and new.status <> 'voided' then
    raise exception 'A voided expense cannot be reinstated. Record a new one.' using errcode = '23514';
  end if;

  if old.status = 'voided' then
    -- The record of the correction is part of the correction.
    new.voided_at := old.voided_at;
    new.voided_by := old.voided_by;
    new.void_reason := old.void_reason;
    new.amount_minor := old.amount_minor;
    new.tax_amount_minor := old.tax_amount_minor;
    new.currency := old.currency;
    new.incurred_on := old.incurred_on;
    new.allocation := old.allocation;
    new.vehicle_id := old.vehicle_id;
    new.rental_id := old.rental_id;
  end if;

  return new;
end;
$$;

drop trigger if exists expenses_guard_void on public.expenses;
create trigger expenses_guard_void
  before update on public.expenses
  for each row execute function app.guard_expense_void();

-- A voided expense is the evidence that a mistake was corrected. Destroying it
-- destroys the correction.
create or replace function app.guard_expense_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'voided' then
    raise exception
      'A voided expense is the record of a correction and cannot be deleted.'
      using errcode = '23514';
  end if;
  return old;
end;
$$;

drop trigger if exists expenses_guard_delete on public.expenses;
create trigger expenses_guard_delete
  before delete on public.expenses
  for each row execute function app.guard_expense_delete();

-- The expense's own tenant key, so an attachment cannot be pointed at another
-- agency's cost.
alter table public.expenses
  drop constraint if exists expenses_tenant_key;

alter table public.expenses
  add constraint expenses_tenant_key unique (id, organization_id);

-- -----------------------------------------------------------------------------
-- Attachments
--
-- One expense often arrives as several documents: the card slip, the invoice
-- that followed it, a photograph of the damaged part. A single `receipt_path`
-- column could hold one of them.
-- -----------------------------------------------------------------------------

create table if not exists public.expense_attachments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  expense_id      uuid not null,

  kind public.expense_document_kind not null default 'receipt',

  storage_path text not null check (char_length(storage_path) between 1 and 512),
  file_name    text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (
    content_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')
  ),
  byte_size integer not null check (byte_size > 0 and byte_size <= 10485760),
  /** Of the bytes, for integrity and for warning about the same receipt twice. */
  sha256 text check (sha256 is null or char_length(sha256) = 64),

  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_at timestamptz not null default now(),

  constraint expense_attachments_path_unique unique (storage_path),
  constraint expense_attachments_expense_fkey
    foreign key (expense_id, organization_id)
    references public.expenses (id, organization_id)
    on delete cascade
);

comment on table public.expense_attachments is
  'Receipts and invoices for one cost. Private storage; the row records what the file is, the bucket holds the bytes.';

create index if not exists expense_attachments_expense_idx
  on public.expense_attachments (expense_id, uploaded_at);

create index if not exists expense_attachments_hash_idx
  on public.expense_attachments (organization_id, sha256)
  where sha256 is not null;

-- -----------------------------------------------------------------------------
-- Privileges and policies
--
-- Recording a cost is manager work, as it already was. Two new distinctions:
-- vendors are operational — a manager creating an expense must be able to add
-- the garage they just used — while categories are structural and belong to an
-- administrator, because renaming one changes how every historical cost reads.
-- -----------------------------------------------------------------------------

revoke all on table public.expense_categories, public.expense_vendors, public.expense_attachments
  from anon, authenticated;

grant select, insert, update, delete on table public.expense_categories to authenticated;
grant select, insert, update, delete on table public.expense_vendors to authenticated;
grant select, insert, delete on table public.expense_attachments to authenticated;

alter table public.expense_categories enable row level security;
alter table public.expense_vendors enable row level security;
alter table public.expense_attachments enable row level security;

drop policy if exists expense_categories_select on public.expense_categories;
create policy expense_categories_select on public.expense_categories
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists expense_categories_insert on public.expense_categories;
create policy expense_categories_insert on public.expense_categories
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists expense_categories_update on public.expense_categories;
create policy expense_categories_update on public.expense_categories
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists expense_categories_delete on public.expense_categories;
create policy expense_categories_delete on public.expense_categories
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

drop policy if exists expense_vendors_select on public.expense_vendors;
create policy expense_vendors_select on public.expense_vendors
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists expense_vendors_insert on public.expense_vendors;
create policy expense_vendors_insert on public.expense_vendors
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists expense_vendors_update on public.expense_vendors;
create policy expense_vendors_update on public.expense_vendors
  for update to authenticated
  using (app.has_min_role(organization_id, 'manager'))
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists expense_vendors_delete on public.expense_vendors;
create policy expense_vendors_delete on public.expense_vendors
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

drop policy if exists expense_attachments_select on public.expense_attachments;
create policy expense_attachments_select on public.expense_attachments
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists expense_attachments_insert on public.expense_attachments;
create policy expense_attachments_insert on public.expense_attachments
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists expense_attachments_delete on public.expense_attachments;
create policy expense_attachments_delete on public.expense_attachments
  for delete to authenticated
  using (app.has_min_role(organization_id, 'manager'));

-- -----------------------------------------------------------------------------
-- Private storage for receipts
--
-- The bucket the original schema's comment promised and never created.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'expense-receipts',
  'expense-receipts',
  false,
  10485760, -- 10 MiB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "expense receipts readable by members" on storage.objects;
create policy "expense receipts readable by members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'expense-receipts'
    and app.is_org_member(app.organization_id_from_storage_path(name))
  );

drop policy if exists "expense receipts writable by managers" on storage.objects;
create policy "expense receipts writable by managers" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'expense-receipts'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

drop policy if exists "expense receipts replaceable by managers" on storage.objects;
create policy "expense receipts replaceable by managers" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'expense-receipts'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  )
  with check (
    bucket_id = 'expense-receipts'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

drop policy if exists "expense receipts removable by managers" on storage.objects;
create policy "expense receipts removable by managers" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'expense-receipts'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

-- -----------------------------------------------------------------------------
-- New agencies get their categories at provisioning time
-- -----------------------------------------------------------------------------

create or replace function app.provision_expense_categories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.seed_expense_categories(new.id);
  return null;
end;
$$;

drop trigger if exists organizations_seed_expense_categories on public.organizations;
create trigger organizations_seed_expense_categories
  after insert on public.organizations
  for each row execute function app.provision_expense_categories();

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
