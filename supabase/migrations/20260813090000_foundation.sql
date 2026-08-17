-- =============================================================================
-- 20260813090000_foundation.sql
--
-- Extensions, the private `app` schema, shared domains, enumerated types and
-- the generic triggers every table in this product relies on.
--
-- Conventions used throughout this schema:
--   * Every tenant-scoped table carries a NOT NULL `organization_id`.
--   * Monetary amounts are stored as BIGINT minor units (`*_minor`) together
--     with the ISO-4217 code of the currency they were recorded in. Floating
--     point is never used for money.
--   * Percentages / rates are stored as integer basis points (`*_bps`).
--   * Instants are `timestamptz`; calendar-only values are `date`.
--   * Helper functions live in the private `app` schema so they are not part of
--     the PostgREST API surface. Anything intentionally callable from the client
--     lives in `public` and is granted to `authenticated` explicitly.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------

-- btree_gist backs the exclusion constraint that makes double-booking a vehicle
-- physically impossible at the storage layer (see the rentals migration).
create extension if not exists btree_gist with schema extensions;

-- -----------------------------------------------------------------------------
-- Private helper schema
-- -----------------------------------------------------------------------------

create schema if not exists app;

comment on schema app is
  'Internal helper functions (authorization, triggers, provisioning). Not exposed through PostgREST.';

revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Domains
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'currency_code' and typnamespace = 'public'::regnamespace) then
    create domain public.currency_code as char(3)
      constraint currency_code_format check (value ~ '^[A-Z]{3}$');
  end if;

  if not exists (select 1 from pg_type where typname = 'country_code' and typnamespace = 'public'::regnamespace) then
    create domain public.country_code as char(2)
      constraint country_code_format check (value ~ '^[A-Z]{2}$');
  end if;

  if not exists (select 1 from pg_type where typname = 'email_address' and typnamespace = 'public'::regnamespace) then
    create domain public.email_address as text
      constraint email_address_length check (char_length(value) between 3 and 320)
      constraint email_address_format check (value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
  end if;

  if not exists (select 1 from pg_type where typname = 'locale_tag' and typnamespace = 'public'::regnamespace) then
    -- BCP-47 subset: language, optional script/region/variant subtags.
    create domain public.locale_tag as text
      constraint locale_tag_format check (value ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');
  end if;
end
$$;

comment on domain public.currency_code is 'ISO 4217 alphabetic currency code, uppercase.';
comment on domain public.country_code is 'ISO 3166-1 alpha-2 country code, uppercase.';

-- -----------------------------------------------------------------------------
-- Time zone validation
--
-- Declared IMMUTABLE so it can be used in CHECK constraints. The IANA database
-- is effectively static for already-issued identifiers; a tzdata update never
-- invalidates a previously valid name, so stored rows cannot become unverifiable.
-- -----------------------------------------------------------------------------

create or replace function public.is_valid_time_zone(p_time_zone text)
returns boolean
language plpgsql
immutable
parallel safe
as $$
begin
  if p_time_zone is null or btrim(p_time_zone) = '' then
    return false;
  end if;
  perform timezone(p_time_zone, timestamptz '2000-01-01 00:00:00+00');
  return true;
exception
  when others then
    return false;
end;
$$;

comment on function public.is_valid_time_zone(text) is
  'True when the argument is an IANA time zone identifier Postgres can resolve.';

-- -----------------------------------------------------------------------------
-- Enumerated types
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_role' and typnamespace = 'public'::regnamespace) then
    create type public.org_role as enum ('owner', 'admin', 'manager', 'staff');
  end if;

  if not exists (select 1 from pg_type where typname = 'member_status' and typnamespace = 'public'::regnamespace) then
    create type public.member_status as enum ('active', 'suspended');
  end if;

  if not exists (select 1 from pg_type where typname = 'vehicle_status' and typnamespace = 'public'::regnamespace) then
    create type public.vehicle_status as enum ('available', 'rented', 'reserved', 'maintenance', 'unavailable');
  end if;

  if not exists (select 1 from pg_type where typname = 'fuel_type' and typnamespace = 'public'::regnamespace) then
    create type public.fuel_type as enum ('petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'lpg', 'cng', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'transmission_type' and typnamespace = 'public'::regnamespace) then
    create type public.transmission_type as enum ('manual', 'automatic');
  end if;

  if not exists (select 1 from pg_type where typname = 'customer_type' and typnamespace = 'public'::regnamespace) then
    create type public.customer_type as enum ('individual', 'company');
  end if;

  if not exists (select 1 from pg_type where typname = 'identity_document_type' and typnamespace = 'public'::regnamespace) then
    create type public.identity_document_type as enum ('national_id', 'passport', 'residence_permit', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'rental_status' and typnamespace = 'public'::regnamespace) then
    create type public.rental_status as enum ('draft', 'reserved', 'active', 'completed', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'rental_payment_status' and typnamespace = 'public'::regnamespace) then
    create type public.rental_payment_status as enum ('unpaid', 'partially_paid', 'paid', 'overpaid');
  end if;

  if not exists (select 1 from pg_type where typname = 'rental_driver_role' and typnamespace = 'public'::regnamespace) then
    create type public.rental_driver_role as enum ('primary', 'additional');
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_direction' and typnamespace = 'public'::regnamespace) then
    create type public.payment_direction as enum ('inbound', 'outbound');
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_method' and typnamespace = 'public'::regnamespace) then
    create type public.payment_method as enum ('cash', 'card', 'bank_transfer', 'cheque', 'online', 'other');
  end if;

  if not exists (select 1 from pg_type where typname = 'expense_category' and typnamespace = 'public'::regnamespace) then
    create type public.expense_category as enum (
      'fuel', 'maintenance', 'repair', 'insurance', 'registration', 'tax', 'fine',
      'cleaning', 'tolls', 'parking', 'accessories', 'financing', 'salary', 'rent',
      'marketing', 'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'vehicle_document_type' and typnamespace = 'public'::regnamespace) then
    create type public.vehicle_document_type as enum (
      'insurance', 'registration', 'technical_inspection', 'road_tax',
      'permit', 'purchase_invoice', 'lease_agreement', 'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_kind' and typnamespace = 'public'::regnamespace) then
    create type public.financing_kind as enum ('loan', 'lease', 'installment_plan');
  end if;

  if not exists (select 1 from pg_type where typname = 'financing_status' and typnamespace = 'public'::regnamespace) then
    create type public.financing_status as enum ('active', 'completed', 'defaulted', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'notification_category' and typnamespace = 'public'::regnamespace) then
    create type public.notification_category as enum ('compliance', 'rental', 'payment', 'maintenance', 'system');
  end if;

  if not exists (select 1 from pg_type where typname = 'notification_severity' and typnamespace = 'public'::regnamespace) then
    create type public.notification_severity as enum ('info', 'warning', 'critical');
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Generic triggers
-- -----------------------------------------------------------------------------

create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at server-side so clients can never forge it.';

-- Freezes columns that must never change after insert. Rather than raising, the
-- old value is restored: a client that sends a full row back is not punished for
-- echoing immutable fields it did not intend to modify.
create or replace function app.freeze_columns()
returns trigger
language plpgsql
as $$
declare
  v_column text;
  v_new jsonb := to_jsonb(new);
  v_old jsonb := to_jsonb(old);
begin
  foreach v_column in array tg_argv loop
    -- Guard against a mistyped column name: `v_old -> v_column` would be SQL
    -- NULL, jsonb_set would return NULL for the whole document, and the trigger
    -- would silently discard the row.
    if v_old ? v_column then
      v_new := jsonb_set(v_new, array[v_column], v_old -> v_column, true);
    else
      raise exception 'freeze_columns: column % does not exist on %', v_column, tg_table_name;
    end if;
  end loop;

  return jsonb_populate_record(new, v_new);
end;
$$;

comment on function app.freeze_columns() is
  'BEFORE UPDATE trigger: restores the previous value of every column named in TG_ARGV.';
