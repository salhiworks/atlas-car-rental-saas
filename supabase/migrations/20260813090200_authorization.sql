-- =============================================================================
-- 20260813090200_authorization.sql
--
-- The single source of truth for "who may do what". Every RLS policy in this
-- schema is expressed in terms of the four helpers below, so adding a module
-- later means writing policies, never re-deriving authorization logic.
--
-- All helpers are SECURITY DEFINER with an empty search_path:
--   * SECURITY DEFINER lets them read organization_members without tripping the
--     RLS policies that are themselves defined in terms of these functions
--     (which would otherwise recurse infinitely).
--   * `set search_path = ''` prevents search-path hijacking; every identifier
--     inside is schema-qualified.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Role hierarchy
-- -----------------------------------------------------------------------------

create or replace function app.role_rank(p_role public.org_role)
returns smallint
language sql
immutable
parallel safe
as $$
  select case p_role
    when 'owner'   then 40
    when 'admin'   then 30
    when 'manager' then 20
    when 'staff'   then 10
  end::smallint;
$$;

comment on function app.role_rank(public.org_role) is
  'Totally orders the role hierarchy: owner > admin > manager > staff.';

-- -----------------------------------------------------------------------------
-- Membership lookups for the current request
-- -----------------------------------------------------------------------------

create or replace function app.current_role_in(p_organization_id uuid)
returns public.org_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = (select auth.uid())
    and m.status = 'active'
  limit 1;
$$;

comment on function app.current_role_in(uuid) is
  'Role of the requesting user in the given organization, or NULL when not an active member.';

create or replace function app.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

comment on function app.is_org_member(uuid) is
  'True when the requesting user is an active member of the organization. The base tenant predicate.';

create or replace function app.has_min_role(p_organization_id uuid, p_minimum public.org_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    app.role_rank(app.current_role_in(p_organization_id)) >= app.role_rank(p_minimum),
    false
  );
$$;

comment on function app.has_min_role(uuid, public.org_role) is
  'True when the requesting user holds at least the given role in the organization.';

create or replace function app.shares_organization_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members me
    join public.organization_members them
      on them.organization_id = me.organization_id
    where me.user_id = (select auth.uid())
      and me.status = 'active'
      and them.user_id = p_user_id
      and them.status = 'active'
  );
$$;

comment on function app.shares_organization_with(uuid) is
  'True when the requesting user and the target user are both active members of at least one common organization.';

-- Storage object keys are `<organization_id>/<filename>`. Returns NULL rather
-- than raising when the leading segment is not a UUID, so a malformed key
-- simply fails the membership predicate instead of erroring the whole policy.
create or replace function app.organization_id_from_storage_path(p_name text)
returns uuid
language plpgsql
immutable
parallel safe
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception
  when others then
    return null;
end;
$$;

-- -----------------------------------------------------------------------------
-- Membership invariants
--
-- RLS decides *who* may touch organization_members. This trigger enforces the
-- invariants RLS cannot express: owner-only owner management, no self-promotion,
-- and an organization that can never be left without an owner.
-- -----------------------------------------------------------------------------

create or replace function app.guard_membership_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor            uuid := (select auth.uid());
  v_actor_role       public.org_role;
  v_row              public.organization_members;
  v_active_owners    integer;
begin
  -- NEW and OLD are not interchangeable across operations; pick explicitly
  -- rather than relying on coalesce() over composite values.
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;

  -- Provisioning (creating an agency and seeding its first owner) and any
  -- service-role/maintenance path run without a member context.
  if v_actor is null or coalesce(current_setting('app.provisioning', true), '') = 'on' then
    return v_row;
  end if;

  v_actor_role := app.current_role_in(v_row.organization_id);

  select count(*)
    into v_active_owners
  from public.organization_members m
  where m.organization_id = v_row.organization_id
    and m.role = 'owner'
    and m.status = 'active';

  if tg_op = 'INSERT' then
    if new.role = 'owner' and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can add another owner.'
        using errcode = '42501';
    end if;

  elsif tg_op = 'UPDATE' then
    if old.user_id = v_actor and (new.role <> old.role or new.status <> old.status) then
      raise exception 'You cannot change your own role or status.'
        using errcode = '42501';
    end if;

    if (old.role = 'owner' or new.role = 'owner') and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can grant or revoke the owner role.'
        using errcode = '42501';
    end if;

    if old.role = 'owner' and old.status = 'active'
       and (new.role <> 'owner' or new.status <> 'active')
       and v_active_owners <= 1 then
      raise exception 'An organization must always keep at least one active owner.'
        using errcode = '23514';
    end if;

  elsif tg_op = 'DELETE' then
    if old.role = 'owner' and v_actor_role is distinct from 'owner' then
      raise exception 'Only an owner can remove another owner.'
        using errcode = '42501';
    end if;

    if old.role = 'owner' and old.status = 'active' and v_active_owners <= 1 then
      raise exception 'An organization must always keep at least one active owner.'
        using errcode = '23514';
    end if;
  end if;

  return v_row;
end;
$$;

drop trigger if exists organization_members_guard on public.organization_members;
create trigger organization_members_guard
  before insert or update or delete on public.organization_members
  for each row execute function app.guard_membership_changes();

-- -----------------------------------------------------------------------------
-- Organization provisioning
-- -----------------------------------------------------------------------------

create or replace function app.generate_organization_slug(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base    text;
  v_slug    text;
  v_attempt integer := 0;
begin
  v_base := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-');

  -- Names written entirely in a non-Latin script collapse to an empty string.
  if v_base is null or v_base = '' then
    v_base := 'agency';
  end if;

  v_base := btrim(left(v_base, 48), '-');
  if v_base = '' then
    v_base := 'agency';
  end if;

  v_slug := v_base;

  while exists (select 1 from public.organizations o where o.slug = v_slug) loop
    v_attempt := v_attempt + 1;
    v_slug := v_base || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    exit when v_attempt >= 25;
  end loop;

  return v_slug;
end;
$$;

-- Creates an agency, seeds its owner and its settings row atomically.
-- Inputs arrive as plain text and are sanitised here: a bad time zone or
-- currency from a sign-up payload must never be able to fail account creation.
create or replace function app.provision_organization(
  p_user_id    uuid,
  p_name       text,
  p_country    text default null,
  p_currency   text default null,
  p_time_zone  text default null,
  p_locale     text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org       public.organizations;
  v_name      text;
  v_country   text;
  v_currency  text;
  v_time_zone text;
  v_locale    text;
begin
  if p_user_id is null then
    raise exception 'An organization must be provisioned for a user.' using errcode = '22004';
  end if;

  v_name := left(btrim(coalesce(p_name, '')), 120);
  if char_length(v_name) < 2 then
    raise exception 'Organization name must be at least 2 characters.' using errcode = '22023';
  end if;

  v_country := nullif(upper(btrim(coalesce(p_country, ''))), '');
  if v_country !~ '^[A-Z]{2}$' then
    v_country := null;
  end if;

  v_currency := nullif(upper(btrim(coalesce(p_currency, ''))), '');
  if v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    v_currency := 'USD';
  end if;

  v_time_zone := nullif(btrim(coalesce(p_time_zone, '')), '');
  if v_time_zone is null or not public.is_valid_time_zone(v_time_zone) then
    v_time_zone := 'UTC';
  end if;

  v_locale := nullif(btrim(coalesce(p_locale, '')), '');
  if v_locale is null or v_locale !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' then
    v_locale := 'en';
  end if;

  perform set_config('app.provisioning', 'on', true);

  insert into public.organizations (name, slug, default_currency, time_zone, country_code, locale, created_by)
  values (
    v_name,
    app.generate_organization_slug(v_name),
    v_currency::public.currency_code,
    v_time_zone,
    v_country::public.country_code,
    v_locale::public.locale_tag,
    p_user_id
  )
  returning * into v_org;

  insert into public.organization_members (organization_id, user_id, role, status)
  values (v_org.id, p_user_id, 'owner', 'active');

  insert into public.organization_settings (organization_id)
  values (v_org.id);

  perform set_config('app.provisioning', 'off', true);

  return v_org;
end;
$$;

-- Client-callable entry point. Used by the onboarding screen shown to an
-- authenticated user who has no membership yet.
create or replace function public.create_organization(
  p_name      text,
  p_country   text default null,
  p_currency  text default null,
  p_time_zone text default null,
  p_locale    text default null
)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  return app.provision_organization(v_user, p_name, p_country, p_currency, p_time_zone, p_locale);
end;
$$;

comment on function public.create_organization(text, text, text, text, text) is
  'Creates an agency owned by the calling user, together with its owner membership and settings row.';

-- -----------------------------------------------------------------------------
-- auth.users -> profile (+ optional agency) bootstrap
-- -----------------------------------------------------------------------------

create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_org_name text;
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    left(btrim(coalesce(v_meta ->> 'full_name', '')), 120),
    new.email
  )
  on conflict (id) do nothing;

  v_org_name := btrim(coalesce(v_meta ->> 'organization_name', ''));

  if char_length(v_org_name) >= 2 then
    begin
      perform app.provision_organization(
        new.id,
        v_org_name,
        v_meta ->> 'country_code',
        v_meta ->> 'default_currency',
        v_meta ->> 'time_zone',
        v_meta ->> 'locale'
      );
    exception
      when others then
        -- Never let agency provisioning block account creation. The application
        -- detects "authenticated but no membership" and offers onboarding, which
        -- calls public.create_organization() directly.
        raise warning 'Agency provisioning failed for user %: %', new.id, sqlerrm;
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- Keep the profile email mirror in step with GoTrue after a verified change.
create or replace function app.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function app.handle_user_email_change();

-- -----------------------------------------------------------------------------
-- Execution grants — nothing here is reachable anonymously
-- -----------------------------------------------------------------------------

revoke all on function public.is_valid_time_zone(text) from public;
grant execute on function public.is_valid_time_zone(text) to authenticated, service_role;

revoke all on function public.create_organization(text, text, text, text, text) from public;
grant execute on function public.create_organization(text, text, text, text, text) to authenticated;

revoke all on function app.role_rank(public.org_role) from public;
revoke all on function app.current_role_in(uuid) from public;
revoke all on function app.is_org_member(uuid) from public;
revoke all on function app.has_min_role(uuid, public.org_role) from public;
revoke all on function app.shares_organization_with(uuid) from public;
revoke all on function app.organization_id_from_storage_path(text) from public;

grant execute on function app.role_rank(public.org_role) to authenticated, service_role;
grant execute on function app.current_role_in(uuid) to authenticated, service_role;
grant execute on function app.is_org_member(uuid) to authenticated, service_role;
grant execute on function app.has_min_role(uuid, public.org_role) to authenticated, service_role;
grant execute on function app.shares_organization_with(uuid) to authenticated, service_role;
grant execute on function app.organization_id_from_storage_path(text) to authenticated, service_role;
