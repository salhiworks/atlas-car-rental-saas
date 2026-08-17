-- =============================================================================
-- 20260814120000_customer_identity.sql
--
-- Normalises customer identification into its own table, and gives the customer
-- record the fields a rental agency actually collects.
--
-- The foundation put one identity document and one driving licence in columns on
-- `customers`. That is wrong for this domain in three concrete ways:
--
--   * A visitor commonly presents a passport *and* a residence permit; a resident
--     may hold a national ID and a foreign licence. One slot cannot hold both.
--   * A renewed passport replaces the old number, destroying the record of what
--     was presented on last year's contract.
--   * A file cannot be attached to a column, and every one of these documents is
--     something the agency photocopies.
--
-- So identification becomes `customer_documents`: many per customer, each with
-- its own number, issuing country, validity window and optional scan. Driving
-- licences live in the same table rather than a parallel one — they answer the
-- same questions (who issued it, when does it expire, where is the scan) and
-- differ only by carrying vehicle classes.
--
-- The old columns are backfilled and then dropped. Two sources of truth for the
-- same fact would drift, and drift in identity data is the kind that ends with
-- the wrong person driving away in a car.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- Trigram indexing, so "search while the customer stands at the desk" stays fast
-- with a leading wildcard. A plain btree cannot serve `ilike '%smith%'`.
create extension if not exists pg_trgm with schema extensions;

-- -----------------------------------------------------------------------------
-- Document types
--
-- A new enum rather than extending `identity_document_type`: ALTER TYPE ... ADD
-- VALUE cannot be used in the same transaction that adds it, and migrations run
-- in one. The old type is left in place, unused and harmless.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'customer_document_type' and typnamespace = 'public'::regnamespace
  ) then
    create type public.customer_document_type as enum (
      'national_id',
      'passport',
      'residence_permit',
      'driver_license',
      'other'
    );
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Customer record: the fields agencies actually collect
-- -----------------------------------------------------------------------------

alter table public.customers
  add column if not exists secondary_phone text
    check (secondary_phone is null or char_length(secondary_phone) between 4 and 32),
  -- Nationality is not the address country. A German living in Casablanca has
  -- one of each, and a contract needs both.
  add column if not exists nationality_country_code public.country_code,
  add column if not exists preferred_locale public.locale_tag;

-- Normalised search keys. Generated, so they cannot drift from what was typed,
-- and the original entry is preserved exactly as the customer wrote it.
alter table public.customers
  add column if not exists phone_normalized text
    generated always as (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) stored,
  add column if not exists email_normalized text
    generated always as (lower(btrim(coalesce(email, '')))) stored;

comment on column public.customers.phone_normalized is
  'Digits only, for matching numbers typed with different spacing or prefixes. Never displayed.';

-- Replace the foundation''s composite search index with ones that match the
-- queries this module actually issues.
drop index if exists public.customers_search_idx;

create index if not exists customers_display_name_trgm_idx
  on public.customers using gin (display_name extensions.gin_trgm_ops);

create index if not exists customers_phone_idx
  on public.customers (organization_id, phone_normalized)
  where phone_normalized <> '';

create index if not exists customers_email_idx
  on public.customers (organization_id, email_normalized)
  where email_normalized <> '';

-- -----------------------------------------------------------------------------
-- customer_documents
-- -----------------------------------------------------------------------------

create table if not exists public.customer_documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id     uuid not null,

  document_type   public.customer_document_type not null,

  -- Stored as presented; matched on the normalised form. A passport written
  -- "AB 123 456" and "ab123456" is the same passport.
  document_number text not null check (char_length(btrim(document_number)) between 2 and 64),
  document_number_normalized text
    generated always as (upper(regexp_replace(document_number, '[^A-Za-z0-9]', '', 'g'))) stored,

  issuing_country public.country_code,
  issued_on       date,
  expires_on      date,

  -- Only meaningful for a driving licence: B, C1, D, and so on. Deliberately
  -- free text, because class letters are national and there is no universal set.
  license_classes text[] check (
    license_classes is null
    or (array_length(license_classes, 1) between 1 and 20)
  ),

  notes text check (notes is null or char_length(notes) <= 2000),

  -- Attached scan. Metadata is kept alongside the object so the interface can
  -- describe a file without fetching it, and so a deleted object is detectable.
  file_path       text check (file_path is null or char_length(file_path) <= 512),
  file_name       text check (file_name is null or char_length(file_name) <= 200),
  file_mime_type  text check (
    file_mime_type is null
    or file_mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')
  ),
  file_size_bytes integer check (file_size_bytes is null or (file_size_bytes > 0 and file_size_bytes <= 10485760)),
  uploaded_by     uuid references auth.users (id) on delete set null,
  uploaded_at     timestamptz,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint customer_documents_customer_fkey
    foreign key (customer_id, organization_id)
    references public.customers (id, organization_id)
    on delete cascade,

  constraint customer_documents_period_valid
    check (expires_on is null or issued_on is null or expires_on >= issued_on),

  constraint customer_documents_classes_are_for_licences
    check (license_classes is null or document_type = 'driver_license'),

  -- A path without a MIME type describes nothing; a MIME type without a path
  -- points at nothing.
  constraint customer_documents_file_metadata_paired
    check ((file_path is null) = (file_mime_type is null)),

  constraint customer_documents_tenant_key unique (id, organization_id)
);

comment on table public.customer_documents is
  'Identification presented by a customer: passports, national IDs, residence permits and driving licences. Contains personal data — read access is agency members only, and files live in a private bucket.';

-- Hard uniqueness. The same passport cannot be entered twice for one agency,
-- which is the duplicate that actually causes operational harm: two records for
-- one person, each with half the rental history.
--
-- Deliberately spans archived customers too. If somebody archived a record and
-- the same person returns, the right move is to restore that record, not to
-- create a second one — and the duplicate lookup points staff at it.
create unique index if not exists customer_documents_unique_number_idx
  on public.customer_documents (
    organization_id,
    document_type,
    coalesce(issuing_country, '~~'),
    document_number_normalized
  );

create index if not exists customer_documents_customer_idx
  on public.customer_documents (customer_id, document_type);

create index if not exists customer_documents_number_trgm_idx
  on public.customer_documents using gin (document_number_normalized extensions.gin_trgm_ops);

create index if not exists customer_documents_expiry_idx
  on public.customer_documents (organization_id, expires_on)
  where expires_on is not null;

drop trigger if exists customer_documents_set_updated_at on public.customer_documents;
create trigger customer_documents_set_updated_at
  before update on public.customer_documents
  for each row execute function app.set_updated_at();

drop trigger if exists customer_documents_freeze_columns on public.customer_documents;
create trigger customer_documents_freeze_columns
  before update on public.customer_documents
  for each row execute function app.freeze_columns(
    'id', 'organization_id', 'customer_id', 'created_at', 'created_by'
  );

-- -----------------------------------------------------------------------------
-- Backfill, then retire the single-slot columns
-- -----------------------------------------------------------------------------

insert into public.customer_documents (
  organization_id, customer_id, document_type, document_number, issuing_country, expires_on, created_by
)
select
  c.organization_id,
  c.id,
  c.identity_document_type::text::public.customer_document_type,
  btrim(c.identity_document_number),
  c.identity_document_country,
  c.identity_document_expires_on,
  c.created_by
from public.customers c
where c.identity_document_number is not null
  and btrim(c.identity_document_number) <> ''
  and c.identity_document_type is not null
on conflict do nothing;

insert into public.customer_documents (
  organization_id, customer_id, document_type, document_number, issuing_country,
  issued_on, expires_on, created_by
)
select
  c.organization_id,
  c.id,
  'driver_license',
  btrim(c.driver_license_number),
  c.driver_license_country,
  c.driver_license_issued_on,
  c.driver_license_expires_on,
  c.created_by
from public.customers c
where c.driver_license_number is not null
  and btrim(c.driver_license_number) <> ''
on conflict do nothing;

alter table public.customers
  drop constraint if exists customers_identity_number_requires_type,
  drop constraint if exists customers_license_period_valid;

alter table public.customers
  drop column if exists identity_document_type,
  drop column if exists identity_document_number,
  drop column if exists identity_document_country,
  drop column if exists identity_document_expires_on,
  drop column if exists driver_license_number,
  drop column if exists driver_license_country,
  drop column if exists driver_license_issued_on,
  drop column if exists driver_license_expires_on;

-- -----------------------------------------------------------------------------
-- Privileges and policies
--
-- Reading and recording identification is front-desk work; removing it is not.
-- -----------------------------------------------------------------------------

revoke all on table public.customer_documents from anon, authenticated;
grant select, insert, update, delete on table public.customer_documents to authenticated;

alter table public.customer_documents enable row level security;

drop policy if exists customer_documents_select on public.customer_documents;
create policy customer_documents_select on public.customer_documents
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists customer_documents_insert on public.customer_documents;
create policy customer_documents_insert on public.customer_documents
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists customer_documents_update on public.customer_documents;
create policy customer_documents_update on public.customer_documents
  for update to authenticated
  using (app.has_min_role(organization_id, 'staff'))
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists customer_documents_delete on public.customer_documents;
create policy customer_documents_delete on public.customer_documents
  for delete to authenticated
  using (app.has_min_role(organization_id, 'manager'));

-- -----------------------------------------------------------------------------
-- Permanently deleting a customer becomes an administrator action
--
-- It was `manager`, which is out of step with vehicles.delete and with the fact
-- that a customer record is personal data referenced by financial history.
-- -----------------------------------------------------------------------------

drop policy if exists customers_delete on public.customers;
create policy customers_delete on public.customers
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

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
