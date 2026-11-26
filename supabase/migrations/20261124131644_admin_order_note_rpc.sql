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