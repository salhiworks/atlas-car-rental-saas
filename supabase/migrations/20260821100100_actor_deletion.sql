-- =============================================================================
-- 20260821100100_actor_deletion.sql
--
-- Deleting an Auth account is a referential action, not an edit.
--
-- Found while the Team module's own live cleanup refused to remove its fixtures.
-- Two guards in this schema block a foreign key's ON DELETE SET NULL, because
-- that referential action arrives as an ordinary UPDATE and both guards refuse
-- ordinary updates. The effect is not "the record is protected" — it is that
-- an Auth account becomes permanently undeletable the moment its holder voids a
-- cost, and a product that cannot delete an account cannot honour an erasure
-- request.
--
--   1. app.guard_expense_void() refuses every update to a voided expense. A
--      voided cost carries `voided_by`, which references auth.users ON DELETE
--      SET NULL, so anybody who has ever voided anything is undeletable.
--
--   2. app.team_events_are_immutable() refused every delete. team events
--      reference their organization ON DELETE CASCADE, so an AGENCY became
--      undeletable the moment anything happened to its team — which is worse
--      than the first, because agency deletion is an ordinary operation.
--
-- Neither guard loses anything. A voided expense stays a voided expense with
-- every figure it had; the only column that moves is the reference to an
-- account that no longer exists. A team event keeps the actor's name, the
-- target's name, the address and both roles, all snapshotted as text at the
-- time precisely so the record outlives the accounts it names.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- 1. A voided expense survives the deletion of the person who voided it
-- -----------------------------------------------------------------------------

create or replace function app.guard_expense_void()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'voided' then
    /*
     * The one update a voided cost accepts: a foreign key nulling its reference
     * to a deleted Auth account.
     *
     * Recognised by comparing the WHOLE ROW rather than a list of columns.
     * A list is a maintenance trap — the next column added to `expenses` would
     * silently become editable on a voided cost, which is exactly the guarantee
     * this guard exists to make. Everything except the three provenance
     * references to auth.users (and the timestamp a sibling trigger stamps) must
     * be byte-identical, and each of those three may only move to NULL.
     *
     * A client cannot construct this. It would have to leave every meaningful
     * column untouched and null a provenance field, which gains nothing, and
     * the RLS policy on `expenses` refuses it before the trigger is reached.
     */
    if (to_jsonb(new) - 'voided_by' - 'created_by' - 'updated_by' - 'updated_at')
         = (to_jsonb(old) - 'voided_by' - 'created_by' - 'updated_by' - 'updated_at')
       and (new.voided_by  is null or new.voided_by  is not distinct from old.voided_by)
       and (new.created_by is null or new.created_by is not distinct from old.created_by)
       and (new.updated_by is null or new.updated_by is not distinct from old.updated_by)
       and (new.voided_by, new.created_by, new.updated_by)
             is distinct from (old.voided_by, old.created_by, old.updated_by)
    then
      return new;
    end if;

    if new.status <> 'voided' then
      raise exception 'A voided expense cannot be reinstated. Record a new one.'
        using errcode = '23514';
    end if;

    -- Nothing about a voided cost is editable. It is the record of a
    -- correction, and a record that can be rewritten records nothing.
    raise exception 'A voided expense is kept exactly as it was. Record a new cost instead.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function app.guard_expense_void() is
  'Refuses every update to a voided expense except a foreign key nulling its reference to a deleted Auth account. The transition into voided is not affected: that update sees a recorded row.';

-- -----------------------------------------------------------------------------
-- 2. Team history goes when its agency goes
-- -----------------------------------------------------------------------------

create or replace function app.team_events_are_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    /*
     * Only as part of its agency disappearing.
     *
     * `organization_id` references organizations ON DELETE CASCADE, and the
     * cascade reaches this table after the parent row is already gone from this
     * transaction's view — so "the owning organization no longer exists" is a
     * reliable discriminator, and one no client can manufacture: nothing in this
     * schema grants DELETE on organizations to any browser role.
     */
    if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
      return old;
    end if;

    raise exception 'Team history cannot be deleted once written.'
      using errcode = '42501';
  end if;

  /*
   * The one update: a foreign key nulling a reference to a row that has gone.
   *
   * Three columns can be nulled this way and they are exactly the three that
   * reference something outside this table — the actor, the target, and the
   * invitation an event was about. Each is ON DELETE SET NULL, so refusing the
   * action does not protect the history, it makes the referenced row
   * undeletable: an Auth account, or an invitation that has been superseded.
   *
   * Compared as a whole row minus those three, for the same reason as above —
   * everything the history actually SAYS is snapshotted text, and a column added
   * later must not quietly become editable.
   */
  if (to_jsonb(new) - 'actor_user_id' - 'target_user_id' - 'invitation_id')
       = (to_jsonb(old) - 'actor_user_id' - 'target_user_id' - 'invitation_id')
     and (new.actor_user_id  is null or new.actor_user_id  is not distinct from old.actor_user_id)
     and (new.target_user_id is null or new.target_user_id is not distinct from old.target_user_id)
     and (new.invitation_id  is null or new.invitation_id  is not distinct from old.invitation_id)
     and (new.actor_user_id, new.target_user_id, new.invitation_id)
           is distinct from (old.actor_user_id, old.target_user_id, old.invitation_id)
  then
    return new;
  end if;

  raise exception 'Team history cannot be updated once written.'
    using errcode = '42501';
end;
$$;

comment on function app.team_events_are_immutable() is
  'Refuses every write to a team event except the two referential actions: a foreign key nulling a deleted account, and the cascade that removes history with the agency it belongs to.';

-- -----------------------------------------------------------------------------
-- Self-check: an agency with team history, and an account that voided a cost,
-- are both genuinely deletable.
-- -----------------------------------------------------------------------------

do $$
declare
  v_org      uuid;
  v_user     uuid;
  v_category uuid;
  v_expense  uuid;
begin
  insert into auth.users (id, email) values (gen_random_uuid(), 'deletion-probe@example.invalid')
  returning id into v_user;

  insert into public.organizations (name, slug, default_currency, time_zone)
  values ('Deletion Probe', 'deletion-probe-' || substr(md5(random()::text), 1, 12), 'EUR', 'UTC')
  returning id into v_org;

  insert into public.organization_team_events
    (organization_id, event, actor_user_id, actor_name, target_user_id, target_name, new_role)
  values (v_org, 'role_changed', v_user, 'Probe Actor', v_user, 'Probe Target', 'manager');

  select id into v_category
  from public.expense_categories where organization_id = v_org and system_key = 'office';

  insert into public.expenses
    (organization_id, category_id, allocation, amount_minor, currency, incurred_on,
     status, voided_at, voided_by, void_reason)
  values (v_org, v_category, 'overhead', 5000, 'EUR', current_date,
          'voided', now(), v_user, 'Probe')
  returning id into v_expense;

  -- The account goes, and takes nothing legible with it.
  delete from auth.users where id = v_user;

  if (select voided_at from public.expenses where id = v_expense) is null then
    raise exception 'Deleting an account erased when a cost was voided.';
  end if;
  if (select actor_name from public.organization_team_events where organization_id = v_org) <> 'Probe Actor' then
    raise exception 'Deleting an account erased who acted.';
  end if;

  -- And the agency goes, history with it.
  delete from public.organizations where id = v_org;

  if exists (select 1 from public.organization_team_events where organization_id = v_org) then
    raise exception 'Team history outlived the agency it belonged to.';
  end if;
end
$$;
