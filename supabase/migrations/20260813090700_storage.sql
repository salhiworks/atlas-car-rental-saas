-- =============================================================================
-- 20260813090700_storage.sql
--
-- Storage for agency logos.
--
-- The bucket is PRIVATE. A public bucket would make every tenant's uploaded
-- asset world-readable to anyone who can guess a URL, and object keys contain
-- organization ids — so the app reads logos through short-lived signed URLs.
--
-- Object key convention, relied upon by the policies below:
--     <organization_id>/<filename>
--
-- SVG is intentionally excluded from the MIME allow-list: SVG is an active
-- document format, and permitting arbitrary uploads of it puts script content
-- on the storage origin. Raster formats only.
--
-- The same three-policy shape (member reads, admin writes, keyed on the leading
-- path segment) is what the vehicle-document and expense-receipt buckets will
-- use when those modules land.
-- =============================================================================

set search_path = public, extensions, pg_temp;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'organization-logos',
  'organization-logos',
  false,
  2097152, -- 2 MiB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Every member of the agency may read its logo.
drop policy if exists "organization logos are readable by members" on storage.objects;
create policy "organization logos are readable by members" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'organization-logos'
    and app.is_org_member(app.organization_id_from_storage_path(name))
  );

-- Branding is an administrative action, matching the organizations UPDATE policy.
drop policy if exists "organization logos are writable by admins" on storage.objects;
create policy "organization logos are writable by admins" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'organization-logos'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  );

drop policy if exists "organization logos are replaceable by admins" on storage.objects;
create policy "organization logos are replaceable by admins" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'organization-logos'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  )
  with check (
    bucket_id = 'organization-logos'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  );

drop policy if exists "organization logos are removable by admins" on storage.objects;
create policy "organization logos are removable by admins" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'organization-logos'
    and app.has_min_role(app.organization_id_from_storage_path(name), 'admin')
  );
