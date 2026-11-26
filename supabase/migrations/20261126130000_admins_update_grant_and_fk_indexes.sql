-- 1) شاشة "صلاحيات الموظف" في لوحة الإدارة تحدّث admins.perms مباشرة عبر PostgREST،
--    لكن المخطط كان يمنح authenticated صلاحية insert/delete فقط على admins، فكان الحفظ يفشل
--    بـ permission denied. الصلاحية هنا لا تفتح شيئًا لغير الإداري الكامل: السياسة
--    admins_admin_all (for all to authenticated using/with check is_admin()) هي التي تحكم الصفوف.
grant update on public.admins to authenticated;

-- 2) مفاتيح أجنبية بلا فهرس بادئ: كل حذف/تعديل على الأب وكل استعلام RLS فرعي يمرّ بمسح كامل.
create index if not exists idx_orders_captain_id on public.orders (captain_id);
create index if not exists idx_orders_marketer_id on public.orders (marketer_id);
create index if not exists idx_orders_carrier_id on public.orders (carrier_id);
create index if not exists idx_orders_ship_warehouse on public.orders (ship_warehouse);
create index if not exists idx_order_items_order_id on public.order_items (order_id);
create index if not exists idx_order_items_product_id on public.order_items (product_id);
create index if not exists idx_notifications_captain_id on public.notifications (captain_id);
create index if not exists idx_notifications_order_id on public.notifications (order_id);
create index if not exists idx_shipment_events_order_id on public.shipment_events (order_id);
create index if not exists idx_price_requests_captain_id on public.price_requests (captain_id);
create index if not exists idx_captain_payments_captain_id on public.captain_payments (captain_id);
create index if not exists idx_marketer_payments_marketer_id on public.marketer_payments (marketer_id);
create index if not exists idx_carrier_payments_carrier_id on public.carrier_payments (carrier_id);
create index if not exists idx_captains_warehouse_id on public.captains (warehouse_id);
create index if not exists idx_stock_product_id on public.stock (product_id);
create index if not exists idx_stock_movements_warehouse_id on public.stock_movements (warehouse_id);
create index if not exists idx_stock_movements_product_id on public.stock_movements (product_id);
create index if not exists idx_stock_movements_order_id on public.stock_movements (order_id);
create index if not exists idx_stock_invoices_warehouse_id on public.stock_invoices (warehouse_id);
create index if not exists idx_stock_invoice_items_invoice_id on public.stock_invoice_items (invoice_id);
create index if not exists idx_stock_invoice_items_product_id on public.stock_invoice_items (product_id);
create index if not exists idx_push_subscriptions_captain_id on public.push_subscriptions (captain_id);
create index if not exists idx_native_push_devices_user_id on public.native_push_devices (user_id);
