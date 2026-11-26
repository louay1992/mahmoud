
create table if not exists marketers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  governorate text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists marketer_payments (
  id uuid primary key default gen_random_uuid(),
  marketer_id uuid not null references marketers(id),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now()
);
alter table orders add column if not exists marketer_id uuid references marketers(id);

create table if not exists order_item_capital (
  item_id uuid primary key references order_items(id) on delete cascade,
  capital numeric(12,2) not null default 0
);
insert into order_item_capital(item_id, capital) select id, list_price from order_items on conflict do nothing;

alter table marketers enable row level security;
alter table marketer_payments enable row level security;
alter table order_item_capital enable row level security;
create policy admin_all on marketers for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on marketer_payments for all to authenticated using (is_admin()) with check (is_admin());
create policy admin_all on order_item_capital for all to authenticated using (is_admin()) with check (is_admin());
revoke all on marketers, marketer_payments, order_item_capital from anon;
grant select, insert, update, delete on marketers, marketer_payments, order_item_capital to authenticated;

-- رأس المال (products.price) مخفي عن الكباتن
revoke select on products from authenticated;
grant select (id, name, active, created_at) on products to authenticated;
create or replace function admin_products() returns setof products
language sql security definer set search_path = public stable as $$
  select * from products where is_admin() order by name $$;
revoke execute on function admin_products() from public, anon;
grant execute on function admin_products() to authenticated;

create or replace function trg_item_capital() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into order_item_capital(item_id, capital) select new.id, p.price from products p where p.id = new.product_id
  on conflict (item_id) do nothing;
  return new;
end $$;
revoke execute on function trg_item_capital() from public, anon, authenticated;
drop trigger if exists item_capital on order_items;
create trigger item_capital after insert on order_items for each row execute function trg_item_capital();

create or replace view order_profits with (security_invoker = true) as
select o.id as order_id, o.order_no, o.marketer_id, o.status, o.delivered_at, o.customer_name, o.items_total,
  coalesce(sum(c.capital * i.qty), 0) as capital,
  o.items_total - coalesce(sum(c.capital * i.qty), 0) as profit
from orders o left join order_items i on i.order_id = o.id left join order_item_capital c on c.item_id = i.id
group by o.id;

create or replace view marketer_balances with (security_invoker = true) as
select m.id as marketer_id, m.name,
  coalesce((select count(*) from order_profits p where p.marketer_id = m.id and p.status = 'delivered'), 0) as delivered_count,
  coalesce((select sum(profit) from order_profits p where p.marketer_id = m.id and p.status = 'delivered'), 0) as earned,
  coalesce((select sum(amount) from marketer_payments x where x.marketer_id = m.id), 0) as paid,
  coalesce((select sum(profit) from order_profits p where p.marketer_id = m.id and p.status = 'delivered'), 0)
   - coalesce((select sum(amount) from marketer_payments x where x.marketer_id = m.id), 0) as balance,
  coalesce((select sum(profit) from order_profits p where p.marketer_id = m.id and p.status in ('new','assigned','in_delivery','no_answer','closed','other')), 0) as pending
from marketers m;
grant select on order_profits, marketer_balances to authenticated;
revoke all on order_profits, marketer_balances from anon;

drop function if exists create_order(text,text,text,uuid,jsonb,text,text);
create or replace function create_order(p_name text, p_phone text, p_note text, p_captain uuid, p_items jsonb, p_address text default null, p_map text default null, p_marketer uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare oid uuid; it jsonb; pr numeric; up numeric; sub numeric := 0; fee numeric := 0;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  if p_captain is not null then select delivery_fee into fee from captains where id = p_captain; end if;
  insert into orders(customer_name, customer_phone, note, captain_id, status, delivery_fee, customer_address, map_url, marketer_id)
  values (p_name, p_phone, p_note, p_captain, case when p_captain is null then 'new' else 'assigned' end, coalesce(fee,0),
          nullif(trim(coalesce(p_address,'')),''), nullif(trim(coalesce(p_map,'')),''), p_marketer)
  returning id into oid;
  for it in select * from jsonb_array_elements(p_items) loop
    select price into pr from products where id = (it->>'product_id')::uuid;
    up := coalesce(nullif(it->>'unit_price','')::numeric, pr);
    if up < 0 then raise exception 'السعر لا يكون سالباً'; end if;
    insert into order_items(order_id, product_id, qty, unit_price, list_price)
    values (oid, (it->>'product_id')::uuid, (it->>'qty')::int, up, up);
    sub := sub + up * (it->>'qty')::int;
  end loop;
  update orders set items_total = sub, list_total = sub, total = sub + coalesce(fee,0) where id = oid;
  return oid;
end $$;
revoke execute on function create_order(text,text,text,uuid,jsonb,text,text,uuid) from public, anon;
grant execute on function create_order(text,text,text,uuid,jsonb,text,text,uuid) to authenticated;
