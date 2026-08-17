-- =============================================================================
-- Test doubles for the parts of a Supabase database that Supabase itself owns.
--
-- THIS FILE IS NEVER APPLIED TO A REAL DATABASE. It exists only so the schema
-- migrations can be executed end-to-end against a throwaway PostgreSQL instance
-- in CI, where GoTrue and Storage are not present.
--
-- It recreates the minimum surface the migrations depend on:
--   * the anon / authenticated / service_role login roles
--   * the `extensions` schema
--   * `auth.users` and `auth.uid()`
--   * `storage.buckets` and `storage.objects`
--
-- Anything added here must mirror Supabase's real definitions closely enough
-- that a passing test means something. Where the real definition is richer, the
-- columns we do not use are simply omitted rather than invented.
-- =============================================================================

create schema if not exists extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- Supabase's default privileges, reproduced exactly.
--
-- This matters more than it looks. Supabase grants ALL on new tables AND
-- functions to anon, authenticated and service_role, per role and explicitly.
-- A migration that says `revoke ... from public` therefore does NOT remove the
-- anon grant, and a test harness without these lines will happily prove that a
-- boundary exists when on the real project it does not. Omitting them once
-- produced exactly that false pass.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- auth (GoTrue)
-- -----------------------------------------------------------------------------

create schema if not exists auth;
grant usage on schema auth to authenticated, service_role;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              varchar(255),
  encrypted_password varchar(255),
  raw_user_meta_data jsonb default '{}'::jsonb,
  -- Invitation acceptance reads this: possession of an invitation link is not
  -- permission to attach it to an unverified address. GoTrue sets it when the
  -- confirmation link is followed, and the default here mirrors a project with
  -- confirmations already completed — a test that cares sets it back to null.
  email_confirmed_at timestamptz default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Mirrors Supabase's implementation: the subject claim of the request's JWT.
-- Tests impersonate a user with `set local request.jwt.claim.sub = '<uuid>'`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- storage
-- -----------------------------------------------------------------------------

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

revoke all on table storage.objects from anon, authenticated;
grant select, insert, update, delete on table storage.objects to authenticated;

-- -----------------------------------------------------------------------------
-- Supabase Vault
--
-- The real thing is an extension that encrypts with a key held outside the
-- database. What matters to the schema tests is the *shape* and the privilege
-- boundary, not the cipher: `vault.secrets` and `vault.decrypted_secrets` exist,
-- `create_secret`/`update_secret` behave as documented, and only `postgres` and
-- `service_role` have any grant on either relation.
--
-- The suite therefore proves what it can prove locally — that no application
-- role can name these relations — and the live smoke suite proves the same
-- boundary against the real extension on the real project.
-- -----------------------------------------------------------------------------

create schema if not exists vault;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at
  from vault.secrets;

create or replace function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default '',
  new_key_id uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into vault.secrets (secret, name, description)
  values (new_secret, new_name, coalesce(new_description, ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function vault.update_secret(
  secret_id uuid,
  new_secret text default null,
  new_name text default null,
  new_description text default null,
  new_key_id uuid default null
)
returns void
language plpgsql
as $$
begin
  update vault.secrets
     set secret = coalesce(new_secret, secret),
         name = coalesce(new_name, name),
         description = coalesce(new_description, description),
         updated_at = now()
   where id = secret_id;
end;
$$;

-- Exactly the grants the real project has: nothing for anon or authenticated.
revoke all on schema vault from public, anon, authenticated;
revoke all on all tables in schema vault from public, anon, authenticated;
revoke all on all functions in schema vault from public, anon, authenticated;
grant usage on schema vault to service_role;
grant select, delete on vault.secrets to service_role;
grant select, delete on vault.decrypted_secrets to service_role;
