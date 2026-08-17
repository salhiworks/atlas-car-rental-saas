-- =============================================================================
-- GPS: a floor under how often one agency may reach its provider
--
-- Position refresh was already coalesced — `gps_claim_sync` collapses every open
-- tab in an agency into one provider call per window. Two other paths reach the
-- provider and had nothing in front of them:
--
--   TEST CONNECTION, which an administrator can press repeatedly, and which
--   sends a candidate token to the provider each time. Unthrottled, it is a
--   credential-testing oracle running on the agency's own account.
--
--   HISTORY, which a manager can ask for as fast as a mouse can click, each
--   click a bounded but real `messages/load_interval` against a provider that
--   rate-limits concurrent requests and bills for volume.
--
-- The mechanism is the same conditional UPDATE the sync lease uses: whoever wins
-- the race gets the row back, everybody else gets nothing and a 429 with a
-- sentence. It is server-side because a client-side throttle protects nobody —
-- the browser is the thing being throttled.
-- =============================================================================

create table if not exists public.gps_rate_limits (
  connection_id uuid not null
    references public.gps_provider_connections (id) on delete cascade,
  /* 'test' | 'history' — free text so a new provider action needs no migration. */
  action text not null check (btrim(action) <> '' and length(action) <= 32),
  last_at timestamptz not null default now(),
  /* Kept for support: "we called the provider 400 times yesterday" is a question
     somebody eventually asks, and one counter per action answers it without
     retaining who asked or what they asked about. */
  hit_count bigint not null default 1,
  primary key (connection_id, action)
);

comment on table public.gps_rate_limits is
  'Per-connection floor on how often a provider-reaching action may run. Written only by trusted server-side code.';

alter table public.gps_rate_limits enable row level security;

/*
 * This table exists for the service role alone; the browser has no reason to
 * read it and every reason not to write it.
 *
 * The deny is written twice on purpose. Revoking the grants is what actually
 * stops a Data API client; the explicit false policy states the intent in the
 * schema, so a later `grant select … to authenticated` — the kind of line that
 * gets added to fix an unrelated symptom — still hits a closed door.
 */
drop policy if exists gps_rate_limits_none on public.gps_rate_limits;
create policy gps_rate_limits_none on public.gps_rate_limits
  for all to authenticated
  using (false)
  with check (false);

revoke all on public.gps_rate_limits from public;
revoke all on public.gps_rate_limits from anon;
revoke all on public.gps_rate_limits from authenticated;
grant select, insert, update, delete on public.gps_rate_limits to service_role;

-- -----------------------------------------------------------------------------
-- The claim
-- -----------------------------------------------------------------------------

create or replace function public.gps_claim_action(
  p_connection_id uuid,
  p_action text,
  p_min_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean := false;
begin
  if p_connection_id is null or p_action is null or btrim(p_action) = '' then
    return false;
  end if;

  /*
   * One statement decides it.
   *
   * `insert … on conflict … do update … where` is atomic: two isolates racing
   * produce exactly one winner, because the loser's UPDATE matches no row once
   * the winner has moved `last_at` forward. A read-then-write would let both
   * through, which is precisely the case a rate limit exists for.
   */
  insert into public.gps_rate_limits (connection_id, action, last_at, hit_count)
  values (p_connection_id, btrim(p_action), now(), 1)
  on conflict (connection_id, action) do update
    set last_at = now(),
        hit_count = public.gps_rate_limits.hit_count + 1
    where public.gps_rate_limits.last_at
          <= now() - make_interval(secs => greatest(coalesce(p_min_seconds, 0), 0))
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function public.gps_claim_action(uuid, text, integer) is
  'Server-side floor between provider-reaching actions. True when the caller may proceed. Reachable only by trusted server-side code.';

revoke all on function public.gps_claim_action(uuid, text, integer) from public;
revoke all on function public.gps_claim_action(uuid, text, integer) from anon;
revoke all on function public.gps_claim_action(uuid, text, integer) from authenticated;
grant execute on function public.gps_claim_action(uuid, text, integer) to service_role;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

do $$
begin
  if has_function_privilege('authenticated', 'public.gps_claim_action(uuid, text, integer)', 'EXECUTE')
  then
    raise exception 'authenticated can execute gps_claim_action';
  end if;

  if has_function_privilege('anon', 'public.gps_claim_action(uuid, text, integer)', 'EXECUTE') then
    raise exception 'anon can execute gps_claim_action';
  end if;

  if has_table_privilege('authenticated', 'public.gps_rate_limits', 'SELECT') then
    raise exception 'authenticated can read gps_rate_limits';
  end if;

  if has_table_privilege('anon', 'public.gps_rate_limits', 'SELECT') then
    raise exception 'anon can read gps_rate_limits';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'gps_rate_limits' and c.relrowsecurity
  ) then
    raise exception 'gps_rate_limits does not have row level security enabled';
  end if;
end $$;
