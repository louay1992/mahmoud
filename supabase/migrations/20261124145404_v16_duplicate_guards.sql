create table if not exists public.op_guard(k text primary key, at timestamptz not null default now());
alter table public.op_guard enable row level security;
revoke all on public.op_guard from anon, authenticated;

create or replace function public.guard_once(p_key text, p_secs int default 15) returns void
language plpgsql security definer set search_path to 'public' as $$
declare r text;
begin
  delete from op_guard where at < now() - interval '1 hour';
  insert into op_guard(k, at) values (md5(p_key), now())
  on conflict (k) do update set at = now() where op_guard.at < now() - (p_secs || ' seconds')::interval
  returning k into r;
  if r is null then raise exception 'تم تنفيذ نفس العملية قبل لحظات، تم تجاهل التكرار'; end if;
end $$;
revoke all on function public.guard_once(text,int) from public, anon, authenticated;

create or replace function public.trg_dup_guard() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_table_name = 'captain_payments' then
    perform guard_once('cp|'||new.captain_id||'|'||new.amount||'|'||coalesce(new.note,''), 15);
  elsif tg_table_name = 'marketer_payments' then
    perform guard_once('mp|'||new.marketer_id||'|'||new.amount||'|'||coalesce(new.note,''), 15);
  elsif tg_table_name = 'orders' then
    perform guard_once('o|'||coalesce(auth.uid()::text,'')||'|'||new.customer_name||'|'||coalesce(new.customer_phone,'')||'|'||coalesce(new.captain_id::text,'')||'|'||coalesce(new.note,''), 15);
  end if;
  return new;
end $$;
revoke all on function public.trg_dup_guard() from public, anon, authenticated;

drop trigger if exists trg_dup_guard on public.captain_payments;
create trigger trg_dup_guard before insert on public.captain_payments for each row execute function public.trg_dup_guard();
drop trigger if exists trg_dup_guard on public.marketer_payments;
create trigger trg_dup_guard before insert on public.marketer_payments for each row execute function public.trg_dup_guard();
drop trigger if exists trg_dup_guard on public.orders;
create trigger trg_dup_guard before insert on public.orders for each row execute function public.trg_dup_guard();

create or replace function public.transfer_stock(p_from uuid, p_to uuid, p_product uuid, p_qty integer, p_note text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare cur integer;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if p_from = p_to then raise exception 'اختر مستودعين مختلفين'; end if;
  if p_qty <= 0 then raise exception 'الكمية يجب أن تكون أكبر من صفر'; end if;
  perform guard_once('tr|'||auth.uid()||'|'||p_from||'|'||p_to||'|'||p_product||'|'||p_qty||'|'||coalesce(p_note,''), 10);
  select qty into cur from stock where warehouse_id = p_from and product_id = p_product for update;
  if coalesce(cur, 0) < p_qty then raise exception 'الكمية غير متوفرة في المستودع المصدر (المتوفر %)', coalesce(cur, 0); end if;
  update stock set qty = qty - p_qty where warehouse_id = p_from and product_id = p_product;
  insert into stock(warehouse_id, product_id, qty) values (p_to, p_product, p_qty)
  on conflict (warehouse_id, product_id) do update set qty = stock.qty + excluded.qty;
  insert into stock_movements(warehouse_id, product_id, qty, kind, note) values
    (p_from, p_product, -p_qty, 'transfer_out', p_note),
    (p_to, p_product, p_qty, 'transfer_in', p_note);
end $$;

create or replace function public.create_stock_invoice(p_warehouse uuid, p_note text, p_items jsonb, p_deduct_main boolean default false)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare inv uuid; it jsonb; mw uuid; wn text; pid uuid; q int; cur int; pn text; ded boolean;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  perform guard_once('inv|'||auth.uid()||'|'||p_warehouse||'|'||p_items::text||'|'||coalesce(p_note,'')||'|'||coalesce(p_deduct_main,false), 15);
  select name into wn from warehouses where id = p_warehouse;
  if not found then raise exception 'المستودع غير موجود'; end if;
  select id into mw from warehouses where is_main;
  ded := coalesce(p_deduct_main,false) and mw is not null and mw <> p_warehouse;
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
end $$;