-- =============================================================================
-- 20260813090600_rls.sql
--
-- Row Level Security and table privileges.
--
-- Two independent layers, both required:
--
--   1. GRANTs decide which *operations* a Postgres role may attempt. `anon` is
--      stripped of everything: an unauthenticated request cannot read a single
--      byte of tenant data even if a policy were misdrafted. This matters
--      because Supabase's default privileges grant ALL on new public tables to
--      anon, authenticated and service_role — a default this file overrides.
--
--   2. POLICIES decide which *rows* an authenticated user sees, always through
--      the helpers in the authorization migration. No policy re-derives tenancy
--      by hand, so there is exactly one place to audit.
--
-- The permission matrix (minimum role required):
--
--   resource            select    insert    update    delete
--   ------------------  --------  --------  --------  --------
--   organizations       member    —         admin     —
--   organization_...    member    admin     admin     admin
--   profiles            self/peer self      self      —
--   vehicles            member    manager   manager   admin
--   vehicle_documents   member    manager   manager   admin
--   customers           member    staff     staff     manager
--   rentals             member    staff     staff     manager
--   rental_drivers      member    staff     staff     staff
--   payments            member    staff     manager   admin
--   expenses            member    manager   manager   admin
--   financing_plans     manager   admin     admin     owner
--   notifications       addressee manager   addressee admin
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

revoke all on table
  public.profiles,
  public.organizations,
  public.organization_members,
  public.organization_settings,
  public.vehicles,
  public.vehicle_documents,
  public.customers,
  public.rentals,
  public.rental_drivers,
  public.payments,
  public.expenses,
  public.financing_plans,
  public.notifications
from anon, authenticated;

-- Organizations are created through public.create_organization() and are never
-- deleted from the client, so neither privilege is granted at all.
grant select, update on table public.organizations to authenticated;
grant select, update on table public.organization_settings to authenticated;
grant select, insert, update, delete on table public.organization_members to authenticated;
grant select, insert, update on table public.profiles to authenticated;

grant select, insert, update, delete on table public.vehicles to authenticated;
grant select, insert, update, delete on table public.vehicle_documents to authenticated;
grant select, insert, update, delete on table public.customers to authenticated;
grant select, insert, update, delete on table public.rentals to authenticated;
grant select, insert, update, delete on table public.rental_drivers to authenticated;
grant select, insert, update, delete on table public.payments to authenticated;
grant select, insert, update, delete on table public.expenses to authenticated;
grant select, insert, update, delete on table public.financing_plans to authenticated;
grant select, insert, update, delete on table public.notifications to authenticated;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere
-- -----------------------------------------------------------------------------

alter table public.profiles              enable row level security;
alter table public.organizations         enable row level security;
alter table public.organization_members  enable row level security;
alter table public.organization_settings enable row level security;
alter table public.vehicles              enable row level security;
alter table public.vehicle_documents     enable row level security;
alter table public.customers             enable row level security;
alter table public.rentals               enable row level security;
alter table public.rental_drivers        enable row level security;
alter table public.payments              enable row level security;
alter table public.expenses              enable row level security;
alter table public.financing_plans       enable row level security;
alter table public.notifications         enable row level security;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or app.shares_organization_with(id));

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (app.is_org_member(id));

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update to authenticated
  using (app.has_min_role(id, 'admin'))
  with check (app.has_min_role(id, 'admin'));

-- -----------------------------------------------------------------------------
-- organization_members
--
-- Additional invariants (owner-only owner management, last-owner protection,
-- no self-promotion) are enforced by app.guard_membership_changes().
-- -----------------------------------------------------------------------------

drop policy if exists organization_members_select on public.organization_members;
create policy organization_members_select on public.organization_members
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists organization_members_insert on public.organization_members;
create policy organization_members_insert on public.organization_members
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists organization_members_update on public.organization_members;
create policy organization_members_update on public.organization_members
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists organization_members_delete on public.organization_members;
create policy organization_members_delete on public.organization_members
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

-- -----------------------------------------------------------------------------
-- organization_settings
-- -----------------------------------------------------------------------------

drop policy if exists organization_settings_select on public.organization_settings;
create policy organization_settings_select on public.organization_settings
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists organization_settings_update on public.organization_settings;
create policy organization_settings_update on public.organization_settings
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

-- -----------------------------------------------------------------------------
-- vehicles
-- -----------------------------------------------------------------------------

drop policy if exists vehicles_select on public.vehicles;
create policy vehicles_select on public.vehicles
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists vehicles_insert on public.vehicles;
create policy vehicles_insert on public.vehicles
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists vehicles_update on public.vehicles;
create policy vehicles_update on public.vehicles
  for update to authenticated
  using (app.has_min_role(organization_id, 'manager'))
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists vehicles_delete on public.vehicles;
create policy vehicles_delete on public.vehicles
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

-- -----------------------------------------------------------------------------
-- vehicle_documents
-- -----------------------------------------------------------------------------

drop policy if exists vehicle_documents_select on public.vehicle_documents;
create policy vehicle_documents_select on public.vehicle_documents
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists vehicle_documents_insert on public.vehicle_documents;
create policy vehicle_documents_insert on public.vehicle_documents
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists vehicle_documents_update on public.vehicle_documents;
create policy vehicle_documents_update on public.vehicle_documents
  for update to authenticated
  using (app.has_min_role(organization_id, 'manager'))
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists vehicle_documents_delete on public.vehicle_documents;
create policy vehicle_documents_delete on public.vehicle_documents
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

-- -----------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers
  for update to authenticated
  using (app.has_min_role(organization_id, 'staff'))
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists customers_delete on public.customers;
create policy customers_delete on public.customers
  for delete to authenticated
  using (app.has_min_role(organization_id, 'manager'));

-- -----------------------------------------------------------------------------
-- rentals
-- -----------------------------------------------------------------------------

drop policy if exists rentals_select on public.rentals;
create policy rentals_select on public.rentals
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists rentals_insert on public.rentals;
create policy rentals_insert on public.rentals
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rentals_update on public.rentals;
create policy rentals_update on public.rentals
  for update to authenticated
  using (app.has_min_role(organization_id, 'staff'))
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rentals_delete on public.rentals;
create policy rentals_delete on public.rentals
  for delete to authenticated
  using (app.has_min_role(organization_id, 'manager'));

-- -----------------------------------------------------------------------------
-- rental_drivers
-- -----------------------------------------------------------------------------

drop policy if exists rental_drivers_select on public.rental_drivers;
create policy rental_drivers_select on public.rental_drivers
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists rental_drivers_insert on public.rental_drivers;
create policy rental_drivers_insert on public.rental_drivers
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rental_drivers_update on public.rental_drivers;
create policy rental_drivers_update on public.rental_drivers
  for update to authenticated
  using (app.has_min_role(organization_id, 'staff'))
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists rental_drivers_delete on public.rental_drivers;
create policy rental_drivers_delete on public.rental_drivers
  for delete to authenticated
  using (app.has_min_role(organization_id, 'staff'));

-- -----------------------------------------------------------------------------
-- payments
--
-- Front-desk staff may record a payment; correcting or removing one is a
-- higher-trust action because it rewrites the agency's books.
-- -----------------------------------------------------------------------------

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'staff'));

drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments
  for update to authenticated
  using (app.has_min_role(organization_id, 'manager'))
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists payments_delete on public.payments;
create policy payments_delete on public.payments
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

-- -----------------------------------------------------------------------------
-- expenses
-- -----------------------------------------------------------------------------

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated
  using (app.is_org_member(organization_id));

drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses
  for update to authenticated
  using (app.has_min_role(organization_id, 'manager'))
  with check (app.has_min_role(organization_id, 'manager'));

drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

-- -----------------------------------------------------------------------------
-- financing_plans
--
-- Financing terms are commercially sensitive: visibility itself starts at
-- manager, not at membership.
-- -----------------------------------------------------------------------------

drop policy if exists financing_plans_select on public.financing_plans;
create policy financing_plans_select on public.financing_plans
  for select to authenticated
  using (app.has_min_role(organization_id, 'manager'));

drop policy if exists financing_plans_insert on public.financing_plans;
create policy financing_plans_insert on public.financing_plans
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_plans_update on public.financing_plans;
create policy financing_plans_update on public.financing_plans
  for update to authenticated
  using (app.has_min_role(organization_id, 'admin'))
  with check (app.has_min_role(organization_id, 'admin'));

drop policy if exists financing_plans_delete on public.financing_plans;
create policy financing_plans_delete on public.financing_plans
  for delete to authenticated
  using (app.has_min_role(organization_id, 'owner'));

-- -----------------------------------------------------------------------------
-- notifications
--
-- A row addressed to one member (user_id) is visible only to that member;
-- user_id IS NULL addresses the whole agency.
-- -----------------------------------------------------------------------------

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (
    app.is_org_member(organization_id)
    and (user_id is null or user_id = (select auth.uid()))
  );

drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications
  for insert to authenticated
  with check (app.has_min_role(organization_id, 'manager'));

-- Marking as read is the only client-side mutation this table needs.
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (
    app.is_org_member(organization_id)
    and (user_id is null or user_id = (select auth.uid()))
  )
  with check (
    app.is_org_member(organization_id)
    and (user_id is null or user_id = (select auth.uid()))
  );

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated
  using (app.has_min_role(organization_id, 'admin'));

-- -----------------------------------------------------------------------------
-- Self-check
--
-- Fails the migration rather than shipping a table that is reachable but
-- unprotected. This runs on every deploy, so a future migration that adds a
-- table and forgets its policies cannot reach production silently.
-- -----------------------------------------------------------------------------

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
    and not c.relrowsecurity;

  if v_unprotected is not null then
    raise exception 'Row Level Security is not enabled on: %', v_unprotected;
  end if;

  select string_agg(c.relname, ', ' order by c.relname)
    into v_unprotected
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

  if v_unprotected is not null then
    raise exception 'Row Level Security is enabled but no policy exists on: %', v_unprotected;
  end if;
end
$$;
