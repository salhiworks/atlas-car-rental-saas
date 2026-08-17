-- =============================================================================
-- GPS credentials: the only path to a provider token
--
-- Four functions, all SECURITY DEFINER, all granted to `service_role` and
-- nothing else. They exist because Supabase Vault deliberately gives no
-- privilege to `authenticated`, and because the alternative — a token column in
-- an RLS table — is not secret storage however carefully the policy is written.
--
-- THE BOUNDARY, IN LAYERS
--
--   1. `vault.decrypted_secrets` is granted only to `postgres` and
--      `service_role`. A signed-in user cannot read it.
--   2. The `vault` schema is not among the schemas the Data API exposes, so
--      PostgREST cannot reach it even for a role that could.
--   3. `gps_provider_credentials`, which holds the pointer, has no grant to any
--      application role at all.
--   4. These functions are granted to `service_role` only, so the RPC endpoint
--      refuses them for anyone signed in through the browser.
--
-- Each of those four is asserted by the test suite rather than assumed, because
-- a security arrangement nobody checks is a security arrangement that quietly
-- stops being true.
--
-- SECURITY DEFINER is unavoidable here: the function has to reach a schema its
-- caller must never reach. It is confined accordingly — `search_path = ''`,
-- fully qualified names, no dynamic SQL, and no argument that can widen what it
-- touches beyond the one connection it is given.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Storing a credential
--
-- Creates the Vault secret on first use and replaces it on rotation. Bumping
-- the generation is what makes a synchronisation started under the old token
-- unable to report the connection healthy afterwards.
-- -----------------------------------------------------------------------------

create or replace function public.gps_store_credential(
  p_connection_id uuid,
  p_token         text,
  p_base_url      text default null,
  p_label         text default null,
  p_user_id       uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection public.gps_provider_connections;
  v_existing   uuid;
  v_secret_id  uuid;
  v_generation integer;
begin
  if p_token is null or btrim(p_token) = '' then
    raise exception 'A provider credential cannot be empty.' using errcode = '22004';
  end if;

  select * into v_connection
  from public.gps_provider_connections
  where id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'Connection not found.' using errcode = 'P0002';
  end if;

  v_generation := v_connection.generation + 1;

  select c.secret_ref into v_existing
  from public.gps_provider_credentials c
  where c.connection_id = p_connection_id;

  if v_existing is null then
    v_secret_id := vault.create_secret(
      btrim(p_token),
      'gps_provider_' || p_connection_id::text,
      'Telematics provider credential. Written and read only by trusted server-side code.'
    );

    insert into public.gps_provider_credentials
      (connection_id, organization_id, secret_ref, credential_set_by, generation)
    values (p_connection_id, v_connection.organization_id, v_secret_id, p_user_id, v_generation);
  else
    perform vault.update_secret(v_existing, btrim(p_token));

    update public.gps_provider_credentials
       set credential_set_at = now(),
           credential_set_by = p_user_id,
           generation = v_generation
     where connection_id = p_connection_id;
  end if;

  update public.gps_provider_connections
     set generation = v_generation,
         base_url = coalesce(p_base_url, base_url),
         label = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label),
         -- A replaced credential has not been verified yet. Saying otherwise
         -- would leave the interface claiming a connection works when nobody
         -- has asked the provider since the token changed.
         status = case when disabled_at is null then 'never_connected'::public.gps_connection_status
                       else status end,
         last_error_category = null,
         last_error_message = null,
         updated_by = p_user_id
   where id = p_connection_id;
end;
$$;

comment on function public.gps_store_credential(uuid, text, text, text, uuid) is
  'Writes a provider token into Vault and bumps the connection generation. Reachable only by trusted server-side code.';

-- -----------------------------------------------------------------------------
-- Reading a credential
--
-- The narrowest function in the product: one connection in, one token out, no
-- listing, no search, no way to enumerate.
-- -----------------------------------------------------------------------------

create or replace function public.gps_read_credential(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_ref uuid;
  v_secret     text;
begin
  select c.secret_ref into v_secret_ref
  from public.gps_provider_credentials c
  join public.gps_provider_connections n on n.id = c.connection_id
  where c.connection_id = p_connection_id
    -- A connection somebody switched off cannot be used to reach the provider,
    -- whatever else is still holding a reference to it.
    and n.disabled_at is null;

  if v_secret_ref is null then
    return null;
  end if;

  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s
  where s.id = v_secret_ref;

  return v_secret;
end;
$$;

comment on function public.gps_read_credential(uuid) is
  'The single path from a connection to its plaintext token. Granted to service_role only; refuses a disabled connection.';

-- -----------------------------------------------------------------------------
-- Claiming a refresh
--
-- One agency's refresh serves every open tab. The lease is a conditional
-- UPDATE, so two tabs racing produce exactly one provider call: the loser gets
-- false back and reads the snapshot already in the database.
-- -----------------------------------------------------------------------------

create or replace function public.gps_claim_sync(
  p_connection_id uuid,
  p_min_seconds   integer default 20
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed uuid;
begin
  update public.gps_provider_connections
     set last_sync_started_at = now()
   where id = p_connection_id
     and disabled_at is null
     and (
       p_min_seconds <= 0
       or last_sync_started_at is null
       or last_sync_started_at < now() - make_interval(secs => p_min_seconds)
     )
  returning id into v_claimed;

  return v_claimed is not null;
end;
$$;

comment on function public.gps_claim_sync(uuid, integer) is
  'Atomically claims the right to talk to the provider. Coalesces concurrent refreshes across tabs and users into one call.';

-- -----------------------------------------------------------------------------
-- Disconnecting
--
-- Stops future synchronisation and destroys the secret. Devices, assignments
-- and last-known positions all survive: switching a provider off is not a
-- reason to forget which tracker was on which car.
-- -----------------------------------------------------------------------------

create or replace function public.gps_disconnect_connection(
  p_connection_id uuid,
  p_user_id       uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_ref uuid;
begin
  select c.secret_ref into v_secret_ref
  from public.gps_provider_credentials c
  where c.connection_id = p_connection_id;

  update public.gps_provider_connections
     set status = 'disabled',
         disabled_at = coalesce(disabled_at, now()),
         disabled_by = coalesce(disabled_by, p_user_id),
         -- Bumped so a synchronisation already in flight cannot write a
         -- healthy status onto a connection somebody just switched off.
         generation = generation + 1,
         updated_by = p_user_id
   where id = p_connection_id;

  if v_secret_ref is not null then
    delete from public.gps_provider_credentials where connection_id = p_connection_id;
    delete from vault.secrets where id = v_secret_ref;
  end if;
end;
$$;

comment on function public.gps_disconnect_connection(uuid, uuid) is
  'Switches a provider connection off and removes its stored credential. Devices, assignments and last-known positions are kept.';

-- -----------------------------------------------------------------------------
-- Privileges
--
-- Every one of these is server-side only. `authenticated` is not merely
-- unlikely to call them — it has no privilege to.
-- -----------------------------------------------------------------------------

revoke all on function public.gps_store_credential(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.gps_read_credential(uuid) from public, anon, authenticated;
revoke all on function public.gps_claim_sync(uuid, integer) from public, anon, authenticated;
revoke all on function public.gps_disconnect_connection(uuid, uuid) from public, anon, authenticated;

grant execute on function public.gps_store_credential(uuid, text, text, text, uuid) to service_role;
grant execute on function public.gps_read_credential(uuid) to service_role;
grant execute on function public.gps_claim_sync(uuid, integer) to service_role;
grant execute on function public.gps_disconnect_connection(uuid, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

do $$
declare
  v_reachable text;
begin
  select string_agg(name, ', ') into v_reachable
  from (
    select 'gps_store_credential' as name where has_function_privilege('authenticated', 'public.gps_store_credential(uuid, text, text, text, uuid)', 'EXECUTE')
    union all
    select 'gps_read_credential' where has_function_privilege('authenticated', 'public.gps_read_credential(uuid)', 'EXECUTE')
    union all
    select 'gps_claim_sync' where has_function_privilege('authenticated', 'public.gps_claim_sync(uuid, integer)', 'EXECUTE')
    union all
    select 'gps_disconnect_connection' where has_function_privilege('authenticated', 'public.gps_disconnect_connection(uuid, uuid)', 'EXECUTE')
  ) reachable;

  if v_reachable is not null then
    raise exception 'a signed-in user can call the credential function(s): %', v_reachable;
  end if;
end
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_count > 0 then
    raise exception 'anon can execute % callable function(s) in public', v_count;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
