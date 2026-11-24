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
