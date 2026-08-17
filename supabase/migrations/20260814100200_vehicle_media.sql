-- =============================================================================
-- 20260814100200_vehicle_media.sql
--
-- Vehicle photographs and document attachments.
--
-- Images get their own table rather than an array column on `vehicles`: each one
-- carries its own storage key, MIME type, size, ordering and primary flag, and
-- an array would make "delete this photo" and "make that one primary" into
-- read-modify-write races on the vehicle row.
--
-- Two private buckets. Object keys are `<organization_id>/<vehicle_id>/<file>`,
-- and the policies read that leading segment — the key is part of the security
-- model, not a naming convention. Nothing is world-readable: the interface
-- fetches short-lived signed URLs, exactly as it does for agency logos.
--
-- SVG is refused in both buckets. It is an active document format, and accepting
-- arbitrary SVG would place script content on the storage origin.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- vehicle_images
-- -----------------------------------------------------------------------------

create table if not exists public.vehicle_images (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  vehicle_id      uuid not null,

  storage_path text not null check (char_length(storage_path) between 1 and 512),
  -- A small copy generated in the browser at upload time, so a list of forty
  -- vehicles does not pull down forty full-resolution photographs. Kept separate
  -- from storage_path rather than derived, because server-side image transforms
  -- are a paid Supabase feature and this must work on any plan.
  thumbnail_path text check (thumbnail_path is null or char_length(thumbnail_path) between 1 and 512),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  byte_size    integer not null check (byte_size > 0 and byte_size <= 8388608),
  width        integer check (width is null or width > 0),
  height       integer check (height is null or height > 0),

  -- One photo per vehicle leads the list and the detail header.
  is_primary   boolean not null default false,
  sort_order   integer not null default 0,
  caption      text check (caption is null or char_length(caption) <= 160),

  uploaded_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint vehicle_images_storage_path_key unique (storage_path),
  constraint vehicle_images_thumbnail_path_key unique (thumbnail_path),
  constraint vehicle_images_vehicle_fkey
    foreign key (vehicle_id, organization_id)
    references public.vehicles (id, organization_id)
    on delete cascade
);

comment on table public.vehicle_images is
  'Photographs of a vehicle. Files live in the private vehicle-photos bucket; this table holds the metadata.';

create unique index if not exists vehicle_images_single_primary_idx
  on public.vehicle_images (vehicle_id)
  where is_primary;

create index if not exists vehicle_images_vehicle_idx
  on public.vehicle_images (vehicle_id, sort_order, created_at);

create index if not exists vehicle_images_organization_idx
  on public.vehicle_images (organization_id);

drop trigger if exists vehicle_images_set_updated_at on public.vehicle_images;
create trigger vehicle_images_set_updated_at
  before update on public.vehicle_images
  for each row execute function app.set_updated_at();

drop trigger if exists vehicle_images_freeze_columns on public.vehicle_images;
create trigger vehicle_images_freeze_columns
  before update on public.vehicle_images
  for each row execute function app.freeze_columns(
    'id', 'organization_id', 'vehicle_id', 'storage_path', 'created_at', 'uploaded_by'
  );

-- -----------------------------------------------------------------------------
-- Exactly one primary photo per vehicle, maintained by the database
--
-- The demotion runs in a BEFORE trigger, and that ordering is the whole point:
-- the partial unique index rejects a second primary at write time, so an AFTER
-- trigger would never get the chance to demote the previous one — "make this
-- one primary" would fail with a duplicate-key error instead of working. The
-- BEFORE trigger clears the old primary first, then this row's write proceeds.
--
-- Promotion after a delete is the mirror case and must be AFTER, so the row
-- being removed is already gone and cannot promote itself.
-- -----------------------------------------------------------------------------

create or replace function app.maintain_vehicle_primary_image()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Keep a vehicle that still has photos from ending up with no primary.
    if old.is_primary then
      update public.vehicle_images i
         set is_primary = true
       where i.id = (
         select i2.id
         from public.vehicle_images i2
         where i2.vehicle_id = old.vehicle_id
         order by i2.sort_order, i2.created_at
         limit 1
       );
    end if;

    return old;
  end if;

  -- The first photo uploaded becomes the primary without anyone choosing.
  if tg_op = 'INSERT' and not exists (
    select 1 from public.vehicle_images i where i.vehicle_id = new.vehicle_id
  ) then
    new.is_primary := true;
  end if;

  -- Clear the incumbent before this row claims the flag. The recursive update
  -- re-enters this trigger with is_primary = false, so it stops here.
  if new.is_primary and (tg_op = 'INSERT' or not old.is_primary) then
    update public.vehicle_images i
       set is_primary = false
     where i.vehicle_id = new.vehicle_id
       and i.id <> new.id
       and i.is_primary;
  end if;

  return new;
end;
$$;

drop trigger if exists vehicle_images_maintain_primary on public.vehicle_images;
drop trigger if exists vehicle_images_claim_primary on public.vehicle_images;
create trigger vehicle_images_claim_primary
  before insert or update of is_primary on public.vehicle_images
  for each row execute function app.maintain_vehicle_primary_image();

drop trigger if exists vehicle_images_promote_primary on public.vehicle_images;
create trigger vehicle_images_promote_primary
  after delete on public.vehicle_images
  for each row execute function app.maintain_vehicle_primary_image();

-- -----------------------------------------------------------------------------
-- Privileges and policies — same shape as every other tenant table
-- -----------------------------------------------------------------------------

revoke all on table public.vehicle_images from anon, authenticated;
grant select, insert, update, delete on table public.vehicle_images to authenticated;

alter table public.vehicle_images enable row level security;

drop policy if exists vehicle_images_select on public.vehicle_images;
create policy vehicle_images_select on public.vehicle_images
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists vehicle_images_insert on public.vehicle_images;
create policy vehicle_images_insert on public.vehicle_images
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists vehicle_images_update on public.vehicle_images;
create policy vehicle_images_update on public.vehicle_images
  for update to authenticated
  using (app.has_min_role(organization_id, 'manager'))
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists vehicle_images_delete on public.vehicle_images;
create policy vehicle_images_delete on public.vehicle_images
  for delete to authenticated
  using (app.has_min_role(organization_id, 'manager'));

-- -----------------------------------------------------------------------------
-- Storage buckets
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vehicle-photos',
  'vehicle-photos',
  false,
  8388608, -- 8 MiB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vehicle-documents',
  'vehicle-documents',
  false,
  10485760, -- 10 MiB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Reading fleet media is ordinary membership; writing it matches the vehicles
-- UPDATE policy, so whoever can edit a vehicle can manage its files.
drop policy if exists "vehicle media readable by members" on storage.objects;
create policy "vehicle media readable by members" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('vehicle-photos', 'vehicle-documents')
    and app.is_org_member(app.organization_id_from_storage_path(name))
  );

drop policy if exists "vehicle media writable by managers" on storage.objects;
create policy "vehicle media writable by managers" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('vehicle-photos', 'vehicle-documents')
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

drop policy if exists "vehicle media replaceable by managers" on storage.objects;
create policy "vehicle media replaceable by managers" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('vehicle-photos', 'vehicle-documents')
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  )
  with check (
    bucket_id in ('vehicle-photos', 'vehicle-documents')
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

drop policy if exists "vehicle media removable by managers" on storage.objects;
create policy "vehicle media removable by managers" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('vehicle-photos', 'vehicle-documents')
    and app.has_min_role(app.organization_id_from_storage_path(name), 'manager')
  );

-- -----------------------------------------------------------------------------
-- What references a vehicle — the archive-versus-delete decision
--
-- The interface must be able to say "this vehicle has 14 contracts against it,
-- so it will be archived" rather than offering a delete the foreign keys are
-- going to refuse.
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

  -- Same answer for "does not exist" and "belongs to another agency": the caller
  -- must not be able to tell the difference.
  if v_organization_id is null or not app.is_org_member(v_organization_id) then
    raise exception 'Vehicle not found.' using errcode = 'P0002';
  end if;

  return query
  with counts as (
    select
      (select count(*) from public.rentals r where r.vehicle_id = p_vehicle_id)           as rentals,
      (select count(*) from public.expenses e where e.vehicle_id = p_vehicle_id)          as expenses,
      (select count(*) from public.financing_plans f where f.vehicle_id = p_vehicle_id)   as financing,
      (select count(*) from public.vehicle_documents d where d.vehicle_id = p_vehicle_id) as documents,
      (select count(*) from public.vehicle_images i where i.vehicle_id = p_vehicle_id)    as images
  )
  select
    counts.rentals,
    counts.expenses,
    counts.financing,
    counts.documents,
    counts.images,
    -- Documents and images cascade; the other three are ON DELETE RESTRICT and
    -- represent financial history that must never disappear.
    (counts.rentals = 0 and counts.expenses = 0 and counts.financing = 0)
  from counts;
end;
$$;

comment on function public.vehicle_usage(uuid) is
  'Reference counts for a vehicle, and whether a hard delete is possible without destroying financial history.';

revoke all on function public.vehicle_usage(uuid) from public;
grant execute on function public.vehicle_usage(uuid) to authenticated;

-- The RLS self-check from the foundation migration, re-run now that a table has
-- been added: a new table without policies must not reach production.
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

select app.assert_views_are_security_invoker();
