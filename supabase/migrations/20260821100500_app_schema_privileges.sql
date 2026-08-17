-- =============================================================================
-- 20260821100500_app_schema_privileges.sql
--
-- The anonymous role holds EXECUTE on 39 of the 66 functions in the private
-- `app` schema.
--
-- Found by a check written for something else: the Team review's freeze_columns
-- assertion asked whether `anon` could execute it, and the answer was yes.
--
-- NOTHING IS REACHABLE THROUGH IT TODAY. `anon` has no USAGE on `app`, so it
-- cannot name any of them; PostgREST exposes only `public`; and every RLS policy
-- in this schema is written `to authenticated`, so no anonymous request has a
-- reason to resolve an `app` function in the first place. This is not a live
-- hole and it is not reported as one.
--
-- It is closed for the reason 20260814110000_function_privileges.sql gives for
-- the `public` schema, which is the same reason and which that file put better:
-- depth of defence is not the same as the boundary being where it was supposed
-- to be.
--
-- The mechanism here is the mirror image of the one in `public`, and worth
-- stating because it is what made it invisible. There, Supabase's default
-- privileges granted EXECUTE to `anon` explicitly and `revoke ... from public`
-- left that grant untouched. Here, nothing was ever granted to `anon` at all:
-- these functions carry PostgreSQL's own default ACL, which grants EXECUTE to
-- PUBLIC, and every role is a member of PUBLIC. The two mistakes are opposites
-- and the lesson is one — check the privilege that is actually effective, not
-- the statement you believe you wrote.
--
-- It matters more now than it did last week. `app.freeze_columns` became
-- SECURITY DEFINER in 20260821100300 so it could ask whether an Auth account
-- still exists. A SECURITY DEFINER function carrying an anonymous EXECUTE grant
-- is safe only because of a schema USAGE that one careless `grant usage on
-- schema app to anon` would remove, and the whole point of the private schema is
-- that it does not depend on remembering that.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Remove it, including from everything added since
--
-- From PUBLIC, not from `anon`. This is the detail that made it survive: these
-- functions were never granted to the anonymous role at all — they carry
-- PostgreSQL's built-in default ACL, which grants EXECUTE to PUBLIC, and every
-- role is a member of PUBLIC. `revoke ... from anon` removes a grant that does
-- not exist and changes nothing, which is why the first attempt at this file
-- failed its own self-check.
--
-- The four authorization helpers were revoked from PUBLIC individually by the
-- foundation migration, which is why they are not in the affected set; what
-- accumulated is everything added after it — trigger functions, provisioning,
-- the financing and GPS guards.
--
-- Revoking from PUBLIC does not touch the explicit grants to `authenticated`
-- and `service_role` that earlier migrations made, and a trigger function needs
-- no EXECUTE from the writing user: PostgreSQL checks that when the trigger is
-- created, not when it fires.
-- -----------------------------------------------------------------------------

revoke all on all functions in schema app from public, anon;
revoke all on all routines in schema app from public, anon;

-- And from anything a later migration creates.
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema app revoke execute on routines from public;

-- The schema itself was already closed; stated so the two facts live together
-- rather than one of them being folded into a migration about something else.
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Give back exactly what a signed-in user genuinely calls
--
-- Removing the PUBLIC grant removes it from `authenticated` too, and some `app`
-- helpers are reached in INVOKER context — from an RLS policy expression, from
-- a view, from a CHECK constraint, from an index expression, or from the body of
-- a SECURITY INVOKER function in `public`. In every one of those the caller's
-- own privileges decide, so revoking without restoring locks a signed-in user
-- out. `app.organization_today` was the first to prove it, in eight financing
-- tests.
--
-- The set is DERIVED rather than listed. A hand-written list is a list somebody
-- has to remember to extend, and the next module that adds a helper to a view
-- would fail in production rather than here. This asks the catalogue which
-- helpers are actually referenced from an invoker context and grants those.
--
-- A SECURITY DEFINER function needs nothing: it runs as its owner. That is why
-- the membership guards, the provisioning path and the Team domain are absent
-- from what this grants, and they should stay absent.
-- -----------------------------------------------------------------------------

do $$
declare
  v_fn      record;
  v_granted integer := 0;
begin
  for v_fn in
    with referenced as (
      -- RLS policy expressions
      select pg_get_expr(p.polqual, p.polrelid) as body from pg_policy p
      union all
      select pg_get_expr(p.polwithcheck, p.polrelid) from pg_policy p
      union all
      -- Views, which run with the invoker's privileges by design here
      select pg_get_viewdef(c.oid) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
      union all
      -- CHECK constraints and index expressions
      select pg_get_constraintdef(k.oid) from pg_constraint k
      join pg_class t on t.oid = k.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
      union all
      select indexdef from pg_indexes where schemaname = 'public'
      union all
      -- Bodies of SECURITY INVOKER functions in public
      select p.prosrc from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and not p.prosecdef
    ),
    corpus as (select string_agg(coalesce(body, ''), E'\n') as text from referenced)
    select p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join corpus
    where n.nspname = 'app'
      and corpus.text like '%app.' || p.proname || '(%'
  loop
    execute format('grant execute on function app.%I(%s) to authenticated, service_role',
                   v_fn.proname, v_fn.args);
    v_granted := v_granted + 1;
  end loop;

  raise notice 'Restored EXECUTE to authenticated on % app helpers reachable in invoker context.', v_granted;
end
$$;

-- -----------------------------------------------------------------------------
-- Self-check — the boundary is where this file says it is
--
-- `authenticated` deliberately keeps what it needs: every RLS policy in the
-- schema is written in terms of app.is_org_member() and app.has_min_role(), and
-- a policy expression is evaluated with the caller's own privileges, so removing
-- those grants would lock every signed-in user out of every table.
-- -----------------------------------------------------------------------------

do $$
declare
  v_reachable text;
  v_authenticated integer;
begin
  select string_agg(p.proname, ', ' order by p.proname)
    into v_reachable
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_reachable is not null then
    raise exception
      'The anonymous role can still execute these private functions: %.', v_reachable;
  end if;

  if has_schema_privilege('anon', 'app', 'USAGE') then
    raise exception 'The anonymous role has USAGE on the private app schema.';
  end if;

  -- The helpers every policy depends on must still be callable by a signed-in
  -- user, or this migration has locked the product out of its own data.
  select count(*) into v_authenticated
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app'
    and p.proname in ('is_org_member', 'has_min_role', 'current_role_in', 'shares_organization_with')
    and has_function_privilege('authenticated', p.oid, 'EXECUTE');

  if v_authenticated <> 4 then
    raise exception
      'Only % of the 4 authorization helpers are executable by authenticated; RLS would refuse everything.',
      v_authenticated;
  end if;
end
$$;
