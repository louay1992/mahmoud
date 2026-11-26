-- ===== الإعدادات =====
create table if not exists settings (key text primary key, value text);
insert into settings(key, value) values ('business_name','متجري'), ('currency','د.أ'), ('low_stock','3')
on conflict (key) do nothing;
alter table settings enable row level security;
drop policy if exists settings_read on settings;
create policy settings_read on settings for select to authenticated using (true);
drop policy if exists settings_admin on settings;
create policy settings_admin on settings for all to authenticated using (is_admin()) with check (is_admin());
grant select, insert, update, delete on settings to authenticated;

-- ===== إدارة الإداريين =====
drop policy if exists admins_admin_all on admins;
create policy admins_admin_all on admins for all to authenticated using (is_admin()) with check (is_admin());
grant insert, delete on admins to authenticated;

create or replace function trg_keep_one_admin() returns trigger language plpgsql as $$
begin
  if (select count(*) from admins) <= 1 then raise exception 'لا يمكن حذف آخر إداري'; end if;
  return old;
end $$;
drop trigger if exists keep_one_admin on admins;
create trigger keep_one_admin before delete on admins for each row execute function trg_keep_one_admin();

-- ===== سجل حركة المخزون =====
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  product_id uuid not null references products(id),
  qty integer not null,
  kind text not null check (kind in ('invoice','sale','return','adjust','transfer_in','transfer_out')),
  order_id uuid references orders(id) on delete set null,
  note text,
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
alter table stock_movements enable row level security;
drop policy if exists mv_admin on stock_movements;
create policy mv_admin on stock_movements for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists mv_captain on stock_movements;
create policy mv_captain on stock_movements for select to authenticated
  using (warehouse_id in (select id from warehouses where captain_id = my_captain_id()));
grant select, insert, update, delete on stock_movements to authenticated;

-- ===== حالة «مرتجع» =====
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('new','assigned','delivered','cancelled','returned'));

-- ===== فاتورة المخزون تسجّل حركة =====
create or replace function trg_stock_invoice_item() returns trigger
language plpgsql security definer set search_path = public as $$
declare wh uuid; nt text;
begin
  select warehouse_id, note into wh, nt from stock_invoices where id = new.invoice_id;
  insert into stock(warehouse_id, product_id, qty) values (wh, new.product_id, new.qty)
  on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
  insert into stock_movements(warehouse_id, product_id, qty, kind, note) values (wh, new.product_id, new.qty, 'invoice', nt);
  return new;
end $$;

-- ===== التسليم يسجّل حركة بيع =====
create or replace function deliver_order(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; wh uuid; r record;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status <> 'assigned' then raise exception 'الطلب ليس بحالة مُسند'; end if;

  select id into wh from warehouses where captain_id = o.captain_id;
  if wh is null then raise exception 'لا يوجد مستودع مرتبط بهذا الكابتن'; end if;

  for r in
    select p.name, need.qty as needed, coalesce(s.qty, 0) as available
    from (select product_id, sum(qty) as qty from order_items where order_id = p_order group by product_id) need
    join products p on p.id = need.product_id
    left join stock s on s.warehouse_id = wh and s.product_id = need.product_id
    where coalesce(s.qty, 0) < need.qty
  loop
    raise exception 'المنتج "%" غير متوفر بالكمية المطلوبة في مستودع الكابتن (المطلوب %، المتوفر %). يجب تحديث الجرد أولاً.', r.name, r.needed, r.available;
  end loop;

  update stock st set qty = st.qty - need.qty
  from (select product_id, sum(qty) as qty from order_items where order_id = p_order group by product_id) need
  where st.warehouse_id = wh and st.product_id = need.product_id;

  insert into stock_movements(warehouse_id, product_id, qty, kind, order_id, note)
  select wh, product_id, -sum(qty), 'sale', p_order, 'طلب #' || o.order_no from order_items where order_id = p_order group by product_id;

  update orders set status = 'delivered', delivered_at = now() where id = p_order;
end $$;

-- ===== إرجاع طلب مُسلَّم (إداري) =====
create or replace function return_order(p_order uuid, p_restock boolean default true, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; wh uuid;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status <> 'delivered' then raise exception 'يمكن إرجاع الطلبات المُسلَّمة فقط'; end if;
  update orders set status = 'returned', captain_note = coalesce(p_note, captain_note) where id = p_order;
  if p_restock then
    select id into wh from warehouses where captain_id = o.captain_id;
    if wh is not null then
      insert into stock(warehouse_id, product_id, qty)
      select wh, product_id, sum(qty) from order_items where order_id = p_order group by product_id
      on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
      insert into stock_movements(warehouse_id, product_id, qty, kind, order_id, note)
      select wh, product_id, sum(qty), 'return', p_order, 'مرتجع طلب #' || o.order_no from order_items where order_id = p_order group by product_id;
    end if;
  end if;
end $$;

-- ===== تسوية الجرد: ضبط الكمية الفعلية =====
create or replace function adjust_stock(p_warehouse uuid, p_product uuid, p_new_qty integer, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare cur integer;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_new_qty < 0 then raise exception 'الكمية لا تكون سالبة'; end if;
  select qty into cur from stock where warehouse_id = p_warehouse and product_id = p_product;
  cur := coalesce(cur, 0);
  if cur = p_new_qty then return; end if;
  insert into stock(warehouse_id, product_id, qty) values (p_warehouse, p_product, p_new_qty)
  on conflict (warehouse_id, product_id) do update set qty = excluded.qty;
  insert into stock_movements(warehouse_id, product_id, qty, kind, note)
  values (p_warehouse, p_product, p_new_qty - cur, 'adjust', coalesce(p_note, 'تسوية جرد'));
end $$;

-- ===== نقل بضاعة بين مستودعين =====
create or replace function transfer_stock(p_from uuid, p_to uuid, p_product uuid, p_qty integer, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare cur integer;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_from = p_to then raise exception 'اختر مستودعين مختلفين'; end if;
  if p_qty <= 0 then raise exception 'الكمية يجب أن تكون أكبر من صفر'; end if;
  select qty into cur from stock where warehouse_id = p_from and product_id = p_product;
  if coalesce(cur, 0) < p_qty then raise exception 'الكمية غير متوفرة في المستودع المصدر (المتوفر %)', coalesce(cur, 0); end if;
  update stock set qty = qty - p_qty where warehouse_id = p_from and product_id = p_product;
  insert into stock(warehouse_id, product_id, qty) values (p_to, p_product, p_qty)
  on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
  insert into stock_movements(warehouse_id, product_id, qty, kind, note) values
    (p_from, p_product, -p_qty, 'transfer_out', p_note),
    (p_to, p_product, p_qty, 'transfer_in', p_note);
end $$;

-- ===== إحصاءات الرئيسية =====
create or replace function dashboard_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare low int; day_start timestamptz; res jsonb;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select coalesce((select value::int from settings where key = 'low_stock'), 3) into low;
  day_start := date_trunc('day', now() at time zone 'Asia/Amman') at time zone 'Asia/Amman';
  select jsonb_build_object(
    'new_orders', (select count(*) from orders where status = 'new'),
    'in_delivery', (select count(*) from orders where status = 'assigned'),
    'delivered_today', (select count(*) from orders where status = 'delivered' and delivered_at >= day_start),
    'sales_today', (select coalesce(sum(items_total), 0) from orders where status = 'delivered' and delivered_at >= day_start),
    'owed_total', (select coalesce(sum(balance), 0) from captain_balances),
    'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('warehouse', w.name, 'product', p.name, 'qty', s.qty) order by s.qty), '[]'::jsonb)
                  from stock s join warehouses w on w.id = s.warehouse_id join products p on p.id = s.product_id
                  where s.qty <= low and p.active)
  ) into res;
  return res;
end $$;

-- ===== مسح البيانات التجريبية (إداري) =====
create or replace function reset_test_data() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  truncate order_items, orders, captain_payments, stock_invoice_items, stock_invoices, stock_movements, stock restart identity;
end $$;

revoke execute on function return_order, adjust_stock, transfer_stock, dashboard_stats, reset_test_data from public, anon;
grant execute on function return_order, adjust_stock, transfer_stock, dashboard_stats, reset_test_data to authenticated;