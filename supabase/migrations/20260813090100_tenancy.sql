-- =============================================================================
-- 20260813090100_tenancy.sql
--
-- The tenancy core: user profiles, organizations (agencies), membership with
-- roles, and per-organization operational settings.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- profiles — application-visible mirror of auth.users
--
-- auth.users is owned by GoTrue and must not be queried directly by the client.
-- Everything the product needs to render a person lives here.
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text        not null default '' check (char_length(full_name) <= 120),
  -- Deliberately plain text, not the email_address domain: this column is
  -- written by an auth trigger and a constraint violation there would break
  -- account creation itself.
  email       text,
  phone       text        check (phone is null or char_length(phone) between 4 and 32),
  avatar_path text        check (avatar_path is null or char_length(avatar_path) <= 512),
  locale      public.locale_tag not null default 'en',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'One row per authenticated user. Created automatically by the auth.users trigger.';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function app.set_updated_at();

drop trigger if exists profiles_freeze_columns on public.profiles;
create trigger profiles_freeze_columns
  before update on public.profiles
  for each row execute function app.freeze_columns('id', 'created_at');

-- -----------------------------------------------------------------------------
-- organizations — the tenant boundary
-- -----------------------------------------------------------------------------

create table if not exists public.organizations (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(btrim(name)) between 2 and 120),
  slug             text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$'),
  legal_name       text check (legal_name is null or char_length(legal_name) <= 160),
  tax_identifier   text check (tax_identifier is null or char_length(tax_identifier) <= 64),

  -- Localisation. No country is baked into the schema; every agency configures
  -- its own currency, time zone, country and display locale.
  default_currency public.currency_code not null default 'USD',
  time_zone        text not null default 'UTC' check (public.is_valid_time_zone(time_zone)),
  country_code     public.country_code,
  locale           public.locale_tag not null default 'en',

  -- Contact / registered address
  email            public.email_address,
  phone            text check (phone is null or char_length(phone) between 4 and 32),
  website          text check (website is null or char_length(website) <= 255),
  address_line1    text check (address_line1 is null or char_length(address_line1) <= 160),
  address_line2    text check (address_line2 is null or char_length(address_line2) <= 160),
  city             text check (city is null or char_length(city) <= 96),
  region           text check (region is null or char_length(region) <= 96),
  postal_code      text check (postal_code is null or char_length(postal_code) <= 24),

  -- Storage object path inside the private `organization-logos` bucket.
  logo_path        text check (logo_path is null or char_length(logo_path) <= 512),

  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint organizations_slug_key unique (slug)
);

comment on table public.organizations is 'A rental agency. The tenant boundary for every other table in the schema.';
comment on column public.organizations.default_currency is
  'Currency new financial records default to. Historical records keep their own currency column.';

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function app.set_updated_at();

-- The slug is part of the tenant identity and is referenced by storage paths;
-- id/created_by/created_at are provenance. None may be rewritten by a client.
drop trigger if exists organizations_freeze_columns on public.organizations;
create trigger organizations_freeze_columns
  before update on public.organizations
  for each row execute function app.freeze_columns('id', 'slug', 'created_by', 'created_at');

-- -----------------------------------------------------------------------------
-- organization_members — who belongs to which agency, and with what authority
--
-- Invitations are intentionally NOT modelled yet. When the Team module lands it
-- adds an `organization_invitations` table whose acceptance path inserts a row
-- here; nothing below has to change for that.
-- -----------------------------------------------------------------------------

create table if not exists public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            public.org_role      not null default 'staff',
  status          public.member_status not null default 'active',
  job_title       text check (job_title is null or char_length(job_title) <= 96),
  invited_by      uuid references auth.users (id) on delete set null,
  joined_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint organization_members_unique_membership unique (organization_id, user_id)
);

comment on table public.organization_members is
  'Membership edge between a user and an agency, carrying the role that drives every authorization decision.';

create index if not exists organization_members_user_active_idx
  on public.organization_members (user_id)
  where status = 'active';

create index if not exists organization_members_organization_idx
  on public.organization_members (organization_id, role);

drop trigger if exists organization_members_set_updated_at on public.organization_members;
create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function app.set_updated_at();

drop trigger if exists organization_members_freeze_columns on public.organization_members;
create trigger organization_members_freeze_columns
  before update on public.organization_members
  for each row execute function app.freeze_columns('id', 'organization_id', 'user_id', 'created_at');

-- -----------------------------------------------------------------------------
-- organization_settings — operational preferences, 1:1 with an organization
--
-- Kept separate from `organizations` so the identity row stays small and hot
-- while preferences grow over time with each new module.
-- -----------------------------------------------------------------------------

create table if not exists public.organization_settings (
  organization_id               uuid primary key references public.organizations (id) on delete cascade,
  date_format                   text not null default 'dd/MM/yyyy'
                                  check (date_format in ('dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy')),
  time_format                   text not null default '24h' check (time_format in ('12h', '24h')),
  first_day_of_week             smallint not null default 1 check (first_day_of_week between 0 and 6),
  distance_unit                 text not null default 'km' check (distance_unit in ('km', 'mi')),
  volume_unit                   text not null default 'litre' check (volume_unit in ('litre', 'gallon')),

  default_deposit_minor         bigint not null default 0 check (default_deposit_minor >= 0),
  rental_reference_prefix       text not null default 'RNT'
                                  check (rental_reference_prefix ~ '^[A-Z0-9]{2,8}$'),
  compliance_reminder_lead_days smallint not null default 30
                                  check (compliance_reminder_lead_days between 1 and 365),

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

comment on table public.organization_settings is
  'Per-agency operational preferences. Exactly one row per organization, created during provisioning.';

drop trigger if exists organization_settings_set_updated_at on public.organization_settings;
create trigger organization_settings_set_updated_at
  before update on public.organization_settings
  for each row execute function app.set_updated_at();

drop trigger if exists organization_settings_freeze_columns on public.organization_settings;
create trigger organization_settings_freeze_columns
  before update on public.organization_settings
  for each row execute function app.freeze_columns('organization_id', 'created_at');
