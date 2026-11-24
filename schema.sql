-- =====================================================
-- نظام إدارة كباتن التوصيل - قاعدة البيانات (Supabase)
-- الصق هذا الملف كاملاً في: Supabase > SQL Editor > Run
-- =====================================================

-- ---------- الجداول ----------
create table if not exists admins (
  email text primary key
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(12,2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists captains (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text unique,                       -- بريد دخول الكابتن (يُنشأ له حساب في Supabase Auth)
  delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  captain_id uuid unique references captains(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists stock (
  warehouse_id uuid references warehouses(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  qty integer not null default 0,
  primary key (warehouse_id, product_id)
);

create table if not exists stock_invoices (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists stock_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references stock_invoices(id) on delete cascade,
  product_id uuid not null references products(id),
  qty integer not null check (qty > 0)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_no bigint generated always as identity,
  customer_name text not null,
  customer_phone text not null,
  note text,                               -- ملاحظة الطلب (من الإداري)
  captain_note text,                       -- ملاحظة الكابتن
  captain_id uuid references captains(id),
  status text not null default 'new' check (status in ('new','assigned','delivered','cancelled')),
  items_total numeric(12,2) not null default 0,
  delivery_fee numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid not null references products(id),
  qty integer not null check (qty > 0),
  unit_price numeric(12,2) not null
);

-- دفعات الكابتن (تُخصم من رصيده المستحق)
create table if not exists captain_payments (
  id uuid primary key default gen_random_uuid(),
  captain_id uuid not null references captains(id),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now()
);

-- ---------- دوال مساعدة ----------
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

create or replace function my_captain_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from captains where lower(email) = lower(auth.jwt() ->> 'email') limit 1;
$$;

-- ---------- تحديث الجرد تلقائياً عند إضافة فاتورة مخزون ----------
create or replace function trg_stock_invoice_item() returns trigger
language plpgsql security definer set search_path = public as $$
declare wh uuid;
begin
  select warehouse_id into wh from stock_invoices where id = new.invoice_id;
  insert into stock(warehouse_id, product_id, qty) values (wh, new.product_id, new.qty)
  on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
  return new;
end $$;

drop trigger if exists stock_invoice_item_ins on stock_invoice_items;
create trigger stock_invoice_item_ins after insert on stock_invoice_items
for each row execute function trg_stock_invoice_item();

-- ---------- إنشاء طلب (إداري فقط) ----------
-- p_items مثال: [{"product_id":"...","qty":2}]
create or replace function create_order(p_name text, p_phone text, p_note text, p_captain uuid, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare oid uuid; it jsonb; pr numeric; sub numeric := 0; fee numeric := 0;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  if p_captain is not null then select delivery_fee into fee from captains where id = p_captain; end if;

  insert into orders(customer_name, customer_phone, note, captain_id, status, delivery_fee)
  values (p_name, p_phone, p_note, p_captain, case when p_captain is null then 'new' else 'assigned' end, coalesce(fee,0))
  returning id into oid;

  for it in select * from jsonb_array_elements(p_items) loop
    select price into pr from products where id = (it->>'product_id')::uuid;
    insert into order_items(order_id, product_id, qty, unit_price)
    values (oid, (it->>'product_id')::uuid, (it->>'qty')::int, pr);
    sub := sub + pr * (it->>'qty')::int;
  end loop;

  update orders set items_total = sub, total = sub + coalesce(fee,0) where id = oid;
  return oid;
end $$;

-- ---------- إسناد الطلب لكابتن (يعيد احتساب أجور التوصيل) ----------
create or replace function assign_order(p_order uuid, p_captain uuid)
returns void language plpgsql security definer set search_path = public as $$
declare fee numeric;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select delivery_fee into fee from captains where id = p_captain;
  update orders set captain_id = p_captain, status = 'assigned', delivery_fee = fee, total = items_total + fee
  where id = p_order and status in ('new','assigned');
  if not found then raise exception 'لا يمكن إسناد هذا الطلب'; end if;
end $$;

-- ---------- تسليم الطلب (الإداري أو الكابتن صاحب الطلب) ----------
-- يخصم الكميات من مستودع الكابتن، وقيمة الطلب تصبح مستحقة عليه
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

  -- منع التسليم إن كان أي منتج غير متوفر أو كميته أقل من المطلوب في مستودع الكابتن
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

  update orders set status = 'delivered', delivered_at = now() where id = p_order;
end $$;

-- ---------- إلغاء الطلب / ملاحظة الكابتن ----------
create or replace function cancel_order(p_order uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  select * into o from orders where id = p_order for update;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status = 'delivered' then raise exception 'لا يمكن إلغاء طلب مُسلَّم'; end if;
  update orders set status = 'cancelled', captain_note = coalesce(p_note, captain_note) where id = p_order;
end $$;

create or replace function set_captain_note(p_order uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_admin() or (select captain_id from orders where id = p_order) = my_captain_id())
    then raise exception 'غير مسموح'; end if;
  update orders set captain_note = p_note where id = p_order;
end $$;

-- ---------- أرصدة الكباتن ----------
create or replace view captain_balances with (security_invoker = true) as
select c.id as captain_id, c.name,
  coalesce((select sum(items_total) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as delivered_total,
  coalesce((select sum(delivery_fee) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as fees_total,
  coalesce((select count(*) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as delivered_count,
  coalesce((select sum(amount) from captain_payments p where p.captain_id = c.id), 0) as paid_total,
  coalesce((select sum(items_total) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0)
   - coalesce((select sum(amount) from captain_payments p where p.captain_id = c.id), 0) as balance
from captains c;

-- ---------- الصلاحيات (RLS) ----------
alter table admins enable row level security;
alter table products enable row level security;
alter table captains enable row level security;
alter table warehouses enable row level security;
alter table stock enable row level security;
alter table stock_invoices enable row level security;
alter table stock_invoice_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table captain_payments enable row level security;

-- الإداري: كل شيء
do $$ declare t text; begin
  foreach t in array array['products','captains','warehouses','stock','stock_invoices','stock_invoice_items','orders','order_items','captain_payments'] loop
    execute format('drop policy if exists admin_all on %I', t);
    execute format('create policy admin_all on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;

-- الكابتن: قراءة بياناته فقط (الكتابة تتم عبر الدوال أعلاه)
drop policy if exists cap_products on products;
create policy cap_products on products for select to authenticated using (true);
drop policy if exists cap_self on captains;
create policy cap_self on captains for select to authenticated using (id = my_captain_id());
drop policy if exists cap_wh on warehouses;
create policy cap_wh on warehouses for select to authenticated using (captain_id = my_captain_id());
drop policy if exists cap_stock on stock;
create policy cap_stock on stock for select to authenticated
  using (warehouse_id in (select id from warehouses where captain_id = my_captain_id()));
drop policy if exists cap_orders on orders;
create policy cap_orders on orders for select to authenticated using (captain_id = my_captain_id());
drop policy if exists cap_order_items on order_items;
create policy cap_order_items on order_items for select to authenticated
  using (order_id in (select id from orders where captain_id = my_captain_id()));
drop policy if exists cap_payments on captain_payments;
create policy cap_payments on captain_payments for select to authenticated using (captain_id = my_captain_id());

revoke execute on function create_order, assign_order, deliver_order, cancel_order, set_captain_note, is_admin, my_captain_id from public, anon;
grant execute on function create_order, assign_order, deliver_order, cancel_order, set_captain_note, is_admin, my_captain_id to authenticated;

-- =====================================================
-- أخيراً: سجّل بريدك كإداري (غيّر البريد ثم شغّل السطر)
-- insert into admins(email) values ('your@email.com');
-- =====================================================

-- =====================================================
-- صلاحيات الجداول لمستخدمي Supabase المسجّلين (ضرورية في المشاريع الجديدة)
-- =====================================================
grant usage on schema public to authenticated;
grant select, insert, update, delete on products, captains, warehouses, stock, stock_invoices, stock_invoice_items, orders, order_items, captain_payments to authenticated;
grant select on admins, captain_balances to authenticated;
grant usage, select on all sequences in schema public to authenticated;

drop policy if exists admins_self on admins;
create policy admins_self on admins for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

-- =====================================================
-- الإصدار 2: الإعدادات، سجل حركة المخزون، المرتجعات، تسوية ونقل الجرد، لوحة الرئيسية
-- =====================================================
create table if not exists settings (key text primary key, value text);
insert into settings(key, value) values ('business_name','متجري'), ('currency','د.أ'), ('low_stock','3')
on conflict (key) do nothing;
alter table settings enable row level security;
drop policy if exists settings_read on settings;
create policy settings_read on settings for select to authenticated using (true);
drop policy if exists settings_admin on settings;
create policy settings_admin on settings for all to authenticated using (is_admin()) with check (is_admin());
grant select, insert, update, delete on settings to authenticated;

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

alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check check (status in ('new','assigned','delivered','cancelled','returned'));

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

create or replace function reset_test_data() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  truncate order_items, orders, captain_payments, stock_invoice_items, stock_invoices, stock_movements, stock restart identity;
end $$;

revoke execute on function return_order, adjust_stock, transfer_stock, dashboard_stats, reset_test_data from public, anon;
grant execute on function return_order, adjust_stock, transfer_stock, dashboard_stats, reset_test_data to authenticated;

-- =====================================================
-- الإصدار 3: حالات الطلب (لم يتم الرد / مغلق / ملاحظة أخرى) وسجل أحداث الطلب
-- =====================================================
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('new','assigned','no_answer','closed','other','delivered','cancelled','returned'));

create table if not exists order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  status text not null,
  note text,
  by_email text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create index if not exists order_events_order_idx on order_events(order_id, created_at);
alter table order_events enable row level security;
drop policy if exists ev_admin on order_events;
create policy ev_admin on order_events for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists ev_captain on order_events;
create policy ev_captain on order_events for select to authenticated
  using (order_id in (select id from orders where captain_id = my_captain_id()));
grant select, insert, update, delete on order_events to authenticated;

create or replace function trg_order_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into order_events(order_id, status, note) values (new.id, new.status, 'تم إنشاء الطلب');
  return new;
end $$;
drop trigger if exists order_created on orders;
create trigger order_created after insert on orders for each row execute function trg_order_created();

create or replace function assign_order(p_order uuid, p_captain uuid)
returns void language plpgsql security definer set search_path = public as $$
declare fee numeric; cn text;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select delivery_fee, name into fee, cn from captains where id = p_captain;
  update orders set captain_id = p_captain, status = 'assigned', delivery_fee = fee, total = items_total + fee
  where id = p_order and status in ('new','assigned','no_answer','closed','other');
  if not found then raise exception 'لا يمكن إسناد هذا الطلب'; end if;
  insert into order_events(order_id, status, note) values (p_order, 'assigned', 'أُسند إلى ' || cn);
end $$;

create or replace function set_order_status(p_order uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','no_answer','closed','other') then raise exception 'لا يمكن تغيير حالة هذا الطلب'; end if;
  if p_status not in ('assigned','no_answer','closed','other') then raise exception 'حالة غير صالحة'; end if;
  if p_status = 'other' and n is null then raise exception 'اكتب الملاحظة'; end if;
  update orders set status = p_status, captain_note = n where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, p_status, n);
end $$;

drop function if exists deliver_order(uuid);
create or replace function deliver_order(p_order uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; wh uuid; r record; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','no_answer','closed','other') then raise exception 'الطلب غير جاهز للتسليم'; end if;
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
  update orders set status = 'delivered', delivered_at = now(), captain_note = coalesce(n, captain_note) where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, 'delivered', n);
end $$;

create or replace function cancel_order(p_order uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status in ('delivered','cancelled','returned') then raise exception 'لا يمكن إلغاء هذا الطلب'; end if;
  update orders set status = 'cancelled', captain_note = coalesce(n, captain_note) where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, 'cancelled', n);
end $$;

create or replace function return_order(p_order uuid, p_restock boolean default true, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; wh uuid;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status <> 'delivered' then raise exception 'يمكن إرجاع الطلبات المُسلَّمة فقط'; end if;
  update orders set status = 'returned', captain_note = coalesce(p_note, captain_note) where id = p_order;
  insert into order_events(order_id, status, note)
  values (p_order, 'returned', case when p_restock then 'عادت البضاعة للمستودع' else 'مرتجع بدون إعادة للجرد' end);
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

create or replace function dashboard_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare low int; day_start timestamptz; res jsonb;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select coalesce((select value::int from settings where key = 'low_stock'), 3) into low;
  day_start := date_trunc('day', now() at time zone 'Asia/Amman') at time zone 'Asia/Amman';
  select jsonb_build_object(
    'by_status', (select coalesce(jsonb_object_agg(status, c), '{}'::jsonb) from (select status, count(*) c from orders group by status) x),
    'delivered_today', (select count(*) from orders where status = 'delivered' and delivered_at >= day_start),
    'sales_today', (select coalesce(sum(items_total), 0) from orders where status = 'delivered' and delivered_at >= day_start),
    'owed_total', (select coalesce(sum(balance), 0) from captain_balances),
    'low_stock', (select coalesce(jsonb_agg(jsonb_build_object('warehouse', w.name, 'product', p.name, 'qty', s.qty) order by s.qty), '[]'::jsonb)
                  from stock s join warehouses w on w.id = s.warehouse_id join products p on p.id = s.product_id
                  where s.qty <= low and p.active)
  ) into res;
  return res;
end $$;

revoke execute on function set_order_status, deliver_order, cancel_order, assign_order, return_order, dashboard_stats from public, anon;
grant execute on function set_order_status, deliver_order, cancel_order, assign_order, return_order, dashboard_stats to authenticated;
