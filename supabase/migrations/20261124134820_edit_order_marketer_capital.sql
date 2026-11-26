
create or replace function edit_order(p_order uuid, p_info jsonb, p_items jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare o orders; it jsonb; pr numeric; up numeric; oc numeric; nid uuid; sub numeric := 0; summ text := '';
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
    if p_info ? 'marketer_id' then
      update orders set marketer_id = nullif(p_info->>'marketer_id','')::uuid where id = p_order;
    end if;
  end if;
  if p_items is not null then
    if jsonb_array_length(p_items) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
    create temp table _old_items on commit drop as
      select i.product_id, i.unit_price, c.capital from order_items i left join order_item_capital c on c.item_id = i.id where i.order_id = p_order;
    delete from order_items where order_id = p_order;
    for it in select * from jsonb_array_elements(p_items) loop
      pid := (it->>'product_id')::uuid; q := (it->>'qty')::int;
      if q is null or q <= 0 then raise exception 'الكمية غير صالحة'; end if;
      select price, name into pr, pn from products where id = pid;
      if not found then raise exception 'منتج غير موجود'; end if;
      select unit_price, capital into up, oc from _old_items where product_id = pid limit 1;
      up := coalesce(nullif(it->>'unit_price','')::numeric, up, pr);
      if up < 0 then raise exception 'السعر لا يكون سالباً'; end if;
      insert into order_items(order_id, product_id, qty, unit_price, list_price) values (p_order, pid, q, up, up) returning id into nid;
      if oc is not null then update order_item_capital set capital = oc where item_id = nid; end if;
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
end $$;
