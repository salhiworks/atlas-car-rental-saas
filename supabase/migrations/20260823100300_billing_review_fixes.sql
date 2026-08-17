-- =============================================================================
-- Billing: corrections found by attacking the deployed module
--
-- Six findings, each reproduced before being fixed here. Every one is a case
-- where the module said something untrue or refused something it must permit —
-- which is exactly the class this schema exists to prevent, so each fix comes
-- with a catalogue assertion or a test rather than a promise.
--
--   1. AN EMPTIED CATALOGUE HID A PAYING AGENCY'S SUBSCRIPTION. The worst of
--      them. app.billing_platform_configured() requires a sellable plan, and
--      app.billing_access_state_of returned `platform_unconfigured` when it was
--      false — so withdrawing the last plan from sale told every subscribed
--      agency that billing "is not set up", hid its plan, its price and its
--      renewal date, and dropped its attention notification. Withdrawing a plan
--      from SALE has nothing to do with whether an existing subscription is
--      real.
--
--   2. AN OLDER INVOICE EVENT COULD OVERWRITE A NEWER ONE. The ordering guard on
--      app.billing_apply_invoice compared the event's time against `synced_at`,
--      which is a write timestamp rather than an event timestamp. A late
--      invoice.paid could therefore clear latest_payment_failed_at that a newer
--      invoice.payment_failed had just set — and Stripe guarantees no ordering
--      and retries for three days.
--
--   3. AN AGENCY BECAME UNDELETABLE once a webhook event referenced it.
--      billing_webhook_events.organization_id is ON DELETE SET NULL, and the
--      guard's allowance named only the auth.users references — so the cascade's
--      own UPDATE was refused. The third time this class of defect has appeared
--      in this schema; this time the fix is expressed as "every nullable
--      reference on the table", not a hand-listed pair.
--
--   4. A DUPLICATE-SUBSCRIPTION ANOMALY WROTE A NEW ROW ON EVERY RETRY. The
--      anomaly is real and must be visible, but Stripe retries for three days,
--      so one genuine anomaly produced dozens of identical events and dozens of
--      notifications.
--
--   5. "CANCELS ON <date>" WAS SHOWN FOR A SUBSCRIPTION THAT HAD ALREADY ENDED,
--      contradicting its own "Cancelled" badge.
--
--   6. THE WEBHOOK COULD NOT MARK A STRIPE CUSTOMER DELETED. There was no
--      function for it, so the Edge Function wrote the table directly, the guard
--      refused it, and the discarded error left the event recorded as applied.
-- =============================================================================

set search_path = public, extensions, pg_temp;

-- -----------------------------------------------------------------------------
-- 1. A withdrawn plan is not an unconfigured platform
-- -----------------------------------------------------------------------------

/**
 * Whether this deployment can SELL a subscription.
 *
 * Unchanged in meaning, but the name now says what it decides: it is about
 * whether a new subscription can be started, and it is no longer allowed to
 * imply anything about subscriptions that already exist.
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

/**
 * What the product does about one agency's billing.
 *
 * THE ORDER OF THESE TESTS IS THE FIX. A subscription that exists is a fact
 * about this agency; a catalogue that has nothing for sale is a fact about the
 * deployment. Asking the second question first told a paying customer their
 * billing was not set up, hid their plan and their renewal date, and dropped the
 * notification that would have warned them about a failed payment.
 *
 * So: if this agency has a subscription we have ever been told about, its status
 * decides. Only an agency with no subscription at all can resolve to
 * `platform_unconfigured`, and only while the platform genuinely is.
 *
 * `restricted` is still unreachable, and still deliberately so: no commercial
 * restriction policy has been decided, and a migration is not where one gets
 * decided.
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
  v_subscription := app.billing_effective_subscription(p_organization_id);

  -- A subscription this agency actually has. Its state is the answer, whatever
  -- the catalogue currently offers for sale.
  if v_subscription.id is not null then
    return case v_subscription.status
      when 'active'   then 'normal'
      when 'trialing' then 'normal'
      /*
       * Everything else needs an owner, and is deliberately not collapsed
       * further:
       *   past_due / unpaid   a payment failed and Stripe is retrying, or has
       *                       stopped retrying
       *   incomplete          a checkout whose first payment never completed;
       *                       terminal after 23 hours
       *   incomplete_expired  that 23 hours has passed — a new subscription is
       *                       required, this one cannot be revived
       *   paused              a trial ended with no payment method
       *   canceled            terminal
       */
      else 'attention'
    end;
  end if;

  -- No subscription, and nothing to sell. Billing has not launched here: access
  -- is normal, and this is not a subscription, an exemption or a grandfathered
  -- plan.
  if not app.billing_platform_configured() then
    return 'platform_unconfigured';
  end if;

  -- Configured, but this agency has not chosen a plan. An owner has something to
  -- do; nothing is taken away.
  return 'attention';
end;
$$;

comment on function app.billing_access_state_of(uuid) is
  'Stripe status -> product access, in one place. An existing subscription always decides; only an agency with none can resolve to platform_unconfigured. Never returns restricted today: no restriction policy has been decided.';

-- -----------------------------------------------------------------------------
-- 2. The Billing page stops contradicting itself
-- -----------------------------------------------------------------------------

/**
 * The Billing workspace, for the owner.
 *
 * Three corrections to what it reports:
 *
 *   * `cancel_effective_at` is null once the subscription has ended. Showing
 *     "cancels on the 4th" beside a "Cancelled" badge is the page arguing with
 *     itself, and the reader believes whichever half is worse for them.
 *
 *   * `trial_end` is reported only while it is in the future. Stripe keeps
 *     trial_end forever, so a year-old trial was rendering as "Trial ends" with
 *     a date in the past.
 *
 *   * `catalog_configured` no longer decides whether the page shows a
 *     subscription. It still says whether anything is for sale, because plan
 *     selection needs to know.
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

  pending_checkout      boolean,
  pending_checkout_at   timestamptz,

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
  v_ended        boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not app.has_min_role(p_organization_id, 'owner') then
    raise exception 'Only an owner can see billing for this organization.' using errcode = '42501';
  end if;

  select * into v_state from public.billing_platform_state where id;
  v_subscription := app.billing_effective_subscription(p_organization_id);

  v_ended := v_subscription.id is not null
             and (v_subscription.ended_at is not null
                  or v_subscription.status in ('canceled', 'incomplete_expired'));

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
    -- Either of Stripe's two facts means "this ends", and neither means anything
    -- once it already has.
    (not v_ended)
      and (coalesce(v_subscription.cancel_at_period_end, false)
           or v_subscription.cancel_at is not null),
    case when v_ended then null
         else coalesce(v_subscription.cancel_at, v_subscription.current_period_end) end,
    v_subscription.canceled_at,
    v_subscription.ended_at,
    -- Stripe keeps trial_end forever; a trial that finished is not a trial.
    case when v_subscription.trial_end > now() then v_subscription.trial_end end,
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

-- -----------------------------------------------------------------------------
-- 3. Invoice events stop overwriting each other out of order
-- -----------------------------------------------------------------------------

alter table public.billing_subscriptions
  add column if not exists latest_invoice_event_at timestamptz;

comment on column public.billing_subscriptions.latest_invoice_event_at is
  'Creation time of the Stripe event that produced the latest_invoice_* columns. Compared against an arriving event so a late invoice.paid cannot clear a newer payment failure.';

/**
 * The latest invoice outcome, and only if it really is the latest.
 *
 * The previous version compared the arriving event against `synced_at`, which is
 * when we last WROTE the row — not when Stripe generated what we wrote. A late
 * invoice.paid therefore looked newer than the invoice.payment_failed that had
 * just been applied, and cleared `latest_payment_failed_at`: an owner whose card
 * had failed would have seen a healthy subscription.
 *
 * Now the comparison is event time against event time, which is the only pair
 * that means anything when the provider guarantees no ordering and retries for
 * three days.
 *
 * Still sanitised: an amount, a currency, a status and a time. No decline code,
 * no payment method, no card.
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
  v_existing     timestamptz;
  v_found        boolean;
begin
  perform app.billing_writing();

  select c.organization_id into v_organization
  from public.billing_customers c
  where c.stripe_customer_id = p_stripe_customer_id;

  if v_organization is null then
    return 'unknown_customer';
  end if;

  perform app.lock_organization_billing(v_organization);

  select s.latest_invoice_event_at, true into v_existing, v_found
  from public.billing_subscriptions s
  where s.stripe_subscription_id = p_stripe_subscription_id
    and s.organization_id = v_organization;

  if not coalesce(v_found, false) then
    -- The subscription has not arrived yet. Stripe does not order its events, so
    -- this is ordinary; the caller retries rather than discarding it.
    return 'no_subscription';
  end if;

  -- An invoice event older than the one already applied changes nothing.
  if v_existing is not null and p_event_at < v_existing then
    return 'stale';
  end if;

  update public.billing_subscriptions s
     set latest_invoice_id           = p_invoice_id,
         latest_invoice_status       = left(p_invoice_status, 40),
         latest_invoice_amount_minor = p_amount_minor,
         latest_invoice_currency     = nullif(btrim(coalesce(p_currency, '')), '')::public.currency_code,
         latest_payment_failed_at    = case when coalesce(p_failed, false) then p_event_at
                                            else null end,
         latest_invoice_event_at     = p_event_at,
         synced_at                   = now()
   where s.stripe_subscription_id = p_stripe_subscription_id
     and s.organization_id = v_organization;

  if coalesce(p_failed, false) then
    insert into public.billing_events
      (organization_id, kind, summary, stripe_object_id, stripe_event_id)
    values (v_organization, 'payment_failed', 'A subscription payment did not go through.',
            p_invoice_id, p_event_id);
  end if;

  return 'applied';
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. The guard permits every referential action, not two of them
-- -----------------------------------------------------------------------------

/**
 * Billing rows are written by the billing service, and by nothing else.
 *
 * The correction: the set of columns a referential action may null is now
 * DERIVED from the table's own foreign keys rather than hand-listed. The
 * hand-listed version named the two auth.users references and missed
 * billing_webhook_events.organization_id, which is ON DELETE SET NULL — so
 * deleting an agency that had ever received a webhook was refused by this guard.
 *
 * That is the third time in this schema that a guard has made a row undeletable
 * by refusing a referential action. Listing columns by hand is what makes it
 * recur, so it is not done here: any nullable foreign key added to a billing
 * table later is covered without anybody remembering to come back.
 *
 * Everything else is unchanged. A write announced by a billing service function
 * passes; a cascade whose parent agency is already gone passes; anything else
 * raises.
 */
create or replace function app.billing_rows_are_server_written()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new       jsonb;
  v_old       jsonb;
  v_org       uuid;
  v_nullable  text[];
  v_column    text;
  v_changed   boolean := false;
begin
  -- The billing service, mid-transaction. Everything it does is deliberate.
  if coalesce(current_setting('app.billing_writer', true), '') = 'on' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    v_org := case when to_jsonb(old) ? 'organization_id'
                  then (to_jsonb(old) ->> 'organization_id')::uuid end;
    -- The agency cascade: the parent row has already left this transaction's
    -- view by the time the cascade reaches here, and nothing grants a browser
    -- DELETE on organizations at any role.
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
   * Every column on THIS table that a foreign key may set to NULL, read from the
   * catalogue. `updated_at` joins them because a sibling trigger stamps it.
   */
  select coalesce(array_agg(a.attname::text), array[]::text[]) into v_nullable
  from pg_constraint k
  join unnest(k.conkey) as key(attnum) on true
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = key.attnum
  where k.conrelid = tg_relid
    and k.contype = 'f'
    and k.confdeltype = 'n'   -- ON DELETE SET NULL
    and not a.attnotnull;

  v_nullable := v_nullable || array['updated_at'];

  -- Everything outside those columns must be byte-identical, so a column added
  -- to a billing table later cannot quietly become editable.
  foreach v_column in array v_nullable loop
    v_new := v_new - v_column;
    v_old := v_old - v_column;
  end loop;

  if v_new = v_old then
    -- And each of those columns may only move to NULL, with at least one moving.
    foreach v_column in array v_nullable loop
      if v_column = 'updated_at' then
        continue;
      end if;
      if to_jsonb(new) -> v_column is distinct from to_jsonb(old) -> v_column then
        if to_jsonb(new) -> v_column <> 'null'::jsonb then
          raise exception 'Billing records are written by the billing service, not by clients.'
            using errcode = '42501';
        end if;
        v_changed := true;
      end if;
    end loop;

    if v_changed then
      return new;
    end if;
  end if;

  raise exception 'Billing records are written by the billing service, not by clients.'
    using errcode = '42501';
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. One anomaly is recorded once, however many times Stripe retries
-- -----------------------------------------------------------------------------

/*
 * A duplicate live subscription is a real Stripe-side anomaly and must stay
 * visible. But Stripe retries a non-2xx for three days, so the previous version
 * wrote a fresh anomaly_detected row — and therefore a fresh notification — on
 * every attempt. One per subscription is what support needs.
 */
create unique index if not exists billing_events_one_anomaly_per_object
  on public.billing_events (organization_id, stripe_object_id)
  where kind = 'anomaly_detected';

/**
 * The projection writer.
 *
 * Unchanged except in the anomaly branch, which now records the anomaly at most
 * once per subscription and returns a verdict the caller can settle on: retrying
 * a genuine "Stripe has two live subscriptions for this customer" will not
 * resolve it, and three days of retries only bury the evidence.
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

  if v_organization is null then
    return 'unknown_customer';
  end if;

  perform app.lock_organization_billing(v_organization);

  select * into v_existing
  from public.billing_subscriptions s
  where s.stripe_subscription_id = p_stripe_subscription_id;

  if v_existing.id is not null and p_event_at < v_existing.stripe_event_at then
    return 'stale';
  end if;

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

  update public.billing_checkout_sessions s
     set state = 'completed', completed_at = coalesce(s.completed_at, now())
   where s.organization_id = v_organization
     and s.state = 'open';

  return 'applied';

exception
  when unique_violation then
    /*
     * The partial unique index refused a second live subscription for this
     * agency: Stripe has two, and choosing between two paid subscriptions is not
     * a decision a trigger should make at three in the morning.
     *
     * Recorded at most once per subscription — the second unique index above —
     * so three days of Stripe retries produce one anomaly and one notification
     * rather than dozens.
     */
    insert into public.billing_events
      (organization_id, kind, summary, stripe_object_id, stripe_event_id, context)
    values (v_organization, 'anomaly_detected',
            'Stripe reported a second live subscription for this agency.',
            p_stripe_subscription_id, p_event_id,
            jsonb_build_object('constraint', 'one_live_per_org'))
    on conflict do nothing;
    return 'anomaly';
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. The webhook can mark a Stripe customer deleted
-- -----------------------------------------------------------------------------

/**
 * Records that Stripe says this customer is gone.
 *
 * The mapping stays: the identifier must not be reused, and support needs to
 * know what happened to it. `coalesce` makes a redelivery a no-op rather than
 * moving the timestamp.
 *
 * This exists because the webhook was writing the table directly — the one write
 * in the module that was not a service function — and the guard refused it while
 * the discarded error left the event recorded as applied.
 */
create or replace function app.billing_mark_customer_deleted(p_stripe_customer_id text)
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

  update public.billing_customers c
     set deleted_at = coalesce(c.deleted_at, now())
   where c.stripe_customer_id = p_stripe_customer_id
  returning c.organization_id into v_organization;

  if v_organization is null then
    return 'unknown_customer';
  end if;

  insert into public.billing_events
    (organization_id, kind, summary, stripe_object_id)
  values (v_organization, 'anomaly_detected',
          'Our payment provider reports this agency''s billing account as deleted.',
          p_stripe_customer_id)
  on conflict do nothing;

  return 'applied';
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

revoke all on function app.billing_mark_customer_deleted(text) from public, anon;
grant execute on function app.billing_mark_customer_deleted(text) to service_role;

-- -----------------------------------------------------------------------------
-- Self-checks
-- -----------------------------------------------------------------------------

do $$
declare
  v_offenders text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'app')
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception 'The anonymous role can execute: %.', v_offenders;
  end if;

  -- Every billing writer still announces itself to the guard, including the new
  -- one. A writer that forgets is refused by its own trigger the first time a
  -- customer's subscription changes.
  select string_agg(p.proname, ', ' order by p.proname)
    into v_offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where ((n.nspname = 'app' and p.proname in (
            'billing_report_platform_state', 'billing_claim_customer',
            'billing_record_checkout', 'billing_apply_subscription',
            'billing_apply_invoice', 'billing_claim_webhook_event',
            'billing_finish_webhook_event', 'billing_fail_webhook_event',
            'billing_replace_catalogue', 'billing_note_event',
            'billing_mark_customer_deleted'))
      or (n.nspname = 'public' and p.proname = 'billing_set_email'))
    and p.prosrc not like '%app.billing_writing()%';

  if v_offenders is not null then
    raise exception 'These write billing rows without announcing themselves to the guard: %.', v_offenders;
  end if;

  /*
   * The guard derives its allowance from the catalogue rather than a hand-written
   * list. If somebody replaces it with a list again, the defect that made an
   * agency undeletable comes back — so the shape is asserted.
   */
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'billing_rows_are_server_written')
     not like '%confdeltype%' then
    raise exception
      'The billing guard must derive its nullable references from pg_constraint, not from a hand-written list.';
  end if;

  -- An agency with a subscription is never reported as an unconfigured platform.
  if (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = 'billing_access_state_of')
     not like '%v_subscription.id is not null%' then
    raise exception 'billing_access_state_of must consider an existing subscription first.';
  end if;
end
$$;

select app.assert_views_are_security_invoker();
