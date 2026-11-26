-- Production pg_catalog snapshot captured on 2026-11-26, then explicit integrity fixes.
-- No business rows are changed. Fresh installs and production converge on the same definitions.
begin;
set local lock_timeout='5s';


-- A total lock order serializes overlapping stock operations, including absent stock rows.
create or replace function public.lock_stock(p_warehouses uuid[],p_products uuid[])
returns void language plpgsql security definer set search_path=public as $$
declare r record;
begin
 for r in select distinct w,p from unnest(p_warehouses)w cross join unnest(p_products)p
          where w is not null and p is not null order by w,p loop
  perform pg_advisory_xact_lock(hashtextextended('delivery-stock:'||r.w::text||':'||r.p::text,0));
  perform 1 from stock where warehouse_id=r.w and product_id=r.p for update;
 end loop;
end $$;
revoke all on function public.lock_stock(uuid[],uuid[]) from public,anon,authenticated;

-- The notification id remains a grouping tag. The order id is a separate, explicit field.
create or replace function public.dispatch_order_push(p_aud text,p_cap uuid,p_title text,p_body text,p_tag text,p_order uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare u text; sec text; role_path text;
begin
 select value into u from push_config where key='fn_url';
 select value into sec from push_config where key='push_secret';
 if u is null or sec is null then return; end if;
 if p_aud='admin' then
  if not exists(select 1 from push_subscriptions where admin_email is not null)
   and not exists(select 1 from native_push_devices where enabled and app_scope='admin') then return; end if;
  role_path:='/admin.html';
 elsif p_aud='captain' and p_cap is not null then
  if not exists(select 1 from push_subscriptions where captain_id=p_cap)
   and not exists(select 1 from native_push_devices where enabled and app_scope='captain' and captain_id=p_cap) then return; end if;
  role_path:='/captain.html';
 else return; end if;
 perform net.http_post(url:=u,body:=jsonb_build_object('admins',p_aud='admin','captain_id',p_cap,
  'title',p_title,'body',p_body,'tag',p_tag,'order_id',p_order,
  'url',role_path||case when p_order is null then '' else '?order='||p_order::text end,
  'icon',case when p_aud='admin' then '/icons/admin-192.png' else '/icons/captain-192.png' end),
  headers:=jsonb_build_object('Content-Type','application/json','x-push-secret',sec));
exception when others then raise warning 'Push delivery could not be queued';
end $$;
revoke all on function public.dispatch_order_push(text,uuid,text,text,text,uuid) from public,anon,authenticated;

drop function if exists public.create_order(text,text,text,uuid,jsonb,text,text);

CREATE OR REPLACE FUNCTION public.add_carrier_payment(p_carrier uuid, p_amount numeric, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'مبلغ غير صالح'; end if;
  perform guard_once('cpay:'||p_carrier||':'||p_amount, 15);
  insert into carrier_payments(carrier_id,amount,note) values (p_carrier,p_amount,nullif(trim(coalesce(p_note,'')),''));
end $function$;

CREATE OR REPLACE FUNCTION public.adjust_stock(p_warehouse uuid, p_product uuid, p_new_qty integer, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cur integer;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_new_qty < 0 then raise exception 'الكمية لا تكون سالبة'; end if;
  perform public.lock_stock(array[p_warehouse],array[p_product]);
  select qty into cur from stock where warehouse_id = p_warehouse and product_id = p_product;
  cur := coalesce(cur, 0);
  if cur = p_new_qty then return; end if;
  insert into stock(warehouse_id, product_id, qty) values (p_warehouse, p_product, p_new_qty)
  on conflict (warehouse_id, product_id) do update set qty = excluded.qty;
  insert into stock_movements(warehouse_id, product_id, qty, kind, note)
  values (p_warehouse, p_product, p_new_qty - cur, 'adjust', coalesce(p_note, 'تسوية جرد'));
end $function$;

CREATE OR REPLACE FUNCTION public.admin_products()
 RETURNS SETOF products
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from products where is_admin() order by name $function$;

CREATE OR REPLACE FUNCTION public.admin_profit_items()
 RETURNS TABLE(item_id uuid, order_id uuid, order_no bigint, product_id uuid, product_name text, marketer_id uuid, captain_id uuid, status text, created_at timestamp with time zone, delivered_at timestamp with time zone, governorate text, delivery_fee numeric, first_item boolean, qty integer, unit_price numeric, capital numeric, cost numeric, fulfillment text, shipping_cost numeric, carrier_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select i.id, o.id, o.order_no::bigint, i.product_id, p.name, o.marketer_id, o.captain_id, o.status::text, o.created_at, o.delivered_at, o.governorate, o.delivery_fee,
    (row_number() over (partition by o.id order by i.id)=1), i.qty, i.unit_price, coalesce(c.capital,p.price), coalesce(c.cost,0), o.fulfillment, o.shipping_cost, o.carrier_id
  from orders o join order_items i on i.order_id=o.id join products p on p.id=i.product_id left join order_item_capital c on c.item_id=i.id
  where is_admin() order by o.created_at desc limit 30000 $function$;

CREATE OR REPLACE FUNCTION public.assign_order(p_order uuid, p_captain uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare fee numeric; cn text;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select delivery_fee, name into fee, cn from captains where id = p_captain;
  update orders set captain_id = p_captain, status = 'assigned', delivery_fee = fee, total = items_total + fee, captain_note = null
  where id = p_order and status in ('new','assigned','in_delivery','no_answer','closed','other');
  if not found then raise exception 'لا يمكن إسناد هذا الطلب'; end if;
  insert into order_events(order_id, status, note) values (p_order, 'assigned', 'أُسند إلى ' || cn);
end $function$;

CREATE OR REPLACE FUNCTION public.cancel_order(p_order uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or coalesce(o.captain_id = my_captain_id(), false)) then raise exception 'غير مسموح'; end if;
  if o.status in ('delivered','cancelled','returned') then raise exception 'لا يمكن إلغاء هذا الطلب'; end if;
  update orders set status = 'cancelled', captain_note = coalesce(n, captain_note) where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, 'cancelled', n);
end $function$;

CREATE OR REPLACE FUNCTION public.create_order(p_name text, p_phone text, p_note text, p_captain uuid, p_items jsonb, p_address text DEFAULT NULL::text, p_map text DEFAULT NULL::text, p_marketer uuid DEFAULT NULL::uuid, p_governorate text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare oid uuid; it jsonb; pr numeric; up numeric; sub numeric := 0; fee numeric := 0; staff boolean;
begin
  if not has_perm('create_orders') then raise exception 'غير مسموح'; end if;
  staff := not is_admin();
  if staff then
    if p_captain is not null and not has_perm('pick_captain') then raise exception 'غير مسموح بإسناد الكابتن'; end if;
    if p_marketer is not null and not has_perm('pick_marketer') then raise exception 'غير مسموح باختيار المسوّقة'; end if;
  end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  if p_captain is not null then select delivery_fee into fee from captains where id = p_captain; end if;
  insert into orders(customer_name, customer_phone, note, captain_id, status, delivery_fee, customer_address, map_url, marketer_id, governorate)
  values (p_name, p_phone, p_note, p_captain, case when p_captain is null then 'new' else 'assigned' end, coalesce(fee,0),
          nullif(trim(coalesce(p_address,'')),''), nullif(trim(coalesce(p_map,'')),''), p_marketer, nullif(trim(coalesce(p_governorate,'')),''))
  returning id into oid;
  for it in select * from jsonb_array_elements(p_items) loop
    select price into pr from products where id = (it->>'product_id')::uuid;
    if staff and nullif(it->>'unit_price','') is null then raise exception 'اكتب سعر البيع لكل منتج'; end if;
    up := coalesce(nullif(it->>'unit_price','')::numeric, pr);
    if up < 0 then raise exception 'السعر لا يكون سالباً'; end if;
    if staff and up < coalesce(pr,0) then raise exception 'سعر البيع أقل من الحد الأدنى المسموح لأحد المنتجات'; end if;
    insert into order_items(order_id, product_id, qty, unit_price, list_price)
    values (oid, (it->>'product_id')::uuid, (it->>'qty')::int, up, up);
    sub := sub + up * (it->>'qty')::int;
  end loop;
  update orders set items_total = sub, list_total = sub, total = sub + coalesce(fee,0) where id = oid;
  return oid;
end $function$;

CREATE OR REPLACE FUNCTION public.create_shipment(p_name text, p_phone text, p_note text, p_items jsonb, p_address text, p_map text, p_marketer uuid, p_governorate text, p_carrier uuid, p_waybill text, p_cost numeric, p_fee numeric, p_wh uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare oid uuid; wh uuid;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_carrier is null or not exists(select 1 from carriers where id=p_carrier) then raise exception 'اختر شركة الشحن'; end if;
  if coalesce(p_cost,0)<0 or coalesce(p_fee,0)<0 then raise exception 'مبلغ غير صالح'; end if;
  wh := coalesce(p_wh,(select id from warehouses where is_main limit 1));
  oid := create_order(p_name,p_phone,p_note,null,p_items,p_address,p_map,p_marketer,p_governorate);
  update orders set fulfillment='shipping', carrier_id=p_carrier, waybill=nullif(trim(coalesce(p_waybill,'')),''), shipping_cost=coalesce(p_cost,0),
    delivery_fee=coalesce(p_fee,0), total=items_total+coalesce(p_fee,0), ship_status='preparing', ship_warehouse=wh where id=oid;
  insert into shipment_events(order_id,ship_status,note) values (oid,'preparing','تم إنشاء الشحنة');
  return oid;
end $function$;

CREATE OR REPLACE FUNCTION public.create_stock_invoice(p_warehouse uuid, p_note text, p_items jsonb, p_deduct_main boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare inv uuid; it jsonb; mw uuid; wn text; pid uuid; q int; cur int; pn text; ded boolean;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  perform guard_once('inv|'||auth.uid()||'|'||p_warehouse||'|'||p_items::text||'|'||coalesce(p_note,'')||'|'||coalesce(p_deduct_main,false), 15);
  select name into wn from warehouses where id = p_warehouse;
  if not found then raise exception 'المستودع غير موجود'; end if;
  select id into mw from warehouses where is_main;
  ded := coalesce(p_deduct_main,false) and mw is not null and mw <> p_warehouse;
  perform public.lock_stock(array[p_warehouse,case when ded then mw end],array(select (x->>'product_id')::uuid from jsonb_array_elements(p_items)x));
  insert into stock_invoices(warehouse_id, note, deducted_from_main) values (p_warehouse, nullif(trim(coalesce(p_note,'')),''), ded) returning id into inv;
  if ded then
    for it in select * from jsonb_array_elements(p_items) loop
      pid := (it->>'product_id')::uuid; q := (it->>'qty')::int;
      if q is null or q <= 0 then raise exception 'الكمية غير صالحة'; end if;
      select coalesce(qty,0) into cur from stock where warehouse_id = mw and product_id = pid for update; cur := coalesce(cur,0);
      select name into pn from products where id = pid;
      if cur < q then raise exception 'رصيد المستودع الرئيسي من "%" غير كافٍ (المتوفر %، المطلوب %)', pn, cur, q; end if;
      update stock set qty = qty - q where warehouse_id = mw and product_id = pid;
      insert into stock_movements(warehouse_id, product_id, qty, kind, note) values (mw, pid, -q, 'transfer_out', 'خرجت بفاتورة إلى ' || wn || coalesce(' — ' || nullif(trim(coalesce(p_note,'')),''), ''));
    end loop;
  end if;
  insert into stock_invoice_items(invoice_id, product_id, qty)
    select inv, (x->>'product_id')::uuid, (x->>'qty')::int from jsonb_array_elements(p_items) x;
  return inv;
end $function$;

CREATE OR REPLACE FUNCTION public.dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.decide_price_request(p_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pr price_requests; o orders; n text := nullif(trim(coalesce(p_note,'')), '');
  target numeric; ratio numeric; s numeric;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into pr from price_requests where id = p_id for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if pr.status <> 'pending' then raise exception 'تم البتّ في هذا الطلب مسبقاً'; end if;
  select * into o from orders where id = pr.order_id for update;
  perform set_config('app.skip_edit','1',true);
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
end $function$;

CREATE OR REPLACE FUNCTION public.deliver_order(p_order uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; wh uuid; r record; n text := nullif(trim(coalesce(p_note, '')), ''); owed numeric;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or coalesce(o.captain_id = my_captain_id(), false)) then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'الطلب غير جاهز للتسليم'; end if;

  select warehouse_id into wh from captains where id = o.captain_id;
  if wh is null then raise exception 'لا يوجد مستودع مرتبط بهذا الكابتن'; end if;
  perform public.lock_stock(array[wh], array(select product_id from order_items where order_id=p_order));

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
end $function$;

CREATE OR REPLACE FUNCTION public.edit_order(p_order uuid, p_info jsonb, p_items jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; it jsonb; pr numeric; up numeric; oc numeric; nid uuid; sub numeric := 0; summ text := '';
  pid uuid; q int; pn text; ocost numeric;
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
    if p_info ? 'governorate' then
      update orders set governorate = nullif(trim(p_info->>'governorate'),'') where id = p_order;
    end if;
    if p_info ? 'marketer_id' then
      update orders set marketer_id = nullif(p_info->>'marketer_id','')::uuid where id = p_order;
    end if;
  end if;
  if p_items is not null and o.fulfillment='shipping' and o.stock_out then raise exception 'لا يمكن تعديل البنود بعد خروج الشحنة من المستودع'; end if;
  if p_items is not null then
    if jsonb_array_length(p_items) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
    create temp table _old_items on commit drop as
      select i.product_id, i.unit_price, c.capital, c.cost from order_items i left join order_item_capital c on c.item_id = i.id where i.order_id = p_order;
    delete from order_items where order_id = p_order;
    for it in select * from jsonb_array_elements(p_items) loop
      pid := (it->>'product_id')::uuid; q := (it->>'qty')::int;
      if q is null or q <= 0 then raise exception 'الكمية غير صالحة'; end if;
      select price, name into pr, pn from products where id = pid;
      if not found then raise exception 'منتج غير موجود'; end if;
      select unit_price, capital, cost into up, oc, ocost from _old_items where product_id = pid limit 1;
      up := coalesce(nullif(it->>'unit_price','')::numeric, up, pr);
      if up < 0 then raise exception 'السعر لا يكون سالباً'; end if;
      insert into order_items(order_id, product_id, qty, unit_price, list_price) values (p_order, pid, q, up, up) returning id into nid;
      if oc is not null then update order_item_capital set capital = oc, cost = coalesce(ocost,0) where item_id = nid; end if;
      sub := sub + up * q;
      summ := summ || pn || ' ×' || q || ' @ ' || up || '؛ ';
    end loop;
    update orders set price_adjust = 0, items_total = sub, list_total = sub, total = sub + delivery_fee where id = p_order;
    update price_requests set status = 'rejected', admin_note = 'أُلغي لأن الإداري عدّل بنود الطلب', decided_at = now()
      where order_id = p_order and status = 'pending';
    insert into order_events(order_id, status, note) values (p_order, o.status, 'عدّل الإداري بنود الطلب: ' || summ || 'الإجمالي الجديد ' || (sub + o.delivery_fee));
  elsif p_info is not null then
    insert into order_events(order_id, status, note) values (p_order, o.status, 'عدّل الإداري بيانات الزبون/العنوان');
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.fmt_money(n numeric)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select regexp_replace(to_char(coalesce(n,0),'FM999,999,999,990.00'),'\.00$','') || coalesce(' '||(select value from settings where key='currency'),'')
$function$;

CREATE OR REPLACE FUNCTION public.guard_once(p_key text, p_secs integer DEFAULT 15)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r text;
begin
  delete from op_guard where at < now() - interval '1 hour';
  insert into op_guard(k, at) values (md5(p_key), now())
  on conflict (k) do update set at = now() where op_guard.at < now() - (p_secs || ' seconds')::interval
  returning k into r;
  if r is null then raise exception 'تم تنفيذ نفس العملية قبل لحظات، تم تجاهل التكرار'; end if;
end $function$;

CREATE OR REPLACE FUNCTION public.has_perm(p text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from admins where lower(email) = lower(auth.jwt() ->> 'email') and (perms is null or p = any(perms)));
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from admins where lower(email) = lower(auth.jwt() ->> 'email') and perms is null);
$function$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read(p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare em text := lower(auth.jwt() ->> 'email');
begin
  if em is null then return; end if;
  update notifications set read_by = array_append(read_by, em)
   where not (em = any(read_by)) and (p_ids is null or id = any(p_ids))
     and ((audience='admin' and is_admin()) or (audience='captain' and captain_id = my_captain_id()));
end $function$;

CREATE OR REPLACE FUNCTION public.marketer_return_impact(p_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o record; b record; prof numeric;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from order_profits where order_id = p_order;
  if not found or o.marketer_id is null or o.status <> 'delivered' then return jsonb_build_object('marketer', false); end if;
  select * into b from marketer_balances where marketer_id = o.marketer_id;
  prof := o.profit;
  return jsonb_build_object('marketer', true, 'name', b.name, 'profit', prof, 'balance', b.balance,
    'after', b.balance - prof, 'shortfall', greatest(0, prof - b.balance));
end $function$;

CREATE OR REPLACE FUNCTION public.my_access()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select case when perms is null then jsonb_build_object('role','full','perms','[]'::jsonb) else jsonb_build_object('role','staff','perms',to_jsonb(perms)) end from admins where lower(email) = lower(auth.jwt() ->> 'email') limit 1), jsonb_build_object('role','none','perms','[]'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION public.my_captain_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from captains where lower(email) = lower(auth.jwt() ->> 'email') and active limit 1;
$function$;

create or replace function public.my_warehouse_id() returns uuid
language sql stable security definer set search_path=public as $$
 select warehouse_id from captains where id=my_captain_id();
$$;

CREATE OR REPLACE FUNCTION public.native_device_action(p_id uuid, p_scope text, p_secret_hash text, p_action text, p_token text DEFAULT NULL::text, p_user uuid DEFAULT NULL::uuid, p_captain uuid DEFAULT NULL::uuid, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare d public.native_push_devices; bid uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text, 0));
  select * into d from public.native_push_devices where installation_id = p_id for update;
  if found and (d.secret_hash <> p_secret_hash or d.app_scope <> p_scope) then
    raise exception 'Invalid device credentials';
  end if;
  if p_action = 'bind' then
    if p_user is null or p_token is null or
      (p_scope = 'captain' and p_captain is null) or (p_scope = 'admin' and p_email is null) then
      raise exception 'Invalid binding';
    end if;
    bid := case when d.user_id = p_user and d.enabled then d.binding_id else gen_random_uuid() end;
    insert into public.native_push_devices(installation_id, app_scope, secret_hash, fcm_token, user_id, captain_id, admin_email, binding_id, enabled)
    values(p_id, p_scope, p_secret_hash, p_token, p_user, p_captain, p_email, bid, true)
    on conflict (installation_id) do update set fcm_token = excluded.fcm_token,
      user_id = excluded.user_id, captain_id = excluded.captain_id, admin_email = excluded.admin_email,
      binding_id = excluded.binding_id, enabled = true, updated_at = now()
    returning * into d;
    insert into public.native_push_preferences(user_id,app_scope,captain_id,admin_email,native_only)
    values(p_user,p_scope,p_captain,p_email,true)
    on conflict(user_id,app_scope) do update set captain_id=excluded.captain_id,
      admin_email=excluded.admin_email,native_only=true,updated_at=now();
  elsif p_action = 'sync' then
    if d.installation_id is not null and p_token is not null then
      update public.native_push_devices set fcm_token = p_token, updated_at = now()
      where installation_id = p_id returning * into d;
    end if;
  elsif p_action = 'unbind' then
    update public.native_push_devices set user_id = null, captain_id = null, admin_email = null,
      binding_id = null, enabled = false, updated_at = now() where installation_id = p_id returning * into d;
  elsif p_action = 'test' then
    if d.installation_id is null or not d.enabled or d.user_id is distinct from p_user then raise exception 'Device is not bound to this account'; end if;
    if d.last_test_at > now() - interval '10 seconds' then raise exception 'Please wait before testing again'; end if;
    update public.native_push_devices set last_test_at = now() where installation_id = p_id returning * into d;
  else
    raise exception 'Unknown device action';
  end if;
  return jsonb_build_object('saved', coalesce(d.enabled, false), 'binding_id', d.binding_id,
    'account_id', d.user_id, 'fcm_token', d.fcm_token, 'app_scope', d.app_scope);
end $function$;

CREATE OR REPLACE FUNCTION public.native_push_targets(p_admins boolean, p_captain uuid DEFAULT NULL::uuid)
 RETURNS TABLE(installation_id uuid, fcm_token text, binding_id uuid, app_scope text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select d.installation_id, d.fcm_token, d.binding_id, d.app_scope
  from public.native_push_devices d
  where d.enabled and (
    (p_admins and d.app_scope = 'admin' and exists (
      select 1 from public.admins a where lower(a.email) = d.admin_email
      and (to_jsonb(a)->'perms' is null or to_jsonb(a)->'perms' = 'null'::jsonb)))
    or (not p_admins and d.app_scope = 'captain' and d.captain_id = p_captain and exists (
      select 1 from public.captains c where c.id = d.captain_id and c.active))
  );
$function$;

CREATE OR REPLACE FUNCTION public.norm_phone(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case when d='' then '' when d like '00963%' then '0'||substr(d,6) when d like '963%' then '0'||substr(d,4)
    when length(d)=9 and d like '9%' then '0'||d else d end
  from (select regexp_replace(translate(coalesce(p,''),'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'\D','','g') d) x $function$;

create or replace function public.notify(p_aud text,p_cap uuid,p_kind text,p_level text,p_title text,p_body text,p_order uuid)
returns void language plpgsql security definer set search_path=public as $$
declare nid uuid;
begin
 if p_aud='captain' and p_cap is null then return; end if;
 insert into notifications(audience,captain_id,kind,level,title,body,order_id)
 values(p_aud,p_cap,p_kind,p_level,p_title,p_body,p_order) returning id into nid;
 if random()<0.02 then delete from notifications where created_at<now()-interval '90 days'; end if;
 perform public.dispatch_order_push(p_aud,p_cap,p_title,p_body,'notification:'||nid,p_order);
end $$;

CREATE OR REPLACE FUNCTION public.order_lines(oid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(string_agg(p.name||' ×'||i.qty, '، ' order by p.name),'—') from order_items i join products p on p.id=i.product_id where i.order_id=oid
$function$;

CREATE OR REPLACE FUNCTION public.push_to_admins(p_title text, p_body text, p_tag text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare u text; sec text;
begin
  select value into u from push_config where key = 'fn_url';
  select value into sec from push_config where key = 'push_secret';
  if u is null or sec is null then return; end if;
  if not exists (select 1 from push_subscriptions where admin_email is not null)
    and not exists (select 1 from native_push_devices
      where enabled and app_scope = 'admin' and admin_email is not null) then return; end if;
  perform net.http_post(url := u,
    body := jsonb_build_object('admins', true, 'title', p_title, 'body', p_body, 'tag', p_tag, 'url', '/admin.html', 'icon', '/icons/admin-192.png'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', sec));
exception when others then null;
end $function$;

CREATE OR REPLACE FUNCTION public.push_to_captain(p_captain uuid, p_title text, p_body text, p_tag text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare u text; sec text;
begin
  select value into u from push_config where key = 'fn_url';
  select value into sec from push_config where key = 'push_secret';
  if u is null or sec is null or p_captain is null then return; end if;
  if not exists (select 1 from push_subscriptions where captain_id = p_captain)
    and not exists (select 1 from native_push_devices
      where enabled and app_scope = 'captain' and captain_id = p_captain) then return; end if;
  perform net.http_post(url := u,
    body := jsonb_build_object('captain_id', p_captain, 'title', p_title, 'body', p_body, 'tag', p_tag),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', sec));
exception when others then null;
end $function$;

CREATE OR REPLACE FUNCTION public.remove_push_subscription(p_endpoint text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  delete from push_subscriptions where endpoint = p_endpoint
    and (captain_id = my_captain_id() or admin_email = lower(auth.jwt() ->> 'email'));
end $function$;

CREATE OR REPLACE FUNCTION public.request_price_change(p_order uuid, p_new_total numeric, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;

create or replace function public.reset_test_data() returns void
language plpgsql security definer set search_path=public as $$
begin raise exception 'تم إيقاف مسح البيانات التجريبية على هذا النظام'; end $$;

CREATE OR REPLACE FUNCTION public.restore_order(p_order uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; n text := nullif(trim(coalesce(p_note, '')), ''); ns text;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or coalesce(o.captain_id = my_captain_id(), false)) then raise exception 'غير مسموح'; end if;
  if o.status <> 'cancelled' then raise exception 'يمكن استرجاع الطلبات الملغية فقط'; end if;
  ns := case when o.captain_id is null then 'new' else 'assigned' end;
  update orders set status = ns, captain_note = null where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, ns, 'استرجاع الطلب' || coalesce(' — ' || n, ''));
end $function$;

CREATE OR REPLACE FUNCTION public.return_order(p_order uuid, p_restock boolean DEFAULT true, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; wh uuid;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status <> 'delivered' then raise exception 'يمكن إرجاع الطلبات المُسلَّمة فقط'; end if;
  update orders set status = 'returned', captain_note = coalesce(p_note, captain_note) where id = p_order;
  insert into order_events(order_id, status, note)
  values (p_order, 'returned', case when p_restock then 'عادت البضاعة للمستودع' else 'مرتجع بدون إعادة للجرد' end);
  if p_restock then
    select warehouse_id into wh from captains where id = o.captain_id;
    select coalesce((select warehouse_id from stock_movements where order_id=p_order and kind='sale' and qty<0 order by created_at,id limit 1),wh) into wh;
    if wh is not null then
      perform public.lock_stock(array[wh], array(select product_id from order_items where order_id=p_order));
      insert into stock(warehouse_id, product_id, qty)
      select wh, product_id, sum(qty) from order_items where order_id = p_order group by product_id
      on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
      insert into stock_movements(warehouse_id, product_id, qty, kind, order_id, note)
      select wh, product_id, sum(qty), 'return', p_order, 'مرتجع طلب #' || o.order_no from order_items where order_id = p_order group by product_id;
    end if;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.save_admin_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare em text := lower(auth.jwt() ->> 'email');
begin
  if not is_admin() or em is null then raise exception 'غير مسموح'; end if;
  insert into push_subscriptions(captain_id, admin_email, endpoint, p256dh, auth) values (null, em, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set captain_id = null, admin_email = excluded.admin_email, p256dh = excluded.p256dh, auth = excluded.auth;
end $function$;

CREATE OR REPLACE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cid uuid := my_captain_id();
begin
  if cid is null then raise exception 'غير مسموح'; end if;
  insert into push_subscriptions(captain_id, admin_email, endpoint, p256dh, auth) values (cid, null, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set captain_id = excluded.captain_id, admin_email = null, p256dh = excluded.p256dh, auth = excluded.auth;
end $function$;

CREATE OR REPLACE FUNCTION public.set_captain_note(p_order uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (is_admin() or coalesce((select captain_id from orders where id = p_order) = my_captain_id(), false))
    then raise exception 'غير مسموح'; end if;
  update orders set captain_note = p_note where id = p_order;
end $function$;

CREATE OR REPLACE FUNCTION public.set_order_note(p_order uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; n text := nullif(trim(coalesce(p_note,'')), '');
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  update orders set note = n where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, o.status,
    case when n is null then 'حذف الإداري الملاحظة' else 'ملاحظة من الإداري: ' || n end);
end $function$;

CREATE OR REPLACE FUNCTION public.set_order_status(p_order uuid, p_status text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or coalesce(o.captain_id = my_captain_id(), false)) then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن تغيير حالة هذا الطلب'; end if;
  if p_status not in ('in_delivery','no_answer','closed','other') then raise exception 'حالة غير صالحة'; end if;
  if p_status = 'other' and n is null then raise exception 'اكتب الملاحظة'; end if;
  update orders set status = p_status, captain_note = n where id = p_order;
  insert into order_events(order_id, status, note) values (p_order, p_status, n);
end $function$;

CREATE OR REPLACE FUNCTION public.set_shipment_status(p_order uuid, p_status text, p_note text DEFAULT NULL::text, p_restock boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; wh uuid; r record; n text := nullif(trim(coalesce(p_note,'')),''); owed numeric; cn text; lbl text; lv text := 'info';
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id=p_order for update;
  if not found or o.fulfillment<>'shipping' then raise exception 'ليست شحنة'; end if;
  if p_status not in ('preparing','handed','in_transit','at_branch','delivered','returned','cancelled') then raise exception 'حالة غير صالحة'; end if;
  if o.status in ('cancelled','returned') then raise exception 'الشحنة مغلقة (ملغاة أو مرتجعة)'; end if;
  if o.ship_status = p_status then raise exception 'الشحنة بهذه الحالة بالفعل'; end if;
  if o.status='delivered' and p_status not in ('returned') then raise exception 'الشحنة مُسلَّمة، يمكن فقط تسجيلها مرتجعة'; end if;
  wh := coalesce(o.ship_warehouse,(select id from warehouses where is_main limit 1));
  perform public.lock_stock(array[wh], array(select product_id from order_items where order_id=p_order));
  if p_status in ('handed','in_transit','at_branch','delivered') and not o.stock_out then
    if wh is null then raise exception 'حدّد المستودع المصدر للشحنة'; end if;
    for r in select p.name, need.qty as needed, coalesce(s.qty,0) as available
      from (select product_id, sum(qty) as qty from order_items where order_id=p_order group by product_id) need
      join products p on p.id=need.product_id left join stock s on s.warehouse_id=wh and s.product_id=need.product_id
      where coalesce(s.qty,0) < need.qty
    loop raise exception 'المنتج "%" غير متوفر بالكمية المطلوبة في المستودع (المطلوب %، المتوفر %)', r.name, r.needed, r.available; end loop;
    update stock st set qty=st.qty-need.qty from (select product_id, sum(qty) as qty from order_items where order_id=p_order group by product_id) need
      where st.warehouse_id=wh and st.product_id=need.product_id;
    insert into stock_movements(warehouse_id,product_id,qty,kind,order_id,note)
      select wh, product_id, -sum(qty), 'sale', p_order, 'شحنة #'||o.order_no from order_items where order_id=p_order group by product_id;
    update orders set stock_out=true where id=p_order; o.stock_out := true;
  end if;
  if p_status in ('cancelled','returned') and o.stock_out and p_restock then
    insert into stock(warehouse_id,product_id,qty) select wh, product_id, sum(qty) from order_items where order_id=p_order group by product_id
      on conflict (warehouse_id,product_id) do update set qty=stock.qty+excluded.qty;
    insert into stock_movements(warehouse_id,product_id,qty,kind,order_id,note)
      select wh, product_id, sum(qty), 'return', p_order, 'مرتجع شحنة #'||o.order_no from order_items where order_id=p_order group by product_id;
    update orders set stock_out=false where id=p_order;
  end if;
  if p_status='cancelled' then update orders set status='cancelled', ship_status='cancelled' where id=p_order; lv:='danger';
  elsif p_status='returned' then
    if o.ship_status='preparing' then raise exception 'لم تُسلَّم الشحنة للشركة بعد، استخدم الإلغاء'; end if;
    update orders set status='returned', ship_status='returned' where id=p_order; lv:='danger';
  elsif p_status='delivered' then
    owed := case when coalesce((select value from settings where key='price_mode'),'actual')='list' then o.list_total else o.items_total end;
    update orders set status='delivered', ship_status='delivered', delivered_at=now(), owed_amount=owed where id=p_order; lv:='success';
  elsif p_status='preparing' then
    if o.stock_out then raise exception 'خرجت البضاعة من المستودع، لا يمكن الرجوع لقيد التجهيز'; end if;
    update orders set status='new', ship_status='preparing' where id=p_order;
  else update orders set status='in_delivery', ship_status=p_status where id=p_order; end if;
  insert into shipment_events(order_id,ship_status,note) values (p_order,p_status,n);
  select name into cn from carriers where id=o.carrier_id;
  lbl := case p_status when 'preparing' then 'قيد التجهيز' when 'handed' then 'سُلِّمت لشركة الشحن' when 'in_transit' then 'في الطريق' when 'at_branch' then 'وصلت لفرع الشركة' when 'delivered' then 'سُلِّمت للزبون' when 'returned' then 'مرتجعة' else 'ملغاة' end;
  perform notify('admin', null, 'status', lv, '📦 شحنة #'||o.order_no||' — '||lbl,
    'الشركة: '||coalesce(cn,'—')||coalesce(E'\nرقم البوليصة: '||o.waybill,'')||E'\nالزبون: '||o.customer_name||coalesce(E'\nالمحافظة: '||o.governorate,'')||E'\nالمنتجات: '||order_lines(p_order)||E'\nالمطلوب من الزبون: '||fmt_money(o.total)||coalesce(E'\nملاحظة: '||n,''), p_order);
end $function$;

CREATE OR REPLACE FUNCTION public.staff_lookups()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not has_perm('create_orders') then raise exception 'غير مسموح'; end if;
  return jsonb_build_object(
    'products', coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by name) from products),'[]'::jsonb),
    'captains', case when has_perm('pick_captain') then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active,'delivery_fee',delivery_fee,'warehouse_id',warehouse_id) order by name) from captains),'[]'::jsonb) else '[]'::jsonb end,
    'warehouses', case when has_perm('pick_captain') then coalesce((select jsonb_agg(jsonb_build_object('id',id,'governorates',governorates)) from warehouses),'[]'::jsonb) else '[]'::jsonb end,
    'marketers', case when has_perm('pick_marketer') then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active,'governorate',governorate) order by name) from marketers),'[]'::jsonb) else '[]'::jsonb end);
end $function$;

CREATE OR REPLACE FUNCTION public.status_ar(s text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case s when 'new' then 'جديد' when 'assigned' then 'مُسند' when 'in_delivery' then 'قيد التوصيل' when 'no_answer' then 'لم يتم الرد'
    when 'closed' then 'مغلق' when 'other' then 'ملاحظة أخرى' when 'delivered' then 'مُسلَّم' when 'cancelled' then 'ملغي' when 'returned' then 'مُرجَع' else s end $function$;

CREATE OR REPLACE FUNCTION public.transfer_stock(p_from uuid, p_to uuid, p_product uuid, p_qty integer, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cur integer;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_from = p_to then raise exception 'اختر مستودعين مختلفين'; end if;
  if p_qty <= 0 then raise exception 'الكمية يجب أن تكون أكبر من صفر'; end if;
  perform guard_once('tr|'||auth.uid()||'|'||p_from||'|'||p_to||'|'||p_product||'|'||p_qty||'|'||coalesce(p_note,''), 10);
  perform public.lock_stock(array[p_from,p_to],array[p_product]);
  select qty into cur from stock where warehouse_id = p_from and product_id = p_product for update;
  if coalesce(cur, 0) < p_qty then raise exception 'الكمية غير متوفرة في المستودع المصدر (المتوفر %)', coalesce(cur, 0); end if;
  update stock set qty = qty - p_qty where warehouse_id = p_from and product_id = p_product;
  insert into stock(warehouse_id, product_id, qty) values (p_to, p_product, p_qty)
  on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
  insert into stock_movements(warehouse_id, product_id, qty, kind, note) values
    (p_from, p_product, -p_qty, 'transfer_out', p_note),
    (p_to, p_product, p_qty, 'transfer_in', p_note);
end $function$;

CREATE OR REPLACE FUNCTION public.trg_customer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare ph text := norm_phone(new.customer_phone);
begin
  if ph<>'' then
    insert into customers(phone,name,first_order_at,last_order_at) values(ph,new.customer_name,new.created_at,new.created_at)
    on conflict(phone) do update set name=excluded.name,
      first_order_at=least(customers.first_order_at,excluded.first_order_at), last_order_at=greatest(customers.last_order_at,excluded.last_order_at);
  end if; return new; end $function$;

CREATE OR REPLACE FUNCTION public.trg_dup_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_table_name = 'captain_payments' then
    perform guard_once('cp|'||new.captain_id||'|'||new.amount||'|'||coalesce(new.note,''), 15);
  elsif tg_table_name = 'marketer_payments' then
    perform guard_once('mp|'||new.marketer_id||'|'||new.amount||'|'||coalesce(new.note,''), 15);
  elsif tg_table_name = 'orders' then
    perform guard_once('o|'||coalesce(auth.uid()::text,'')||'|'||new.customer_name||'|'||coalesce(new.customer_phone,'')||'|'||coalesce(new.captain_id::text,'')||'|'||coalesce(new.note,''), 15);
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_item_capital()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into order_item_capital(item_id, capital, cost) select new.id, p.price, p.cost from products p where p.id = new.product_id
  on conflict (item_id) do nothing;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_keep_one_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if (select count(*) from admins) <= 1 then raise exception 'لا يمكن حذف آخر إداري'; end if;
  return old;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into order_events(order_id, status, note) values (new.id, new.status, 'تم إنشاء الطلب');
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_order_times()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    new.status_at := coalesce(new.status_at, now());
  else
    if new.status is distinct from old.status then new.status_at := now(); end if;
    if new.captain_note is distinct from old.captain_note then
      new.captain_note_at := case when new.captain_note is null then null else now() end;
    end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_orders_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare staff_actor boolean := exists(select 1 from admins where lower(email)=lower(auth.jwt() ->> 'email'));
        full_actor boolean := is_admin(); who text; lines text; head text; sn text;
begin
  if not staff_actor then return new; end if;
  if tg_op = 'INSERT' then return new; end if;
  lines := order_lines(new.id);
  head := 'الزبون: '||new.customer_name||coalesce(E'\nالهاتف: '||nullif(new.customer_phone,''),'')||coalesce(E'\nالمحافظة: '||nullif(new.governorate,''),'')||coalesce(E'\nالعنوان: '||nullif(new.customer_address,''),'')
          ||E'\nالمنتجات: '||lines||E'\nالمطلوب من الزبون: '||fmt_money(new.total)||' (منتجات '||fmt_money(new.items_total)||' + توصيل '||fmt_money(new.delivery_fee)||')'
          ||coalesce(E'\nملاحظة: '||nullif(new.note,''),'');
  if old.total = 0 and old.items_total = 0 and new.total > 0 then
    if new.captain_id is not null then perform notify('captain', new.captain_id, 'new_order', 'info', '📦 طلب جديد #'||new.order_no, head, new.id); end if;
    if not full_actor then
      select coalesce(name,email) into who from admins where lower(email)=lower(auth.jwt() ->> 'email');
      perform notify('admin', null, 'staff_order', 'info', '🆕 طلب جديد #'||new.order_no||' من '||coalesce(who,'موظف'), head||E'\nالكابتن: '||coalesce((select name from captains where id=new.captain_id),'بدون إسناد'), new.id);
    end if;
    return new;
  end if;
  if new.captain_id is distinct from old.captain_id then
    if new.captain_id is not null then perform notify('captain', new.captain_id, 'new_order', 'info', '📦 طلب جديد #'||new.order_no, head, new.id); end if;
    if old.captain_id is not null then perform notify('captain', old.captain_id, 'order_removed', 'warn', '↩️ سُحب منك الطلب #'||new.order_no, 'تم نقل الطلب إلى كابتن آخر.'||E'\nالزبون: '||new.customer_name||E'\nالمنتجات: '||lines, new.id); end if;
  elsif new.captain_id is null then return new;
  elsif new.note is distinct from old.note and new.note is not null then
    perform notify('captain', new.captain_id, 'admin_note', 'warn', '💬 ملاحظة من الإداري — طلب #'||new.order_no, new.note||E'\n\nالزبون: '||new.customer_name||E'\nالحالة: '||status_ar(new.status), new.id);
  elsif coalesce(current_setting('app.skip_edit',true),'')='1' and new.total is distinct from old.total then return new;
  elsif new.total is distinct from old.total or new.customer_address is distinct from old.customer_address or new.map_url is distinct from old.map_url or new.customer_phone is distinct from old.customer_phone then
    perform notify('captain', new.captain_id, 'order_edit', 'warn', '✏️ تم تعديل الطلب #'||new.order_no,
      case when new.total is distinct from old.total then 'الإجمالي الآن '||fmt_money(new.total)||' (كان '||fmt_money(old.total)||')'||E'\nالمنتجات: '||lines else 'تغيّرت بيانات الزبون (العنوان أو الهاتف أو الموقع)' end
      ||E'\nالزبون: '||new.customer_name||coalesce(E'\nالمحافظة: '||nullif(new.governorate,''),'')||coalesce(E'\nالعنوان: '||nullif(new.customer_address,''),''), new.id);
  elsif new.status is distinct from old.status then
    sn := status_ar(new.status);
    perform notify('captain', new.captain_id, 'status',
      case when new.status in ('cancelled','returned') then 'danger' else 'info' end,
      case new.status when 'cancelled' then '❌ أُلغي الطلب #'||new.order_no when 'returned' then '↩️ أُرجع الطلب #'||new.order_no else '🔄 تغيّرت حالة الطلب #'||new.order_no end,
      'الحالة الآن: '||sn||E'\nالزبون: '||new.customer_name||E'\nالمنتجات: '||lines, new.id);
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_orders_push_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cn text; lines text; base text; t text; lv text := 'info';
begin
  if exists(select 1 from admins where lower(email)=lower(auth.jwt() ->> 'email')) or old.captain_id is null then return new; end if;
  select name into cn from captains where id = new.captain_id;
  lines := order_lines(new.id);
  base := 'الكابتن: '||coalesce(cn,'—')||E'\nالزبون: '||new.customer_name||coalesce(E'\nالعنوان: '||nullif(new.customer_address,''),'')||E'\nالمنتجات: '||lines;
  if new.status is distinct from old.status then
    t := case new.status
      when 'delivered' then '✅ تم تسليم الطلب #'||new.order_no
      when 'in_delivery' then '🚚 الطلب #'||new.order_no||' قيد التوصيل'
      when 'no_answer' then '📵 الزبون لم يرد — طلب #'||new.order_no
      when 'closed' then '🔒 هاتف الزبون مغلق — طلب #'||new.order_no
      when 'other' then '📝 ملاحظة أخرى — طلب #'||new.order_no
      when 'cancelled' then '❌ ألغى الكابتن الطلب #'||new.order_no
      else '🔄 تحديث حالة الطلب #'||new.order_no end;
    lv := case when new.status='delivered' then 'success' when new.status in ('no_answer','closed','other') then 'warn' when new.status='cancelled' then 'danger' else 'info' end;
    perform notify('admin', null, 'status', lv, t,
      base||E'\nالحالة: '||status_ar(new.status)
      ||case when new.status='delivered' then E'\nالمبلغ المستحق للإدارة: '||fmt_money(coalesce(new.owed_amount,new.items_total))||E'\nأجرة التوصيل: '||fmt_money(new.delivery_fee)||E'\nالمطلوب من الزبون: '||fmt_money(new.total) else '' end
      ||coalesce(E'\nملاحظة الكابتن: '||nullif(new.captain_note,''),''), new.id);
  elsif new.captain_note is distinct from old.captain_note and new.captain_note is not null then
    perform notify('admin', null, 'captain_note', 'warn', '💬 ملاحظة من الكابتن — طلب #'||new.order_no, new.captain_note||E'\n\n'||base||E'\nالحالة: '||status_ar(new.status), new.id);
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_pay_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare bal numeric;
begin
  select balance into bal from captain_balances where captain_id = new.captain_id;
  perform notify('captain', new.captain_id, 'payment', 'success', '💰 تم تسجيل دفعة '||fmt_money(new.amount),
    'المبلغ المسجَّل: '||fmt_money(new.amount)||coalesce(E'\nالملاحظة: '||nullif(new.note,''),'')||E'\nالمتبقي عليك للإدارة بعد الدفعة: '||fmt_money(bal), null);
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_pr_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders;
begin
  if old.status = 'pending' and new.status <> 'pending' and is_admin() then
    select * into o from orders where id = new.order_id;
    perform notify('captain', new.captain_id, 'price_decision', case when new.status='approved' then 'success' else 'danger' end,
      case when new.status='approved' then '✅ تمت الموافقة على تعديل السعر — طلب #'||o.order_no else '❌ رُفض طلب تعديل السعر — طلب #'||o.order_no end,
      case when new.status='approved' then 'الإجمالي الجديد: '||fmt_money(new.new_total)||' (كان '||fmt_money(new.old_total)||')' else 'يبقى الإجمالي: '||fmt_money(new.old_total) end
      ||E'\nالزبون: '||o.customer_name||coalesce(E'\nملاحظة الإداري: '||nullif(new.admin_note,''),''), new.order_id);
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_pr_push_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cn text; o orders;
begin
  select name into cn from captains where id = new.captain_id;
  select * into o from orders where id = new.order_id;
  perform notify('admin', null, 'price_request', 'warn', '💲 طلب تعديل سعر — طلب #'||o.order_no,
    'الكابتن '||coalesce(cn,'—')||' يطلب تعديل إجمالي الفاتورة'||E'\nالزبون: '||o.customer_name||E'\nالإجمالي: من '||fmt_money(new.old_total)||' إلى '||fmt_money(new.new_total)||' (الفرق '||case when new.new_total>=new.old_total then '+' else '−' end||fmt_money(abs(new.new_total-new.old_total))||')'
    ||coalesce(E'\nالسبب: '||nullif(new.reason,''),''), new.order_id);
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_stock_invoice_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare wh uuid; nt text;
begin
  select warehouse_id, note into wh, nt from stock_invoices where id = new.invoice_id;
  insert into stock(warehouse_id, product_id, qty) values (wh, new.product_id, new.qty)
  on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
  insert into stock_movements(warehouse_id, product_id, qty, kind, note) values (wh, new.product_id, new.qty, 'invoice', nt);
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.update_order_prices(p_order uuid, p_prices jsonb, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders; it jsonb; n text := nullif(trim(coalesce(p_note, '')), ''); newp numeric; oldp numeric; pn text; chg text := '';
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if not (is_admin() or (coalesce(o.captain_id = my_captain_id(), false)
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
end $function$;

CREATE OR REPLACE FUNCTION public.update_shipment(p_order uuid, p_carrier uuid, p_waybill text, p_cost numeric, p_fee numeric, p_wh uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o orders;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id=p_order for update;
  if not found or o.fulfillment<>'shipping' then raise exception 'ليست شحنة'; end if;
  if coalesce(p_cost,0)<0 or coalesce(p_fee,0)<0 then raise exception 'مبلغ غير صالح'; end if;
  if p_carrier is not null and not exists(select 1 from carriers where id=p_carrier) then raise exception 'شركة غير موجودة'; end if;
  update orders set carrier_id=coalesce(p_carrier,carrier_id), waybill=nullif(trim(coalesce(p_waybill,'')),''), shipping_cost=coalesce(p_cost,shipping_cost) where id=p_order;
  if p_fee is not null and p_fee is distinct from o.delivery_fee then
    if o.status in ('delivered','returned','cancelled') then raise exception 'لا يمكن تغيير أجور الشحن على الزبون بعد إغلاق الشحنة'; end if;
    update orders set delivery_fee=p_fee, total=items_total+p_fee where id=p_order;
  end if;
  if p_wh is not null and not o.stock_out then update orders set ship_warehouse=p_wh where id=p_order; end if;
  insert into shipment_events(order_id,ship_status,note) values (p_order,coalesce(o.ship_status,'preparing'),'تعديل بيانات الشحنة');
end $function$;

CREATE OR REPLACE FUNCTION public.web_push_targets(p_admins boolean, p_captain uuid DEFAULT NULL::uuid)
 RETURNS SETOF push_subscriptions
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select s.* from public.push_subscriptions s
 where ((p_admins and s.admin_email is not null and exists(select 1 from public.admins a where lower(a.email)=lower(s.admin_email)
   and (to_jsonb(a)->'perms' is null or to_jsonb(a)->'perms'='null'::jsonb)))
  or (not p_admins and s.captain_id=p_captain and exists(select 1 from public.captains c where c.id=s.captain_id and c.active)))
 and not exists(select 1 from public.native_push_preferences p where p.native_only and
  ((p_admins and p.app_scope='admin' and lower(p.admin_email)=lower(s.admin_email)) or
   (not p_admins and p.app_scope='captain' and p.captain_id=s.captain_id)));
$function$;

drop policy if exists "admin_all" on public."products";
create policy "admin_all" on public."products" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."captains";
create policy "admin_all" on public."captains" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."warehouses";
create policy "admin_all" on public."warehouses" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."stock";
create policy "admin_all" on public."stock" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."stock_invoices";
create policy "admin_all" on public."stock_invoices" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."stock_invoice_items";
create policy "admin_all" on public."stock_invoice_items" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."orders";
create policy "admin_all" on public."orders" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."order_items";
create policy "admin_all" on public."order_items" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."captain_payments";
create policy "admin_all" on public."captain_payments" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "cap_products" on public."products";
create policy "cap_products" on public."products" for SELECT to "authenticated" using (true);

drop policy if exists "cap_self" on public."captains";
create policy "cap_self" on public."captains" for SELECT to "authenticated" using ((id = my_captain_id()));

drop policy if exists "cap_orders" on public."orders";
create policy "cap_orders" on public."orders" for SELECT to "authenticated" using ((captain_id = my_captain_id()));

drop policy if exists "pr_select" on public."price_requests";
create policy "pr_select" on public."price_requests" for SELECT to "authenticated" using ((is_admin() OR (captain_id = my_captain_id())));

drop policy if exists "cap_order_items" on public."order_items";
create policy "cap_order_items" on public."order_items" for SELECT to "authenticated" using ((order_id IN ( SELECT orders.id
   FROM orders
  WHERE (orders.captain_id = my_captain_id()))));

drop policy if exists "cap_payments" on public."captain_payments";
create policy "cap_payments" on public."captain_payments" for SELECT to "authenticated" using ((captain_id = my_captain_id()));

drop policy if exists "admins_self" on public."admins";
create policy "admins_self" on public."admins" for SELECT to "authenticated" using ((lower(email) = lower((auth.jwt() ->> 'email'::text))));

drop policy if exists "settings_read" on public."settings";
create policy "settings_read" on public."settings" for SELECT to "authenticated" using (true);

drop policy if exists "settings_admin" on public."settings";
create policy "settings_admin" on public."settings" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admins_admin_all" on public."admins";
create policy "admins_admin_all" on public."admins" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "mv_admin" on public."stock_movements";
create policy "mv_admin" on public."stock_movements" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "ev_admin" on public."order_events";
create policy "ev_admin" on public."order_events" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "ev_captain" on public."order_events";
create policy "ev_captain" on public."order_events" for SELECT to "authenticated" using ((order_id IN ( SELECT orders.id
   FROM orders
  WHERE (orders.captain_id = my_captain_id()))));

drop policy if exists "admin_all" on public."marketers";
create policy "admin_all" on public."marketers" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."marketer_payments";
create policy "admin_all" on public."marketer_payments" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "admin_all" on public."order_item_capital";
create policy "admin_all" on public."order_item_capital" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "cap_stock" on public."stock";
create policy "cap_stock" on public."stock" for SELECT to public using ((warehouse_id = my_warehouse_id()));

drop policy if exists "mv_captain" on public."stock_movements";
create policy "mv_captain" on public."stock_movements" for SELECT to public using ((warehouse_id = my_warehouse_id()));

drop policy if exists "cap_wh" on public."warehouses";
create policy "cap_wh" on public."warehouses" for SELECT to public using ((id = my_warehouse_id()));

drop policy if exists "cust_admin" on public."customers";
create policy "cust_admin" on public."customers" for SELECT to "authenticated" using (is_admin());

drop policy if exists "carriers_admin" on public."carriers";
create policy "carriers_admin" on public."carriers" for ALL to "authenticated" using (is_admin()) with check (is_admin());

drop policy if exists "cpay_admin" on public."carrier_payments";
create policy "cpay_admin" on public."carrier_payments" for SELECT to "authenticated" using (is_admin());

drop policy if exists "cpay_admin_del" on public."carrier_payments";
create policy "cpay_admin_del" on public."carrier_payments" for DELETE to "authenticated" using (is_admin());

drop policy if exists "sev_admin" on public."shipment_events";
create policy "sev_admin" on public."shipment_events" for SELECT to "authenticated" using (is_admin());

drop policy if exists "n_admin" on public."notifications";
create policy "n_admin" on public."notifications" for SELECT to public using (((audience = 'admin'::text) AND is_admin()));

drop policy if exists "n_captain" on public."notifications";
create policy "n_captain" on public."notifications" for SELECT to public using (((audience = 'captain'::text) AND (captain_id = my_captain_id())));

drop policy if exists "staff_orders" on public."orders";
create policy "staff_orders" on public."orders" for SELECT to public using ((has_perm('view_orders'::text) AND (created_by = lower((auth.jwt() ->> 'email'::text)))));

drop policy if exists "staff_order_items" on public."order_items";
create policy "staff_order_items" on public."order_items" for SELECT to public using ((order_id IN ( SELECT orders.id
   FROM orders
  WHERE (has_perm('view_orders'::text) AND (orders.created_by = lower((auth.jwt() ->> 'email'::text)))))));

drop trigger if exists "stock_invoice_item_ins" on public."stock_invoice_items";
CREATE TRIGGER stock_invoice_item_ins AFTER INSERT ON public.stock_invoice_items FOR EACH ROW EXECUTE FUNCTION trg_stock_invoice_item();

drop trigger if exists "keep_one_admin" on public."admins";
CREATE TRIGGER keep_one_admin BEFORE DELETE ON public.admins FOR EACH ROW EXECUTE FUNCTION trg_keep_one_admin();

drop trigger if exists "order_created" on public."orders";
CREATE TRIGGER order_created AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_order_created();

drop trigger if exists "orders_push" on public."orders";
CREATE TRIGGER orders_push AFTER INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_orders_push();

drop trigger if exists "pr_push" on public."price_requests";
CREATE TRIGGER pr_push AFTER UPDATE ON public.price_requests FOR EACH ROW EXECUTE FUNCTION trg_pr_push();

drop trigger if exists "pay_push" on public."captain_payments";
CREATE TRIGGER pay_push AFTER INSERT ON public.captain_payments FOR EACH ROW EXECUTE FUNCTION trg_pay_push();

drop trigger if exists "orders_push_admin" on public."orders";
CREATE TRIGGER orders_push_admin AFTER UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_orders_push_admin();

drop trigger if exists "pr_push_admin" on public."price_requests";
CREATE TRIGGER pr_push_admin AFTER INSERT ON public.price_requests FOR EACH ROW EXECUTE FUNCTION trg_pr_push_admin();

drop trigger if exists "item_capital" on public."order_items";
CREATE TRIGGER item_capital AFTER INSERT ON public.order_items FOR EACH ROW EXECUTE FUNCTION trg_item_capital();

drop trigger if exists "order_times" on public."orders";
CREATE TRIGGER order_times BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_order_times();

drop trigger if exists "trg_customer" on public."orders";
CREATE TRIGGER trg_customer AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_customer();

drop trigger if exists "trg_dup_guard" on public."orders";
CREATE TRIGGER trg_dup_guard BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION trg_dup_guard();

drop trigger if exists "trg_dup_guard" on public."captain_payments";
CREATE TRIGGER trg_dup_guard BEFORE INSERT ON public.captain_payments FOR EACH ROW EXECUTE FUNCTION trg_dup_guard();

drop trigger if exists "trg_dup_guard" on public."marketer_payments";
CREATE TRIGGER trg_dup_guard BEFORE INSERT ON public.marketer_payments FOR EACH ROW EXECUTE FUNCTION trg_dup_guard();

revoke execute on function public.add_carrier_payment(uuid,numeric,text) from public,anon,authenticated,service_role;

grant execute on function public.add_carrier_payment(uuid,numeric,text) to "authenticated";

revoke execute on function public.adjust_stock(uuid,uuid,integer,text) from public,anon,authenticated,service_role;

grant execute on function public.adjust_stock(uuid,uuid,integer,text) to "authenticated";

revoke execute on function public.admin_products() from public,anon,authenticated,service_role;

grant execute on function public.admin_products() to "authenticated";

revoke execute on function public.admin_profit_items() from public,anon,authenticated,service_role;

grant execute on function public.admin_profit_items() to "authenticated";

revoke execute on function public.assign_order(uuid,uuid) from public,anon,authenticated,service_role;

grant execute on function public.assign_order(uuid,uuid) to "authenticated";

revoke execute on function public.cancel_order(uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.cancel_order(uuid,text) to "authenticated";

revoke execute on function public.create_order(text,text,text,uuid,jsonb,text,text,uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.create_order(text,text,text,uuid,jsonb,text,text,uuid,text) to "authenticated";

revoke execute on function public.create_shipment(text,text,text,jsonb,text,text,uuid,text,uuid,text,numeric,numeric,uuid) from public,anon,authenticated,service_role;

grant execute on function public.create_shipment(text,text,text,jsonb,text,text,uuid,text,uuid,text,numeric,numeric,uuid) to "authenticated";

revoke execute on function public.create_stock_invoice(uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;

grant execute on function public.create_stock_invoice(uuid,text,jsonb,boolean) to "authenticated";

revoke execute on function public.dashboard_stats() from public,anon,authenticated,service_role;

grant execute on function public.dashboard_stats() to "authenticated";

revoke execute on function public.decide_price_request(uuid,boolean,text) from public,anon,authenticated,service_role;

grant execute on function public.decide_price_request(uuid,boolean,text) to "authenticated";

revoke execute on function public.deliver_order(uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.deliver_order(uuid,text) to "authenticated";

revoke execute on function public.edit_order(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;

grant execute on function public.edit_order(uuid,jsonb,jsonb) to "authenticated";

revoke execute on function public.fmt_money(numeric) from public,anon,authenticated,service_role;

revoke execute on function public.guard_once(text,integer) from public,anon,authenticated,service_role;

revoke execute on function public.has_perm(text) from public,anon,authenticated,service_role;

grant execute on function public.has_perm(text) to "authenticated";

revoke execute on function public.is_admin() from public,anon,authenticated,service_role;

grant execute on function public.is_admin() to "authenticated";

revoke execute on function public.mark_notifications_read(uuid[]) from public,anon,authenticated,service_role;

grant execute on function public.mark_notifications_read(uuid[]) to "authenticated";

revoke execute on function public.marketer_return_impact(uuid) from public,anon,authenticated,service_role;

grant execute on function public.marketer_return_impact(uuid) to "authenticated";

revoke execute on function public.my_access() from public,anon,authenticated,service_role;

grant execute on function public.my_access() to "authenticated";

revoke execute on function public.my_captain_id() from public,anon,authenticated,service_role;

grant execute on function public.my_captain_id() to "authenticated";

revoke execute on function public.my_warehouse_id() from public,anon,authenticated,service_role;

grant execute on function public.my_warehouse_id() to "authenticated";

revoke execute on function public.native_device_action(uuid,text,text,text,text,uuid,uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.native_device_action(uuid,text,text,text,text,uuid,uuid,text) to "service_role";

revoke execute on function public.native_push_targets(boolean,uuid) from public,anon,authenticated,service_role;

grant execute on function public.native_push_targets(boolean,uuid) to "service_role";

revoke execute on function public.norm_phone(text) from public,anon,authenticated,service_role;

grant execute on function public.norm_phone(text) to public;

revoke execute on function public.notify(text,uuid,text,text,text,text,uuid) from public,anon,authenticated,service_role;

revoke execute on function public.order_lines(uuid) from public,anon,authenticated,service_role;

revoke execute on function public.push_to_admins(text,text,text) from public,anon,authenticated,service_role;

revoke execute on function public.push_to_captain(uuid,text,text,text) from public,anon,authenticated,service_role;

revoke execute on function public.remove_push_subscription(text) from public,anon,authenticated,service_role;

grant execute on function public.remove_push_subscription(text) to "authenticated";

revoke execute on function public.request_price_change(uuid,numeric,text) from public,anon,authenticated,service_role;

grant execute on function public.request_price_change(uuid,numeric,text) to "authenticated";

revoke execute on function public.reset_test_data() from public,anon,authenticated,service_role;

grant execute on function public.reset_test_data() to "authenticated";

revoke execute on function public.restore_order(uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.restore_order(uuid,text) to "authenticated";

revoke execute on function public.return_order(uuid,boolean,text) from public,anon,authenticated,service_role;

grant execute on function public.return_order(uuid,boolean,text) to "authenticated";

revoke execute on function public.save_admin_push_subscription(text,text,text) from public,anon,authenticated,service_role;

grant execute on function public.save_admin_push_subscription(text,text,text) to "authenticated";

revoke execute on function public.save_push_subscription(text,text,text) from public,anon,authenticated,service_role;

grant execute on function public.save_push_subscription(text,text,text) to "authenticated";

revoke execute on function public.set_captain_note(uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.set_captain_note(uuid,text) to "authenticated";

revoke execute on function public.set_order_note(uuid,text) from public,anon,authenticated,service_role;

grant execute on function public.set_order_note(uuid,text) to "authenticated";

revoke execute on function public.set_order_status(uuid,text,text) from public,anon,authenticated,service_role;

grant execute on function public.set_order_status(uuid,text,text) to "authenticated";

revoke execute on function public.set_shipment_status(uuid,text,text,boolean) from public,anon,authenticated,service_role;

grant execute on function public.set_shipment_status(uuid,text,text,boolean) to "authenticated";

revoke execute on function public.staff_lookups() from public,anon,authenticated,service_role;

grant execute on function public.staff_lookups() to "authenticated";

revoke execute on function public.status_ar(text) from public,anon,authenticated,service_role;

revoke execute on function public.transfer_stock(uuid,uuid,uuid,integer,text) from public,anon,authenticated,service_role;

grant execute on function public.transfer_stock(uuid,uuid,uuid,integer,text) to "authenticated";

revoke execute on function public.trg_customer() from public,anon,authenticated,service_role;

grant execute on function public.trg_customer() to public;

revoke execute on function public.trg_dup_guard() from public,anon,authenticated,service_role;

revoke execute on function public.trg_item_capital() from public,anon,authenticated,service_role;

revoke execute on function public.trg_keep_one_admin() from public,anon,authenticated,service_role;

grant execute on function public.trg_keep_one_admin() to public;

revoke execute on function public.trg_order_created() from public,anon,authenticated,service_role;

revoke execute on function public.trg_order_times() from public,anon,authenticated,service_role;

revoke execute on function public.trg_orders_push() from public,anon,authenticated,service_role;

revoke execute on function public.trg_orders_push_admin() from public,anon,authenticated,service_role;

revoke execute on function public.trg_pay_push() from public,anon,authenticated,service_role;

revoke execute on function public.trg_pr_push() from public,anon,authenticated,service_role;

revoke execute on function public.trg_pr_push_admin() from public,anon,authenticated,service_role;

revoke execute on function public.trg_stock_invoice_item() from public,anon,authenticated,service_role;

revoke execute on function public.update_order_prices(uuid,jsonb,text) from public,anon,authenticated,service_role;

grant execute on function public.update_order_prices(uuid,jsonb,text) to "authenticated";

revoke execute on function public.update_shipment(uuid,uuid,text,numeric,numeric,uuid) from public,anon,authenticated,service_role;

grant execute on function public.update_shipment(uuid,uuid,text,numeric,numeric,uuid) to "authenticated";

revoke execute on function public.web_push_targets(boolean,uuid) from public,anon,authenticated,service_role;

grant execute on function public.web_push_targets(boolean,uuid) to "service_role";

revoke all on function public.reset_test_data() from public,anon,authenticated,service_role;


-- RLS remains active: callers can only see orders and products they could SELECT directly.
-- JSON aggregation avoids the REST row cap hiding old, still-open work.
create or replace function public.working_orders(p_history_limit integer default 300,p_captain uuid default null)
returns jsonb language sql stable security invoker set search_path=public as $$
 with visible as (
  select o.* from orders o where (p_captain is null or o.captain_id=p_captain)
 ), chosen as (
  select * from visible where status not in ('delivered','returned','cancelled')
  union all (select * from visible where status in ('delivered','returned','cancelled')
   order by created_at desc,id desc limit greatest(0,least(coalesce(p_history_limit,300),1000)))
 ) select coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('order_items',
    coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'product_id',i.product_id,'qty',i.qty,
     'unit_price',i.unit_price,'list_price',i.list_price,'products',jsonb_build_object('name',p.name)) order by i.id)
     from order_items i join products p on p.id=i.product_id where i.order_id=o.id),'[]'::jsonb))
    order by o.created_at desc,o.id desc),'[]'::jsonb) from chosen o;
$$;
revoke all on function public.working_orders(integer,uuid) from public,anon;
grant execute on function public.working_orders(integer,uuid) to authenticated;

-- Account balances must include the entire ledger, independently of paged display lists.
create or replace function public.carrier_balances() returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
 if not is_admin() then raise exception 'غير مسموح'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('carrier_id',c.id,'col',x.col,'fees',x.fees,
  'paid',p.paid,'owed',x.col-x.fees-p.paid,'fly',x.fly,'pend',x.pend,'n',x.n,'dl',x.dl,'rt',x.rt) order by c.id),'[]'::jsonb)
 from carriers c cross join lateral (
  select coalesce(sum(total) filter(where status='delivered'),0) col,
   coalesce(sum(shipping_cost) filter(where status in ('delivered','returned')),0) fees,
   count(*) filter(where ship_status in ('handed','in_transit','at_branch')) fly,
   coalesce(sum(total) filter(where ship_status in ('handed','in_transit','at_branch')),0) pend,
   count(*) n,count(*) filter(where status='delivered') dl,count(*) filter(where status='returned') rt
  from orders where carrier_id=c.id and fulfillment='shipping'
 )x cross join lateral (select coalesce(sum(amount),0) paid from carrier_payments where carrier_id=c.id)p);
end $$;
revoke all on function public.carrier_balances() from public,anon;
grant execute on function public.carrier_balances() to authenticated;

-- Detail and totals share one statement snapshot; no REST cap truncates the financial export.
create or replace function public.carrier_statement(p_carrier uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
 if not is_admin() then raise exception 'غير مسموح'; end if;
 return jsonb_build_object(
 'balance',(select x from jsonb_array_elements(carrier_balances())x where x->>'carrier_id'=p_carrier::text),
 'orders',(select coalesce(jsonb_agg(to_jsonb(o) order by o.status_at,o.id),'[]'::jsonb) from
  (select id,order_no,status_at,waybill,customer_name,status,total,shipping_cost from orders
   where carrier_id=p_carrier and fulfillment='shipping' and status in ('delivered','returned'))o),
 'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id desc),'[]'::jsonb)
  from carrier_payments p where p.carrier_id=p_carrier));
end $$;
revoke all on function public.carrier_statement(uuid) from public,anon;
grant execute on function public.carrier_statement(uuid) to authenticated;

do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.stock'::regclass and conname='stock_nonnegative') then
  alter table public.stock add constraint stock_nonnegative check(qty>=0) not valid;
 end if;
 if not exists(select 1 from public.stock where qty<0) then alter table public.stock validate constraint stock_nonnegative; end if;
end $$;
notify pgrst,'reload schema';
commit;
