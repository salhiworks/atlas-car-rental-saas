# Atlas — Car Rental Management SaaS

_by [Profit Studio](https://profitstudio.app)_

A multi-tenant SaaS for car rental agencies: fleet, contracts, customers, payments,
expenses, financing and reporting. Every agency is an isolated tenant sharing one
application and one database.

Every module is complete and distributed free: Overview, Rentals, Calendar, Customers,
Vehicles, GPS tracking, Expenses, Financing, Reports, Team, Billing and Settings. Nothing
is locked behind a subscription — see [RELEASE.md](RELEASE.md) for what is configured out
of the box and what is optional.

---

## Getting started

The base **Free Build** needs only a Supabase project. Stripe, Wialon and an invitation
email provider are all optional — nothing below requires any of them; see
[Edge Function secrets](#edge-function-secrets).

```bash
git clone https://github.com/salhiworks/atlas-car-rental-saas.git
cd atlas-car-rental-saas
npm ci
```

Create a Supabase project (dashboard → New project), then set up the database and Edge
Functions — see [`supabase/README.md`](supabase/README.md) for the full walkthrough:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
supabase functions deploy team-invitations gps-provider billing billing-webhook \
  --project-ref <your-project-ref>
```

Neither command needs Docker or the local Supabase stack: both push directly to your
hosted project. Docker only matters if you separately run `supabase start` for fully
offline local development — this workflow doesn't need that.

```bash
cp .env.example .env.local     # then fill in the two Supabase values
```

Then configure Auth → URL Configuration in the dashboard — Site URL and redirect URLs,
detailed in [`supabase/README.md`](supabase/README.md#supabase-project-settings-to-check).
Supabase enables email confirmation by default on new projects; the app handles either
setting, so decide deliberately rather than switching it off out of habit.

```bash
npm run dev
```

Sign up once the app is running — that creates your account and your agency together.
If Vite starts on a port other than 5173 because something else already holds it, either
free 5173 or add the port it actually used to Auth's redirect allow-list.

Without a configured database the application does not start; it renders a screen naming
the missing variables. That is deliberate — see [Configuration](#configuration).

### Scripts

| Command              | What it does                                                 |
| -------------------- | ------------------------------------------------------------ |
| `npm run dev`        | Vite dev server on http://localhost:5173                     |
| `npm run build`      | Type-check, then build to `dist/`                            |
| `npm run preview`    | Serve the production build locally                           |
| `npm run typecheck`  | TypeScript across app, config and tests                      |
| `npm run lint`       | ESLint with type-aware rules                                 |
| `npm run test`       | Vitest — unit tests and the database schema suite            |
| `npm run verify`     | format → lint → typecheck → test → build. Run before merging |
| `npm run smoke:live` | Live checks against the linked Supabase project (see below)  |

---

## Configuration

Two variables, both public by definition since they ship in the browser bundle:

| Variable                 | Where it comes from                                    |
| ------------------------ | ------------------------------------------------------ |
| `VITE_SUPABASE_URL`      | Supabase → Project Settings → API → Project URL        |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon / publishable |
| `VITE_APP_NAME`          | Optional. Product name in the tab and shell.           |

**Never put the `service_role` key here.** It bypasses Row Level Security entirely and
would hand every tenant's data to anyone who opens developer tools. The application
decodes the key at startup and refuses to run if a privileged key is detected
(`src/lib/config/env.ts`, covered by `env.test.ts`).

No secret ever belongs in this repository. Server-side keys go in Supabase Edge Function
secrets — not in a `VITE_` variable.

### Edge Function secrets

Set with `supabase secrets set NAME=value`. None is required for the application to run;
each one turns on a capability that is otherwise reported as unconfigured rather than
faked.

| Secret                | What it turns on                                                                                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEAM_APP_URL`        | The origin invitation links point at. **Required before any invitation email can be sent** — the address is never taken from a request, so an unset value means invitations are created and offered as a one-time link to copy instead. |
| `TEAM_EMAIL_PROVIDER` | `resend`, or unset for no delivery.                                                                                                                                                                                                     |
| `TEAM_EMAIL_API_KEY`  | The provider's key.                                                                                                                                                                                                                     |
| `TEAM_EMAIL_FROM`     | The sender address the provider is verified for.                                                                                                                                                                                        |

With none of them set, invitations still work end to end: the Team page reports
`No email configured` and hands an administrator a one-time link to pass on. Nothing
claims an email was sent.

#### SaaS subscription billing

| Secret                          | What it turns on                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_STRIPE_SECRET_KEY`     | Stripe itself. The prefix decides the mode — `sk_test_`/`rk_test_` for a sandbox, `sk_live_`/`rk_live_` for the real account — and a configured price from the other mode is refused before any request. |
| `BILLING_STRIPE_WEBHOOK_SECRET` | The `billing-webhook` endpoint. Without it that endpoint refuses every request; there is no development fallback that trusts unsigned JSON.                                                              |
| `BILLING_APP_URL`               | The trusted origin Checkout and the Customer Portal return to. Never taken from a request header or a redirect parameter.                                                                                |
| `BILLING_PLAN_CATALOGUE`        | Which Stripe prices this deployment sells: `[{"plan_key":"standard","price_id":"price_..."}]` or `[{"plan_key":"standard","lookup_key":"standard"}]`. Amounts and intervals are read from Stripe.        |

With none of them set, `/billing` tells an owner that subscription billing is not
configured, no subscription enforcement applies, and every other module is unaffected.
Nothing invents a plan, a price or a trial.

`billing-webhook` is the one function deployed with `verify_jwt = false`: Stripe is the
caller and has no user session, so the signature check inside the function stands in for
the platform check. Local development uses the Stripe CLI:

```bash
stripe listen --forward-to http://localhost:54321/functions/v1/billing-webhook
stripe trigger customer.subscription.updated
```

`/accept-invite` should also be added to the project's **Auth → URL Configuration →
Redirect URLs** allow-list, so an invited person who creates an account returns to their
invitation after confirming their address rather than to the generic callback.

---

## Applying the database schema

The schema lives in `supabase/migrations/` and is the source of truth — 53 files, applied
in order by `supabase db push`. See [`supabase/README.md`](supabase/README.md) for the
full setup walkthrough, including the (much slower) SQL-editor fallback for when the CLI
isn't available.

Nothing is created by hand in the dashboard. If a table exists, it exists because a
migration in this repository created it.

---

## Architecture

```
src/
  app/
    providers/        React Query, toasts, auth — composed once
    routes/           Route table, route guards, path constants
  components/
    ui/               Design primitives (Button, Field, Card, Badge, …)
    layout/           Application shell, sidebar, navigation model
    feedback/         Loading, error, and configuration screens
    brand/            Wordmark
  features/
    auth/             Session provider, auth API, validation schemas
    workspace/        Active agency, membership, role, logo storage
    overview/         Dashboard read models and its components
    settings/         Agency settings form and logo upload
    vehicles/         Fleet: list, detail, form, photos, documents, CSV import
    customers/        Customers: list, profile, identification, duplicates, CSV import
  lib/
    authz/            Role hierarchy and permission matrix (mirrors RLS)
    compliance/       The single expiry rule shared by every module
    import/           Shared CSV core: parsing, column matching, row validation
    config/           Environment resolution and validation
    datetime/         Time-zone-correct date handling
    money/            Integer minor-unit money arithmetic and formatting
    i18n/             Country, currency and locale reference data
    query/            React Query key registry
    supabase/         Client construction and error mapping
  pages/              Route components
  types/              Database contract

supabase/
  migrations/         Version-controlled SQL — the schema's source of truth
  tests/              Schema, RLS and invariant tests against a real PostgreSQL
```

### Multi-tenancy

Every tenant-scoped table carries a `NOT NULL organization_id`. Three independent
mechanisms keep agencies apart, and all three must hold:

1. **Row Level Security.** Every table has RLS enabled and policies expressed through
   four helper functions in the private `app` schema — `is_org_member`, `has_min_role`,
   `current_role_in`, `shares_organization_with`. No policy re-derives tenancy by hand,
   so there is one place to audit.

2. **Privileges.** `anon` is stripped of every privilege on every tenant table. An
   unauthenticated request cannot read a byte even if a policy were misdrafted.

3. **Composite foreign keys.** Cross-table references carry the tenant column —
   `rentals(vehicle_id, organization_id) → vehicles(id, organization_id)`. A row in
   agency A pointing at a row in agency B is rejected by the storage engine, not by
   application code.

Frontend filtering is never the boundary. The client queries `organizations` with no
`where` clause at all and receives only the agencies the caller belongs to, because RLS
decided that.

### Roles

`owner > admin > manager > staff`, ordered by `app.role_rank()` in SQL and mirrored in
`src/lib/authz/permissions.ts`. The interface uses the mirror to avoid _offering_ actions
the database will refuse; it is not what enforces them.

`supabase/tests/permission-matrix.test.ts` reads the live policy expressions out of
PostgreSQL and asserts each one names the role the interface expects, so the two cannot
drift apart silently.

### Membership

Since `20260821100000`, **no client role holds INSERT, UPDATE or DELETE on
`organization_members`.** The rules that govern a membership change — who may grant
which role, that nobody edits their own, that an agency never reaches zero owners, that
the change is recorded — cannot be expressed as a row policy, so they live in
`SECURITY DEFINER` functions that establish the caller from `auth.uid()` and check the
role themselves. A browser reaching for the table gets `42501` before any policy is
consulted.

Ownership is **transferred, never granted.** No invitation can carry it (a CHECK
constraint on `organization_invitations`, not a missing dropdown option), no role change
can produce it, and `transfer_organization_ownership()` moves it and demotes the outgoing
owner in one transaction under an advisory lock.

An invitation is this product's own object, not Supabase's: it carries a 256-bit token
from `pgcrypto`, of which only a SHA-256 digest is stored, and the same path serves a
brand-new person and somebody who already runs another agency here. Supabase's Auth
invitation was checked against current documentation and does not fit — it returns an
error for an address that already belongs to a confirmed user, so it handles exactly one
of the two cases.

An account is **removed from an agency, never deleted.** Removal drops a membership row;
the profile, the Auth account, every other membership and every business record they
created stay exactly as they are. Team history snapshots names and addresses as text at
the time of the event, so it stays legible after the people it names have gone.

### Money

Amounts are `BIGINT` minor units (`*_minor`) with the ISO-4217 code stored alongside
them on the same row. Never floats, never a shared currency inferred from settings — an
agency that changes its default currency does not retroactively rewrite its books.
Arithmetic, parsing and formatting all go through `src/lib/money/money.ts`.

Rates are integer basis points (`interest_rate_bps`); 7.25% is stored as `725`.

### Dates and time zones

Instants are `timestamptz`; calendar-only values are `date`. Each agency has an IANA time
zone, and every conversion between an instant and a wall-clock reading goes through
`src/lib/datetime/timezone.ts`, which is tested across daylight-saving transitions in
both directions. There is deliberately no "format in the local zone" helper: the correct
zone is the agency's, not the browser's.

### Personal data

`customers` and `customer_documents` hold passports, national IDs and driving licences.
Three rules apply throughout:

- **Identification is normalised, not inline.** A customer has many documents, each with
  its own number, issuing country, validity window and optional scan. One column cannot
  hold both a passport and a residence permit, and a renewed passport must not erase the
  number that was on last year's contract.
- **Numbers are masked by default.** Lists never carry them at all; the profile shows a
  masked tail and revealing the whole value is a deliberate action that hides itself
  again. `customer_directory` is asserted by test to contain no document numbers.
- **Scans are private.** Object keys are `<organization_id>/<customer_id>/…`, the storage
  policies read that leading segment, and access is a five-minute signed URL minted when
  somebody asks to see a file.

### Availability and vehicle status

Two different things, kept apart:

- **Operational status** is what the agency decides — in service, in maintenance, off the
  road. It is a column on `vehicles`, constrained to those three values.
- **Occupancy** is what the contracts imply, and is never stored. `public.vehicle_fleet`
  derives it, so a completed contract cannot leave a car marked rented and a booked car
  cannot appear available.

`rentals_no_vehicle_overlap` is a GiST exclusion constraint and remains the authority: a
vehicle cannot be committed to two overlapping periods, not under concurrency and not
through a direct API call. `public.vehicles_available_between()` mirrors it exactly, so
the interface only ever offers bookings the database will accept.

---

## Deployment

`npm run build` produces a static `dist/`. Upload its contents to the Hostinger web root.

`public/.htaccess` is copied into the build and handles the three things a static SPA
needs on Apache/LiteSpeed: rewriting unknown paths to `index.html` so a refresh on
`/settings` does not 404, long-lived caching for fingerprinted assets with none for
`index.html`, and baseline security headers.

Set the two `VITE_` variables in the build environment before running `npm run build` —
they are inlined at build time, not read at runtime.

---

## Testing

```bash
npm run test
```

Two suites:

- **Unit tests** (`src/**/*.test.ts`) — money arithmetic and parsing, time-zone
  conversion across DST, the permission matrix, environment validation, and route guards.
- **Schema tests** (`supabase/tests/`) — the real migrations applied to a real PostgreSQL
  instance (PGlite, Postgres compiled to WebAssembly), then exercised as the
  `authenticated` role so RLS is genuinely in force. These cover cross-tenant reads and
  writes, role gating, double-booking, settlement arithmetic and owner-safety invariants.

The schema tests stub only what Supabase itself owns — `auth.users`, `auth.uid()` and the
storage tables — in `supabase/tests/support/supabase-doubles.sql`. That file is never
applied to a real database. It also reproduces Supabase's _default privileges_, which
matters: without them the harness proves boundaries that do not exist on the real project.

### Live smoke test

```bash
npm run smoke:live      # requires a linked project and .env.local
```

418 checks against the linked Supabase project, covering what a local harness structurally
cannot: PostgREST's query builder (the `.or()` search, view pagination, ordering, exact
count), Storage upload and signed-URL retrieval, GoTrue sign-in, and cross-tenant refusal
of real signed URLs. It creates data prefixed `Smoke Test` and removes all of it, including
uploaded objects, at the end.

## License

Atlas is released under the MIT License.

You may use, modify, distribute and use the software commercially under the terms of the
license.

See [LICENSE](./LICENSE) for the full license text.
