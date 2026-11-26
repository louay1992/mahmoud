create table if not exists price_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  captain_id uuid references captains(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  items jsonb not null,
  reason text not null,
  admin_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create unique index if not exists price_requests_one_pending on price_requests(order_id) where status = 'pending';
alter table price_requests enable row level security;
drop policy if exists pr_select on price_requests;
create policy pr_select on price_requests for select to authenticated
  using (is_admin() or captain_id = my_captain_id());
grant select on price_requests to authenticated;

create or replace function request_price_change(p_order uuid, p_prices jsonb, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare o orders; it jsonb; r record; arr jsonb := '[]'::jsonb; newp numeric; rid uuid; n text := nullif(trim(coalesce(p_reason,'')), '');
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if o.captain_id is distinct from my_captain_id() then raise exception 'غير مسموح'; end if;
  if o.status not in ('assigned','in_delivery','no_answer','closed','other') then raise exception 'لا يمكن طلب تعديل سعر هذا الطلب'; end if;
  if n is null then raise exception 'اكتب سبب طلب التعديل'; end if;
  if exists (select 1 from price_requests where order_id = p_order and status = 'pending') then
    raise exception 'يوجد طلب تعديل سعر معلّق لهذا الطلب، انتظر قرار الإداري'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_prices,'[]'::jsonb)) loop
    newp := (it->>'unit_price')::numeric;
    if newp is null or newp < 0 then raise exception 'سعر غير صالح'; end if;
    select oi.id, oi.qty, oi.unit_price, p.name into r from order_items oi join products p on p.id = oi.product_id
      where oi.id = (it->>'item_id')::uuid and oi.order_id = p_order;
    if not found then raise exception 'بند غير صالح'; end if;
    if r.unit_price <> newp then
      arr := arr || jsonb_build_array(jsonb_build_object('item_id', r.id, 'name', r.name, 'qty', r.qty, 'old', r.unit_price, 'new', newp));
    end if;
  end loop;
  if jsonb_array_length(arr) = 0 then raise exception 'لم تغيّر أي سعر'; end if;
  insert into price_requests(order_id, captain_id, items, reason) values (p_order, o.captain_id, arr, n) returning id into rid;
  insert into order_events(order_id, status, note) values (p_order, o.status, 'طلب الكابتن تعديل السعر — السبب: ' || n);
  return rid;
end $$;

create or replace function decide_price_request(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare pr price_requests; o orders; n text := nullif(trim(coalesce(p_note,'')), '');
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into pr from price_requests where id = p_id for update;
  if not found then raise exception 'الطلب غير موجود'; end if;
  if pr.status <> 'pending' then raise exception 'تم البتّ في هذا الطلب مسبقاً'; end if;
  select * into o from orders where id = pr.order_id for update;
  if p_approve then
    if o.status not in ('new','assigned','in_delivery','no_answer','closed','other') then
      raise exception 'حالة الطلب تغيّرت ولا يمكن تعديل سعره، ارفض الطلب'; end if;
    update order_items oi set unit_price = (x->>'new')::numeric
      from jsonb_array_elements(pr.items) x where oi.id = (x->>'item_id')::uuid and oi.order_id = pr.order_id;
    update orders set items_total = s.a, list_total = s.l, total = s.a + delivery_fee
      from (select sum(qty*unit_price) a, sum(qty*list_price) l from order_items where order_id = pr.order_id) s
      where orders.id = pr.order_id;
    insert into order_events(order_id, status, note) values (pr.order_id, o.status,
      'وافق الإداري على تعديل السعر: ' || (select string_agg((x->>'name') || ' ' || (x->>'old') || ' ← ' || (x->>'new'), '؛ ') from jsonb_array_elements(pr.items) x)
      || coalesce(' — ملاحظة: ' || n, ''));
  else
    insert into order_events(order_id, status, note) values (pr.order_id, o.status, 'رفض الإداري تعديل السعر' || coalesce(' — السبب: ' || n, ''));
  end if;
  update price_requests set status = case when p_approve then 'approved' else 'rejected' end, admin_note = n, decided_at = now() where id = p_id;
end $$;

revoke execute on function request_price_change, decide_price_request from public, anon;
grant execute on function request_price_change, decide_price_request to authenticated;