# Database

`migrations/` is the source of truth for the schema. Nothing is created by hand in the
Supabase dashboard: if a table, policy or function exists, a file here created it.

## Applying the migrations

### Option A — Supabase CLI (recommended)

```bash
npm install -g supabase          # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

`db push` applies every file in `migrations/` that the project has not seen yet, in
filename order, and records them in `supabase_migrations.schema_migrations`.

### Option B — SQL editor

Open the Supabase dashboard → SQL Editor and run each file **in filename order**, one at
a time, confirming each succeeds before moving on:

1. `20260813090000_foundation.sql`
2. `20260813090100_tenancy.sql`
3. `20260813090200_authorization.sql`
4. `20260813090300_fleet.sql`
5. `20260813090400_rentals.sql`
6. `20260813090500_finance.sql`
7. `20260813090600_rls.sql`
8. `20260813090700_storage.sql`
9. `20260813090800_analytics.sql`
10. `20260814100000_foundation_hardening.sql`
11. `20260814100100_vehicle_fleet_model.sql`
12. `20260814100200_vehicle_media.sql`
13. `20260814110000_function_privileges.sql`
14. `20260814120000_customer_identity.sql`
15. `20260814120100_customer_read_models.sql`

The migrations are written to be safely re-runnable (`if not exists`, `create or replace`,
`drop policy if exists`), so a partial application can be resumed by running the rest.

## What each migration does

| File            | Contents                                                                       |
| --------------- | ------------------------------------------------------------------------------ |
| `…_foundation`  | `btree_gist`, the private `app` schema, domains, enums, shared triggers          |
| `…_tenancy`     | `profiles`, `organizations`, `organization_members`, `organization_settings`     |
| `…_authorization` | Authorization helpers, membership invariants, agency provisioning, auth triggers |
| `…_fleet`       | `vehicles`, `vehicle_documents`, `customers`                                     |
| `…_rentals`     | `rentals`, `rental_drivers`, contract numbering, the no-overlap constraint       |
| `…_finance`     | `payments`, `expenses`, `financing_plans`, `notifications`, settlement triggers  |
| `…_rls`         | Privileges and every RLS policy, plus a self-check that fails on an unprotected table |
| `…_storage`     | The private `organization-logos` bucket and its policies                         |
| `…_analytics`   | `organization_overview` and `organization_financial_series` read models          |
| `…_foundation_hardening` | Idempotent agency creation; deploy guard against RLS-bypassing views    |
| `…_vehicle_fleet_model`  | Operational-only vehicle status, the `vehicle_fleet` view, availability search |
| `…_vehicle_media`        | `vehicle_images`, the vehicle-photos and vehicle-documents buckets       |
| `…_function_privileges`  | Revokes anon EXECUTE on every public function; guards it permanently     |
| `…_customer_identity`    | `customer_documents`, customer contact/nationality fields, search indexes |
| `…_customer_read_models` | `customer_directory`, rental/financial summaries, duplicate detection, customer-documents bucket |

## Supabase project settings to check

Applying the SQL is not quite everything. In the dashboard:

- **Authentication → URL Configuration.** Set *Site URL* to your deployed origin and add
  `<origin>/auth/callback` and `<origin>/auth/reset-password` to *Redirect URLs*. Email
  confirmation and password-reset links will not work until you do.
- **Authentication → Providers → Email.** Decide whether *Confirm email* is on. The
  application handles both: with it on, sign-up leads to a "confirm your email" screen and
  the agency is already provisioned and waiting.
- **Authentication → Email templates.** The defaults work; customise the branding when
  convenient.

Nothing else needs configuring. All four storage buckets — `organization-logos`,
`vehicle-photos`, `vehicle-documents` and `customer-documents` — are created by
migrations, not by hand.

### If a storage migration is rejected

`storage.objects` is owned by `supabase_storage_admin`. The `postgres` role that runs
migrations can normally create policies on it, but if your project rejects the statement,
run `20260813090700_storage.sql` and `20260814100200_vehicle_media.sql` from the dashboard
SQL editor, which executes with the required privileges. Only file upload is affected;
everything else works without it.

## Conventions

- Tenant-scoped tables carry a `NOT NULL organization_id`.
- Money is `BIGINT` minor units in a `*_minor` column, always beside the ISO-4217 code
  the amount was recorded in. Rates are integer basis points (`*_bps`).
- Instants are `timestamptz`; calendar-only values are `date`.
- Cross-table references use composite foreign keys carrying `organization_id`, so a
  cross-tenant reference is impossible at the storage layer.
- Views are created `WITH (security_invoker = true)` so RLS applies to whoever queries
  them. `app.assert_views_are_security_invoker()` fails the deploy if one is not.
- Personal data (`customers`, `customer_documents`) carries the same RLS as everything
  else, and identification scans live in a private bucket reached only through
  short-lived signed URLs. Read models never carry document numbers.
- Derived state is never stored. A vehicle's occupancy comes from its contracts through
  `public.vehicle_fleet`; only its operational state is a column.
- Helper functions live in the private `app` schema and are not part of the PostgREST API
  surface. Anything intentionally client-callable lives in `public` and is granted to
  `authenticated` explicitly.
- Every `SECURITY DEFINER` function sets `search_path = ''` and schema-qualifies every
  identifier.

## Regenerating the TypeScript types

`src/types/database.ts` is hand-authored to match these migrations. Once the CLI is
linked you can generate it instead:

```bash
supabase gen types typescript --linked > src/types/database.ts
```

Row shapes must remain **type aliases**, not interfaces. Supabase's `GenericTable`
requires them to satisfy `Record<string, unknown>`, and TypeScript grants that implicit
index signature to object type aliases but never to interfaces — declaring them as
interfaces silently collapses every query result to `never`.

## Tests

`tests/` applies these exact migrations to a throwaway PostgreSQL instance (PGlite) and
exercises them as the `authenticated` role, so RLS is genuinely in force:

```bash
npm run test
```

`tests/support/supabase-doubles.sql` stubs the parts Supabase owns — `auth.users`,
`auth.uid()`, `storage.buckets`, `storage.objects` — and is **never** applied to a real
database.

Note that PGlite tracks a newer PostgreSQL major than Supabase currently runs. Nothing in
this schema depends on version-specific behaviour, but that is the one difference between
a passing test run and production.
