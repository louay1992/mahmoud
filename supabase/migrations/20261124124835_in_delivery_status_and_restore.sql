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

-- استرجاع طلب ملغي: يعود "مُسنداً" (جديداً عند الكابتن)
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