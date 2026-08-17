-- =============================================================================
-- 20260815100300_line_item_defaults.sql
--
-- Makes rental_line_items survive a PostgREST bulk insert.
--
-- Found by the live smoke test, not by the harness. PostgREST builds one
-- statement for an array of rows and takes the union of their keys, filling any
-- key a given row omits with an explicit NULL. A column default only applies
-- when the column is absent from the statement altogether — so inserting three
-- charges at once, where only the first specifies `quantity`, made the other two
-- fail with a not-null violation on a column that has a default.
--
-- Adding several charges in one request is an ordinary thing to do, so the fix
-- belongs here rather than in a rule every caller has to remember.
-- =============================================================================

set search_path = public, extensions, pg_temp;

create or replace function app.rental_line_items_inherit_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency public.currency_code;
begin
  select r.currency into v_currency from public.rentals r where r.id = new.rental_id;
  if v_currency is null then
    raise exception 'Rental not found.' using errcode = 'P0002';
  end if;

  -- A line item is always in the contract's currency. Taking it from the rental
  -- rather than trusting the caller means a mixed-currency contract — whose
  -- total would be meaningless — cannot be created at all.
  new.currency := v_currency;

  -- An explicit NULL from a bulk insert means "not specified", which is what
  -- the column default already answers.
  new.quantity          := coalesce(new.quantity, 1);
  new.unit_amount_minor := coalesce(new.unit_amount_minor, new.amount_minor);
  new.is_taxable        := coalesce(new.is_taxable, true);
  new.sort_order        := coalesce(new.sort_order, 0);
  new.kind              := coalesce(new.kind, 'other');

  return new;
end;
$$;

comment on function app.rental_line_items_inherit_currency() is
  'Forces a line item into the contract currency and fills the explicit NULLs a PostgREST bulk insert produces for omitted defaulted columns.';
