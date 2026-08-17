-- =============================================================================
-- 20260817100200_expense_audit_and_vendors.sql
--
-- Two corrections to the expense domain, both made before any interface was
-- built on top of them.
--
-- 1. A SUPPLIER NAME IS NOT AN IDENTIFIER
--
-- The first cut refused a second supplier whose name normalised to one already
-- on file. That is not a real invariant. A chain has branches — "Total" on the
-- ring road and "Total" at the airport are two accounts, two contacts and two
-- sets of invoices — and two unrelated businesses can share a trading name. A
-- hard refusal there blocks a legitimate record and teaches staff to type
-- "Total 2", which is worse than the duplicate it prevented.
--
-- What IS an identifier is a tax or business registration number: that names
-- one legal entity by construction. So the name becomes a search key and a
-- warning signal, and only the tax identifier is enforced as unique.
--
-- 2. WHO CHANGED THIS FIGURE, AND WHAT WAS IT BEFORE
--
-- Managers may correct a recorded cost — forcing a void and re-entry for a
-- transposed digit produces worse records, not better ones. But `updated_by`
-- and `updated_at` say only that something changed, not what it was. A cost
-- edited from 1,200 to 12,000 leaves no trace of the 1,200.
--
-- So material changes write an immutable event: what changed, from what, to
-- what, by whom, when. Deliberately not a generic audit framework — nine
-- columns are watched, one row is written per edit, and nothing else in the
-- product may write to it.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Vendors: name identifies nothing, tax identifier identifies an entity
-- -----------------------------------------------------------------------------

drop index if exists public.expense_vendors_name_unique_idx;

-- Kept, and no longer unique: this is what search and duplicate warnings read.
create index if not exists expense_vendors_name_normalized_idx
  on public.expense_vendors (organization_id, name_normalized);

-- A tax or business registration number does name one entity. Two vendor rows
-- carrying the same one are the same supplier entered twice.
create unique index if not exists expense_vendors_tax_identifier_unique_idx
  on public.expense_vendors (organization_id, upper(btrim(tax_identifier)))
  where tax_identifier is not null and btrim(tax_identifier) <> '';

comment on index public.expense_vendors_tax_identifier_unique_idx is
  'A tax identifier names one legal entity, so it is enforced. A display name does not, so it is not.';

/**
 * Suppliers that look like the one being entered.
 *
 * Warns; never merges and never refuses. Archived suppliers are included on
 * purpose — the commonest cause of a duplicate is somebody re-creating a
 * supplier that was retired rather than restoring it, and the interface can
 * only offer to restore what it can see.
 */
create or replace function public.find_duplicate_vendors(
  p_organization_id uuid,
  p_name text,
  p_tax_identifier text default null,
  p_exclude_vendor_id uuid default null
)
returns table (
  vendor_id      uuid,
  name           text,
  archived_at    timestamptz,
  match_reason   text,
  match_strength text
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_name text := upper(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  v_tax  text := upper(btrim(coalesce(p_tax_identifier, '')));
begin
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select v.id, v.name, v.archived_at,
           'Same tax or business ID' as reason, 'strong' as strength
    from public.expense_vendors v
    where v.organization_id = p_organization_id
      and v_tax <> ''
      and upper(btrim(v.tax_identifier)) = v_tax

    union all

    select v.id, v.name, v.archived_at,
           case when v.archived_at is null
                then 'Same name'
                else 'Same name, currently retired' end,
           'weak'
    from public.expense_vendors v
    where v.organization_id = p_organization_id
      and v_name <> ''
      and v.name_normalized = v_name
  )
  select candidates.id, candidates.name, candidates.archived_at,
         string_agg(distinct candidates.reason, ', '),
         case when bool_or(candidates.strength = 'strong') then 'strong' else 'weak' end
  from candidates
  where p_exclude_vendor_id is null or candidates.id <> p_exclude_vendor_id
  group by 1, 2, 3
  order by 5 desc, 2
  limit 10;
end;
$$;

-- -----------------------------------------------------------------------------
-- The change history
--
-- One row per edit that moved something financially material. Written by a
-- trigger, never by the application: there is no INSERT grant, no UPDATE grant
-- and no DELETE grant for `authenticated` on this table, so a record of a
-- change cannot be edited away by whoever made it.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'expense_change_kind' and typnamespace = 'public'::regnamespace
  ) then
    -- A correction and a void are different acts and must stay distinguishable.
    create type public.expense_change_kind as enum ('correction', 'void');
  end if;
end
$$;

create table if not exists public.expense_change_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  expense_id      uuid not null,

  kind public.expense_change_kind not null default 'correction',

  /**
   * `{ "amount_minor": { "from": 120000, "to": 12000 }, … }`
   *
   * One object rather than a row per field: an edit is one act, and splitting
   * it would make "what did this correction do" a join instead of a read.
   */
  changes jsonb not null,

  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  reason     text check (reason is null or char_length(reason) <= 500),

  constraint expense_change_events_expense_fkey
    foreign key (expense_id, organization_id)
    references public.expenses (id, organization_id)
    on delete cascade
);

comment on table public.expense_change_events is
  'What a correction changed, from what, to what, by whom and when. Written only by a trigger; the application cannot insert, edit or delete a row here.';

create index if not exists expense_change_events_expense_idx
  on public.expense_change_events (expense_id, changed_at desc);

create index if not exists expense_change_events_organization_idx
  on public.expense_change_events (organization_id, changed_at desc);

/**
 * Records a material change.
 *
 * Nine columns are watched. Description, notes, reference and the odometer are
 * deliberately not among them: correcting a typo in a description is not a
 * financial event, and logging it would bury the edits that are.
 */
create or replace function app.record_expense_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_kind    public.expense_change_kind := 'correction';
begin
  if new.status = 'voided' and old.status <> 'voided' then
    v_kind := 'void';
    v_changes := jsonb_build_object(
      'status', jsonb_build_object('from', old.status::text, 'to', new.status::text)
    );
  else
    if new.amount_minor is distinct from old.amount_minor then
      v_changes := v_changes || jsonb_build_object(
        'amount_minor', jsonb_build_object('from', old.amount_minor, 'to', new.amount_minor));
    end if;
    if new.tax_amount_minor is distinct from old.tax_amount_minor then
      v_changes := v_changes || jsonb_build_object(
        'tax_amount_minor', jsonb_build_object('from', old.tax_amount_minor, 'to', new.tax_amount_minor));
    end if;
    if new.currency is distinct from old.currency then
      v_changes := v_changes || jsonb_build_object(
        'currency', jsonb_build_object('from', old.currency, 'to', new.currency));
    end if;
    if new.incurred_on is distinct from old.incurred_on then
      v_changes := v_changes || jsonb_build_object(
        'incurred_on', jsonb_build_object('from', old.incurred_on, 'to', new.incurred_on));
    end if;
    if new.allocation is distinct from old.allocation then
      v_changes := v_changes || jsonb_build_object(
        'allocation', jsonb_build_object('from', old.allocation::text, 'to', new.allocation::text));
    end if;
    if new.vehicle_id is distinct from old.vehicle_id then
      v_changes := v_changes || jsonb_build_object(
        'vehicle_id', jsonb_build_object('from', old.vehicle_id, 'to', new.vehicle_id));
    end if;
    if new.rental_id is distinct from old.rental_id then
      v_changes := v_changes || jsonb_build_object(
        'rental_id', jsonb_build_object('from', old.rental_id, 'to', new.rental_id));
    end if;
    if new.category_id is distinct from old.category_id then
      v_changes := v_changes || jsonb_build_object(
        'category_id', jsonb_build_object('from', old.category_id, 'to', new.category_id));
    end if;
    if new.vendor_id is distinct from old.vendor_id then
      v_changes := v_changes || jsonb_build_object(
        'vendor_id', jsonb_build_object('from', old.vendor_id, 'to', new.vendor_id));
    end if;
  end if;

  -- Nothing material moved, so there is nothing worth recording.
  if v_changes = '{}'::jsonb then
    return null;
  end if;

  insert into public.expense_change_events
    (organization_id, expense_id, kind, changes, changed_by, reason)
  values (
    new.organization_id,
    new.id,
    v_kind,
    v_changes,
    coalesce(new.updated_by, (select auth.uid())),
    case when v_kind = 'void' then new.void_reason else null end
  );

  return null;
end;
$$;

drop trigger if exists expenses_record_change on public.expenses;
create trigger expenses_record_change
  after update on public.expenses
  for each row execute function app.record_expense_change();

-- -----------------------------------------------------------------------------
-- Privileges
--
-- Read only. The trigger writes as definer; nobody else writes at all, which is
-- what makes the history worth having.
-- -----------------------------------------------------------------------------

revoke all on table public.expense_change_events from anon, authenticated;
grant select on table public.expense_change_events to authenticated;

alter table public.expense_change_events enable row level security;

drop policy if exists expense_change_events_select on public.expense_change_events;
create policy expense_change_events_select on public.expense_change_events
  for select to authenticated
  using (app.is_org_member(organization_id));

revoke all on function public.find_duplicate_vendors(uuid, text, text, uuid) from public, anon;
grant execute on function public.find_duplicate_vendors(uuid, text, text, uuid) to authenticated;

revoke all on all functions in schema public from anon;
revoke all on all routines in schema public from anon;

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
    raise exception 'The anonymous role can execute these public functions: %.', v_reachable;
  end if;
end
$$;

do $$
declare
  v_unprotected text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and (not c.relrowsecurity
         or not exists (select 1 from pg_policy p where p.polrelid = c.oid));

  if v_unprotected is not null then
    raise exception 'Row Level Security is missing or unpoliced on: %', v_unprotected;
  end if;
end
$$;
