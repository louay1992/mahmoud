-- ===== حالات الطلب الجديدة =====
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('new','assigned','no_answer','closed','other','delivered','cancelled','returned'));

-- ===== سجل أحداث الطلب =====
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

-- حدث الإنشاء
create or replace function trg_order_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into order_events(order_id, status, note) values (new.id, new.status, 'تم إنشاء الطلب');
  return new;
end $$;
drop trigger if exists order_created on orders;
create trigger order_created after insert on orders for each row execute function trg_order_created();

-- ===== إسناد =====
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

-- ===== تغيير الحالة (لم يتم الرد / مغلق / ملاحظة أخرى / مُسند) =====
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

-- ===== تسليم (من أي حالة مفتوحة) =====
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

-- ===== إلغاء =====
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

-- ===== إرجاع: يسجّل حدثاً =====
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

-- ===== الإحصاءات: عدد الطلبات لكل حالة =====
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