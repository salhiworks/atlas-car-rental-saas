-- =============================================================================
-- SaaS Billing & Subscriptions
--
-- WHAT THIS IS, AND WHAT IT IS NOT
--
-- This is what a rental agency pays US to use Atlas. It is not a rental
-- payment, not a deposit, not a financing instalment and not an operating cost.
-- Nothing in this file touches public.payments, public.expenses,
-- public.financing_* or any figure the Reports module aggregates, and a test
-- asserts that it never will. An agency's own bookkeeping decision about our
-- invoice stays theirs.
--
-- STRIPE IS AUTHORITATIVE. THIS SCHEMA IS A PROJECTION.
--
-- Every row below describes what Stripe told us, through a signed webhook or a
-- deliberate server-side read. No client writes any of it. The browser cannot
-- name a price, a customer, a subscription or a status, and a successful
-- Checkout redirect changes nothing here: the redirect is a navigation event,
-- and this schema only moves when the trusted server path says it does.
--
-- THE SUBSCRIPTION BELONGS TO THE ORGANIZATION
--
--   organization -> stripe customer -> subscription
--
-- never `user -> subscription`. Owners change, members leave, ownership
-- transfers, and one person may hold four agencies. None of that may create a
-- second Stripe customer or move a subscription, so every mapping here is keyed
-- on organization_id and nothing is keyed on the person who happened to click.
--
-- WHAT IS TRUE IN THIS DEPLOYMENT TODAY
--
-- No Stripe credential and no sellable catalogue are configured. The platform
-- state row below therefore says `unconfigured`, every organization resolves to
-- the access state `platform_unconfigured`, and the product operates exactly as
-- it did before. That is a deployment fact, deliberately represented — it is
-- NOT a subscription, NOT a grandfathered plan, and NOT an exemption. Nothing in
-- this migration inserts a customer, a subscription, a plan or a price.
--
-- STRIPE CONTRACT THIS SCHEMA WAS WRITTEN AGAINST
--
-- API version 2026-07-29.dahlia, the current stable release. Two things about
-- it shape the columns here:
--
--   * `current_period_start` / `current_period_end` no longer exist on the
--     subscription. Since 2025-03-31.basil they live on each subscription item.
--     The projection stores one period because this product sells one recurring
--     item; the server derives it as the minimum across items, which is what
--     Stripe's own `cancel_at: min_period_end` helper means by "the period".
--
--   * `cancel_at_period_end` is deprecated (2025-05-28) but still functional,
--     and the Customer Portal on flexible billing sets `cancel_at` instead.
--     Both are stored, and a scheduled cancellation is "either one".
--
-- Statuses are Stripe's eight, unchanged: incomplete, incomplete_expired,
-- trialing, active, past_due, canceled, unpaid, paused.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'stripe_subscription_status'
                   and typnamespace = 'public'::regnamespace) then
    /*
     * Stripe's own enum, spelled exactly as Stripe spells it. Deliberately not
     * collapsed into our own vocabulary here: the mapping from "what Stripe
     * says" to "what the product does about it" is a decision, and a decision
     * belongs in one named place (app.billing_access_state_of) rather than
     * being smuggled into a column definition.
     */
    create type public.stripe_subscription_status as enum (
      'incomplete',
      'incomplete_expired',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'billing_access_state'
                   and typnamespace = 'public'::regnamespace) then
    /*
     * What the PRODUCT does, which is a different question from what Stripe
     * says. Four values, and only four, because every screen that ever asks
     * "may this agency work today?" must get an answer it can act on.
     *
     *   platform_unconfigured  Billing has not launched in this deployment.
     *                          Access is normal. This is not a subscription and
     *                          must never be displayed as one.
     *   normal                 A healthy subscription, or a trial.
     *   attention              Something needs an owner: a failed payment, an
     *                          unfinished checkout, a subscription that ended.
     *                          Access continues — see the comment on
     *                          app.billing_access_state_of.
     *   restricted             Access is limited by commercial policy. Nothing
     *                          produces this value today, and deliberately so:
     *                          no restriction policy has been decided, and
     *                          inventing one in a migration would be deciding
     *                          it. The value exists so the decision has a place
     *                          to land without a schema change.
     */
    create type public.billing_access_state as enum (
      'platform_unconfigured',
      'normal',
      'attention',
      'restricted'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'billing_interval'
                   and typnamespace = 'public'::regnamespace) then
    -- Stripe's recurring.interval values.
    create type public.billing_interval as enum ('day', 'week', 'month', 'year');
  end if;

  if not exists (select 1 from pg_type where typname = 'stripe_mode'
                   and typnamespace = 'public'::regnamespace) then
    /*
     * Which Stripe account half an object came from. Stored rather than
     * inferred: mixing a test customer with a live price is a configuration
     * mistake that produces a confusing 400 from Stripe hours later, and the
     * only reliable source is Stripe's own `livemode` boolean.
     */
    create type public.stripe_mode as enum ('test', 'live');
  end if;

  if not exists (select 1 from pg_type where typname = 'billing_checkout_state'
                   and typnamespace = 'public'::regnamespace) then
    /*
     * Named for what is actually known, never for what we hope happened.
     * `completed` means Stripe told us the session completed — not that a
     * browser came back to a success URL.
     */
    create type public.billing_checkout_state as enum (
      'open',
      'completed',
      'expired',
      'superseded'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'billing_event_kind'
                   and typnamespace = 'public'::regnamespace) then
    -- The internal audit trail. Focused, not an accounting ledger: Stripe holds
    -- the invoices and always will.
    create type public.billing_event_kind as enum (
      'customer_created',
      'checkout_started',
      'checkout_completed',
      'subscription_activated',
      'subscription_updated',
      'plan_changed',
      'payment_failed',
      'payment_recovered',
      'cancellation_scheduled',
      'cancellation_reverted',
      'subscription_ended',
      'reconciled',
      'anomaly_detected'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'billing_webhook_result'
                   and typnamespace = 'public'::regnamespace) then
    create type public.billing_webhook_result as enum (
      'applied',
      'ignored_unsupported',
      'ignored_duplicate',
      'ignored_stale',
      'ignored_unknown_customer',
      'failed'
    );
  end if;
end
$$;

-- =============================================================================
-- 1. Whether Billing is configured at all
-- =============================================================================

/**
 * One row, describing what the SERVER knows about its own Stripe configuration.
 *
 * The database cannot see a Deno environment variable, and the browser must
 * never be the authority on whether billing is live. So the Billing Edge
 * Functions — which are the only things holding the secret — report what they
 * found, and this row is that report. Nothing else may write it.
 *
 * `catalog_configured` is NOT stored: it is derived from billing_plans, because
 * a stored copy of a countable fact is a copy that goes stale.
 */
create table if not exists public.billing_platform_state (
  -- Exactly one row, forever. The check is the whole point of the column.
  id                boolean primary key default true check (id),

  stripe_configured boolean not null default false,
  stripe_mode       public.stripe_mode,

  -- What the server last reported, and when. A stale timestamp with
  -- stripe_configured = false is the honest state of an unconfigured
  -- deployment, not an error.
  reported_at       timestamptz,
  reported_reason   text check (reported_reason is null or char_length(reported_reason) <= 200),

  updated_at        timestamptz not null default now(),

  constraint billing_platform_state_mode_consistent check (
    (stripe_configured and stripe_mode is not null)
    or (not stripe_configured and stripe_mode is null)
  )
);

comment on table public.billing_platform_state is
  'What the server knows about its own Stripe configuration. One row. Written only by the Billing Edge Functions through a service-role function; read by every access decision.';

insert into public.billing_platform_state (id, stripe_configured, reported_reason)
values (true, false, 'No Stripe configuration has been reported by the server.')
on conflict (id) do nothing;

drop trigger if exists billing_platform_state_set_updated_at on public.billing_platform_state;
create trigger billing_platform_state_set_updated_at
  before update on public.billing_platform_state
  for each row execute function app.set_updated_at();

-- =============================================================================
-- 2. The commercial catalogue
--
-- Empty in this deployment, and it must stay empty until somebody makes a
-- commercial decision. Prices are Stripe's; this table is the ALLOWLIST that
-- says which of them this application is willing to sell. A browser names a
-- plan key; the server turns that into a Stripe price. A browser that names a
-- price is ignored.
-- =============================================================================

create table if not exists public.billing_plans (
  id               uuid primary key default gen_random_uuid(),

  -- What the browser is allowed to say. Stable, internal, not a Stripe object.
  plan_key         text not null check (plan_key ~ '^[a-z][a-z0-9_]{1,48}$'),

  display_name     text not null check (char_length(btrim(display_name)) between 1 and 80),
  description      text check (description is null or char_length(description) <= 400),

  /*
   * The Stripe price this plan sells. The price decides the money: currency,
   * amount and interval are mirrored here for display and are refreshed from
   * Stripe, never authored by hand.
   *
   * This is emphatically NOT organizations.default_currency. An agency renting
   * in MAD may be billed in EUR; that is a normal SaaS arrangement, and
   * converting between the two would invent a number Stripe never charged.
   */
  stripe_price_id  text not null check (stripe_price_id ~ '^price_[A-Za-z0-9_]+$'),
  stripe_product_id text check (stripe_product_id is null or stripe_product_id ~ '^prod_[A-Za-z0-9_]+$'),
  lookup_key       text check (lookup_key is null or char_length(lookup_key) <= 200),

  currency         public.currency_code not null,
  amount_minor     bigint not null check (amount_minor >= 0),
  interval         public.billing_interval not null,
  interval_count   integer not null default 1 check (interval_count between 1 and 12),

  mode             public.stripe_mode not null,

  -- Sellable right now. An archived Stripe price must be deactivated here
  -- rather than deleted, so an existing subscription can still name its plan.
  is_active        boolean not null default true,
  sort_order       integer not null default 0,

  /*
   * Entitlements, as configured. Empty today. The column exists so a future
   * commercial decision has somewhere to land; nothing in this schema invents
   * a limit, and no code enforces one that is not here.
   */
  entitlements     jsonb not null default '{}'::jsonb
    check (jsonb_typeof(entitlements) = 'object'),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint billing_plans_key_unique unique (plan_key),
  constraint billing_plans_price_unique unique (stripe_price_id)
);

comment on table public.billing_plans is
  'The prices this application is willing to sell, keyed by an internal plan key. Empty until a commercial catalogue is configured. A browser may name a plan_key and never a Stripe price.';

create index if not exists billing_plans_active_idx
  on public.billing_plans (is_active, sort_order, plan_key);

drop trigger if exists billing_plans_set_updated_at on public.billing_plans;
create trigger billing_plans_set_updated_at
  before update on public.billing_plans
  for each row execute function app.set_updated_at();

-- =============================================================================
-- 3. Organization -> Stripe customer
-- =============================================================================

create table if not exists public.billing_customers (
  organization_id    uuid primary key references public.organizations (id) on delete cascade,

  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  mode               public.stripe_mode not null,

  /*
   * Where our invoices go. Defaulted from the agency's own contact address when
   * the customer is created, and editable by the owner alone — deliberately a
   * billing fact rather than a copy of organizations.email, because the person
   * who receives the rental enquiries is not always the person who pays for the
   * software. It is not the owner's personal address either: owners change, and
   * a subscription that follows a departed owner's inbox is a lost renewal.
   */
  billing_email      public.email_address,

  -- Set when Stripe tells us the customer is gone. The row stays: it is how we
  -- know not to reuse the identifier, and how support explains what happened.
  deleted_at         timestamptz,

  created_at         timestamptz not null default now(),
  synced_at          timestamptz,
  updated_at         timestamptz not null default now(),

  -- One organization, one customer; and one customer, one organization. The
  -- second half is what makes webhook tenant resolution trustworthy.
  constraint billing_customers_stripe_unique unique (stripe_customer_id)
);

comment on table public.billing_customers is
  'The organization <-> Stripe customer mapping, and the only trusted way to resolve a webhook to a tenant. Survives ownership transfer unchanged.';

drop trigger if exists billing_customers_set_updated_at on public.billing_customers;
create trigger billing_customers_set_updated_at
  before update on public.billing_customers
  for each row execute function app.set_updated_at();

-- The organization and the Stripe identifier are the identity of this row.
drop trigger if exists billing_customers_freeze_columns on public.billing_customers;
create trigger billing_customers_freeze_columns
  before update on public.billing_customers
  for each row execute function app.freeze_columns('organization_id', 'stripe_customer_id', 'created_at');

-- =============================================================================
-- 4. The subscription projection
-- =============================================================================

create table if not exists public.billing_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,

  stripe_subscription_id text not null check (stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'),
  stripe_customer_id     text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'),
  mode                   public.stripe_mode not null,

  status                 public.stripe_subscription_status not null,

  -- The plan as configured when this subscription was last seen. Nullable: a
  -- subscription can legitimately reference a price that has since left the
  -- catalogue, and rewriting history to the current plan would lose the fact.
  plan_key               text,
  stripe_price_id        text check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9_]+$'),

  -- The money, as Stripe charges it. Never converted, never derived from the
  -- agency's operational currency.
  currency               public.currency_code,
  amount_minor           bigint check (amount_minor is null or amount_minor >= 0),
  interval               public.billing_interval,
  interval_count         integer check (interval_count is null or interval_count between 1 and 12),
  quantity               integer check (quantity is null or quantity >= 0),

  /*
   * The period. On API version 2026-07-29.dahlia this comes from
   * subscription.items.data[].current_period_start/end — there is no
   * subscription-level period any more. The server passes the minimum across
   * items, which is what "the period" means for a single-item subscription and
   * what Stripe's own min_period_end helper means for several.
   */
  current_period_start   timestamptz,
  current_period_end     timestamptz,

  -- Cancellation, in Stripe's three separate facts. `cancel_at_period_end` is
  -- deprecated but still set by some flows; the portal on flexible billing sets
  -- `cancel_at` instead. A scheduled cancellation is either of them.
  cancel_at_period_end   boolean not null default false,
  cancel_at              timestamptz,
  canceled_at            timestamptz,
  ended_at               timestamptz,

  trial_start            timestamptz,
  trial_end              timestamptz,

  -- The last invoice outcome we were told about, for the payment-attention
  -- state. Sanitised: a decline code is not stored and is never shown.
  latest_invoice_id      text check (latest_invoice_id is null or char_length(latest_invoice_id) <= 80),
  latest_invoice_status  text check (latest_invoice_status is null or char_length(latest_invoice_status) <= 40),
  latest_invoice_amount_minor bigint check (latest_invoice_amount_minor is null or latest_invoice_amount_minor >= 0),
  latest_invoice_currency public.currency_code,
  latest_payment_failed_at timestamptz,

  /*
   * How this projection refuses to travel backwards.
   *
   * Stripe guarantees no ordering whatsoever — its own words — and retries for
   * three days, so a cancellation from Tuesday can arrive after Wednesday's
   * reactivation. `stripe_event_at` is the creation time of the event (or the
   * read) that produced this row's current contents, and the projection
   * function refuses anything older. Arrival time is never consulted.
   */
  stripe_event_at        timestamptz not null,
  stripe_event_id        text check (stripe_event_id is null or char_length(stripe_event_id) <= 80),

  created_at             timestamptz not null default now(),
  synced_at              timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint billing_subscriptions_stripe_unique unique (stripe_subscription_id),
  constraint billing_subscriptions_tenant_key unique (id, organization_id),
  constraint billing_subscriptions_period_order check (
    current_period_start is null or current_period_end is null
    or current_period_end >= current_period_start
  )
);

comment on table public.billing_subscriptions is
  'A normalized projection of Stripe subscriptions. Historical rows are kept; the effective current one is derived, never flagged by hand.';

create index if not exists billing_subscriptions_organization_idx
  on public.billing_subscriptions (organization_id, status, current_period_end desc);

create index if not exists billing_subscriptions_customer_idx
  on public.billing_subscriptions (stripe_customer_id);

/*
 * At most one subscription per organization in a state Stripe considers live.
 *
 * A partial unique index rather than application logic, because "we should not
 * end up with two paid subscriptions" is exactly the kind of rule that is true
 * in every code path until the one that runs at 3am during a retry storm.
 * Duplicates are refused at the write, surfaced as an anomaly, and reconciled
 * deliberately — never silently resolved by picking one.
 */
create unique index if not exists billing_subscriptions_one_live_per_org
  on public.billing_subscriptions (organization_id)
  where status in ('trialing', 'active', 'past_due', 'unpaid', 'paused');

drop trigger if exists billing_subscriptions_set_updated_at on public.billing_subscriptions;
create trigger billing_subscriptions_set_updated_at
  before update on public.billing_subscriptions
  for each row execute function app.set_updated_at();

-- =============================================================================
-- 5. Checkout intents
-- =============================================================================

create table if not exists public.billing_checkout_sessions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,

  stripe_session_id text not null check (stripe_session_id ~ '^cs_[A-Za-z0-9_]+$'),
  plan_key          text not null,
  stripe_price_id   text not null check (stripe_price_id ~ '^price_[A-Za-z0-9_]+$'),
  mode              public.stripe_mode not null,

  state             public.billing_checkout_state not null default 'open',

  /*
   * Who started it, kept because support will ask. Nulled rather than blocking
   * deletion when that Auth account goes — the same referential rule the rest
   * of this schema follows.
   */
  created_by        uuid references auth.users (id) on delete set null,

  expires_at        timestamptz not null,
  completed_at      timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint billing_checkout_sessions_stripe_unique unique (stripe_session_id)
);

comment on table public.billing_checkout_sessions is
  'Server-created Checkout intents. Holds no card data and no Stripe payload — an identifier, the approved plan, and what became of it.';

create index if not exists billing_checkout_sessions_open_idx
  on public.billing_checkout_sessions (organization_id, expires_at desc)
  where state = 'open';

drop trigger if exists billing_checkout_sessions_set_updated_at on public.billing_checkout_sessions;
create trigger billing_checkout_sessions_set_updated_at
  before update on public.billing_checkout_sessions
  for each row execute function app.set_updated_at();

-- =============================================================================
-- 6. The webhook ledger
--
-- Enough to be idempotent and to debug a delivery, and nothing else. Stripe
-- payloads carry billing PII; none is stored here.
-- =============================================================================

create table if not exists public.billing_webhook_events (
  stripe_event_id  text primary key check (stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'),

  event_type       text not null check (char_length(event_type) between 1 and 120),
  event_created_at timestamptz not null,

  -- The Stripe object the event was about, and the tenant we resolved it to.
  -- Both nullable: an event for an unknown customer resolves to neither, and
  -- recording that is the point.
  object_id        text check (object_id is null or char_length(object_id) <= 80),
  organization_id  uuid references public.organizations (id) on delete set null,

  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  result           public.billing_webhook_result,
  -- A category, never a message from Stripe and never a payload.
  failure_category text check (failure_category is null or char_length(failure_category) <= 60),
  attempts         integer not null default 0 check (attempts >= 0),

  /*
   * The second duplicate guard Stripe documents. Event ids dedupe redelivery;
   * this deduplicates the case Stripe warns about separately — two distinct
   * Event objects describing the same change — by (object, type, created).
   */
  constraint billing_webhook_events_object_unique
    unique (object_id, event_type, event_created_at)
);

comment on table public.billing_webhook_events is
  'One row per Stripe event id, and the second duplicate guard on (object, type, created). No payload is stored: Stripe events carry billing PII and Stripe keeps them for us.';

create index if not exists billing_webhook_events_organization_idx
  on public.billing_webhook_events (organization_id, received_at desc);

create index if not exists billing_webhook_events_unprocessed_idx
  on public.billing_webhook_events (received_at)
  where processed_at is null;

-- =============================================================================
-- 7. Internal billing history
-- =============================================================================

create table if not exists public.billing_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,

  kind             public.billing_event_kind not null,
  occurred_at      timestamptz not null default now(),

  -- Said in our own words, from typed facts. Never a Stripe error string.
  summary          text not null check (char_length(summary) between 1 and 200),

  -- The safe identifiers support needs, and no more.
  stripe_object_id text check (stripe_object_id is null or char_length(stripe_object_id) <= 80),
  stripe_event_id  text check (stripe_event_id is null or char_length(stripe_event_id) <= 80),
  plan_key         text,
  previous_plan_key text,

  actor_user_id    uuid references auth.users (id) on delete set null,
  actor_label      text not null default '' check (char_length(actor_label) <= 200),

  context          jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),

  created_at       timestamptz not null default now()
);

comment on table public.billing_events is
  'A focused internal history of what happened to this agency''s subscription. Not an accounting ledger: Stripe holds the invoices.';

create index if not exists billing_events_organization_idx
  on public.billing_events (organization_id, occurred_at desc);

-- =============================================================================
-- 8. Is Billing configured?
-- =============================================================================

/**
 * Whether this deployment can actually sell a subscription.
 *
 * Two halves, and both must be true: the server must hold Stripe credentials
 * (which only the server can know, so it reports them), and there must be at
 * least one sellable price (which is a countable fact, so it is counted).
 *
 * Today both are false. Every access decision reads this first, which is why an
 * unconfigured deployment produces no billing errors anywhere in the product.
 */
create or replace function app.billing_platform_configured()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.stripe_configured from public.billing_platform_state s where s.id)
    and exists (select 1 from public.billing_plans p where p.is_active),
    false
  );
$$;

comment on function app.billing_platform_configured() is
  'True only when the server has reported Stripe credentials AND a sellable price exists. False in this deployment, which is why nothing in the product asks about billing.';

/**
 * The one subscription that currently decides this organization's billing.
 *
 * A live one if there is one — the partial unique index guarantees at most a
 * single live row — otherwise the most recently observed. Historical rows are
 * kept and are not flagged; "current" is derived, so it cannot drift.
 */
create or replace function app.billing_effective_subscription(p_organization_id uuid)
returns public.billing_subscriptions
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
  from public.billing_subscriptions s
  where s.organization_id = p_organization_id
  order by
    (s.status in ('trialing', 'active', 'past_due', 'unpaid', 'paused')) desc,
    s.stripe_event_at desc,
    s.created_at desc
  limit 1;
$$;

/**
 * What the product does about it.
 *
 * The ONE place Stripe's vocabulary becomes ours. Everything downstream reads
 * this enum; nothing downstream reads a Stripe status. That is the difference
 * between a billing decision that can be changed in one place and
 * `status === 'active'` scattered through fifty components.
 *
 * ACCESS IS NOT WITHDRAWN HERE, and that is deliberate rather than unfinished.
 * `restricted` is unreachable in this deployment: no commercial restriction
 * policy has been decided, and a migration is not the place to decide one. This
 * is operational software holding real contracts and real customers, and the
 * difference between "your payment failed" and "you cannot reach your business
 * records" is a commercial decision with a date on it, not a default.
 */
create or replace function app.billing_access_state_of(p_organization_id uuid)
returns public.billing_access_state
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subscription public.billing_subscriptions;
begin
  -- Billing has not launched. Every organization works exactly as before, and
  -- this is not a subscription, an exemption or a grandfathered plan.
  if not app.billing_platform_configured() then
    return 'platform_unconfigured';
  end if;

  v_subscription := app.billing_effective_subscription(p_organization_id);

  -- Configured, but this agency has not chosen a plan. An owner has something
  -- to do; nothing is taken away.
  if v_subscription.id is null then
    return 'attention';
  end if;

  return case v_subscription.status
    when 'active'   then 'normal'
    when 'trialing' then 'normal'
    /*
     * Everything else needs an owner. Deliberately NOT collapsed further:
     *   past_due / unpaid          a payment failed and Stripe is retrying, or
     *                              has stopped retrying
     *   incomplete                 a checkout that never completed its first
     *                              payment; terminal after 23 hours
     *   incomplete_expired         that 23 hours has passed; a new subscription
     *                              is required, this one cannot be revived
     *   paused                     a trial ended with no payment method
     *   canceled                   terminal
     */
    else 'attention'
  end;
end;
$$;

comment on function app.billing_access_state_of(uuid) is
  'Stripe status -> product access, in one place. Returns platform_unconfigured while Billing has not launched. Never returns restricted today: no restriction policy has been decided.';

-- =============================================================================
-- 9. Reads for the client
-- =============================================================================

/**
 * The generic operational fact, for anybody in the agency.
 *
 * Deliberately NOT called `billing_access_state`, which is the name of the enum
 * it returns: `select public.billing_access_state('...')` parses as a cast to
 * that type rather than as a call, and fails with "invalid input value for
 * enum". A function that only works when its argument is already typed is a trap
 * for the next caller.
 *
 * Four values and nothing else — no amount, no plan, no billing address, no
 * Stripe identifier. This is what a manager or a front-desk member may know if
 * billing state ever affects their work, and it is all they may know.
 */
create or replace function public.billing_access(p_organization_id uuid)
returns public.billing_access_state
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.is_org_member(p_organization_id) then
    raise exception 'Not a member of this organization.' using errcode = '42501';
  end if;

  return app.billing_access_state_of(p_organization_id);
end;
$$;

/**
 * The Billing workspace, for the owner.
 *
 * Owner-only, in the database, because `billing.manage` is owner-only in
 * src/lib/authz/permissions.ts and a permission that is only enforced in React
 * is a decoration. An administrator calling this directly is refused here, not
 * hidden from a menu.
 */
create or replace function public.billing_overview(p_organization_id uuid)
returns table (
  access_state          public.billing_access_state,
  platform_configured   boolean,
  stripe_configured     boolean,
  catalog_configured    boolean,
  mode                  public.stripe_mode,

  has_customer          boolean,
  billing_email         public.email_address,

  subscription_id       text,
  status                public.stripe_subscription_status,
  plan_key              text,
  plan_name             text,
  currency              public.currency_code,
  amount_minor          bigint,
  billing_interval      public.billing_interval,
  interval_count        integer,
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  cancel_scheduled      boolean,
  cancel_effective_at   timestamptz,
  canceled_at           timestamptz,
  ended_at              timestamptz,
  trial_end             timestamptz,
  payment_failed_at     timestamptz,
  latest_invoice_status text,
  synced_at             timestamptz,

  -- A Checkout this agency started that Stripe has not yet reported on. The
  -- Billing page uses it to say "confirming", never to unlock anything.
  pending_checkout      boolean,
  pending_checkout_at   timestamptz,

  -- Facts, not limits. Nothing enforces a ceiling on either number, because no
  -- ceiling has been sold.
  active_members        integer,
  active_vehicles       integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subscription public.billing_subscriptions;
  v_state        public.billing_platform_state;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.has_min_role(p_organization_id, 'owner') then
    raise exception 'Only an owner can see billing for this organization.' using errcode = '42501';
  end if;

  select * into v_state from public.billing_platform_state where id;
  v_subscription := app.billing_effective_subscription(p_organization_id);

  return query
  select
    app.billing_access_state_of(p_organization_id),
    app.billing_platform_configured(),
    coalesce(v_state.stripe_configured, false),
    exists (select 1 from public.billing_plans p where p.is_active),
    v_state.stripe_mode,

    exists (select 1 from public.billing_customers c
             where c.organization_id = p_organization_id and c.deleted_at is null),
    (select c.billing_email from public.billing_customers c
      where c.organization_id = p_organization_id),

    v_subscription.stripe_subscription_id,
    v_subscription.status,
    v_subscription.plan_key,
    (select p.display_name from public.billing_plans p where p.plan_key = v_subscription.plan_key),
    v_subscription.currency,
    v_subscription.amount_minor,
    v_subscription.interval,
    v_subscription.interval_count,
    v_subscription.current_period_start,
    v_subscription.current_period_end,
    -- Either fact means "this ends". The portal on flexible billing sets
    -- cancel_at and leaves cancel_at_period_end false.
    coalesce(v_subscription.cancel_at_period_end, false) or v_subscription.cancel_at is not null,
    coalesce(v_subscription.cancel_at, v_subscription.current_period_end),
    v_subscription.canceled_at,
    v_subscription.ended_at,
    v_subscription.trial_end,
    v_subscription.latest_payment_failed_at,
    v_subscription.latest_invoice_status,
    v_subscription.synced_at,

    exists (
      select 1 from public.billing_checkout_sessions s
      where s.organization_id = p_organization_id
        and s.state = 'open'
        and s.expires_at > now()
    ),
    (select max(s.created_at) from public.billing_checkout_sessions s
      where s.organization_id = p_organization_id and s.state = 'open' and s.expires_at > now()),

    (select t.active_members from public.team_seat_summary(p_organization_id) t),
    (select count(*)::integer from public.vehicles v
      where v.organization_id = p_organization_id and v.archived_at is null);
end;
$$;

comment on function public.billing_overview(uuid) is
  'Everything the Billing page shows an owner, in one call. Owner-only in the database, not merely in the interface.';

/**
 * What this deployment is willing to sell.
 *
 * Owner-only, and empty today. The browser gets a plan KEY and a price to look
 * at; it never gets to choose a Stripe price, and the server does not accept
 * one from it.
 */
create or replace function public.billing_available_plans(p_organization_id uuid)
returns table (
  plan_key       text,
  display_name   text,
  description    text,
  currency       public.currency_code,
  amount_minor   bigint,
  billing_interval public.billing_interval,
  interval_count integer,
  entitlements   jsonb,
  is_current     boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_current text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.has_min_role(p_organization_id, 'owner') then
    raise exception 'Only an owner can see billing for this organization.' using errcode = '42501';
  end if;

  select s.plan_key into v_current
  from public.billing_subscriptions s
  where s.organization_id = p_organization_id
    and s.status in ('trialing', 'active', 'past_due', 'unpaid', 'paused')
  limit 1;

  return query
  select p.plan_key, p.display_name, p.description, p.currency, p.amount_minor,
         p.interval, p.interval_count, p.entitlements,
         p.plan_key is not distinct from v_current
  from public.billing_plans p
  where p.is_active
  order by p.sort_order, p.amount_minor, p.plan_key;
end;
$$;

/**
 * The internal history, for the owner.
 */
create or replace function public.billing_history(p_organization_id uuid, p_limit integer default 20)
returns table (
  kind        public.billing_event_kind,
  occurred_at timestamptz,
  summary     text,
  plan_key    text,
  actor_label text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.has_min_role(p_organization_id, 'owner') then
    raise exception 'Only an owner can see billing for this organization.' using errcode = '42501';
  end if;

  return query
  select e.kind, e.occurred_at, e.summary, e.plan_key, e.actor_label
  from public.billing_events e
  where e.organization_id = p_organization_id
  order by e.occurred_at desc, e.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

/**
 * The billing contact address, changed by the owner.
 *
 * The one billing field a client may write, and it writes it through here so
 * the ownership check is the database's rather than a policy's — the
 * organizations_update policy admits any admin, and billing is an owner's.
 */
create or replace function public.billing_set_email(p_organization_id uuid, p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email public.email_address;
begin
  perform app.billing_writing();
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.has_min_role(p_organization_id, 'owner') then
    raise exception 'Only an owner can change billing for this organization.' using errcode = '42501';
  end if;

  if p_email is null or btrim(p_email) = '' then
    v_email := null;
  else
    begin
      v_email := lower(btrim(p_email))::public.email_address;
    exception when others then
      raise exception 'That is not a valid email address.' using errcode = '22023';
    end;
  end if;

  update public.billing_customers c
     set billing_email = v_email
   where c.organization_id = p_organization_id;

  if not found then
    raise exception 'This organization has no billing account yet.' using errcode = 'P0002';
  end if;
end;
$$;

-- =============================================================================
-- 10. Server-side writes
--
-- Everything below is granted to `service_role` and to nothing else. These are
-- the only ways a billing row is ever written, and the Billing Edge Functions
-- are the only callers. A browser cannot reach any of them, at any role.
-- =============================================================================

/**
 * Serialises every billing decision for one agency for the rest of the
 * transaction.
 *
 * Two owner tabs pressing Subscribe at the same instant is the ordinary case,
 * not the exotic one, and "the button was disabled" is not a concurrency
 * control. A distinct lock namespace from membership: a role change and a
 * checkout have no reason to block each other.
 */
create or replace function app.lock_organization_billing(p_organization_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtext('app.organization_billing'),
    hashtext(p_organization_id::text)
  );
$$;

/**
 * What the server found when it looked for its own Stripe configuration.
 *
 * Called by the Billing Edge Functions. `reason` is a short sentence for an
 * owner ("Stripe is not configured for this deployment"), never a variable
 * name, never a key, never a fragment of a secret.
 */
create or replace function app.billing_report_platform_state(
  p_configured boolean,
  p_mode       public.stripe_mode,
  p_reason     text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.billing_writing();
  update public.billing_platform_state
     set stripe_configured = coalesce(p_configured, false),
         stripe_mode       = case when coalesce(p_configured, false) then p_mode else null end,
         reported_at       = now(),
         reported_reason   = left(p_reason, 200)
   where id;
end;
$$;

/**
 * The organization's Stripe customer, created at most once.
 *
 * Idempotent by construction rather than by hope: the advisory lock serialises
 * the agency, the primary key on organization_id is the second line, and the
 * caller is expected to pass a Stripe idempotency key derived from the
 * organization so that even a retried HTTP request cannot mint a second
 * customer at Stripe's end.
 *
 * Returns the customer that is now mapped — which may be the one that already
 * existed, in which case the caller must release the one it just created.
 */
create or replace function app.billing_claim_customer(
  p_organization_id    uuid,
  p_stripe_customer_id text,
  p_mode               public.stripe_mode,
  p_billing_email      text default null
)
returns public.billing_customers
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.billing_customers;
begin
  perform app.billing_writing();
  perform app.lock_organization_billing(p_organization_id);

  select * into v_row from public.billing_customers c
   where c.organization_id = p_organization_id;

  if v_row.organization_id is not null then
    return v_row;
  end if;

  insert into public.billing_customers
    (organization_id, stripe_customer_id, mode, billing_email, synced_at)
  values (
    p_organization_id, p_stripe_customer_id, p_mode,
    nullif(lower(btrim(coalesce(p_billing_email, ''))), '')::public.email_address,
    now()
  )
  on conflict (organization_id) do nothing
  returning * into v_row;

  if v_row.organization_id is null then
    select * into v_row from public.billing_customers c
     where c.organization_id = p_organization_id;
    return v_row;
  end if;

  insert into public.billing_events (organization_id, kind, summary, stripe_object_id)
  values (p_organization_id, 'customer_created', 'A billing account was created for this agency.',
          p_stripe_customer_id);

  return v_row;
end;
$$;

/**
 * Records a Checkout session the server just created.
 *
 * Any earlier open session for the agency is superseded rather than deleted:
 * two live sessions for one organization is the state that produces two
 * subscriptions, and the record of what happened is worth keeping.
 */
create or replace function app.billing_record_checkout(
  p_organization_id   uuid,
  p_stripe_session_id text,
  p_plan_key          text,
  p_stripe_price_id   text,
  p_mode              public.stripe_mode,
  p_expires_at        timestamptz,
  p_created_by        uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.billing_writing();
  perform app.lock_organization_billing(p_organization_id);

  update public.billing_checkout_sessions s
     set state = 'superseded'
   where s.organization_id = p_organization_id
     and s.state = 'open'
     and s.stripe_session_id <> p_stripe_session_id;

  insert into public.billing_checkout_sessions
    (organization_id, stripe_session_id, plan_key, stripe_price_id, mode, expires_at, created_by)
  values (p_organization_id, p_stripe_session_id, p_plan_key, p_stripe_price_id, p_mode,
          p_expires_at, p_created_by)
  on conflict (stripe_session_id) do nothing;

  insert into public.billing_events
    (organization_id, kind, summary, stripe_object_id, plan_key, actor_user_id)
  values (p_organization_id, 'checkout_started', 'Checkout was started for a subscription.',
          p_stripe_session_id, p_plan_key, p_created_by);
end;
$$;

/**
 * An open Checkout session this agency can be sent back to.
 *
 * Reusing a session that Stripe has not expired is safer than minting another:
 * every extra session is another chance for two of them to complete.
 */
create or replace function app.billing_open_checkout(
  p_organization_id uuid,
  p_plan_key        text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.stripe_session_id
  from public.billing_checkout_sessions s
  where s.organization_id = p_organization_id
    and s.plan_key = p_plan_key
    and s.state = 'open'
    and s.expires_at > now() + interval '2 minutes'
  order by s.created_at desc
  limit 1;
$$;

/**
 * The projection writer, and the only thing that moves a subscription row.
 *
 * ORDER. Stripe states plainly that it does not guarantee delivery order, and
 * retries for three days. So this compares the event's own creation time
 * against what produced the row we already hold, and refuses to go backwards.
 * HTTP arrival time is never consulted. `p_event_at` for a deliberate read
 * (reconciliation) is the moment of the read, which is by definition the
 * freshest thing we have.
 *
 * TENANT. Resolved from billing_customers, never from event metadata. Metadata
 * is a free-form field an attacker would love to write; the customer mapping is
 * ours, unique, and was established by a server that had already checked the
 * caller's membership.
 *
 * Returns the outcome so the caller can log it without re-querying.
 */
create or replace function app.billing_apply_subscription(
  p_stripe_subscription_id text,
  p_stripe_customer_id     text,
  p_mode                   public.stripe_mode,
  p_status                 public.stripe_subscription_status,
  p_stripe_price_id        text,
  p_currency               text,
  p_amount_minor           bigint,
  p_interval               public.billing_interval,
  p_interval_count         integer,
  p_quantity               integer,
  p_current_period_start   timestamptz,
  p_current_period_end     timestamptz,
  p_cancel_at_period_end   boolean,
  p_cancel_at              timestamptz,
  p_canceled_at            timestamptz,
  p_ended_at               timestamptz,
  p_trial_start            timestamptz,
  p_trial_end              timestamptz,
  p_event_at               timestamptz,
  p_event_id               text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization uuid;
  v_existing     public.billing_subscriptions;
  v_plan_key     text;
  v_previous     public.stripe_subscription_status;
  v_previous_plan text;
begin
  perform app.billing_writing();
  select c.organization_id into v_organization
  from public.billing_customers c
  where c.stripe_customer_id = p_stripe_customer_id;

  -- An event about somebody we have never heard of. Recorded by the caller and
  -- otherwise ignored: guessing a tenant is how one agency's subscription ends
  -- up on another's account.
  if v_organization is null then
    return 'unknown_customer';
  end if;

  perform app.lock_organization_billing(v_organization);

  select * into v_existing
  from public.billing_subscriptions s
  where s.stripe_subscription_id = p_stripe_subscription_id;

  -- Older than what we already applied. Stripe retried, or two events crossed.
  if v_existing.id is not null and p_event_at < v_existing.stripe_event_at then
    return 'stale';
  end if;

  -- The plan this price belongs to, if it is one we sell. A subscription on a
  -- price that has left the catalogue keeps its history: plan_key stays null
  -- rather than being rewritten to whatever is current.
  select p.plan_key into v_plan_key
  from public.billing_plans p
  where p.stripe_price_id = p_stripe_price_id;

  v_previous      := v_existing.status;
  v_previous_plan := v_existing.plan_key;

  insert into public.billing_subscriptions (
    organization_id, stripe_subscription_id, stripe_customer_id, mode, status,
    plan_key, stripe_price_id, currency, amount_minor, interval, interval_count, quantity,
    current_period_start, current_period_end,
    cancel_at_period_end, cancel_at, canceled_at, ended_at, trial_start, trial_end,
    stripe_event_at, stripe_event_id, synced_at
  ) values (
    v_organization, p_stripe_subscription_id, p_stripe_customer_id, p_mode, p_status,
    v_plan_key, p_stripe_price_id,
    nullif(btrim(coalesce(p_currency, '')), '')::public.currency_code,
    p_amount_minor, p_interval, p_interval_count, p_quantity,
    p_current_period_start, p_current_period_end,
    coalesce(p_cancel_at_period_end, false), p_cancel_at, p_canceled_at, p_ended_at,
    p_trial_start, p_trial_end,
    p_event_at, p_event_id, now()
  )
  on conflict (stripe_subscription_id) do update set
    status               = excluded.status,
    plan_key             = coalesce(excluded.plan_key, public.billing_subscriptions.plan_key),
    stripe_price_id      = excluded.stripe_price_id,
    currency             = excluded.currency,
    amount_minor         = excluded.amount_minor,
    interval             = excluded.interval,
    interval_count       = excluded.interval_count,
    quantity             = excluded.quantity,
    current_period_start = excluded.current_period_start,
    current_period_end   = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    cancel_at            = excluded.cancel_at,
    canceled_at          = excluded.canceled_at,
    ended_at             = excluded.ended_at,
    trial_start          = excluded.trial_start,
    trial_end            = excluded.trial_end,
    stripe_event_at      = excluded.stripe_event_at,
    stripe_event_id      = excluded.stripe_event_id,
    synced_at            = now();

  -- History, from the transition rather than from the event type: the same
  -- customer.subscription.updated carries a plan change, a scheduled
  -- cancellation and a reactivation, and they are not the same sentence.
  if v_existing.id is null then
    if p_status in ('active', 'trialing') then
      insert into public.billing_events (organization_id, kind, summary, stripe_object_id, plan_key, stripe_event_id)
      values (v_organization, 'subscription_activated', 'The subscription became active.',
              p_stripe_subscription_id, v_plan_key, p_event_id);
    end if;
  else
    if v_previous is distinct from p_status then
      if p_status in ('active', 'trialing') and v_previous in ('past_due', 'unpaid', 'incomplete', 'paused') then
        insert into public.billing_events (organization_id, kind, summary, stripe_object_id, plan_key, stripe_event_id)
        values (v_organization, 'payment_recovered', 'The subscription is active again.',
                p_stripe_subscription_id, v_plan_key, p_event_id);
      elsif p_status in ('canceled', 'incomplete_expired') then
        insert into public.billing_events (organization_id, kind, summary, stripe_object_id, plan_key, stripe_event_id)
        values (v_organization, 'subscription_ended', 'The subscription ended.',
                p_stripe_subscription_id, v_plan_key, p_event_id);
      elsif p_status in ('past_due', 'unpaid') then
        insert into public.billing_events (organization_id, kind, summary, stripe_object_id, plan_key, stripe_event_id)
        values (v_organization, 'payment_failed', 'A subscription payment did not go through.',
                p_stripe_subscription_id, v_plan_key, p_event_id);
      else
        insert into public.billing_events (organization_id, kind, summary, stripe_object_id, plan_key, stripe_event_id)
        values (v_organization, 'subscription_updated', 'The subscription changed.',
                p_stripe_subscription_id, v_plan_key, p_event_id);
      end if;
    end if;

    if v_plan_key is not null and v_previous_plan is not null and v_plan_key <> v_previous_plan then
      insert into public.billing_events
        (organization_id, kind, summary, stripe_object_id, plan_key, previous_plan_key, stripe_event_id)
      values (v_organization, 'plan_changed', 'The subscription moved to a different plan.',
              p_stripe_subscription_id, v_plan_key, v_previous_plan, p_event_id);
    end if;

    -- Scheduled, then un-scheduled. Both are ordinary and both are worth a line.
    if (coalesce(p_cancel_at_period_end, false) or p_cancel_at is not null)
       and not (coalesce(v_existing.cancel_at_period_end, false) or v_existing.cancel_at is not null) then
      insert into public.billing_events (organization_id, kind, summary, stripe_object_id, stripe_event_id)
      values (v_organization, 'cancellation_scheduled', 'The subscription is set to end.',
              p_stripe_subscription_id, p_event_id);
    elsif not (coalesce(p_cancel_at_period_end, false) or p_cancel_at is not null)
       and (coalesce(v_existing.cancel_at_period_end, false) or v_existing.cancel_at is not null)
       and p_status not in ('canceled', 'incomplete_expired') then
      insert into public.billing_events (organization_id, kind, summary, stripe_object_id, stripe_event_id)
      values (v_organization, 'cancellation_reverted', 'The subscription will continue.',
              p_stripe_subscription_id, p_event_id);
    end if;
  end if;

  -- Whatever started this subscription is finished.
  update public.billing_checkout_sessions s
     set state = 'completed', completed_at = coalesce(s.completed_at, now())
   where s.organization_id = v_organization
     and s.state = 'open';

  return 'applied';

exception
  /*
   * The partial unique index refused a second live subscription for this
   * agency. That is a real Stripe-side anomaly — two live subscriptions for one
   * customer — and it is recorded rather than resolved: choosing which of two
   * paid subscriptions is "the" one is not a decision a trigger should make at
   * three in the morning.
   */
  when unique_violation then
    insert into public.billing_events
      (organization_id, kind, summary, stripe_object_id, stripe_event_id, context)
    values (v_organization, 'anomaly_detected',
            'Stripe reported a second live subscription for this agency.',
            p_stripe_subscription_id, p_event_id,
            jsonb_build_object('constraint', 'one_live_per_org'));
    return 'anomaly';
end;
$$;

/**
 * The latest invoice outcome, kept alongside the subscription.
 *
 * Sanitised on purpose: an amount, a currency, a status and a time. No decline
 * code, no payment method, no card. "An invoice payment attempt failed" is what
 * is known; "the card was permanently declined" is not.
 */
create or replace function app.billing_apply_invoice(
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_invoice_id             text,
  p_invoice_status         text,
  p_amount_minor           bigint,
  p_currency               text,
  p_failed                 boolean,
  p_event_at               timestamptz,
  p_event_id               text default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization uuid;
begin
  perform app.billing_writing();
  select c.organization_id into v_organization
  from public.billing_customers c
  where c.stripe_customer_id = p_stripe_customer_id;

  if v_organization is null then
    return 'unknown_customer';
  end if;

  perform app.lock_organization_billing(v_organization);

  update public.billing_subscriptions s
     set latest_invoice_id           = p_invoice_id,
         latest_invoice_status       = left(p_invoice_status, 40),
         latest_invoice_amount_minor = p_amount_minor,
         latest_invoice_currency     = nullif(btrim(coalesce(p_currency, '')), '')::public.currency_code,
         latest_payment_failed_at    = case when coalesce(p_failed, false) then p_event_at
                                            else null end,
         synced_at                   = now()
   where s.stripe_subscription_id = p_stripe_subscription_id
     and s.organization_id = v_organization
     -- Invoices are not subscriptions: an old invoice event must not overwrite
     -- a newer one, and must never move the subscription's own ordering clock.
     and (s.latest_invoice_id is distinct from p_invoice_id or p_event_at >= s.synced_at);

  if not found then
    return 'no_subscription';
  end if;

  if coalesce(p_failed, false) then
    insert into public.billing_events
      (organization_id, kind, summary, stripe_object_id, stripe_event_id)
    values (v_organization, 'payment_failed', 'A subscription payment did not go through.',
            p_invoice_id, p_event_id);
  end if;

  return 'applied';
end;
$$;

/**
 * Claims a webhook event for processing, or reports that somebody already has.
 *
 * The first duplicate guard Stripe documents is the event id, which is this
 * table's primary key. The second — two distinct Event objects describing one
 * change — is the unique constraint on (object, type, created). A claim that
 * loses either race returns `duplicate`, and the caller answers 2xx so Stripe
 * stops retrying something that is already done.
 */
create or replace function app.billing_claim_webhook_event(
  p_stripe_event_id  text,
  p_event_type       text,
  p_event_created_at timestamptz,
  p_object_id        text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_processed timestamptz;
begin
  perform app.billing_writing();
  insert into public.billing_webhook_events
    (stripe_event_id, event_type, event_created_at, object_id, attempts)
  values (p_stripe_event_id, p_event_type, p_event_created_at, p_object_id, 1)
  on conflict (stripe_event_id) do update
    set attempts = public.billing_webhook_events.attempts + 1
  returning processed_at into v_processed;

  if v_processed is not null then
    return 'duplicate';
  end if;

  return 'claimed';

exception
  -- The (object, type, created) guard. A second Event object for a change we
  -- have already applied is not an error; it is Stripe being thorough.
  when unique_violation then
    return 'duplicate';
end;
$$;

/**
 * Marks an event finished. Stripe will not be asked to send it again.
 *
 * Used for everything that reached a conclusion, including the deliberate
 * ignores: an unsupported event type and a stale delivery are both decisions,
 * and a decision is not a failure to retry.
 */
create or replace function app.billing_finish_webhook_event(
  p_stripe_event_id  text,
  p_result           public.billing_webhook_result,
  p_organization_id  uuid default null,
  p_failure_category text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.billing_writing();
  update public.billing_webhook_events e
     set processed_at     = now(),
         result           = p_result,
         organization_id  = coalesce(p_organization_id, e.organization_id),
         failure_category = left(p_failure_category, 60)
   where e.stripe_event_id = p_stripe_event_id;
end;
$$;

/**
 * Records that processing failed, and leaves the event OPEN.
 *
 * `processed_at` deliberately stays null. Stripe retries a non-2xx for three
 * days, and the claim in app.billing_claim_webhook_event treats a row with
 * processed_at set as already done — so stamping it here would turn a transient
 * failure into a permanently skipped event, which is the worst of both: the
 * subscription never syncs and the ledger says it was handled.
 */
create or replace function app.billing_fail_webhook_event(
  p_stripe_event_id  text,
  p_failure_category text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.billing_writing();
  update public.billing_webhook_events e
     set result           = 'failed',
         failure_category = left(p_failure_category, 60)
   where e.stripe_event_id = p_stripe_event_id;
end;
$$;

/**
 * Replaces the sellable catalogue with what the server read from Stripe.
 *
 * Whole-catalogue, not row-by-row: a price that has left the configuration must
 * stop being sellable in the same instant, and a partial update leaves a
 * window where it is still on offer. Prices already sold keep their history —
 * billing_subscriptions holds its own price id and never reads this table for
 * anything but a display name.
 */
create or replace function app.billing_replace_catalogue(p_plans jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform app.billing_writing();
  if jsonb_typeof(p_plans) <> 'array' then
    raise exception 'A catalogue is a list of plans.' using errcode = '22023';
  end if;

  update public.billing_plans set is_active = false where is_active;

  insert into public.billing_plans (
    plan_key, display_name, description, stripe_price_id, stripe_product_id, lookup_key,
    currency, amount_minor, interval, interval_count, mode, is_active, sort_order, entitlements
  )
  select
    p->>'plan_key',
    p->>'display_name',
    nullif(p->>'description', ''),
    p->>'stripe_price_id',
    nullif(p->>'stripe_product_id', ''),
    nullif(p->>'lookup_key', ''),
    (p->>'currency')::public.currency_code,
    (p->>'amount_minor')::bigint,
    (p->>'interval')::public.billing_interval,
    coalesce((p->>'interval_count')::integer, 1),
    (p->>'mode')::public.stripe_mode,
    true,
    coalesce((p->>'sort_order')::integer, 0),
    coalesce(p->'entitlements', '{}'::jsonb)
  from jsonb_array_elements(p_plans) as p
  on conflict (plan_key) do update set
    display_name      = excluded.display_name,
    description       = excluded.description,
    stripe_price_id   = excluded.stripe_price_id,
    stripe_product_id = excluded.stripe_product_id,
    lookup_key        = excluded.lookup_key,
    currency          = excluded.currency,
    amount_minor      = excluded.amount_minor,
    interval          = excluded.interval,
    interval_count    = excluded.interval_count,
    mode              = excluded.mode,
    is_active         = true,
    sort_order        = excluded.sort_order,
    entitlements      = excluded.entitlements;

  select count(*)::integer into v_count from public.billing_plans where is_active;
  return v_count;
end;
$$;

/**
 * The plan a browser asked for, turned into something sellable.
 *
 * The whole defence against price tampering is that this is the only lookup:
 * the browser sends a plan key, this returns the price, and a Stripe price id
 * arriving from a browser is not consulted by anything.
 */
create or replace function app.billing_resolve_plan(p_plan_key text, p_mode public.stripe_mode)
returns public.billing_plans
language sql
stable
security definer
set search_path = ''
as $$
  select p.* from public.billing_plans p
  where p.plan_key = p_plan_key
    and p.is_active
    and p.mode = p_mode;
$$;

/**
 * Notes something a person or the server did, for support.
 */
create or replace function app.billing_note_event(
  p_organization_id uuid,
  p_kind            public.billing_event_kind,
  p_summary         text,
  p_actor_user_id   uuid default null,
  p_stripe_object_id text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform app.billing_writing();
  insert into public.billing_events
    (organization_id, kind, summary, actor_user_id, actor_label, stripe_object_id)
  values (
    p_organization_id, p_kind, left(p_summary, 200), p_actor_user_id,
    coalesce(app.actor_display_name(p_actor_user_id), ''),
    p_stripe_object_id
  );
end;
$$;

-- =============================================================================
-- 11. Billing rows are written by the billing service, and by nothing else
--
-- The tables carry no client privilege at all, so a direct write already fails
-- with "permission denied". This guard is the second line: a re-applied
-- Supabase default, a future migration, or one `grant all` typed at the wrong
-- moment would otherwise be the difference between a projection and a wish.
--
-- HOW IT TELLS THE SERVICE APART FROM A CLIENT. Each server-side write function
-- sets a transaction-local flag before it writes. A browser cannot set it:
-- PostgREST executes RPCs and table operations, never arbitrary SQL, and no RPC
-- reachable by `authenticated` sets it. The flag is transaction-scoped, so it
-- cannot leak into the next statement on a pooled connection.
--
-- The guard also permits the two referential actions this schema requires — the
-- cascade that arrives when an agency is deleted, and the update that nulls a
-- reference to a deleted Auth account. Refusing those does not protect
-- anything; it makes an agency or an Auth account impossible to delete. That
-- lesson cost two rounds of live cleanup failures in Team and Notifications.
-- =============================================================================

create or replace function app.billing_writing()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select set_config('app.billing_writer', 'on', true);
$$;

create or replace function app.billing_rows_are_server_written()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new jsonb;
  v_old jsonb;
  v_org uuid;
begin
  -- The billing service, mid-transaction. Everything it does is deliberate.
  if coalesce(current_setting('app.billing_writer', true), '') = 'on' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    v_org := case when to_jsonb(old) ? 'organization_id'
                  then (to_jsonb(old) ->> 'organization_id')::uuid end;
    if v_org is not null
       and not exists (select 1 from public.organizations o where o.id = v_org) then
      return old;
    end if;
    raise exception 'Billing records are written by the billing service, not by clients.'
      using errcode = '42501';
  end if;

  v_new := to_jsonb(new);
  v_old := to_jsonb(old);

  /*
   * The one update a client-shaped write may perform: a foreign key nulling a
   * reference to an Auth account that has been deleted. Compared as a whole row
   * minus those references, so a column added to a billing table later cannot
   * quietly become editable, and each reference may only move to NULL.
   */
  if (v_new - 'created_by' - 'actor_user_id' - 'updated_at')
       = (v_old - 'created_by' - 'actor_user_id' - 'updated_at')
     and (v_new -> 'created_by' = 'null'::jsonb
          or v_new -> 'created_by' is not distinct from v_old -> 'created_by')
     and (v_new -> 'actor_user_id' = 'null'::jsonb
          or v_new -> 'actor_user_id' is not distinct from v_old -> 'actor_user_id')
     and (v_new -> 'created_by', v_new -> 'actor_user_id')
           is distinct from (v_old -> 'created_by', v_old -> 'actor_user_id')
  then
    return new;
  end if;

  raise exception 'Billing records are written by the billing service, not by clients.'
    using errcode = '42501';
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'billing_platform_state', 'billing_plans', 'billing_customers',
    'billing_subscriptions', 'billing_checkout_sessions', 'billing_webhook_events',
    'billing_events'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      v_table || '_server_written', v_table
    );
    execute format(
      'create trigger %I before update or delete on public.%I
         for each row execute function app.billing_rows_are_server_written()',
      v_table || '_server_written', v_table
    );
  end loop;
end
$$;

-- =============================================================================
-- 12. An agency with a live subscription cannot be quietly deleted
--
-- Nothing grants DELETE on public.organizations to any browser role, so this is
-- about the trusted paths: a support script, a future account-closure flow, a
-- service-role cleanup. Deleting the agency would cascade its billing rows away
-- and leave a subscription billing a customer nobody can see.
--
-- The guard refuses only while Stripe considers the subscription live. A
-- cancelled or expired one is history and does not stand in the way. There is
-- deliberately no Stripe call here: a database trigger that makes an HTTP
-- request is a trigger that can hang a transaction on somebody else's outage.
-- =============================================================================

create or replace function app.guard_organization_billing_on_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_subscription text;
begin
  select s.stripe_subscription_id into v_subscription
  from public.billing_subscriptions s
  where s.organization_id = old.id
    and s.status in ('trialing', 'active', 'past_due', 'unpaid', 'paused')
  limit 1;

  if v_subscription is not null then
    raise exception
      'This agency still has a live subscription. Close the subscription in Stripe before deleting it.'
      using errcode = '23514';
  end if;

  return old;
end;
$$;

drop trigger if exists organizations_guard_billing_delete on public.organizations;
create trigger organizations_guard_billing_delete
  before delete on public.organizations
  for each row execute function app.guard_organization_billing_on_delete();

-- =============================================================================
-- 13. Privileges and Row Level Security
-- =============================================================================

revoke all on table public.billing_platform_state from anon, authenticated;
revoke all on table public.billing_plans from anon, authenticated;
revoke all on table public.billing_customers from anon, authenticated;
revoke all on table public.billing_subscriptions from anon, authenticated;
revoke all on table public.billing_checkout_sessions from anon, authenticated;
revoke all on table public.billing_webhook_events from anon, authenticated;
revoke all on table public.billing_events from anon, authenticated;

alter table public.billing_platform_state enable row level security;
alter table public.billing_plans enable row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_checkout_sessions enable row level security;
alter table public.billing_webhook_events enable row level security;
alter table public.billing_events enable row level security;

/*
 * Policies without grants, as with Team and Notifications: every read goes
 * through a function that checks the caller, and these are the backstop if a
 * future migration or a re-applied Supabase default ever hands a client role a
 * table privilege. Every one is owner-scoped, because billing is an owner's.
 */
drop policy if exists billing_customers_select on public.billing_customers;
create policy billing_customers_select on public.billing_customers
  for select to authenticated
  using (app.has_min_role(organization_id, 'owner'));

drop policy if exists billing_subscriptions_select on public.billing_subscriptions;
create policy billing_subscriptions_select on public.billing_subscriptions
  for select to authenticated
  using (app.has_min_role(organization_id, 'owner'));

drop policy if exists billing_checkout_sessions_select on public.billing_checkout_sessions;
create policy billing_checkout_sessions_select on public.billing_checkout_sessions
  for select to authenticated
  using (app.has_min_role(organization_id, 'owner'));

drop policy if exists billing_events_select on public.billing_events;
create policy billing_events_select on public.billing_events
  for select to authenticated
  using (app.has_min_role(organization_id, 'owner'));

/*
 * The catalogue is not tenant data — it is what this deployment sells — but it
 * is still only an owner's business, and only while it is sellable.
 */
drop policy if exists billing_plans_select on public.billing_plans;
create policy billing_plans_select on public.billing_plans
  for select to authenticated
  using (
    is_active
    and exists (
      select 1 from public.organization_members m
      where m.user_id = (select auth.uid())
        and m.status = 'active'
        and m.role = 'owner'
    )
  );

/*
 * The platform state and the webhook ledger are readable by nobody, said out
 * loud rather than left to the absence of a grant.
 *
 * The ledger describes Stripe's traffic to us — not any one agency's business —
 * and the platform state is a deployment fact. Both are reached only through
 * functions that answer a narrower question, so `false` is not a placeholder
 * here: it is the whole intended policy, and writing it keeps the schema-wide
 * rule "every table has RLS and a policy" true without an exception list.
 */
drop policy if exists billing_platform_state_no_client_read on public.billing_platform_state;
create policy billing_platform_state_no_client_read on public.billing_platform_state
  for select to authenticated using (false);

drop policy if exists billing_webhook_events_no_client_read on public.billing_webhook_events;
create policy billing_webhook_events_no_client_read on public.billing_webhook_events
  for select to authenticated using (false);

-- -----------------------------------------------------------------------------
-- Execution grants
--
-- Every function is revoked from PUBLIC explicitly: PostgreSQL's default ACL
-- grants EXECUTE to PUBLIC, and revoking from `anon` alone changes nothing.
-- -----------------------------------------------------------------------------

revoke all on function app.billing_platform_configured() from public, anon;
revoke all on function app.billing_effective_subscription(uuid) from public, anon;
revoke all on function app.billing_access_state_of(uuid) from public, anon;
revoke all on function app.lock_organization_billing(uuid) from public, anon;
revoke all on function app.billing_writing() from public, anon;
revoke all on function app.billing_rows_are_server_written() from public, anon;
revoke all on function app.guard_organization_billing_on_delete() from public, anon;
revoke all on function app.billing_report_platform_state(boolean, public.stripe_mode, text) from public, anon;
revoke all on function app.billing_claim_customer(uuid, text, public.stripe_mode, text) from public, anon;
revoke all on function app.billing_record_checkout(uuid, text, text, text, public.stripe_mode, timestamptz, uuid) from public, anon;
revoke all on function app.billing_open_checkout(uuid, text) from public, anon;
revoke all on function app.billing_apply_subscription(text, text, public.stripe_mode, public.stripe_subscription_status, text, text, bigint, public.billing_interval, integer, integer, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text) from public, anon;
revoke all on function app.billing_apply_invoice(text, text, text, text, bigint, text, boolean, timestamptz, text) from public, anon;
revoke all on function app.billing_claim_webhook_event(text, text, timestamptz, text) from public, anon;
revoke all on function app.billing_finish_webhook_event(text, public.billing_webhook_result, uuid, text) from public, anon;
revoke all on function app.billing_fail_webhook_event(text, text) from public, anon;
revoke all on function app.billing_replace_catalogue(jsonb) from public, anon;
revoke all on function app.billing_resolve_plan(text, public.stripe_mode) from public, anon;
revoke all on function app.billing_note_event(uuid, public.billing_event_kind, text, uuid, text) from public, anon;

revoke all on function public.billing_access(uuid) from public, anon;
revoke all on function public.billing_overview(uuid) from public, anon;
revoke all on function public.billing_available_plans(uuid) from public, anon;
revoke all on function public.billing_history(uuid, integer) from public, anon;
revoke all on function public.billing_set_email(uuid, text) from public, anon;

-- The four reads and the one write a browser genuinely makes.
grant execute on function public.billing_access(uuid) to authenticated;
grant execute on function public.billing_overview(uuid) to authenticated;
grant execute on function public.billing_available_plans(uuid) to authenticated;
grant execute on function public.billing_history(uuid, integer) to authenticated;
grant execute on function public.billing_set_email(uuid, text) to authenticated;

/*
 * Everything the billing service calls, granted to service_role alone.
 *
 * A service-role client is not a tenant bypass: each of these either takes no
 * tenant at all, or takes one the Edge Function has already checked against the
 * caller's own membership under RLS before it reached this far.
 */
grant execute on function app.billing_report_platform_state(boolean, public.stripe_mode, text) to service_role;
grant execute on function app.billing_claim_customer(uuid, text, public.stripe_mode, text) to service_role;
grant execute on function app.billing_record_checkout(uuid, text, text, text, public.stripe_mode, timestamptz, uuid) to service_role;
grant execute on function app.billing_open_checkout(uuid, text) to service_role;
grant execute on function app.billing_apply_subscription(text, text, public.stripe_mode, public.stripe_subscription_status, text, text, bigint, public.billing_interval, integer, integer, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text) to service_role;
grant execute on function app.billing_apply_invoice(text, text, text, text, bigint, text, boolean, timestamptz, text) to service_role;
grant execute on function app.billing_claim_webhook_event(text, text, timestamptz, text) to service_role;
grant execute on function app.billing_finish_webhook_event(text, public.billing_webhook_result, uuid, text) to service_role;
grant execute on function app.billing_fail_webhook_event(text, text) to service_role;
grant execute on function app.billing_replace_catalogue(jsonb) to service_role;
grant execute on function app.billing_resolve_plan(text, public.stripe_mode) to service_role;
grant execute on function app.billing_note_event(uuid, public.billing_event_kind, text, uuid, text) to service_role;
grant execute on function app.billing_platform_configured() to service_role;
grant execute on function app.billing_access_state_of(uuid) to service_role;
grant execute on function app.billing_effective_subscription(uuid) to service_role;

/*
 * app.billing_access_state_of and app.billing_platform_configured are also
 * reached in INVOKER context — from inside public.billing_access_state and
 * public.billing_overview, which run as their definer — so `authenticated`
 * needs no grant on them. It is deliberately not given one.
 */

-- =============================================================================
-- 14. Self-checks
--
-- These fail the deploy rather than the first customer.
-- =============================================================================

do $$
declare
  v_offenders text;
begin
  -- 1. Nothing anonymous, in either schema. The invariant the whole product
  --    rests on, re-asserted after every module.
  select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app')
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'The anonymous role can execute: %.', v_offenders;
  end if;

  -- 2. No client role may touch a billing table directly.
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, ', ')
    into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name like 'billing%'
    and grantee in ('anon', 'authenticated');

  if v_offenders is not null then
    raise exception 'Billing tables are directly accessible: %.', v_offenders;
  end if;

  -- 3. No client role may execute a billing service function.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app'
    and p.proname like 'billing%'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'A signed-in user can execute billing service functions: %.', v_offenders;
  end if;

  -- 4. Every billing table has RLS on.
  select string_agg(c.relname, ', ' order by c.relname)
    into v_offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname like 'billing%'
    and not c.relrowsecurity;

  if v_offenders is not null then
    raise exception 'Billing tables without row level security: %.', v_offenders;
  end if;

  -- 5. This deployment sells nothing, and says so. A migration that shipped a
  --    plan or a subscription would be inventing commercial policy.
  if exists (select 1 from public.billing_plans) then
    raise exception 'The billing catalogue must not be populated by a migration.';
  end if;
  if exists (select 1 from public.billing_subscriptions)
     or exists (select 1 from public.billing_customers) then
    raise exception 'Billing must not create a customer or a subscription at deploy time.';
  end if;

  -- 6. Exactly one platform-state row, and it must start unconfigured.
  if (select count(*) from public.billing_platform_state) <> 1 then
    raise exception 'billing_platform_state must hold exactly one row.';
  end if;

  /*
   * 7. Every billing writer announces itself to the guard trigger.
   *
   * A writer that forgets `perform app.billing_writing()` is refused by its own
   * guard the first time it updates a row — which would be discovered by a
   * customer, at the moment their subscription activated, rather than here.
   */
  select string_agg(p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where ((n.nspname = 'app' and p.proname in (
            'billing_report_platform_state', 'billing_claim_customer',
            'billing_record_checkout', 'billing_apply_subscription',
            'billing_apply_invoice', 'billing_claim_webhook_event',
            'billing_finish_webhook_event', 'billing_fail_webhook_event',
            'billing_replace_catalogue', 'billing_note_event'))
      or (n.nspname = 'public' and p.proname = 'billing_set_email'))
    and p.prosrc not like '%app.billing_writing()%';

  if v_offenders is not null then
    raise exception 'These write billing rows without announcing themselves to the guard: %.', v_offenders;
  end if;
end
$$;

select app.assert_views_are_security_invoker();
