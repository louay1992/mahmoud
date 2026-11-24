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

-- =====================================================
-- الإصدار 4: حالة «قيد التوصيل» (الكابتن يستلم الطلب) واسترجاع الطلب الملغي
-- =====================================================
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('new','assigned','in_delivery','no_answer','closed','other','delivered','cancelled','returned'));

create or replace function assign_order(p_order uuid, p_captain uuid)
returns void language plpgsql security definer set search_path = public as $$
declare fee numeric; cn text;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select delivery_fee, name into fee, cn from captains where id = p_captain;
  update orders set captain_id = p_captain, status = 'assigned', delivery_fee = fee, total = items_total + fee, captain_note = null
  where id = p_order and status in ('new','assigned','in_delivery','no_answer','closed','other');
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
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن تغيير حالة هذا الطلب'; end if;
  if p_status not in ('in_delivery','no_answer','closed','other') then raise exception 'حالة غير صالحة'; end if;
  if p_status = 'other' and n is null then raise exception 'اكتب الملاحظة'; end if;
  update orders set status = p_status, captain_note = n where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, p_status, n);
end $$;

-- (دالة deliver_order في الإصدار 3 تُحدَّث لتقبل الحالات المفتوحة الخمس)
create or replace function deliver_order(p_order uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; wh uuid; r record; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'الطلب غير جاهز للتسليم'; end if;
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

create or replace function restore_order(p_order uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; n text := nullif(trim(coalesce(p_note, '')), ''); ns text;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status <> 'cancelled' then raise exception 'يمكن استرجاع الطلبات الملغية فقط'; end if;
  ns := case when o.captain_id is null then 'new' else 'assigned' end;
  update orders set status = ns, captain_note = null where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, ns, 'استرجاع الطلب' || coalesce(' — ' || n, ''));
end $$;

revoke execute on function restore_order, set_order_status, deliver_order, assign_order from public, anon;
grant execute on function restore_order, set_order_status, deliver_order, assign_order to authenticated;

-- =====================================================
-- الإصدار 5: فروقات الأسعار (السعر المثبت مقابل السعر الفعلي) ونمط الحساب
-- =====================================================
alter table order_items add column if not exists list_price numeric(12,2);
update order_items set list_price = unit_price where list_price is null;
alter table order_items alter column list_price set not null;

alter table orders add column if not exists list_total numeric(12,2) not null default 0;
alter table orders add column if not exists owed_amount numeric(12,2);
update orders set list_total = items_total where list_total = 0;
update orders set owed_amount = items_total where status = 'delivered' and owed_amount is null;

insert into settings(key, value) values ('price_mode','actual'), ('captain_can_edit_price','false')
on conflict (key) do nothing;

create or replace function create_order(p_name text, p_phone text, p_note text, p_captain uuid, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare oid uuid; it jsonb; pr numeric; up numeric; sub numeric := 0; lsub numeric := 0; fee numeric := 0;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  if p_captain is not null then select delivery_fee into fee from captains where id = p_captain; end if;
  insert into orders(customer_name, customer_phone, note, captain_id, status, delivery_fee)
  values (p_name, p_phone, p_note, p_captain, case when p_captain is null then 'new' else 'assigned' end, coalesce(fee,0))
  returning id into oid;
  for it in select * from jsonb_array_elements(p_items) loop
    select price into pr from products where id = (it->>'product_id')::uuid;
    up := coalesce(nullif(it->>'unit_price','')::numeric, pr);
    if up < 0 then raise exception 'السعر لا يكون سالباً'; end if;
    insert into order_items(order_id, product_id, qty, unit_price, list_price)
    values (oid, (it->>'product_id')::uuid, (it->>'qty')::int, up, pr);
    sub := sub + up * (it->>'qty')::int;
    lsub := lsub + pr * (it->>'qty')::int;
  end loop;
  update orders set items_total = sub, list_total = lsub, total = sub + coalesce(fee,0) where id = oid;
  return oid;
end $$;

create or replace function update_order_prices(p_order uuid, p_prices jsonb, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; it jsonb; n text := nullif(trim(coalesce(p_note, '')), ''); newp numeric; oldp numeric; pn text; chg text := '';
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or (o.captain_id = my_captain_id()
        and coalesce((select value from settings where key = 'captain_can_edit_price'), 'false') = 'true'))
    then raise exception 'غير مسموح بتعديل الأسعار'; end if;
  if o.status not in ('new','assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن تعديل أسعار هذا الطلب'; end if;
  if n is null then raise exception 'اكتب سبب تعديل السعر'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_prices, '[]'::jsonb)) loop
    newp := (it->>'unit_price')::numeric;
    if newp is null or newp < 0 then raise exception 'سعر غير صالح'; end if;
    select oi.unit_price, p.name into oldp, pn
    from order_items oi join products p on p.id = oi.product_id
    where oi.id = (it->>'item_id')::uuid and oi.order_id = p_order;
    if not found then raise exception 'بند غير صالح'; end if;
    if oldp <> newp then
      update order_items set unit_price = newp where id = (it->>'item_id')::uuid;
      chg := chg || pn || ': ' || oldp || ' ← ' || newp || '؛ ';
    end if;
  end loop;
  if chg = '' then return; end if;
  update orders set items_total = x.s, list_total = x.l, total = x.s + delivery_fee
  from (select sum(qty * unit_price) s, sum(qty * list_price) l from order_items where order_id = p_order) x
  where orders.id = p_order;
  insert into order_events(order_id, status, note) values (p_order, o.status, 'تعديل أسعار: ' || chg || 'السبب: ' || n);
end $$;

create or replace function deliver_order(p_order uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; wh uuid; r record; n text := nullif(trim(coalesce(p_note, '')), ''); owed numeric;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or o.captain_id = my_captain_id()) then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'الطلب غير جاهز للتسليم'; end if;
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
  owed := case when coalesce((select value from settings where key = 'price_mode'), 'actual') = 'list' then o.list_total else o.items_total end;
  update orders set status = 'delivered', delivered_at = now(), owed_amount = owed, captain_note = coalesce(n, captain_note) where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, 'delivered', n);
end $$;

create or replace view captain_balances with (security_invoker = true) as
select c.id as captain_id, c.name,
  coalesce((select sum(coalesce(o.owed_amount, o.items_total)) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as delivered_total,
  coalesce((select sum(delivery_fee) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as fees_total,
  coalesce((select count(*) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as delivered_count,
  coalesce((select sum(amount) from captain_payments p where p.captain_id = c.id), 0) as paid_total,
  coalesce((select sum(coalesce(o.owed_amount, o.items_total)) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0)
   - coalesce((select sum(amount) from captain_payments p where p.captain_id = c.id), 0) as balance,
  coalesce((select sum(items_total) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as sales_total,
  coalesce((select sum(list_total) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as list_total,
  coalesce((select sum(items_total - list_total) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as variance
from captains c;

revoke execute on function update_order_prices, create_order, deliver_order from public, anon;
grant execute on function update_order_prices, create_order, deliver_order to authenticated;
-- =====================================================
-- الإصدار 6: طلبات تعديل السعر (الكابتن يطلب، الإداري يوافق أو يرفض)
-- =====================================================
create table if not exists price_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  captain_id uuid references captains(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  items jsonb not null,              -- [{item_id, name, qty, old, new}]
  reason text not null,
  admin_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists price_requests_one_pending on price_requests(order_id) where status = 'pending';
alter table price_requests enable row level security;
drop policy if exists pr_select on price_requests;
create policy pr_select on price_requests for select to authenticated
  using (is_admin() or captain_id = my_captain_id());
grant select on price_requests to authenticated;

create or replace function request_price_change(p_order uuid, p_prices jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o orders; it jsonb; r record; arr jsonb := '[]'::jsonb; newp numeric; rid uuid; n text := nullif(trim(coalesce(p_reason,'')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if o.captain_id is distinct from my_captain_id() then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن طلب تعديل سعر هذا الطلب'; end if;
  if n is null then raise exception 'اكتب سبب طلب التعديل'; end if;
  if exists (select 1 from price_requests where order_id = p_order and status = 'pending') then
    raise exception 'يوجد طلب تعديل سعر معلّق لهذا الطلب، انتظر قرار الإداري'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_prices,'[]'::jsonb)) loop
    newp := (it->>'unit_price')::numeric;
    if newp is null or newp < 0 then raise exception 'سعر غير صالح'; end if;
    select oi.id, oi.qty, oi.unit_price, p.name into r from order_items oi join products p on p.id = oi.product_id
      where oi.id = (it->>'item_id')::uuid and oi.order_id = p_order;
    if not found then raise exception 'بند غير صالح'; end if;
    if r.unit_price <> newp then
      arr := arr || jsonb_build_array(jsonb_build_object('item_id', r.id, 'name', r.name, 'qty', r.qty, 'old', r.unit_price, 'new', newp));
    end if;
  end loop;
  if jsonb_array_length(arr) = 0 then raise exception 'لم تغيّر أي سعر'; end if;
  insert into price_requests(order_id, captain_id, items, reason) values (p_order, o.captain_id, arr, n) returning id into rid;
  insert into order_events(order_id, status, note) values (p_order, o.status, 'طلب الكابتن تعديل السعر — السبب: ' || n);
  return rid;
end $$;

create or replace function decide_price_request(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare pr price_requests; o orders; n text := nullif(trim(coalesce(p_note,'')), '');
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into pr from price_requests where id = p_id for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if pr.status <> 'pending' then raise exception 'تم البتّ في هذا الطلب مسبقاً'; end if;
  select * into o from orders where id = pr.order_id for update;
  if p_approve then
    if o.status not in ('new','assigned','in_delivery','no_answer','closed','other') then
      raise exception 'حالة الطلب تغيّرت ولا يمكن تعديل سعره، ارفض الطلب'; end if;
    update order_items oi set unit_price = (x->>'new')::numeric
      from jsonb_array_elements(pr.items) x where oi.id = (x->>'item_id')::uuid and oi.order_id = pr.order_id;
    update orders set items_total = s.a, list_total = s.l, total = s.a + delivery_fee
      from (select sum(qty*unit_price) a, sum(qty*list_price) l from order_items where order_id = pr.order_id) s
      where orders.id = pr.order_id;
    insert into order_events(order_id, status, note) values (pr.order_id, o.status,
      'وافق الإداري على تعديل السعر: ' || (select string_agg((x->>'name') || ' ' || (x->>'old') || ' ← ' || (x->>'new'), '؛ ') from jsonb_array_elements(pr.items) x)
      || coalesce(' — ملاحظة: ' || n, ''));
  else
    insert into order_events(order_id, status, note) values (pr.order_id, o.status, 'رفض الإداري تعديل السعر' || coalesce(' — السبب: ' || n, ''));
  end if;
  update price_requests set status = case when p_approve then 'approved' else 'rejected' end, admin_note = n, decided_at = now() where id = p_id;
end $$;

revoke execute on function request_price_change, decide_price_request from public, anon;
grant execute on function request_price_change, decide_price_request to authenticated;
-- =====================================================
-- الإصدار 7: طلب تعديل السعر على إجمالي الفاتورة (وليس على المنتجات منفصلة)
-- =====================================================
alter table orders add column if not exists price_adjust numeric(12,2) not null default 0;
alter table price_requests add column if not exists old_total numeric(12,2);
alter table price_requests add column if not exists new_total numeric(12,2);
alter table price_requests alter column items set default '[]'::jsonb;

drop function if exists request_price_change(uuid, jsonb, text);
create or replace function request_price_change(p_order uuid, p_new_total numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o orders; rid uuid; n text := nullif(trim(coalesce(p_reason,'')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if o.captain_id is distinct from my_captain_id() then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن طلب تعديل سعر هذا الطلب'; end if;
  if n is null then raise exception 'اكتب سبب طلب التعديل'; end if;
  if p_new_total is null or p_new_total < 0 then raise exception 'مبلغ غير صالح'; end if;
  if p_new_total < o.delivery_fee then raise exception 'الإجمالي المطلوب أقل من أجرة التوصيل'; end if;
  if p_new_total = o.total then raise exception 'الإجمالي المطلوب مطابق للحالي'; end if;
  if exists (select 1 from price_requests where order_id = p_order and status = 'pending') then
    raise exception 'يوجد طلب تعديل سعر معلّق لهذا الطلب، انتظر قرار الإداري'; end if;
  insert into price_requests(order_id, captain_id, old_total, new_total, reason)
  values (p_order, o.captain_id, o.total, p_new_total, n) returning id into rid;
  insert into order_events(order_id, status, note)
  values (p_order, o.status, 'طلب الكابتن تعديل إجمالي الفاتورة من ' || o.total || ' إلى ' || p_new_total || ' — السبب: ' || n);
  return rid;
end $$;

create or replace function decide_price_request(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare pr price_requests; o orders; n text := nullif(trim(coalesce(p_note,'')), '');
  target numeric; ratio numeric; s numeric;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into pr from price_requests where id = p_id for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if pr.status <> 'pending' then raise exception 'تم البتّ في هذا الطلب مسبقاً'; end if;
  select * into o from orders where id = pr.order_id for update;
  if p_approve then
    if o.status not in ('new','assigned','in_delivery','no_answer','closed','other') then
      raise exception 'حالة الطلب تغيّرت ولا يمكن تعديل سعره، ارفض الطلب'; end if;
    target := pr.new_total - o.delivery_fee;
    if target < 0 then raise exception 'الإجمالي المطلوب أقل من أجرة التوصيل'; end if;
    if o.items_total <= 0 then raise exception 'لا يمكن توزيع الفرق على طلب إجمالي منتجاته صفر'; end if;
    -- توزيع الفرق على المنتجات بنسبة أسعارها
    ratio := target / o.items_total;
    update order_items set unit_price = round(unit_price * ratio, 2) where order_id = pr.order_id;
    select sum(qty * unit_price) into s from order_items where order_id = pr.order_id;
    update orders set price_adjust = target - s, items_total = target, total = pr.new_total,
      list_total = (select sum(qty * list_price) from order_items where order_id = pr.order_id)
      where id = pr.order_id;
    insert into order_events(order_id, status, note) values (pr.order_id, o.status,
      'وافق الإداري على تعديل إجمالي الفاتورة من ' || pr.old_total || ' إلى ' || pr.new_total || coalesce(' — ملاحظة: ' || n, ''));
  else
    insert into order_events(order_id, status, note) values (pr.order_id, o.status, 'رفض الإداري تعديل الإجمالي' || coalesce(' — السبب: ' || n, ''));
  end if;
  update price_requests set status = case when p_approve then 'approved' else 'rejected' end, admin_note = n, decided_at = now() where id = p_id;
end $$;

-- التعديل اليدوي للأسعار من الإداري يُصفّر فرق التقريب
create or replace function update_order_prices(p_order uuid, p_prices jsonb, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; it jsonb; n text := nullif(trim(coalesce(p_note, '')), ''); newp numeric; oldp numeric; pn text; chg text := '';
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or (o.captain_id = my_captain_id()
        and coalesce((select value from settings where key = 'captain_can_edit_price'), 'false') = 'true'))
    then raise exception 'غير مسموح بتعديل الأسعار'; end if;
  if o.status not in ('new','assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن تعديل أسعار هذا الطلب'; end if;
  if n is null then raise exception 'اكتب سبب تعديل السعر'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_prices, '[]'::jsonb)) loop
    newp := (it->>'unit_price')::numeric;
    if newp is null or newp < 0 then raise exception 'سعر غير صالح'; end if;
    select oi.unit_price, p.name into oldp, pn
    from order_items oi join products p on p.id = oi.product_id
    where oi.id = (it->>'item_id')::uuid and oi.order_id = p_order;
    if not found then raise exception 'بند غير صالح'; end if;
    if oldp <> newp then
      update order_items set unit_price = newp where id = (it->>'item_id')::uuid;
      chg := chg || pn || ': ' || oldp || ' ← ' || newp || '؛ ';
    end if;
  end loop;
  if chg = '' then return; end if;
  update orders set price_adjust = 0, items_total = x.s, list_total = x.l, total = x.s + delivery_fee
  from (select sum(qty * unit_price) s, sum(qty * list_price) l from order_items where order_id = p_order) x
  where orders.id = p_order;
  insert into order_events(order_id, status, note) values (p_order, o.status, 'تعديل أسعار: ' || chg || 'السبب: ' || n);
end $$;

revoke execute on function request_price_change, decide_price_request, update_order_prices from public, anon;
grant execute on function request_price_change, decide_price_request, update_order_prices to authenticated;

-- =====================================================
-- الإصدار 8: ملاحظة الإداري للكابتن + تفعيل التحديث اللحظي (Realtime)
-- =====================================================
create or replace function set_order_note(p_order uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; n text := nullif(trim(coalesce(p_note,'')), '');
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  update orders set note = n where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, o.status,
    case when n is null then 'حذف الإداري الملاحظة' else 'ملاحظة من الإداري: ' || n end);
end $$;
revoke execute on function set_order_note(uuid, text) from public, anon;
grant execute on function set_order_note(uuid, text) to authenticated;
alter publication supabase_realtime add table public.orders, public.captain_payments, public.price_requests;
-- =====================================================
-- الإصدار 9: عنوان الطلب والخرائط + تعديل الطلب (بيانات وبنود) من الإداري + رمز الدولة للواتساب
-- =====================================================
alter table orders add column if not exists customer_address text;
alter table orders add column if not exists map_url text;
insert into settings(key, value) values ('phone_country', '963') on conflict (key) do nothing;

drop function if exists create_order(text, text, text, uuid, jsonb);
create or replace function create_order(p_name text, p_phone text, p_note text, p_captain uuid, p_items jsonb, p_address text default null, p_map text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare oid uuid; it jsonb; pr numeric; up numeric; sub numeric := 0; lsub numeric := 0; fee numeric := 0;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  if p_captain is not null then select delivery_fee into fee from captains where id = p_captain; end if;
  insert into orders(customer_name, customer_phone, note, captain_id, status, delivery_fee, customer_address, map_url)
  values (p_name, p_phone, p_note, p_captain, case when p_captain is null then 'new' else 'assigned' end, coalesce(fee,0),
          nullif(trim(coalesce(p_address,'')),''), nullif(trim(coalesce(p_map,'')),''))
  returning id into oid;
  for it in select * from jsonb_array_elements(p_items) loop
    select price into pr from products where id = (it->>'product_id')::uuid;
    up := coalesce(nullif(it->>'unit_price','')::numeric, pr);
    if up < 0 then raise exception 'السعر لا يكون سالباً'; end if;
    insert into order_items(order_id, product_id, qty, unit_price, list_price)
    values (oid, (it->>'product_id')::uuid, (it->>'qty')::int, up, pr);
    sub := sub + up * (it->>'qty')::int;
    lsub := lsub + pr * (it->>'qty')::int;
  end loop;
  update orders set items_total = sub, list_total = lsub, total = sub + coalesce(fee,0) where id = oid;
  return oid;
end $$;

create or replace function edit_order(p_order uuid, p_info jsonb, p_items jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; it jsonb; pr numeric; up numeric; lp numeric; sub numeric := 0; lsub numeric := 0; summ text := '';
  pid uuid; q int; pn text;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if o.status not in ('new','assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن تعديل هذا الطلب في حالته الحالية'; end if;
  if p_info is not null and jsonb_typeof(p_info) = 'object' then
    if coalesce(trim(p_info->>'name'),'') = '' or coalesce(trim(p_info->>'phone'),'') = '' then raise exception 'اسم الزبون ورقمه مطلوبان'; end if;
    update orders set customer_name = trim(p_info->>'name'), customer_phone = trim(p_info->>'phone'),
      customer_address = nullif(trim(coalesce(p_info->>'address','')),''), map_url = nullif(trim(coalesce(p_info->>'map_url','')),'')
      where id = p_order;
  end if;
  if p_items is not null then
    if jsonb_array_length(p_items) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
    create temp table _old_items on commit drop as select product_id, unit_price, list_price from order_items where order_id = p_order;
    delete from order_items where order_id = p_order;
    for it in select * from jsonb_array_elements(p_items) loop
      pid := (it->>'product_id')::uuid; q := (it->>'qty')::int;
      if q is null or q <= 0 then raise exception 'الكمية غير صالحة'; end if;
      select price, name into pr, pn from products where id = pid;
      if not found then raise exception 'منتج غير موجود'; end if;
      select unit_price, list_price into up, lp from _old_items where product_id = pid limit 1;
      lp := coalesce(lp, pr);
      up := coalesce(nullif(it->>'unit_price','')::numeric, up, pr);
      if up < 0 then raise exception 'السعر لا يكون سالباً'; end if;
      insert into order_items(order_id, product_id, qty, unit_price, list_price) values (p_order, pid, q, up, lp);
      sub := sub + up * q; lsub := lsub + lp * q;
      summ := summ || pn || ' ×' || q || ' @ ' || up || '؛ ';
    end loop;
    update orders set price_adjust = 0, items_total = sub, list_total = lsub, total = sub + delivery_fee where id = p_order;
    update price_requests set status = 'rejected', admin_note = 'أُلغي لأن الإداري عدّل بنود الطلب', decided_at = now()
      where order_id = p_order and status = 'pending';
    insert into order_events(order_id, status, note) values (p_order, o.status, 'عدّل الإداري بنود الطلب: ' || summ || 'الإجمالي الجديد ' || (sub + o.delivery_fee));
  elsif p_info is not null then
    insert into order_events(order_id, status, note) values (p_order, o.status, 'عدّل الإداري بيانات الزبون/العنوان');
  end if;
end $$;

revoke execute on function create_order, edit_order from public, anon;
grant execute on function create_order, edit_order to authenticated;

-- =====================================================
-- الإصدار 10: إشعارات Push (تصل والتطبيق مغلق)
-- تتطلب Edge Function باسم send-push (الكود في supabase/functions/send-push/index.ts) بدون verify_jwt.
-- مفاتيح VAPID تُولَّد تلقائياً داخل الدالة وتُحفظ في push_config ولا يصل إليها أي تطبيق.
-- =====================================================
create extension if not exists pg_net with schema extensions;

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  captain_id uuid not null references captains(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create table if not exists push_config (key text primary key, value text not null);
alter table push_subscriptions enable row level security;
alter table push_config enable row level security;
revoke all on push_subscriptions, push_config from anon, authenticated;
grant all on push_subscriptions, push_config to service_role;

insert into push_config(key, value) values
  ('push_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('fn_url', 'https://jabapvnmfdflysxfxwwf.supabase.co/functions/v1/send-push')
on conflict (key) do nothing;

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare cid uuid := my_captain_id();
begin
  if cid is null then raise exception 'غير مسموح'; end if;
  insert into push_subscriptions(captain_id, endpoint, p256dh, auth) values (cid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set captain_id = excluded.captain_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function remove_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint and captain_id = my_captain_id();
end $$;

create or replace function push_to_captain(p_captain uuid, p_title text, p_body text, p_tag text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare u text; sec text;
begin
  select value into u from push_config where key = 'fn_url';
  select value into sec from push_config where key = 'push_secret';
  if u is null or sec is null or p_captain is null then return; end if;
  if not exists (select 1 from push_subscriptions where captain_id = p_captain) then return; end if;
  perform net.http_post(url := u,
    body := jsonb_build_object('captain_id', p_captain, 'title', p_title, 'body', p_body, 'tag', p_tag),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', sec));
exception when others then null;
end $$;

create or replace function trg_orders_push() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then return new; end if;
  if new.captain_id is null then return new; end if;
  if tg_op = 'INSERT' then
    perform push_to_captain(new.captain_id, 'طلب جديد #' || new.order_no, new.customer_name || ' — ' || new.total, 'o' || new.id);
  elsif new.captain_id is distinct from old.captain_id then
    perform push_to_captain(new.captain_id, 'طلب جديد #' || new.order_no, new.customer_name || ' — ' || new.total, 'o' || new.id);
  elsif new.note is distinct from old.note and new.note is not null then
    perform push_to_captain(new.captain_id, 'ملاحظة من الإداري — طلب #' || new.order_no, new.note, 'n' || new.id);
  elsif new.total is distinct from old.total or new.customer_address is distinct from old.customer_address or new.map_url is distinct from old.map_url then
    perform push_to_captain(new.captain_id, 'تم تعديل الطلب #' || new.order_no, 'الإجمالي الآن ' || new.total, 'e' || new.id);
  elsif new.status is distinct from old.status then
    perform push_to_captain(new.captain_id, 'تغيّرت حالة الطلب #' || new.order_no, 'أصبحت: ' || new.status, 's' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists orders_push on orders;
create trigger orders_push after insert or update on orders for each row execute function trg_orders_push();

create or replace function trg_pr_push() returns trigger language plpgsql security definer set search_path = public as $$
declare no int;
begin
  if old.status = 'pending' and new.status <> 'pending' and is_admin() then
    select order_no into no from orders where id = new.order_id;
    perform push_to_captain(new.captain_id,
      case when new.status = 'approved' then 'تمت الموافقة على تعديل السعر' else 'تم رفض تعديل السعر' end,
      'طلب #' || no || coalesce(' — ' || new.admin_note, ''), 'r' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists pr_push on price_requests;
create trigger pr_push after update on price_requests for each row execute function trg_pr_push();

create or replace function trg_pay_push() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform push_to_captain(new.captain_id, 'تم تسجيل دفعة', new.amount || coalesce(' — ' || new.note, ''), 'p' || new.id);
  return new;
end $$;
drop trigger if exists pay_push on captain_payments;
create trigger pay_push after insert on captain_payments for each row execute function trg_pay_push();

revoke execute on function push_to_captain, trg_orders_push, trg_pr_push, trg_pay_push from public, anon, authenticated;
revoke execute on function save_push_subscription, remove_push_subscription from public, anon;
grant execute on function save_push_subscription, remove_push_subscription to authenticated;

-- تحصين دوال المشغّلات
revoke execute on function trg_order_created(), trg_stock_invoice_item() from public, anon, authenticated;
alter function trg_keep_one_admin() set search_path = public;
