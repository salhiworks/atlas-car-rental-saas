-- =============================================================================
-- 20260814110000_function_privileges.sql
--
-- Removes the anonymous role's EXECUTE privilege on every function in `public`.
--
-- Found by checking the live project rather than the test harness. Supabase
-- ships with:
--
--     alter default privileges in schema public
--       grant all on functions to anon, authenticated, service_role;
--
-- so every function created by a migration is granted EXECUTE to `anon`
-- *explicitly*. The earlier migrations said `revoke all on function … from
-- public`, which removes the implicit PUBLIC grant but leaves an explicit
-- per-role grant untouched. The net effect was that `anon` could call every
-- RPC in the schema.
--
-- Nothing leaked: the SECURITY INVOKER functions all call app.is_org_member(),
-- and `anon` has no USAGE on the private `app` schema, so they failed; and
-- create_organization() checks auth.uid() and refuses. But depth of defence is
-- not the same as the boundary being where it was supposed to be, and the next
-- public function that happens not to touch `app` would be genuinely exposed.
--
-- The self-check at the end makes this permanent rather than a one-time repair.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Remove the grant, including from anything added since
-- -----------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

-- Future functions must not inherit it either. This counteracts Supabase's
-- default privileges for objects created by the migration role from here on.
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on routines from anon;

-- -----------------------------------------------------------------------------
-- Restate what the application actually needs
--
-- Spelled out per function rather than granted wholesale, so this file is also
-- the readable inventory of what a signed-in user may call.
-- -----------------------------------------------------------------------------

grant execute on function public.create_organization(text, text, text, text, text) to authenticated;
grant execute on function public.organization_overview(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.organization_financial_series(uuid, date, date, text) to authenticated;
grant execute on function public.fleet_status_counts(uuid) to authenticated;
grant execute on function public.vehicle_usage(uuid) to authenticated;
grant execute on function public.vehicles_available_between(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public.is_valid_time_zone(text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Self-check — fails the deploy if anon can reach any public function
-- -----------------------------------------------------------------------------

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
    raise exception
      'The anonymous role can execute these public functions: %. Revoke EXECUTE from anon.',
      v_reachable;
  end if;
end
$$;
