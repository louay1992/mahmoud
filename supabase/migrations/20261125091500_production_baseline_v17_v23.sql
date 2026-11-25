-- =====================================================================
-- أساس الإنتاج للهجرات v17–v23 (مستخرج من مشروع jabapvnmfdflysxfxwwf)
--
-- المصدر: قراءة فقط من pg_catalog عبر: أعمدة، قيود، فهارس، سياسات،
-- مشغّلات، mysqli pg_get_functiondef. تاريخ السحب: 2026-11-25.
--
-- لماذا هذا الملف: schema.sql يوثّق حتى v15 نصًّا، ثم يكتفي من v16 إلى v23
-- بتعليقات. لذلك كانت إعادة تركيب قاعدة من الصفر تفقد: صلاحيات الموظفين،
-- المستودعات والمحافظات، تدقيق العملاء، مركز الإشعارات، الشحن عبر الشركات،
-- ودوالها. هذا الترحيل يجعل التركيب الجديد يطابق الإنتاج في هذه الكائنات.
--
-- يُطبَّق بعد schema.sql وبعد بقية ملفات supabase/migrations.
-- كل العبارات idempotent (if not exists / drop ... if exists).
-- لا تعدّل نص أي دالة يدويًا؛ صحّحها في ترحيل جديد.
-- =====================================================================

begin;

-- ---------- 1) جداول v18–v23 الغائبة عن schema.sql ----------
create table if not exists public.customers (
  phone text primary key,
  name text,
  first_order_at timestamptz default now(),
  last_order_at timestamptz default now()
);

create table if not exists public.op_guard (
  k text primary key,
  at timestamptz not null default now()
);

create table if not exists public.carriers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tracking_url text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.carrier_payments (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references public.carriers(id) on delete cascade,
  amount numeric not null check (amount > 0),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.shipment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  ship_status text not null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  audience text not null check (audience in ('admin', 'captain')),
  captain_id uuid references public.captains(id) on delete cascade,
  kind text not null,
  level text not null default 'info',
  title text not null,
  body text not null default '',
  order_id uuid references public.orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_by text[] not null default '{}'
);

create index if not exists notifications_aud_idx
  on public.notifications (audience, captain_id, created_at desc);

-- ---------- 2) أعمدة v17–v23 الغائبة عن الجداول القائمة ----------
alter table public.admins add column if not exists perms text[];
alter table public.admins add column if not exists name text;

alter table public.captains add column if not exists warehouse_id uuid
  references public.warehouses(id) on delete set null;

alter table public.products add column if not exists cost numeric not null default 0;
alter table public.products drop constraint if exists products_cost_check;
alter table public.products add constraint products_cost_check check (cost >= 0);

alter table public.order_item_capital add column if not exists cost numeric not null default 0;

alter table public.warehouses add column if not exists governorate text;
alter table public.warehouses add column if not exists governorates text[] not null default '{}';

alter table public.orders add column if not exists created_by text
  default lower(auth.jwt() ->> 'email');
alter table public.orders add column if not exists governorate text;
alter table public.orders add column if not exists fulfillment text not null default 'delivery';
alter table public.orders add column if not exists carrier_id uuid
  references public.carriers(id) on delete set null;
alter table public.orders add column if not exists waybill text;
alter table public.orders add column if not exists shipping_cost numeric not null default 0;
alter table public.orders add column if not exists ship_status text;
alter table public.orders add column if not exists ship_warehouse uuid
  references public.warehouses(id) on delete set null;
alter table public.orders add column if not exists stock_out boolean not null default false;

alter table public.orders drop constraint if exists orders_shipping_cost_check;
alter table public.orders add constraint orders_shipping_cost_check check (shipping_cost >= 0);
alter table public.orders drop constraint if exists orders_fulfillment_check;
alter table public.orders add constraint orders_fulfillment_check
  check (fulfillment in ('delivery', 'shipping'));

-- ---------- 3) RLS وسياسات الجداول الجديدة (كما في الإنتاج) ----------
alter table public.customers enable row level security;
alter table public.op_guard enable row level security;
alter table public.carriers enable row level security;
alter table public.carrier_payments enable row level security;
alter table public.shipment_events enable row level security;
alter table public.notifications enable row level security;

drop policy if exists cust_admin on public.customers;
create policy cust_admin on public.customers for select to authenticated using (is_admin());

drop policy if exists carriers_admin on public.carriers;
create policy carriers_admin on public.carriers for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists cpay_admin on public.carrier_payments;
create policy cpay_admin on public.carrier_payments for select to authenticated using (is_admin());
drop policy if exists cpay_admin_del on public.carrier_payments;
create policy cpay_admin_del on public.carrier_payments for delete to authenticated using (is_admin());

drop policy if exists sev_admin on public.shipment_events;
create policy sev_admin on public.shipment_events for select to authenticated using (is_admin());

drop policy if exists n_admin on public.notifications;
create policy n_admin on public.notifications for select to public
  using (audience = 'admin' and is_admin());
drop policy if exists n_captain on public.notifications;
create policy n_captain on public.notifications for select to public
  using (audience = 'captain' and captain_id = my_captain_id());

-- الصلاحيات: الإنتاج يمنح anon أيضًا TRUNCATE على جداول الشحن، وTRUNCATE يتجاوز RLS.
-- نمنح authenticated فقط (كل قراءات التطبيق بعد تسجيل الدخول) ونمنع anon.
grant select, insert, update, delete on public.carriers to authenticated;
grant select, insert, update, delete on public.carrier_payments to authenticated;
grant select on public.shipment_events to authenticated;
grant select on public.customers to authenticated;
grant select on public.notifications to authenticated;
revoke all on public.carriers, public.carrier_payments, public.shipment_events,
  public.customers, public.notifications, public.op_guard from anon;
revoke all on public.op_guard from authenticated;

-- ---------- 4) دوال v17–v23 (نصّها من pg_get_functiondef كما هو) ----------
create or replace function public.my_access()
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce((select case when perms is null then jsonb_build_object('role','full','perms','[]'::jsonb) else jsonb_build_object('role','staff','perms',to_jsonb(perms)) end from admins where lower(email) = lower(auth.jwt() ->> 'email') limit 1), jsonb_build_object('role','none','perms','[]'::jsonb));
$function$;

create or replace function public.has_perm(p text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (select 1 from admins where lower(email) = lower(auth.jwt() ->> 'email') and (perms is null or p = any(perms)));
$function$;

create or replace function public.my_warehouse_id()
returns uuid
language sql
stable security definer
set search_path to 'public'
as $function$
  select warehouse_id from captains where lower(email) = lower(auth.jwt() ->> 'email') limit 1
$function$;

create or replace function public.norm_phone(p text)
returns text
language sql
immutable
as $function$
  select case when d='' then '' when d like '00963%' then '0'||substr(d,6) when d like '963%' then '0'||substr(d,4)
    when length(d)=9 and d like '9%' then '0'||d else d end
  from (select regexp_replace(translate(coalesce(p,''),'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'\D','','g') d) x $function$;

create or replace function public.fmt_money(n numeric)
returns text
language sql
stable security definer
set search_path to 'public'
as $function$
  select regexp_replace(to_char(coalesce(n,0),'FM999,999,999,990.00'),'\.00$','') || coalesce(' '||(select value from settings where key='currency'),'')
$function$;

create or replace function public.order_lines(oid uuid)
returns text
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(string_agg(p.name||' ×'||i.qty, '، ' order by p.name),'—') from order_items i join products p on p.id=i.product_id where i.order_id=oid
$function$;

create or replace function public.guard_once(p_key text, p_secs integer default 15)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r text;
begin
  delete from op_guard where at < now() - interval '1 hour';
  insert into op_guard(k, at) values (md5(p_key), now())
  on conflict (k) do update set at = now() where op_guard.at < now() - (p_secs || ' seconds')::interval
  returning k into r;
  if r is null then raise exception 'تم تنفيذ نفس العملية قبل لحظات، تم تجاهل التكرار'; end if;
end $function$;

create or replace function public.notify(p_aud text, p_cap uuid, p_kind text, p_level text, p_title text, p_body text, p_order uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare nid uuid;
begin
  if p_aud='captain' and p_cap is null then return; end if;
  insert into notifications(audience,captain_id,kind,level,title,body,order_id) values (p_aud,p_cap,p_kind,p_level,p_title,p_body,p_order) returning id into nid;
  if random() < 0.02 then delete from notifications where created_at < now() - interval '90 days'; end if;
  if p_aud='admin' then perform push_to_admins(p_title,p_body,'n'||nid); else perform push_to_captain(p_cap,p_title,p_body,'n'||nid); end if;
end $function$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare em text := lower(auth.jwt() ->> 'email');
begin
  if em is null then return; end if;
  update notifications set read_by = array_append(read_by, em)
   where not (em = any(read_by)) and (p_ids is null or id = any(p_ids))
     and ((audience='admin' and is_admin()) or (audience='captain' and captain_id = my_captain_id()));
end $function$;

create or replace function public.staff_lookups()
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if not has_perm('create_orders') then raise exception 'غير مسموح'; end if;
  return jsonb_build_object(
    'products', coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by name) from products),'[]'::jsonb),
    'captains', case when has_perm('pick_captain') then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active,'delivery_fee',delivery_fee,'warehouse_id',warehouse_id) order by name) from captains),'[]'::jsonb) else '[]'::jsonb end,
    'warehouses', case when has_perm('pick_captain') then coalesce((select jsonb_agg(jsonb_build_object('id',id,'governorates',governorates)) from warehouses),'[]'::jsonb) else '[]'::jsonb end,
    'marketers', case when has_perm('pick_marketer') then coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active,'governorate',governorate) order by name) from marketers),'[]'::jsonb) else '[]'::jsonb end);
end $function$;

create or replace function public.create_order(p_name text, p_phone text, p_note text, p_captain uuid, p_items jsonb, p_address text default null, p_map text default null, p_marketer uuid default null, p_governorate text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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

create or replace function public.admin_profit_items()
returns table(item_id uuid, order_id uuid, order_no bigint, product_id uuid, product_name text, marketer_id uuid, captain_id uuid, status text, created_at timestamptz, delivered_at timestamptz, governorate text, delivery_fee numeric, first_item boolean, qty integer, unit_price numeric, capital numeric, cost numeric, fulfillment text, shipping_cost numeric, carrier_id uuid)
language sql
stable security definer
set search_path to 'public'
as $function$
  select i.id, o.id, o.order_no::bigint, i.product_id, p.name, o.marketer_id, o.captain_id, o.status::text, o.created_at, o.delivered_at, o.governorate, o.delivery_fee,
    (row_number() over (partition by o.id order by i.id)=1), i.qty, i.unit_price, coalesce(c.capital,p.price), coalesce(c.cost,0), o.fulfillment, o.shipping_cost, o.carrier_id
  from orders o join order_items i on i.order_id=o.id join products p on p.id=i.product_id left join order_item_capital c on c.item_id=i.id
  where is_admin() order by o.created_at desc limit 30000 $function$;

create or replace function public.create_shipment(p_name text, p_phone text, p_note text, p_items jsonb, p_address text, p_map text, p_marketer uuid, p_governorate text, p_carrier uuid, p_waybill text, p_cost numeric, p_fee numeric, p_wh uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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

create or replace function public.update_shipment(p_order uuid, p_carrier uuid, p_waybill text, p_cost numeric, p_fee numeric, p_wh uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

create or replace function public.add_carrier_payment(p_carrier uuid, p_amount numeric, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'مبلغ غير صالح'; end if;
  perform guard_once('cpay:'||p_carrier||':'||p_amount, 15);
  insert into carrier_payments(carrier_id,amount,note) values (p_carrier,p_amount,nullif(trim(coalesce(p_note,'')),''));
end $function$;

create or replace function public.set_shipment_status(p_order uuid, p_status text, p_note text default null, p_restock boolean default true)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

create or replace function public.trg_customer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare ph text := norm_phone(new.customer_phone);
begin
  if ph<>'' then
    insert into customers(phone,name,first_order_at,last_order_at) values(ph,new.customer_name,new.created_at,new.created_at)
    on conflict(phone) do update set name=excluded.name,
      first_order_at=least(customers.first_order_at,excluded.first_order_at), last_order_at=greatest(customers.last_order_at,excluded.last_order_at);
  end if; return new; end $function$;

create or replace function public.trg_dup_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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

-- ---------- 5) المشغّلات الغائبة ----------
drop trigger if exists trg_customer on public.orders;
create trigger trg_customer after insert on public.orders
  for each row execute function public.trg_customer();

drop trigger if exists trg_dup_guard on public.orders;
create trigger trg_dup_guard before insert on public.orders
  for each row execute function public.trg_dup_guard();
drop trigger if exists trg_dup_guard on public.captain_payments;
create trigger trg_dup_guard before insert on public.captain_payments
  for each row execute function public.trg_dup_guard();
drop trigger if exists trg_dup_guard on public.marketer_payments;
create trigger trg_dup_guard before insert on public.marketer_payments
  for each row execute function public.trg_dup_guard();

-- ---------- 6) صلاحيات الدوال كما في الإنتاج ----------
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;
revoke all on function public.has_perm(text) from public, anon;
grant execute on function public.has_perm(text) to authenticated;
revoke all on function public.my_warehouse_id() from public, anon;
grant execute on function public.my_warehouse_id() to authenticated;
revoke all on function public.create_order(text, text, text, uuid, jsonb, text, text, uuid, text) from public, anon;
grant execute on function public.create_order(text, text, text, uuid, jsonb, text, text, uuid, text) to authenticated;
revoke all on function public.admin_profit_items() from public, anon;
grant execute on function public.admin_profit_items() to authenticated;
revoke all on function public.create_shipment(text, text, text, jsonb, text, text, uuid, text, uuid, text, numeric, numeric, uuid) from public, anon;
grant execute on function public.create_shipment(text, text, text, jsonb, text, text, uuid, text, uuid, text, numeric, numeric, uuid) to authenticated;
revoke all on function public.update_shipment(uuid, uuid, text, numeric, numeric, uuid) from public, anon;
grant execute on function public.update_shipment(uuid, uuid, text, numeric, numeric, uuid) to authenticated;
revoke all on function public.set_shipment_status(uuid, text, text, boolean) from public, anon;
grant execute on function public.set_shipment_status(uuid, text, text, boolean) to authenticated;
revoke all on function public.add_carrier_payment(uuid, numeric, text) from public, anon;
grant execute on function public.add_carrier_payment(uuid, numeric, text) to authenticated;
revoke all on function public.staff_lookups() from public, anon;
grant execute on function public.staff_lookups() to authenticated;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- دوال داخلية تُستدعى من دوال security definer فقط.
revoke all on function public.fmt_money(numeric) from public, anon, authenticated;
revoke all on function public.order_lines(uuid) from public, anon, authenticated;
revoke all on function public.guard_once(text, integer) from public, anon, authenticated;
revoke all on function public.notify(text, uuid, text, text, text, text, uuid) from public, anon, authenticated;

commit;
