-- =============================================================================
-- 20260814120100_customer_read_models.sql
--
-- The query surfaces the Customers module reads, and the private bucket its
-- documents live in.
--
-- `customer_directory` exists so the list can be rendered from one query. The
-- alternative — fetch customers, then each one's documents, then each one's
-- rentals — is an N+1 that also drags every customer's identification down to
-- the browser just to draw a table. Nothing here returns a document number.
--
-- Every function is SECURITY INVOKER with an explicit membership assertion, and
-- the view is `security_invoker = true`, so RLS applies to all of it.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- customer_directory — the list read model
-- -----------------------------------------------------------------------------

drop view if exists public.customer_directory;

create view public.customer_directory
with (security_invoker = true)
as
select
  c.id                       as customer_id,
  c.organization_id,
  c.customer_type,
  c.display_name,
  c.first_name,
  c.last_name,
  c.company_name,
  c.email,
  c.phone,
  c.secondary_phone,
  c.date_of_birth,
  c.nationality_country_code,
  c.country_code,
  c.city,
  c.region,
  c.postal_code,
  c.address_line1,
  c.address_line2,
  c.preferred_locale,
  -- Internal notes. Agency members only, by the same RLS as the row itself.
  c.notes,
  c.created_at,
  c.updated_at,
  c.archived_at,

  -- Identification: counts and validity only. The numbers themselves are read
  -- from customer_documents, on the profile, by someone who opened it.
  coalesce(docs.identity_count, 0)        as identity_document_count,
  coalesce(docs.document_count, 0)        as document_count,
  docs.identity_expires_on,

  licence.id                              as driver_license_id,
  licence.issuing_country                 as driver_license_country,
  licence.issued_on                       as driver_license_issued_on,
  licence.expires_on                      as driver_license_expires_on,
  licence.license_classes                 as driver_license_classes,
  (licence.id is not null)                as has_driver_license,

  coalesce(hist.rental_count, 0)          as rental_count,
  hist.first_rental_at,
  hist.last_rental_ends_at,
  hist.active_rental_id,
  hist.active_rental_reference,
  hist.active_rental_ends_at,
  hist.upcoming_rental_id,
  hist.upcoming_rental_reference,
  hist.upcoming_rental_starts_at,

  -- Money is only ever reported when it is unambiguous. A customer billed in two
  -- currencies gets a count instead of a total, because adding EUR to MAD would
  -- be a confident lie.
  coalesce(money.currency_count, 0)       as outstanding_currency_count,
  case when money.currency_count = 1 then money.outstanding_minor end as outstanding_minor,
  case when money.currency_count = 1 then money.currency end          as outstanding_currency
from public.customers c

left join lateral (
  select
    count(*) filter (where d.document_type <> 'driver_license') as identity_count,
    count(*)                                                    as document_count,
    min(d.expires_on) filter (where d.document_type <> 'driver_license') as identity_expires_on
  from public.customer_documents d
  where d.customer_id = c.id
) docs on true

-- The licence that stays valid longest is the one that matters operationally.
left join lateral (
  select d.id, d.issuing_country, d.issued_on, d.expires_on, d.license_classes
  from public.customer_documents d
  where d.customer_id = c.id
    and d.document_type = 'driver_license'
  order by d.expires_on desc nulls last, d.created_at desc
  limit 1
) licence on true

left join lateral (
  select
    count(*)                                as rental_count,
    min(r.starts_at)                        as first_rental_at,
    max(r.ends_at) filter (where r.status = 'completed') as last_rental_ends_at,
    (array_agg(r.id order by r.starts_at)
       filter (where r.status = 'active' and r.starts_at <= now() and r.ends_at > now()))[1]        as active_rental_id,
    (array_agg(r.reference order by r.starts_at)
       filter (where r.status = 'active' and r.starts_at <= now() and r.ends_at > now()))[1]        as active_rental_reference,
    (array_agg(r.ends_at order by r.starts_at)
       filter (where r.status = 'active' and r.starts_at <= now() and r.ends_at > now()))[1]        as active_rental_ends_at,
    (array_agg(r.id order by r.starts_at)
       filter (where r.status = 'reserved' and r.ends_at > now()))[1]                               as upcoming_rental_id,
    (array_agg(r.reference order by r.starts_at)
       filter (where r.status = 'reserved' and r.ends_at > now()))[1]                               as upcoming_rental_reference,
    (array_agg(r.starts_at order by r.starts_at)
       filter (where r.status = 'reserved' and r.ends_at > now()))[1]                               as upcoming_rental_starts_at
  from public.rentals r
  where r.customer_id = c.id
) hist on true

left join lateral (
  select
    count(*)                                        as currency_count,
    (array_agg(t.currency order by t.currency))[1]  as currency,
    (array_agg(t.outstanding order by t.currency))[1] as outstanding_minor
  from (
    select r.currency, sum(r.balance_due_minor)::bigint as outstanding
    from public.rentals r
    where r.customer_id = c.id
      and r.status in ('reserved', 'active', 'completed')
      and r.balance_due_minor > 0
    group by r.currency
  ) t
) money on true;

comment on view public.customer_directory is
  'Customer list read model: contact details, identification validity, rental context and unambiguous outstanding balance. Contains no document numbers.';

revoke all on public.customer_directory from anon, authenticated;
grant select on public.customer_directory to authenticated;

-- -----------------------------------------------------------------------------
-- Rental history for one customer
-- -----------------------------------------------------------------------------

create or replace function public.customer_rental_summary(p_customer_id uuid)
returns table (
  rental_count       bigint,
  completed_count    bigint,
  cancelled_count    bigint,
  first_rental_at    timestamptz,
  last_rental_ends_at timestamptz,
  active_rental_id   uuid,
  upcoming_rental_id uuid
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select c.organization_id into v_organization_id
  from public.customers c
  where c.id = p_customer_id;

  -- Indistinguishable from "does not exist", so a probe cannot confirm that an
  -- identifier belongs to some other agency.
  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  return query
  select
    count(*),
    count(*) filter (where r.status = 'completed'),
    count(*) filter (where r.status = 'cancelled'),
    min(r.starts_at),
    max(r.ends_at) filter (where r.status = 'completed'),
    (array_agg(r.id order by r.starts_at)
       filter (where r.status = 'active' and r.starts_at <= now() and r.ends_at > now()))[1],
    (array_agg(r.id order by r.starts_at)
       filter (where r.status = 'reserved' and r.ends_at > now()))[1]
  from public.rentals r
  where r.customer_id = p_customer_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Financial context, one row per currency
--
-- Returning a set rather than a total is the whole point: an agency that once
-- billed a customer in USD and now bills in EUR has two true numbers and no
-- single true number, and this product does not hold an exchange rate.
-- -----------------------------------------------------------------------------

create or replace function public.customer_financial_summary(p_customer_id uuid)
returns table (
  currency            public.currency_code,
  rental_count        bigint,
  charged_minor       bigint,
  paid_minor          bigint,
  outstanding_minor   bigint,
  deposits_held_minor bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select c.organization_id into v_organization_id
  from public.customers c
  where c.id = p_customer_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  return query
  select
    r.currency,
    count(*),
    coalesce(sum(r.total_minor), 0)::bigint,
    coalesce(sum(r.amount_paid_minor), 0)::bigint,
    coalesce(sum(r.balance_due_minor) filter (
      where r.balance_due_minor > 0 and r.status in ('reserved', 'active', 'completed')
    ), 0)::bigint,
    coalesce(sum(r.deposit_minor) filter (where r.status in ('reserved', 'active')), 0)::bigint
  from public.rentals r
  where r.customer_id = p_customer_id
    and r.status <> 'draft'
  group by r.currency
  order by r.currency;
end;
$$;

-- -----------------------------------------------------------------------------
-- Duplicate detection
--
-- Returns candidates and says why each matched. It never merges anything, and it
-- never reaches outside the caller's agency: the membership assertion plus RLS
-- on `customers` make a cross-tenant hint impossible.
--
-- Contact details are a warning, not a bar — families and companies legitimately
-- share a phone number. Only the identifier uniqueness index actually refuses.
-- -----------------------------------------------------------------------------

create or replace function public.find_customer_duplicates(
  p_organization_id    uuid,
  p_email              text default null,
  p_phone              text default null,
  p_documents          jsonb default '[]'::jsonb,
  p_exclude_customer_id uuid default null
)
returns table (
  customer_id   uuid,
  display_name  text,
  archived_at   timestamptz,
  match_reason  text,
  match_strength text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  return query
  with candidates as (
    -- An identifier match is decisive: this is the same person.
    select
      c.id,
      c.display_name,
      c.archived_at,
      case d.document_type
        when 'passport'         then 'Same passport number'
        when 'national_id'      then 'Same national ID number'
        when 'residence_permit' then 'Same residence permit number'
        when 'driver_license'   then 'Same driving licence number'
        else 'Same document number'
      end as reason,
      'strong' as strength
    from jsonb_to_recordset(coalesce(p_documents, '[]'::jsonb))
      as incoming(document_type text, document_number text, issuing_country text)
    join public.customer_documents d
      on d.organization_id = p_organization_id
     and d.document_type = incoming.document_type::public.customer_document_type
     and d.document_number_normalized =
         upper(regexp_replace(coalesce(incoming.document_number, ''), '[^A-Za-z0-9]', '', 'g'))
     and coalesce(d.issuing_country, '~~') =
         coalesce(nullif(upper(btrim(coalesce(incoming.issuing_country, ''))), '')::public.country_code, '~~')
    join public.customers c on c.id = d.customer_id
    where coalesce(incoming.document_number, '') <> ''

    union all

    -- Contact matches are worth surfacing but never block.
    select c.id, c.display_name, c.archived_at, 'Same email address', 'weak'
    from public.customers c
    where c.organization_id = p_organization_id
      and v_email <> ''
      and c.email_normalized = v_email

    union all

    select c.id, c.display_name, c.archived_at, 'Same phone number', 'weak'
    from public.customers c
    where c.organization_id = p_organization_id
      and length(v_phone) >= 6
      and c.phone_normalized = v_phone
  )
  select
    candidates.id,
    candidates.display_name,
    candidates.archived_at,
    string_agg(distinct candidates.reason, ', '),
    case when bool_or(candidates.strength = 'strong') then 'strong' else 'weak' end
  from candidates
  where p_exclude_customer_id is null or candidates.id <> p_exclude_customer_id
  group by candidates.id, candidates.display_name, candidates.archived_at
  order by 5 desc, 2;
end;
$$;

-- -----------------------------------------------------------------------------
-- What references a customer — the archive-versus-delete decision
-- -----------------------------------------------------------------------------

create or replace function public.customer_usage(p_customer_id uuid)
returns table (
  rentals_count       bigint,
  driver_on_count     bigint,
  payments_count      bigint,
  documents_count     bigint,
  can_delete          boolean
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
begin
  select c.organization_id into v_organization_id
  from public.customers c
  where c.id = p_customer_id;

  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  return query
  with counts as (
    select
      (select count(*) from public.rentals r where r.customer_id = p_customer_id)           as rentals,
      (select count(*) from public.rental_drivers rd where rd.customer_id = p_customer_id)  as driver_on,
      (select count(*) from public.payments p where p.customer_id = p_customer_id)          as payments,
      (select count(*) from public.customer_documents d where d.customer_id = p_customer_id) as documents
  )
  select
    counts.rentals,
    counts.driver_on,
    counts.payments,
    counts.documents,
    -- Documents cascade with the customer. Rentals, rental_drivers and payments
    -- are ON DELETE RESTRICT and are the agency's financial history.
    (counts.rentals = 0 and counts.driver_on = 0 and counts.payments = 0)
  from counts;
end;
$$;

-- -----------------------------------------------------------------------------
-- Grants — authenticated only, never anon
-- -----------------------------------------------------------------------------

revoke all on function public.customer_rental_summary(uuid) from public, anon;
revoke all on function public.customer_financial_summary(uuid) from public, anon;
revoke all on function public.find_customer_duplicates(uuid, text, text, jsonb, uuid) from public, anon;
revoke all on function public.customer_usage(uuid) from public, anon;

grant execute on function public.customer_rental_summary(uuid) to authenticated;
grant execute on function public.customer_financial_summary(uuid) to authenticated;
grant execute on function public.find_customer_duplicates(uuid, text, text, jsonb, uuid) to authenticated;
grant execute on function public.customer_usage(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Private storage for identification scans
--
-- Same shape as the vehicle buckets: keys are `<organization_id>/<customer_id>/…`
-- and the policies read that leading segment, so a guessed path from another
-- agency resolves to a refusal rather than a passport scan.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-documents',
  'customer-documents',
  false,
  10485760, -- 10 MiB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "customer documents readable by members" on storage.objects;
create policy "customer documents readable by members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'customer-documents'
    and app.is_org_member(app.organization_id_from_storage_path(name))
  );

drop policy if exists "customer documents writable by staff" on storage.objects;
create policy "customer documents writable by staff" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'customer-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'staff')
  );

drop policy if exists "customer documents replaceable by staff" on storage.objects;
create policy "customer documents replaceable by staff" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'customer-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'staff')
  )
  with check (
    bucket_id = 'customer-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'staff')
  );

drop policy if exists "customer documents removable by managers" on storage.objects;
create policy "customer documents removable by managers" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'customer-documents'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

-- -----------------------------------------------------------------------------
-- The guards established earlier, re-run now that a view and functions were added
-- -----------------------------------------------------------------------------

select app.assert_views_are_security_invoker();

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

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
