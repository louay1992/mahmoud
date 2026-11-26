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