-- =====================================================================
-- تكافؤ الإنتاج المتبقي: سياسات الموظفين + قيد المستودع الرئيسي الملغى
--
-- المصدر: cmp مع pg_catalog في مشروع jabapvnmfdflysxfxwwf بتاريخ 2026-11-25.
-- الفهارس (39) والمشغّلات (14) والـViews الثلاثة متطابقة أصلًا؛ هذا الملف
-- يغلق آخر فرقين حقيقيين:
--   1) سياستا القراءة للموظف المحدود الصلاحية (v17) لم تكونا محفوظتين.
--   2) قيد main_no_captain أُلغي في v19 لكنه ما زال يُنشأ في schema.sql،
--      وكان سيمنع ربط كابتن بالمستودع الرئيسي في أي تركيب جديد.
-- =====================================================================

begin;

-- v17: الموظف يرى طلباته هو فقط (طلب أنشأه)، لا كل الطلبات.
drop policy if exists staff_orders on public.orders;
create policy staff_orders on public.orders for select to public
  using (has_perm('view_orders') and created_by = lower(auth.jwt() ->> 'email'));

drop policy if exists staff_order_items on public.order_items;
create policy staff_order_items on public.order_items for select to public
  using (order_id in (
    select orders.id from orders
    where has_perm('view_orders') and orders.created_by = lower(auth.jwt() ->> 'email')
  ));

-- v19: يمكن ربط كابتن بالمستودع الرئيسي فتُخصم مبيعاته منه.
alter table public.warehouses drop constraint if exists main_no_captain;

commit;
