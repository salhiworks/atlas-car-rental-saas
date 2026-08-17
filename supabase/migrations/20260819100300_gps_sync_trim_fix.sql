-- =============================================================================
-- GPS: the synchronisation log was not actually being trimmed
--
-- `app.trim_gps_sync_runs()` was attached as a STATEMENT-level trigger while its
-- body read `new.connection_id`. In a statement-level trigger `NEW` is not
-- assigned, so that expression evaluated to NULL, the DELETE matched
-- `connection_id = NULL` — which matches nothing — and every run ever recorded
-- stayed on the table.
--
-- It failed silently, which is the worst way for a retention rule to fail: no
-- error, no warning, and a table that grows by one row per refresh per agency
-- for as long as the product runs. Verified against the live project: seventy
-- inserted runs left seventy rows behind, and the row cap of fifty had never
-- once been applied.
--
-- The fix uses a transition table. That keeps the trigger statement-level — so a
-- bulk insert trims once rather than once per row — and gives the function a
-- real set of touched connections to work from instead of a NULL.
-- =============================================================================

create or replace function app.trim_gps_sync_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  /*
   * Bounded observability, not an archive.
   *
   * Fifty attempts per connection is enough to tell "the provider is down" from
   * "our credential is wrong" from "nothing has run since Tuesday", and few
   * enough that the table stays a diagnostic rather than becoming a second,
   * accidental telemetry store.
   *
   * `started_at desc, id desc` rather than `started_at desc` alone: two runs
   * recorded in the same millisecond would otherwise have no defined order, and
   * the fiftieth and fifty-first rows could swap on every evaluation.
   */
  delete from public.gps_sync_runs r
  using (select distinct i.connection_id from inserted i) as touched
  where r.connection_id = touched.connection_id
    and r.id not in (
      select k.id
      from public.gps_sync_runs k
      where k.connection_id = touched.connection_id
      order by k.started_at desc, k.id desc
      limit 50
    );

  return null;
end;
$$;

comment on function app.trim_gps_sync_runs() is
  'Keeps the most recent 50 synchronisation attempts per connection. Statement-level, driven by a transition table so a bulk insert trims once.';

drop trigger if exists gps_sync_runs_trim on public.gps_sync_runs;
create trigger gps_sync_runs_trim
  after insert on public.gps_sync_runs
  referencing new table as inserted
  for each statement execute function app.trim_gps_sync_runs();

-- -----------------------------------------------------------------------------
-- Self-check: the trigger has the transition table its function depends on
--
-- The original bug was invisible at rest — the trigger existed, the function
-- existed, and the two were incompatible. This asserts the shape rather than the
-- presence, so the same mistake cannot be reintroduced quietly.
-- -----------------------------------------------------------------------------

do $$
declare
  v_transition text;
begin
  select t.tgnewtable into v_transition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'gps_sync_runs'
    and t.tgname = 'gps_sync_runs_trim';

  if v_transition is distinct from 'inserted' then
    raise exception
      'gps_sync_runs_trim must expose a NEW TABLE named "inserted"; found %',
      coalesce(v_transition, '<none>');
  end if;
end $$;
