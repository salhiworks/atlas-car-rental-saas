-- =============================================================================
-- 20260814100000_foundation_hardening.sql
--
-- Two corrections to the foundation, found by auditing it before building on it.
--
-- 1. public.create_organization() was not idempotent. A double-submitted form, a
--    client retry after a timeout, or two concurrent calls would each mint a
--    separate agency for the same user. Onboarding is exactly the place where a
--    retry is likely, so this is now serialised per user and returns the agency
--    the caller already owns under that name instead of creating another.
--
-- 2. A guard against a class of mistake this schema has not made yet but easily
--    could: a view in `public` created without `security_invoker`. Such a view
--    runs as its owner and silently bypasses the RLS of every table beneath it —
--    the one way "the tables have RLS" stops being sufficient. The check runs on
--    every deploy so it cannot be forgotten later.
--
-- The analytics functions were audited and needed no change: both are SECURITY
-- INVOKER (the default), so RLS applies to every table they read, and both
-- additionally assert membership. `20260814100100` adds tests that prove it
-- rather than asserting it in a comment.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Idempotent, retry-safe agency creation
-- -----------------------------------------------------------------------------

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
  v_user     uuid := (select auth.uid());
  v_name     text;
  v_existing public.organizations;
begin
  if v_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  v_name := left(btrim(coalesce(p_name, '')), 120);
  if char_length(v_name) < 2 then
    raise exception 'Organization name must be at least 2 characters.' using errcode = '22023';
  end if;

  -- Serialise concurrent calls by the same user. Released at transaction end.
  perform pg_advisory_xact_lock(
    hashtext('public.create_organization'),
    hashtext(v_user::text)
  );

  -- If this user already owns an active agency under this name, an earlier call
  -- succeeded — return that one. Scoped to the caller's own OWNER membership, so
  -- this can never hand back an agency belonging to somebody else, however the
  -- name happens to collide.
  select o.*
    into v_existing
  from public.organizations o
  join public.organization_members m on m.organization_id = o.id
  where m.user_id = v_user
    and m.role = 'owner'
    and m.status = 'active'
    and lower(btrim(o.name)) = lower(v_name)
  order by o.created_at
  limit 1;

  if found then
    return v_existing;
  end if;

  return app.provision_organization(v_user, v_name, p_country, p_currency, p_time_zone, p_locale);
end;
$$;

comment on function public.create_organization(text, text, text, text, text) is
  'Creates an agency owned by the calling user. Idempotent per (user, name) and serialised per user, so a retry or double submit cannot create duplicates.';

revoke all on function public.create_organization(text, text, text, text, text) from public;
grant execute on function public.create_organization(text, text, text, text, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Deploy-time guard: no RLS-bypassing views
-- -----------------------------------------------------------------------------

create or replace function app.assert_views_are_security_invoker()
returns void
language plpgsql
as $$
declare
  v_offenders text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and coalesce(array_to_string(c.reloptions, ','), '') not ilike '%security_invoker=true%';

  if v_offenders is not null then
    raise exception
      'These public views run with the definer''s privileges and bypass Row Level Security: %. Recreate them WITH (security_invoker = true).',
      v_offenders;
  end if;
end;
$$;

comment on function app.assert_views_are_security_invoker() is
  'Fails if any view in the public schema would bypass RLS. Called at the end of every migration that adds a view.';

revoke all on function app.assert_views_are_security_invoker() from public;

select app.assert_views_are_security_invoker();
