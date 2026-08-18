# Database

`migrations/` is the source of truth for the schema. Nothing is created by hand in the
Supabase dashboard: if a table, policy or function exists, a file here created it.

## Setting up a fresh project

1. **Create a project.** Atlas does not create one for you —
   [Supabase dashboard](https://supabase.com/dashboard) → New project. Note its project
   ref (the subdomain in `https://<ref>.supabase.co`).
2. **Link and push the schema:**

   ```bash
   npm install -g supabase          # or: brew install supabase/tap/supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   `db push` applies all 53 files in `migrations/`, in filename order, and records them in
   `supabase_migrations.schema_migrations`. Confirm everything landed with
   `supabase migration list --linked` — every local migration should also show up remote,
   nothing pending on either side.

3. **Deploy the Edge Functions:**

   ```bash
   supabase functions deploy team-invitations gps-provider billing billing-webhook \
     --project-ref <your-project-ref>
   ```

   All four deploy with no secrets set. Each one turns on a capability that is otherwise
   reported as unconfigured rather than faked — see [RELEASE.md](../RELEASE.md) for what
   the optional Stripe, Wialon and invitation-email secrets unlock. None of them is
   required for the base Free Build.

4. **Set the two browser values** in `.env.local` (copied from
   [.env.example](../.env.example)): `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`,
   both from Project Settings → API. Nothing else is required for `npm run dev`.
5. **Configure Auth** — see [Supabase project settings to check](#supabase-project-settings-to-check)
   below — then sign up.

### Applying the migrations without the CLI

Only if the CLI is unavailable to you: open the dashboard → SQL Editor and run every file
under `migrations/`, **in filename order, one at a time, confirming each succeeds before
the next** — there are 53 of them, so this is slow. The migrations are written to be
safely re-runnable (`if not exists`, `create or replace`, `drop policy if exists`), so a
partial run can be resumed. Prefer `supabase db push` above.

## What each migration does

| File                     | Contents                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `…_foundation`           | `btree_gist`, the private `app` schema, domains, enums, shared triggers                          |
| `…_tenancy`              | `profiles`, `organizations`, `organization_members`, `organization_settings`                     |
| `…_authorization`        | Authorization helpers, membership invariants, agency provisioning, auth triggers                 |
| `…_fleet`                | `vehicles`, `vehicle_documents`, `customers`                                                     |
| `…_rentals`              | `rentals`, `rental_drivers`, contract numbering, the no-overlap constraint                       |
| `…_finance`              | `payments`, `expenses`, `financing_plans`, `notifications`, settlement triggers                  |
| `…_rls`                  | Privileges and every RLS policy, plus a self-check that fails on an unprotected table            |
| `…_storage`              | The private `organization-logos` bucket and its policies                                         |
| `…_analytics`            | `organization_overview` and `organization_financial_series` read models                          |
| `…_foundation_hardening` | Idempotent agency creation; deploy guard against RLS-bypassing views                             |
| `…_vehicle_fleet_model`  | Operational-only vehicle status, the `vehicle_fleet` view, availability search                   |
| `…_vehicle_media`        | `vehicle_images`, the vehicle-photos and vehicle-documents buckets                               |
| `…_function_privileges`  | Revokes anon EXECUTE on every public function; guards it permanently                             |
| `…_customer_identity`    | `customer_documents`, customer contact/nationality fields, search indexes                        |
| `…_customer_read_models` | `customer_directory`, rental/financial summaries, duplicate detection, customer-documents bucket |

## Supabase project settings to check

Applying the SQL is not quite everything. In the dashboard:

- **Authentication → URL Configuration.** Set _Site URL_ to your app's origin —
  `http://localhost:5173` while developing locally (Vite's default port; see the note
  below if something else is already using it), your real domain once deployed — and add
  `<origin>/auth/callback`, `<origin>/accept-invite`, `<origin>/auth/reset-password` and
  `<origin>/confirm-email` to _Redirect URLs_. Confirmation and password-reset links will
  not work until you do, and the **production** domain needs to be added here too before
  you rely on them there — the local entries do not carry over automatically.

  `supabase/config.toml` ships an `[auth]` section, but it configures the _local_
  Supabase stack (`supabase start`) only. Do not run `supabase config push` expecting it
  to apply these dashboard settings — that command uploads the whole file (api, db,
  storage and auth together) to whichever project is linked, which would silently
  overwrite real hosted settings. See the warning at the top of that file.

- **Authentication → Providers → Email.** Decide whether _Confirm email_ is on — Supabase
  turns it on for every new project by default. The application handles both states: with
  it on, sign-up leads to a "confirm your email" screen and the agency is already
  provisioned and waiting. Leaving it on is the safer default for anything but a quick
  local loop; if you turn it off for local testing, do that deliberately in the dashboard
  and don't carry the choice to a project anyone else can reach.
- **Authentication → Email templates.** The defaults work; customise the branding when
  convenient.

Nothing else needs configuring. All seven storage buckets — `organization-logos`,
`vehicle-photos`, `vehicle-documents`, `customer-documents`, `rental-documents`,
`expense-receipts` and `financing-documents` — are created by migrations, not by hand.

If Vite starts on a port other than 5173 (it falls back silently when something else is
already listening there), either free 5173 or add the port it actually used to _Redirect
URLs_ above — Auth matches these exactly.

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
