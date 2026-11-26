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