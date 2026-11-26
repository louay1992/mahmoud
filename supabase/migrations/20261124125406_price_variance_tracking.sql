-- ===== أعمدة السعر المثبت والفعلي =====
alter table order_items add column if not exists list_price numeric(12,2);
update order_items set list_price = unit_price where list_price is null;
alter table order_items alter column list_price set not null;

alter table orders add column if not exists list_total numeric(12,2) not null default 0;
alter table orders add column if not exists owed_amount numeric(12,2);
update orders set list_total = items_total where list_total = 0;
update orders set owed_amount = items_total where status = 'delivered' and owed_amount is null;

insert into settings(key, value) values ('price_mode','actual'), ('captain_can_edit_price','false')
on conflict (key) do nothing;

-- ===== إنشاء طلب بأسعار قابلة للتعديل لكل بند =====
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

-- ===== تعديل أسعار طلب مفتوح (مع سبب إلزامي وتسجيل في السجل) =====
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

-- ===== التسليم: تثبيت المبلغ المطلوب من الكابتن حسب نمط الحساب =====
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

-- ===== أرصدة الكباتن + فروقات الأسعار =====
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