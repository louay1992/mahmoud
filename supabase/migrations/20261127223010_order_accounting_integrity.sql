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
  -- Order edits, price requests, and approval all take the order lock first.
  select o0.* into o from orders o0 join price_requests p on p.order_id = o0.id
  where p.id = p_id for update of o0;
  if not found then raise exception 'الطلب غير موجود'; end if;
  select * into pr from price_requests where id = p_id and order_id = o.id for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if pr.status <> 'pending' then raise exception 'تم البتّ في هذا الطلب مسبقاً'; end if;
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
  if (o.stock_out or o.status in ('delivered','returned','cancelled'))
      and p_carrier is not null and p_carrier is distinct from o.carrier_id then
    raise exception 'لا يمكن تغيير شركة الشحن بعد خروج الشحنة أو إغلاقها';
  end if;
  if o.status in ('delivered','returned','cancelled')
      and p_cost is not null and p_cost is distinct from o.shipping_cost then
    raise exception 'لا يمكن تعديل تكلفة شحنة مغلقة';
  end if;
  if p_carrier is not null and not exists(select 1 from carriers where id=p_carrier) then raise exception 'شركة غير موجودة'; end if;
  update orders set carrier_id=coalesce(p_carrier,carrier_id), waybill=nullif(trim(coalesce(p_waybill,'')),''), shipping_cost=coalesce(p_cost,shipping_cost) where id=p_order;
  if p_fee is not null and p_fee is distinct from o.delivery_fee then
    if o.status in ('delivered','returned','cancelled') then raise exception 'لا يمكن تغيير أجور الشحن على الزبون بعد إغلاق الشحنة'; end if;
    update orders set delivery_fee=p_fee, total=items_total+p_fee where id=p_order;
  end if;
  if p_wh is not null and p_wh is distinct from o.ship_warehouse then
    if o.stock_out or o.status in ('delivered','returned','cancelled') then
      raise exception 'لا يمكن تغيير مستودع الشحنة بعد خروجها أو إغلاقها';
    end if;
    update orders set ship_warehouse=p_wh where id=p_order;
  end if;
  insert into shipment_events(order_id,ship_status,note) values (p_order,coalesce(o.ship_status,'preparing'),'تعديل بيانات الشحنة');
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
  if o.stock_out then
    select coalesce((select warehouse_id from stock_movements
       where order_id=p_order and kind='sale' and qty<0 order by created_at,id limit 1),wh) into wh;
  end if;
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
    update orders set stock_out=true, ship_warehouse=wh where id=p_order; o.stock_out := true;
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

CREATE OR REPLACE FUNCTION public.trg_order_times()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    new.status_at := coalesce(new.status_at, now());
  else
    if new.status is distinct from old.status or new.ship_status is distinct from old.ship_status then new.status_at := now(); end if;
    if new.captain_note is distinct from old.captain_note then
      new.captain_note_at := case when new.captain_note is null then null else now() end;
    end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.admin_profit_items()
 RETURNS TABLE(item_id uuid, order_id uuid, order_no bigint, product_id uuid, product_name text, marketer_id uuid, captain_id uuid, status text, created_at timestamp with time zone, delivered_at timestamp with time zone, governorate text, delivery_fee numeric, first_item boolean, qty integer, unit_price numeric, capital numeric, cost numeric, fulfillment text, shipping_cost numeric, carrier_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select i.id, o.id, o.order_no::bigint, i.product_id, p.name, o.marketer_id, o.captain_id, o.status::text, o.created_at, o.delivered_at, o.governorate, o.delivery_fee,
    (row_number() over (partition by o.id order by i.id)=1), i.qty, i.unit_price, coalesce(c.capital,p.price), coalesce(c.cost,0), o.fulfillment, o.shipping_cost, o.carrier_id
  from orders o join order_items i on i.order_id=o.id join products p on p.id=i.product_id left join order_item_capital c on c.item_id=i.id
  where is_admin() order by o.created_at desc, o.id desc, i.id desc $function$;

-- Existing rows remain available for reconciliation. All future inserts and updates
-- must use finite values, including writes through older application versions.
alter table public.products add constraint products_finite_amounts
  check (price < 'Infinity'::numeric and cost < 'Infinity'::numeric) not valid;
alter table public.order_items add constraint order_items_finite_amounts check (
  unit_price between -9999999999.99 and 9999999999.99
  and list_price between -9999999999.99 and 9999999999.99) not valid;
alter table public.order_item_capital add constraint order_item_capital_finite_amounts check (
  capital between -9999999999.99 and 9999999999.99
  and cost > '-Infinity'::numeric and cost < 'Infinity'::numeric) not valid;
alter table public.captain_payments add constraint captain_payments_finite_amount
  check (amount < 'Infinity'::numeric) not valid;
alter table public.marketer_payments add constraint marketer_payments_finite_amount
  check (amount < 'Infinity'::numeric) not valid;
alter table public.carrier_payments add constraint carrier_payments_finite_amount
  check (amount < 'Infinity'::numeric) not valid;
alter table public.price_requests add constraint price_requests_finite_amounts check (
  old_total between -9999999999.99 and 9999999999.99
  and new_total between -9999999999.99 and 9999999999.99) not valid;

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
    if up is null or not (up >= 0 and up < 'Infinity'::numeric) then raise exception 'السعر غير صالح'; end if;
    -- Sum the same currency precision that is stored on each invoice line.
    up := round(up, 2);
    if staff and up < coalesce(pr,0) then raise exception 'سعر البيع أقل من الحد الأدنى المسموح لأحد المنتجات'; end if;
    insert into order_items(order_id, product_id, qty, unit_price, list_price)
    values (oid, (it->>'product_id')::uuid, (it->>'qty')::int, up, up);
    sub := sub + up * (it->>'qty')::int;
  end loop;
  update orders set items_total = sub, list_total = sub, total = sub + coalesce(fee,0) where id = oid;
  return oid;
end $function$;

create or replace function public.edit_order(p_order uuid, p_info jsonb, p_items jsonb default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  o orders;
  it record;
  previous order_items;
  product products;
  kept uuid[] := '{}';
  line_id uuid;
  line_price numeric;
  name_next text;
  phone_next text;
  address_next text;
  map_next text;
  governorate_next text;
  marketer_next uuid;
  info_changed boolean := false;
  subtotal numeric;
  baseline numeric;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id=p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if o.status not in ('new','assigned','in_delivery','no_answer','closed','other') then
    raise exception 'لا يمكن تعديل هذا الطلب في حالته الحالية';
  end if;

  if p_info is not null then
    if jsonb_typeof(p_info) <> 'object' then raise exception 'بيانات الزبون غير صالحة'; end if;
    name_next := case when p_info ? 'name' then nullif(btrim(p_info->>'name'),'') else o.customer_name end;
    phone_next := case when p_info ? 'phone' then nullif(btrim(p_info->>'phone'),'') else o.customer_phone end;
    address_next := case when p_info ? 'address' then nullif(btrim(p_info->>'address'),'') else o.customer_address end;
    map_next := case when p_info ? 'map_url' then nullif(btrim(p_info->>'map_url'),'') else o.map_url end;
    governorate_next := case when p_info ? 'governorate' then nullif(btrim(p_info->>'governorate'),'') else o.governorate end;
    marketer_next := case when p_info ? 'marketer_id' then nullif(p_info->>'marketer_id','')::uuid else o.marketer_id end;
    if name_next is null or phone_next is null then raise exception 'اسم الزبون ورقمه مطلوبان'; end if;
    info_changed := row(name_next,phone_next,address_next,map_next,governorate_next,marketer_next)
      is distinct from row(o.customer_name,o.customer_phone,o.customer_address,o.map_url,o.governorate,o.marketer_id);
    if info_changed then
      update orders set customer_name=name_next, customer_phone=phone_next, customer_address=address_next,
        map_url=map_next, governorate=governorate_next, marketer_id=marketer_next where id=p_order;
      insert into order_events(order_id,status,note) values(p_order,o.status,'عدّل الإداري بيانات الزبون/العنوان');
    end if;
  end if;

  if p_items is null then return; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'أضف منتجاً واحداً على الأقل';
  end if;
  -- Older clients send every row when editing contact details. Preserve exact
  -- written amounts, IDs and pending requests when the set of item values matches.
  if not exists (
    with entered as (
      select product_id, qty, unit_price from jsonb_to_recordset(p_items) as x(product_id uuid,qty integer,unit_price numeric)
    ), current_items as (
      select product_id, qty, unit_price from order_items where order_id=p_order
    )
    (select * from entered except all select * from current_items)
    union all
    (select * from current_items except all select * from entered)
  ) then return; end if;
  if o.fulfillment='shipping' and o.stock_out then
    raise exception 'لا يمكن تعديل البنود بعد خروج الشحنة من المستودع';
  end if;

  for it in
    select * from jsonb_to_recordset(p_items) as x(item_id uuid,product_id uuid,qty integer,unit_price numeric)
  loop
    if it.qty is null or it.qty <= 0 then raise exception 'الكمية غير صالحة'; end if;
    select * into product from products where id=it.product_id;
    if not found then raise exception 'منتج غير موجود'; end if;
    previous := null;
    if it.item_id is not null then
      select * into previous from order_items where id=it.item_id and order_id=p_order and not (id=any(kept));
      if not found then raise exception 'بند الطلب تغير، أعد فتح التعديل'; end if;
      if previous.product_id is distinct from it.product_id then previous := null; end if;
    else
      select * into previous from order_items
      where order_id=p_order and product_id=it.product_id and not (id=any(kept))
      order by (unit_price is not distinct from it.unit_price) desc, id limit 1;
    end if;
    line_price := coalesce(it.unit_price,previous.unit_price,product.price);
    if not (line_price >= 0 and line_price < 'Infinity'::numeric) then raise exception 'السعر غير صالح'; end if;
    if previous.id is null then
      insert into order_items(order_id,product_id,qty,unit_price,list_price)
      values (p_order,it.product_id,it.qty,line_price,line_price) returning id into line_id;
    else
      line_id := previous.id;
      if row(previous.qty,previous.unit_price) is distinct from row(it.qty,line_price) then
        update order_items set qty=it.qty, unit_price=line_price where id=line_id;
      end if;
    end if;
    kept := array_append(kept,line_id);
  end loop;
  delete from order_items where order_id=p_order and not (id=any(kept));
  select sum(qty * unit_price),sum(qty * list_price) into subtotal,baseline from order_items where order_id=p_order;
  update orders set price_adjust=0, items_total=subtotal, list_total=baseline, total=subtotal+delivery_fee where id=p_order;
  update price_requests set status='rejected', admin_note='أُلغي لأن الإداري عدّل بنود الطلب', decided_at=now()
  where order_id=p_order and status='pending';
  insert into order_events(order_id,status,note)
  values (p_order,o.status,'عدّل الإداري بنود الطلب. الإجمالي الجديد ' || (subtotal + o.delivery_fee));
end $$;

-- Use one transaction and compare captain locations from the form against current rows.
create function public.save_warehouse(
  p_id uuid, p_name text, p_governorates text[], p_captains uuid[], p_expected jsonb
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  warehouse_id_saved uuid := p_id;
  expected record;
  captain public.captains;
  expected_ids uuid[];
  selected uuid[] := coalesce(p_captains,'{}');
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if coalesce(btrim(p_name),'')='' then raise exception 'أدخل اسم المستودع'; end if;
  if jsonb_typeof(p_expected) is distinct from 'array' then raise exception 'قائمة إسناد غير صالحة'; end if;
  if p_id is not null then
    perform 1 from warehouses where id=p_id for update;
    if not found then raise exception 'المستودع غير موجود'; end if;
  end if;
  select coalesce(array_agg(x.id),'{}') into expected_ids
  from jsonb_to_recordset(p_expected) as x(id uuid,warehouse_id uuid);
  if not selected <@ expected_ids then raise exception 'قائمة إسناد غير صالحة'; end if;
  for expected in select * from jsonb_to_recordset(p_expected) as x(id uuid,warehouse_id uuid) order by id loop
    select * into captain from captains where id=expected.id for update;
    if not found or captain.warehouse_id is distinct from expected.warehouse_id then
      raise exception 'تغيّر ربط الكباتن، حدّث الصفحة ثم أعد المحاولة';
    end if;
  end loop;
  if p_id is not null and exists (select 1 from captains where warehouse_id=p_id and not (id=any(expected_ids))) then
    raise exception 'تغيّر ربط الكباتن، حدّث الصفحة ثم أعد المحاولة';
  end if;

  if p_id is null then
    insert into warehouses(name,governorates)
    values (btrim(p_name),coalesce(p_governorates,'{}')) returning id into warehouse_id_saved;
  else
    update warehouses set name=btrim(p_name),governorates=coalesce(p_governorates,'{}') where id=p_id;
    update captains set warehouse_id=null where warehouse_id=p_id and not (id=any(selected));
  end if;
  update captains set warehouse_id=warehouse_id_saved
  where id=any(selected) and warehouse_id is distinct from warehouse_id_saved;
  return warehouse_id_saved;
end $$;

create function public.set_shipment_status_checked(
  p_order uuid, p_status text, p_note text, p_restock boolean, p_expected_status text, p_expected_stock_out boolean
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from orders where id=p_order and fulfillment='shipping' for update;
  if not found then raise exception 'ليست شحنة'; end if;
  if o.ship_status is distinct from p_expected_status or o.stock_out is distinct from p_expected_stock_out then
    raise exception 'تغيّرت حالة الشحنة. افتحها مجددًا وتحقق من البضاعة قبل المتابعة';
  end if;
  perform set_shipment_status(p_order,p_status,p_note,p_restock);
end $$;

create function public.order_history(p_order uuid)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at,e.id),'[]'::jsonb)
  from order_events e where e.order_id=p_order;
$$;

create function public.captain_statement(p_captain uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not (is_admin() or coalesce(p_captain=my_captain_id(),false)) then raise exception 'غير مسموح'; end if;
  return jsonb_build_object(
    'balance',(select to_jsonb(b) from captain_balances b where b.captain_id=p_captain),
    'orders',(select coalesce(jsonb_agg(to_jsonb(o) order by o.delivered_at,o.id),'[]'::jsonb)
      from (select id,order_no,customer_name,items_total,owed_amount,list_total,delivery_fee,
                   delivered_at,status_at,created_at
            from orders where captain_id=p_captain and status='delivered') o),
    'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id),'[]'::jsonb)
      from captain_payments p where p.captain_id=p_captain)
  );
end $$;

revoke all on function public.save_warehouse(uuid,text,text[],uuid[],jsonb),
  public.set_shipment_status_checked(uuid,text,text,boolean,text,boolean), public.order_history(uuid),
  public.captain_statement(uuid) from public,anon;
grant execute on function public.save_warehouse(uuid,text,text[],uuid[],jsonb),
  public.set_shipment_status_checked(uuid,text,text,boolean,text,boolean), public.order_history(uuid),
  public.captain_statement(uuid) to authenticated;

-- A form submission UUID survives lost responses. Distinct requests may have
-- identical contact information, and repeated UUIDs return the original order.
create table public.order_submissions (
  actor_id uuid not null,
  request_id uuid not null,
  fingerprint bytea not null,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key(actor_id,request_id)
);
alter table public.order_submissions enable row level security;
create policy subscription_required on public.order_submissions as restrictive for all to authenticated
  using ((select public.subscription_is_current())) with check ((select public.subscription_is_current()));
create policy owner_runtime_required on public.order_submissions as restrictive for all to authenticated
  using ((select public.owner_runtime_available())) with check ((select public.owner_runtime_available()));
revoke all on public.order_submissions from public,anon,authenticated;
create index order_submissions_order_idx on public.order_submissions(order_id);

create or replace function public.trg_dup_guard()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_table_name = 'captain_payments' then
    perform guard_once('cp|'||new.captain_id||'|'||new.amount||'|'||coalesce(new.note,''),15);
  elsif tg_table_name = 'marketer_payments' then
    perform guard_once('mp|'||new.marketer_id||'|'||new.amount||'|'||coalesce(new.note,''),15);
  elsif tg_table_name = 'orders' and not exists (
    select 1 from order_submissions where actor_id=auth.uid()
      and request_id::text=current_setting('app.order_submission',true) and order_id is null
  ) then
    perform guard_once('o|'||coalesce(auth.uid()::text,'')||'|'||new.customer_name||'|'||coalesce(new.customer_phone,'')
      ||'|'||coalesce(new.captain_id::text,'')||'|'||coalesce(new.note,''),15);
  end if;
  return new;
end $$;

create function public.submit_order(p_request_id uuid,p_kind text,p_details jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  actor uuid := auth.uid();
  submitted order_submissions;
  request_hash bytea;
  details record;
  created uuid;
begin
  if p_kind is null or p_kind not in ('delivery','shipping') or p_request_id is null
      or jsonb_typeof(p_details) is distinct from 'object' then
    raise exception 'بيانات إرسال الطلب غير صالحة';
  end if;
  if actor is null or not has_perm('create_orders') or (p_kind='shipping' and not is_admin()) then
    raise exception 'غير مسموح';
  end if;
  request_hash := sha256(convert_to(p_kind || ':' || p_details::text,'UTF8'));
  insert into order_submissions(actor_id,request_id,fingerprint) values (actor,p_request_id,request_hash)
  on conflict (actor_id,request_id) do nothing returning * into submitted;
  if not found then
    select * into submitted from order_submissions where actor_id=actor and request_id=p_request_id;
    if not found then raise exception 'تعذّر تأكيد الطلب. أعد المحاولة'; end if;
    if submitted.fingerprint is distinct from request_hash then
      raise exception 'تغيّرت بيانات عملية إرسال سابقة. ابدأ طلبًا جديدًا';
    end if;
    if submitted.order_id is null then raise exception 'لم يعد الطلب السابق متاحًا'; end if;
    return submitted.order_id;
  end if;

  select * into details from jsonb_to_record(p_details) as d(
    p_name text,p_phone text,p_note text,p_captain uuid,p_items jsonb,p_address text,p_map text,
    p_marketer uuid,p_governorate text,p_carrier uuid,p_waybill text,p_cost numeric,p_fee numeric,p_wh uuid);
  if coalesce(btrim(details.p_name),'')='' or coalesce(btrim(details.p_phone),'')='' then
    raise exception 'اسم الزبون ورقمه مطلوبان';
  end if;
  perform set_config('app.order_submission',p_request_id::text,true);
  if p_kind='shipping' then
    if coalesce(btrim(details.p_governorate),'')='' then raise exception 'المحافظة مطلوبة للشحن'; end if;
    created := create_shipment(details.p_name,details.p_phone,details.p_note,details.p_items,
      details.p_address,details.p_map,details.p_marketer,details.p_governorate,
      details.p_carrier,details.p_waybill,details.p_cost,details.p_fee,details.p_wh);
  else
    created := create_order(details.p_name,details.p_phone,details.p_note,details.p_captain,details.p_items,
      details.p_address,details.p_map,details.p_marketer,details.p_governorate);
  end if;
  perform set_config('app.order_submission','',true);
  update order_submissions set order_id=created where actor_id=actor and request_id=p_request_id;
  return created;
end $$;

revoke all on function public.submit_order(uuid,text,jsonb) from public,anon;
grant execute on function public.submit_order(uuid,text,jsonb) to authenticated;

create function public.guard_shipment_snapshot()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.fulfillment='shipping' then
    if new.fulfillment is distinct from old.fulfillment then
      raise exception 'لا يمكن تغيير طريقة تنفيذ الشحنة';
    end if;
    if (old.stock_out or old.status in ('delivered','returned','cancelled'))
       and row(new.carrier_id,new.ship_warehouse) is distinct from row(old.carrier_id,old.ship_warehouse) then
      raise exception 'لا يمكن تغيير الشركة أو المستودع بعد خروج الشحنة أو إغلاقها';
    end if;
    if old.status in ('delivered','returned','cancelled') and
       row(new.shipping_cost,new.delivery_fee,new.items_total,new.total,new.owed_amount)
         is distinct from row(old.shipping_cost,old.delivery_fee,old.items_total,old.total,old.owed_amount) then
      raise exception 'لا يمكن تعديل مبالغ شحنة مغلقة';
    end if;
  end if;
  if new.fulfillment='shipping' and
     row(new.fulfillment,new.ship_status,new.status,new.captain_id)
       is distinct from row(old.fulfillment,old.ship_status,old.status,old.captain_id) and
     (new.captain_id is not null or not coalesce(case new.ship_status
       when 'preparing' then new.status='new'
       when 'handed' then new.status='in_delivery'
       when 'in_transit' then new.status='in_delivery'
       when 'at_branch' then new.status='in_delivery'
       when 'delivered' then new.status='delivered'
       when 'returned' then new.status='returned'
       when 'cancelled' then new.status='cancelled'
     end,false)) then
    raise exception 'استخدم مسار حالات الشحن لتغيير حالة الشحنة';
  end if;
  return new;
end $$;
create trigger guard_shipment_snapshot
before update on public.orders for each row execute function public.guard_shipment_snapshot();
revoke all on function public.guard_shipment_snapshot() from public,anon,authenticated;
