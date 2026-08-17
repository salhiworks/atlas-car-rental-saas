-- =============================================================================
-- 20260813090300_fleet.sql
--
-- Fleet and counterparty records: vehicles, their compliance documents, and
-- customers.
--
-- Note the `unique (id, organization_id)` constraints. They exist so that every
-- cross-table reference can be a *composite* foreign key carrying the tenant
-- column. That makes a row in agency A physically incapable of pointing at a row
-- in agency B — tenant integrity enforced by the storage engine, not by
-- application code and not only by RLS.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- vehicles
-- -----------------------------------------------------------------------------

create table if not exists public.vehicles (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,

  make                text not null check (char_length(btrim(make)) between 1 and 60),
  model               text not null check (char_length(btrim(model)) between 1 and 60),
  model_year          smallint check (model_year between 1900 and 2100),
  registration_plate  text not null check (char_length(btrim(registration_plate)) between 1 and 24),
  vin                 text check (vin is null or char_length(btrim(vin)) between 5 and 32),
  color               text check (color is null or char_length(color) <= 40),

  fuel_type           public.fuel_type,
  transmission        public.transmission_type,
  seats               smallint check (seats is null or seats between 1 and 99),
  doors               smallint check (doors is null or doors between 1 and 9),
  category            text check (category is null or char_length(category) <= 60),

  odometer            integer not null default 0 check (odometer >= 0),
  odometer_updated_at timestamptz,

  -- Pricing. Currency is stored per vehicle so changing the agency default
  -- never silently reinterprets an existing rate.
  daily_rate_minor    bigint not null default 0 check (daily_rate_minor >= 0),
  currency            public.currency_code not null,

  status              public.vehicle_status not null default 'available',

  -- Compliance horizons. The Maintenance & Compliance module reads these.
  insurance_expires_on    date,
  inspection_expires_on   date,
  registration_expires_on date,
  next_service_on         date,
  next_service_odometer   integer check (next_service_odometer is null or next_service_odometer >= 0),

  -- Acquisition, referenced by the Financing module.
  acquired_on              date,
  acquisition_price_minor  bigint check (acquisition_price_minor is null or acquisition_price_minor >= 0),
  acquisition_currency     public.currency_code,

  notes       text check (notes is null or char_length(notes) <= 4000),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Vehicles are archived, never deleted, once they carry financial history.
  archived_at timestamptz,

  constraint vehicles_tenant_key unique (id, organization_id),
  constraint vehicles_acquisition_currency_required
    check (acquisition_price_minor is null or acquisition_currency is not null)
);

comment on table public.vehicles is 'A rentable vehicle belonging to one agency.';
comment on column public.vehicles.status is
  'Operational state. Derived transitions (available <-> rented/reserved) are owned by the Rentals module.';

-- A plate is unique among the agency's live fleet; archived rows keep history
-- without blocking a re-registered plate.
create unique index if not exists vehicles_plate_unique_idx
  on public.vehicles (organization_id, upper(btrim(registration_plate)))
  where archived_at is null;

create unique index if not exists vehicles_vin_unique_idx
  on public.vehicles (organization_id, upper(btrim(vin)))
  where vin is not null and archived_at is null;

create index if not exists vehicles_organization_status_idx
  on public.vehicles (organization_id, status)
  where archived_at is null;

create index if not exists vehicles_compliance_idx
  on public.vehicles (organization_id, insurance_expires_on, inspection_expires_on, registration_expires_on)
  where archived_at is null;

drop trigger if exists vehicles_set_updated_at on public.vehicles;
create trigger vehicles_set_updated_at
  before update on public.vehicles
  for each row execute function app.set_updated_at();

drop trigger if exists vehicles_freeze_columns on public.vehicles;
create trigger vehicles_freeze_columns
  before update on public.vehicles
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- vehicle_documents — insurance, registration, inspection certificates, ...
-- -----------------------------------------------------------------------------

create table if not exists public.vehicle_documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  vehicle_id      uuid not null,

  document_type   public.vehicle_document_type not null,
  document_number text check (document_number is null or char_length(document_number) <= 96),
  issuer          text check (issuer is null or char_length(issuer) <= 120),
  issued_on       date,
  expires_on      date,
  -- Object key inside the private `vehicle-documents` storage bucket.
  file_path       text check (file_path is null or char_length(file_path) <= 512),
  notes           text check (notes is null or char_length(notes) <= 2000),

  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint vehicle_documents_period_valid check (expires_on is null or issued_on is null or expires_on >= issued_on),
  constraint vehicle_documents_vehicle_fkey
    foreign key (vehicle_id, organization_id)
    references public.vehicles (id, organization_id)
    on delete cascade
);

comment on table public.vehicle_documents is
  'Compliance documents attached to a vehicle. `expires_on` drives renewal reminders.';

create index if not exists vehicle_documents_vehicle_idx
  on public.vehicle_documents (vehicle_id, document_type);

create index if not exists vehicle_documents_expiry_idx
  on public.vehicle_documents (organization_id, expires_on)
  where expires_on is not null;

drop trigger if exists vehicle_documents_set_updated_at on public.vehicle_documents;
create trigger vehicle_documents_set_updated_at
  before update on public.vehicle_documents
  for each row execute function app.set_updated_at();

drop trigger if exists vehicle_documents_freeze_columns on public.vehicle_documents;
create trigger vehicle_documents_freeze_columns
  before update on public.vehicle_documents
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');

-- -----------------------------------------------------------------------------
-- customers
--
-- Models both walk-in individuals and corporate accounts, and both residents
-- (national ID) and visitors (passport). Identification is deliberately optional
-- and typed: assuming every customer carries the same document is exactly the
-- kind of assumption that forces a migration later.
-- -----------------------------------------------------------------------------

create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  customer_type   public.customer_type not null default 'individual',
  first_name      text check (first_name is null or char_length(btrim(first_name)) between 1 and 80),
  last_name       text check (last_name is null or char_length(btrim(last_name)) between 1 and 80),
  company_name    text check (company_name is null or char_length(btrim(company_name)) between 1 and 160),

  display_name    text generated always as (
    case
      when customer_type = 'company' then btrim(coalesce(company_name, ''))
      else btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
    end
  ) stored,

  email           public.email_address,
  phone           text check (phone is null or char_length(phone) between 4 and 32),
  date_of_birth   date check (date_of_birth is null or date_of_birth > date '1900-01-01'),

  identity_document_type       public.identity_document_type,
  identity_document_number     text check (identity_document_number is null or char_length(identity_document_number) <= 64),
  identity_document_country    public.country_code,
  identity_document_expires_on date,

  driver_license_number      text check (driver_license_number is null or char_length(driver_license_number) <= 64),
  driver_license_country     public.country_code,
  driver_license_issued_on   date,
  driver_license_expires_on  date,

  address_line1   text check (address_line1 is null or char_length(address_line1) <= 160),
  address_line2   text check (address_line2 is null or char_length(address_line2) <= 160),
  city            text check (city is null or char_length(city) <= 96),
  region          text check (region is null or char_length(region) <= 96),
  postal_code     text check (postal_code is null or char_length(postal_code) <= 24),
  country_code    public.country_code,

  notes           text check (notes is null or char_length(notes) <= 4000),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  archived_at     timestamptz,

  constraint customers_tenant_key unique (id, organization_id),
  constraint customers_name_present check (
    case customer_type
      when 'company' then char_length(btrim(coalesce(company_name, ''))) > 0
      else char_length(btrim(coalesce(first_name, '') || coalesce(last_name, ''))) > 0
    end
  ),
  constraint customers_identity_number_requires_type check (
    identity_document_number is null or identity_document_type is not null
  ),
  constraint customers_license_period_valid check (
    driver_license_expires_on is null
    or driver_license_issued_on is null
    or driver_license_expires_on >= driver_license_issued_on
  )
);

comment on table public.customers is
  'Renters and corporate accounts. Contains personal identification data — read access is restricted to agency members by RLS.';
comment on column public.customers.display_name is
  'Generated presentation name. Never write to this column.';

create index if not exists customers_organization_name_idx
  on public.customers (organization_id, display_name)
  where archived_at is null;

create index if not exists customers_search_idx
  on public.customers (organization_id, lower(coalesce(email, '')), coalesce(phone, ''))
  where archived_at is null;

create index if not exists customers_license_expiry_idx
  on public.customers (organization_id, driver_license_expires_on)
  where driver_license_expires_on is not null and archived_at is null;

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function app.set_updated_at();

drop trigger if exists customers_freeze_columns on public.customers;
create trigger customers_freeze_columns
  before update on public.customers
  for each row execute function app.freeze_columns('id', 'organization_id', 'created_at', 'created_by');
