-- =============================================================================
-- 20260821100300_frozen_provenance.sql
--
-- Deleting an Auth account left dangling foreign keys in every module.
--
-- Found by asking what the Team security review had NOT looked at. The two
-- guards fixed in 20260821100100 were the ones that RAISE on an unexpected
-- update. This is the one that does something quieter and worse:
-- app.freeze_columns() does not refuse a change, it RESTORES the previous value
-- (20260813090000_foundation.sql). A foreign key's ON DELETE SET NULL arrives as
-- an ordinary UPDATE, so on any column that is both a reference to auth.users
-- and a member of a freeze list, the referential action is silently undone —
-- and because the column then matches its old value, PostgreSQL's keys-equal
-- shortcut skips the follow-up constraint check and the DELETE commits anyway.
--
-- VERIFIED before writing this, against the real migrations:
--
--     delete from auth.users where id = <owner>;      -- succeeds, no error
--     select created_by from public.organizations ...  -- still the dead uuid
--     select created_by from public.vehicles ...       -- still the dead uuid
--
-- Fifteen columns are affected, one in almost every module that depends on
-- membership: organizations.created_by, vehicles.created_by,
-- vehicle_documents.created_by, vehicle_images.uploaded_by, customers.created_by,
-- customer_documents.created_by, rentals.created_by, rental_line_items.created_by,
-- payments.recorded_by, expenses.created_by, expense_vendors.created_by,
-- financing_plans.created_by, lenders.created_by, financing_agreements.created_by
-- and financing_payments.recorded_by.
--
-- The consequences are worse than the erasure not happening. The rows violate
-- foreign keys they still declare, so any dump-and-restore — a staging clone, a
-- point-in-time recovery, `supabase db reset` from a dump — fails when it tries
-- to recreate organizations_created_by_fkey.
--
-- THE FIX, AND WHY IT IS NOT "LET FROZEN COLUMNS BE NULLED".
--
-- Simply permitting a NULL would let any client erase attribution — precisely
-- what freezing these columns is for. The transition is allowed only when the
-- value being cleared points at an Auth account that no longer exists, which is
-- true exactly when the referential action is running and false for every client
-- update. A client nulling the provenance of a live user is still refused; a
-- client nulling the provenance of a deleted one achieves nothing that has not
-- already happened.
-- =============================================================================

set search_path = public, extensions, pg_temp;

/*
 * SECURITY DEFINER, which the original was not.
 *
 * The exception below has to ask whether an Auth account still exists, and no
 * client role may read auth.users. Left as an invoker function, an ordinary
 * member sending `created_by: null` back with a legitimate edit — which the
 * freeze exists to tolerate silently — would get "permission denied for table
 * users" and lose the whole update. Verified before this line was written.
 *
 * Nothing is granted by the change: the function only ever restores a previous
 * value or permits a NULL that a foreign key was already applying, and it reads
 * exactly one column of auth.users to decide which.
 */
create or replace function app.freeze_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_column text;
  v_new jsonb := to_jsonb(new);
  v_old jsonb := to_jsonb(old);
  v_old_value jsonb;
  v_orphaned boolean;
begin
  foreach v_column in array tg_argv loop
    -- Guard against a mistyped column name: `v_old -> v_column` would be SQL
    -- NULL, jsonb_set would return NULL for the whole document, and the trigger
    -- would silently discard the row.
    if not (v_old ? v_column) then
      raise exception 'freeze_columns: column % does not exist on %', v_column, tg_table_name;
    end if;

    v_old_value := v_old -> v_column;

    /*
     * The one change a frozen column accepts: a foreign key clearing a
     * reference to an Auth account that has just been deleted.
     *
     * Recognised by the state of the world rather than by who is asking. The
     * referential action runs while the referenced row is already gone from
     * this transaction's view, so this is true for it and false for every
     * client update — a member cannot use it to erase who recorded a payment,
     * because the person who recorded it still exists.
     *
     * Restoring the value here does not merely fail to erase: it leaves the row
     * pointing at a user that is about to disappear, and PostgreSQL then skips
     * the constraint re-check because the key did not change.
     */
    if v_new -> v_column = 'null'::jsonb
       and v_old_value <> 'null'::jsonb
       and jsonb_typeof(v_old_value) = 'string'
       and (v_old_value #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then
      select not exists (
        select 1 from auth.users u where u.id = (v_old_value #>> '{}')::uuid
      ) into v_orphaned;

      if v_orphaned then
        continue;
      end if;
    end if;

    v_new := jsonb_set(v_new, array[v_column], v_old_value, true);
  end loop;

  return jsonb_populate_record(new, v_new);
end;
$$;

comment on function app.freeze_columns() is
  'BEFORE UPDATE trigger: restores the previous value of every column named in TG_ARGV, except when a foreign key is clearing a reference to an Auth account that no longer exists — which is a referential action, not an edit, and undoing it leaves a dangling key the database will not notice.';

-- -----------------------------------------------------------------------------
-- Repair what the old behaviour already left behind
--
-- Any provenance column still pointing at an account that is gone. On this
-- project that is nothing, because no account has been deleted; it runs anyway
-- so a database that has been through an erasure comes out consistent.
-- -----------------------------------------------------------------------------

do $$
declare
  v_target record;
  v_repaired bigint := 0;
  v_count bigint;
begin
  for v_target in
    select c.relname as table_name, a.attname as column_name
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    join pg_class f on f.oid = k.confrelid
    join pg_namespace fn on fn.oid = f.relnamespace
    where k.contype = 'f'
      and n.nspname = 'public'
      and fn.nspname = 'auth'
      and f.relname = 'users'
      and k.confdeltype = 'n'          -- ON DELETE SET NULL
      and array_length(k.conkey, 1) = 1
  loop
    execute format(
      'update public.%I t set %I = null
        where t.%I is not null
          and not exists (select 1 from auth.users u where u.id = t.%I)',
      v_target.table_name, v_target.column_name, v_target.column_name, v_target.column_name
    );
    get diagnostics v_count = row_count;
    v_repaired := v_repaired + v_count;
  end loop;

  if v_repaired > 0 then
    raise notice 'Cleared % dangling references to deleted Auth accounts.', v_repaired;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Self-check
--
-- The one in 20260821100100 passed vacuously: its probe agency was inserted
-- without a `created_by`, and the only columns it exercised were unfrozen. This
-- one populates a frozen provenance column in three different modules and then
-- looks for a dangling key across EVERY such column in the schema, so it cannot
-- pass by touching the wrong rows.
-- -----------------------------------------------------------------------------

do $$
declare
  v_user     uuid;
  v_org      uuid;
  v_vehicle  uuid;
  v_customer uuid;
  v_dangling bigint := 0;
  v_target   record;
  v_count    bigint;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'freeze-probe@example.invalid')
  returning id into v_user;

  insert into public.profiles (id, full_name, email)
  values (v_user, 'Freeze Probe', 'freeze-probe@example.invalid')
  on conflict (id) do nothing;

  -- A frozen provenance column in three modules, plus the tenancy row itself.
  insert into public.organizations (name, slug, default_currency, time_zone, created_by)
  values ('Freeze Probe Agency', 'freeze-probe-' || substr(md5(random()::text), 1, 12),
          'EUR', 'UTC', v_user)
  returning id into v_org;

  insert into public.vehicles
    (organization_id, make, model, registration_plate, currency, created_by)
  values (v_org, 'Probe', 'One', 'FRZ-PROBE', 'EUR', v_user)
  returning id into v_vehicle;

  insert into public.customers (organization_id, first_name, last_name, created_by)
  values (v_org, 'Freeze', 'Probe', v_user)
  returning id into v_customer;

  insert into public.payments
    (organization_id, amount_minor, currency, paid_at, recorded_by)
  values (v_org, 1000, 'EUR', now(), v_user);

  -- A client cannot use the exception to erase provenance while the account
  -- still exists.
  update public.vehicles set created_by = null where id = v_vehicle;
  if (select created_by from public.vehicles where id = v_vehicle) is null then
    raise exception 'A frozen provenance column was cleared while its account still existed.';
  end if;

  delete from auth.users where id = v_user;

  if (select created_by from public.organizations where id = v_org) is not null then
    raise exception 'organizations.created_by survived the deletion of the account it names.';
  end if;
  if (select created_by from public.vehicles where id = v_vehicle) is not null then
    raise exception 'vehicles.created_by survived the deletion of the account it names.';
  end if;
  if (select created_by from public.customers where id = v_customer) is not null then
    raise exception 'customers.created_by survived the deletion of the account it names.';
  end if;

  -- And nothing anywhere in the schema points at an account that is gone.
  for v_target in
    select c.relname as table_name, a.attname as column_name
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    join pg_class f on f.oid = k.confrelid
    join pg_namespace fn on fn.oid = f.relnamespace
    where k.contype = 'f' and n.nspname = 'public'
      and fn.nspname = 'auth' and f.relname = 'users'
      and array_length(k.conkey, 1) = 1
  loop
    execute format(
      'select count(*) from public.%I t
        where t.%I is not null
          and not exists (select 1 from auth.users u where u.id = t.%I)',
      v_target.table_name, v_target.column_name, v_target.column_name
    ) into v_count;
    v_dangling := v_dangling + v_count;
  end loop;

  if v_dangling > 0 then
    raise exception '% references to deleted Auth accounts survived.', v_dangling;
  end if;

  delete from public.organizations where id = v_org;
end
$$;
