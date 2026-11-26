alter table public.products add column price_usd numeric(12,2)
  check (price_usd >= 0 and price_usd < 'NaN'::numeric);

-- The existing admin_products RPC returns the product row type. Public product
-- reads retain their existing column grants and staff_lookups projects its own fields.
revoke select (price_usd) on public.products from public, anon, authenticated;

alter policy settings_read on public.settings
  using (key <> 'usd_exchange_rate' or public.is_admin());

alter policy settings_admin on public.settings
  using (key <> 'usd_exchange_rate' and public.is_admin())
  with check (key <> 'usd_exchange_rate' and public.is_admin());

-- Preserve the existing reporting fallback for any legacy item that has no snapshot.
insert into public.order_item_capital(item_id, capital, cost)
select i.id, p.price, 0
from public.order_items i join public.products p on p.id = i.product_id
where not exists (select 1 from public.order_item_capital c where c.item_id = i.id)
on conflict (item_id) do nothing;

create function public.save_catalog_product(
  p_id uuid, p_name text, p_price numeric, p_cost numeric, p_price_usd numeric
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  rate numeric;
  usd numeric(12,2);
begin
  if not public.is_admin() then raise exception 'غير مسموح'; end if;
  if p_price_usd is not null and not (p_price_usd >= 0 and p_price_usd < 'Infinity'::numeric) then
    raise exception 'أدخل سعرًا صالحًا بالدولار';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(61371, 1);
  usd := p_price_usd;
  if usd is not null then
    select value::numeric into rate from public.settings where key = 'usd_exchange_rate';
    if rate is null then raise exception 'حدّد سعر صرف الدولار من الإعدادات أولاً'; end if;
    p_price := round(usd * rate, 2);
  end if;
  if p_price is null or not (p_price >= 0 and p_price < 'Infinity'::numeric)
     or p_cost is null or not (p_cost >= 0 and p_cost < 'Infinity'::numeric)
     or coalesce(btrim(p_name), '') = '' then
    raise exception 'بيانات المنتج غير صحيحة';
  end if;

  if p_id is null then
    insert into public.products(name, price, cost, price_usd)
    values (btrim(p_name), p_price, p_cost, usd);
  else
    update public.products set name = btrim(p_name), price = p_price, cost = p_cost, price_usd = usd
    where id = p_id;
    if not found then raise exception 'المنتج غير موجود'; end if;
  end if;
end;
$$;

create function public.set_usd_exchange_rate(p_rate numeric) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not public.is_admin() then raise exception 'غير مسموح'; end if;
  if p_rate is null or not (p_rate > 0 and p_rate < 'Infinity'::numeric) then
    raise exception 'أدخل سعر صرف أكبر من الصفر';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(61371, 1);

  insert into public.settings(key, value)
  values ('usd_exchange_rate', p_rate::text), ('currency', 'ل.س')
  on conflict (key) do update set value = excluded.value;

  update public.products set price = round(price_usd * p_rate, 2)
  where price_usd is not null and price is distinct from round(price_usd * p_rate, 2);
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

revoke execute on function public.save_catalog_product(uuid, text, numeric, numeric, numeric),
  public.set_usd_exchange_rate(numeric) from public, anon;
grant execute on function public.save_catalog_product(uuid, text, numeric, numeric, numeric),
  public.set_usd_exchange_rate(numeric) to authenticated;
