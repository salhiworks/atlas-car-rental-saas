-- =============================================================================
-- Notification vocabulary for Billing
--
-- ADDING ENUM VALUES IS ITS OWN MIGRATION, AND HAS TO BE.
--
-- PostgreSQL will not let a value added by `alter type ... add value` be USED in
-- the transaction that added it. Both the Supabase CLI and the PGlite harness
-- apply one migration file as one transaction, so the values live here and
-- everything that reads or writes them lives in the next file. Splitting this
-- is not tidiness; a single file fails with
-- "unsafe use of new value of enum type" the first time it is applied.
--
-- Nothing here creates a notification. It creates the words one could be
-- written in.
-- =============================================================================

set search_path = public, extensions, pg_temp;

/*
 * A sixth category, alongside rentals, compliance, financing, gps and team.
 *
 * It is an owner's category — the only one above `admin` — because
 * src/lib/authz/permissions.ts declares 'billing.manage' as owner-only and this
 * enum's role thresholds mirror that file one for one. A manager who is told
 * "the card was declined" has been told the agency's financial business by a
 * notification list, which is exactly the leak the permission exists to stop.
 */
alter type public.notification_category add value if not exists 'billing';

/*
 * Six kinds, one per fact worth interrupting somebody for. Deliberately not one
 * per Stripe webhook: `invoice.created`, `invoice.finalized`,
 * `payment_intent.succeeded` and a dozen others are Stripe's plumbing, and
 * copying plumbing into an inbox is how an inbox stops being read.
 */
alter type public.notification_kind add value if not exists 'billing_subscription_activated';
alter type public.notification_kind add value if not exists 'billing_payment_failed';
alter type public.notification_kind add value if not exists 'billing_payment_recovered';
alter type public.notification_kind add value if not exists 'billing_cancellation_scheduled';
alter type public.notification_kind add value if not exists 'billing_subscription_ended';
alter type public.notification_kind add value if not exists 'billing_plan_changed';

-- The current condition, as distinct from the events above: this one is derived
-- from live billing state on every read and resolves itself when the
-- subscription becomes healthy again.
alter type public.notification_kind add value if not exists 'billing_attention_required';
