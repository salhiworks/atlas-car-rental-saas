-- =============================================================================
-- 20260821100400_schema_reconciliation.sql
--
-- Forward-only reconciliation between what this repository declares and what the
-- live project actually has, plus a deploy-time guard over the two corrections
-- that were made late in the Team review.
--
-- WHY THIS EXISTS
--
-- Four Team migrations were applied and then edited locally, and the edits were
-- re-applied by reverting the migration-history record and pushing again. That
-- works, and this project's own test harness rebuilds the schema from every
-- migration on every run so the result is continuously exercised — but it is not
-- a practice to keep. From here corrections go forward, in new migrations, and
-- the applied files are left alone.
--
-- Before writing this, the live project was compared against a clean replay of
-- all 44 local migrations, object by object rather than by reading the files:
-- 28 function definitions (body, SECURITY DEFINER flag and search_path),
-- 933 columns, 443 constraints, 97 policies, 76 triggers, 417 table grants,
-- 153 function privileges, 44 enums, 9 views and 151 indexes.
--
-- Everything matched except ONE index, and it is not from the Team module:
--
--     rentals_schedule_range_idx
--
-- declared in 20260816100000_scheduling.sql, absent from the live database. The
-- statement there is an unconditional `create index if not exists` and the
-- migration is recorded as applied, so the file was edited after it was applied
-- — the same practice, in an earlier session, on the Calendar module. Its
-- absence costs correctness nothing and costs the Calendar its range-index
-- probe: "every booking overlapping this window" falls back to a filter.
--
-- (A count difference in pg_constraint between the two — 443 against 761 — is
-- PostgreSQL 18 recording NOT NULL as catalogue rows where 17.6 does not. The
-- 443 real check, foreign key, primary key, unique and exclusion constraints are
-- identical on both.)
--
-- WHAT THIS FILE DOES NOT DO
--
-- It does not restate the invitation functions. Their definitions are already
-- live and byte-identical to a clean replay, and a second copy of 450 lines of
-- domain logic in a "corrective" migration is a worse hazard than the thing it
-- would correct: two definitions that can silently disagree. The two late
-- corrections are pinned by assertion instead — read out of the deployed
-- catalogue, so this migration fails loudly on any database that does not have
-- them rather than quietly overwriting whatever is there.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- The missing index
--
-- Idempotent, so a clean rebuild — where 20260816100000 already created it —
-- passes straight through this.
-- -----------------------------------------------------------------------------

create index if not exists rentals_schedule_range_idx
  on public.rentals using gist (organization_id, tstzrange(starts_at, ends_at, '[)'));

comment on index public.rentals_schedule_range_idx is
  'Supports the Calendar''s "everything overlapping this window" query.';

-- -----------------------------------------------------------------------------
-- Guard 1 — the invitation lock order
--
-- Every function that decides a membership question for one agency takes the
-- per-agency advisory lock, and takes it BEFORE it locks any row. Two of them
-- did not: `resend` and `accept` locked the invitation row first and then asked
-- for the agency lock, while `create` did the reverse. A create racing a resend
-- on one agency would then each hold what the other was waiting for, and
-- PostgreSQL would resolve it by aborting one with a deadlock.
--
-- Asserted against `prosrc` — the source of the function that is actually
-- deployed — rather than against a copy of it kept here.
-- -----------------------------------------------------------------------------

do $$
declare
  v_fn        text;
  v_body      text;
  v_advisory  integer;
  v_row_lock  integer;
begin
  foreach v_fn in array array[
    'create_team_invitation', 'resend_team_invitation', 'accept_team_invitation'
  ] loop
    select p.prosrc into v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if v_body is null then
      raise exception 'public.% is missing.', v_fn;
    end if;

    v_advisory := position('lock_organization_membership' in v_body);
    v_row_lock := position('for update' in v_body);

    if v_advisory = 0 then
      raise exception
        'public.% does not take the per-agency membership lock.', v_fn;
    end if;
    if v_row_lock = 0 then
      raise exception 'public.% no longer locks the row it decides on.', v_fn;
    end if;
    if v_advisory > v_row_lock then
      raise exception
        'public.% locks a row before taking the agency lock. Every invitation path must use one order, or a create racing a resend deadlocks.',
        v_fn;
    end if;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Guard 2 — freeze_columns can ask whether an account still exists
--
-- The exception that lets a foreign key's ON DELETE SET NULL through has to read
-- auth.users, and no client role may. Left as a SECURITY INVOKER function, an
-- ordinary member echoing `created_by: null` back with a legitimate edit — which
-- the freeze exists to tolerate silently — got "permission denied for table
-- users" and lost the whole update.
--
-- The explicit empty search_path is asserted with it: a SECURITY DEFINER trigger
-- without one is the search-path hijack this schema has avoided everywhere else.
-- -----------------------------------------------------------------------------

do $$
declare
  v_definer boolean;
  v_config  text;
begin
  select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '')
    into v_definer, v_config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname = 'freeze_columns';

  if v_definer is null then
    raise exception 'app.freeze_columns is missing.';
  end if;
  if not v_definer then
    raise exception
      'app.freeze_columns is SECURITY INVOKER; its auth.users lookup will refuse every client update that echoes a frozen column.';
  end if;
  if v_config not like '%search_path=%' then
    raise exception
      'app.freeze_columns is SECURITY DEFINER without an explicit search_path.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Guard 3 — nothing above widened the client surface
--
-- Both guards above are assertions about internals; these are the two facts a
-- reader of this file would actually worry about.
-- -----------------------------------------------------------------------------

do $$
declare
  v_offenders text;
begin
  select string_agg(p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'The anonymous role can execute these public functions: %.', v_offenders;
  end if;

  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ')
    into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and (
      (table_name = 'organization_members' and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))
      or table_name in ('organization_invitations', 'organization_team_events')
    );

  if v_offenders is not null then
    raise exception 'Membership tables are directly writable by a client role: %.', v_offenders;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
