
alter table warehouses add column if not exists is_main boolean not null default false;
create unique index if not exists one_main_warehouse on warehouses ((true)) where is_main;
alter table warehouses drop constraint if exists main_no_captain;
alter table warehouses add constraint main_no_captain check (not is_main or captain_id is null);
insert into warehouses(name, is_main) select 'المستودع الرئيسي', true where not exists (select 1 from warehouses where is_main);

alter table stock_invoices add column if not exists deducted_from_main boolean not null default false;

create or replace function create_stock_invoice(p_warehouse uuid, p_note text, p_items jsonb, p_deduct_main boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv uuid; it jsonb; mw uuid; wn text; pid uuid; q int; cur int; pn text; ded boolean;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  if jsonb_array_length(coalesce(p_items,'[]'::jsonb)) = 0 then raise exception 'أضف منتجاً واحداً على الأقل'; end if;
  select name into wn from warehouses where id = p_warehouse;
  if not found then raise exception 'المستودع غير موجود'; end if;
  select id into mw from warehouses where is_main;
  ded := coalesce(p_deduct_main,false) and mw is not null and mw <> p_warehouse;
  insert into stock_invoices(warehouse_id, note, deducted_from_main) values (p_warehouse, nullif(trim(coalesce(p_note,'')),''), ded) returning id into inv;
  if ded then
    for it in select * from jsonb_array_elements(p_items) loop
      pid := (it->>'product_id')::uuid; q := (it->>'qty')::int;
      if q is null or q <= 0 then raise exception 'الكمية غير صالحة'; end if;
      select coalesce(qty,0) into cur from stock where warehouse_id = mw and product_id = pid; cur := coalesce(cur,0);
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
revoke execute on function create_stock_invoice(uuid,text,jsonb,boolean) from public, anon;
grant execute on function create_stock_invoice(uuid,text,jsonb,boolean) to authenticated;
