-- Add these checks after the earlier Auth UUID backfill. PostgreSQL applies a
-- NOT VALID check to row updates even when the changed column is unrelated.
alter table public.captains add constraint captains_finite_delivery_fee
  check (delivery_fee < 'Infinity'::numeric) not valid;
alter table public.orders add constraint orders_finite_amounts check (
  items_total between -9999999999.99 and 9999999999.99
  and delivery_fee between -9999999999.99 and 9999999999.99
  and total between -9999999999.99 and 9999999999.99
  and list_total between -9999999999.99 and 9999999999.99
  and owed_amount between -9999999999.99 and 9999999999.99
  and price_adjust between -9999999999.99 and 9999999999.99
  and shipping_cost < 'Infinity'::numeric) not valid;

-- Minimal read-only version signal used to coordinate GitHub-connected production deployments.
alter table public.settings add constraint settings_currency_display_text
check (key <> 'currency' or (char_length(value) <= 24 and value !~ '[<>[:cntrl:]]')) not valid;

create function public.delivery_schema_release() returns text
language sql immutable set search_path = pg_catalog as $$
  select '20261127223040'::text
$$;

revoke all on function public.delivery_schema_release() from public;
grant execute on function public.delivery_schema_release() to anon;

notify pgrst, 'reload schema';
