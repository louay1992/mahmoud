-- إشعارات الحسابات التي تملك APK فقط: كان push_to_captain وpush_to_admins
-- يتوقفان قبل نداء send-push إذا لم يوجد اشتراك Web للمستلم، فلا يصل FCM أبدًا
-- إلى من ربط جهازه في التطبيق بلا اشتراك متصفح. الشرط الجديد يكتفي بوجود هدف
-- واحد: اشتراك Web أو جهاز أصلي مفعّل. الترشيح النهائي يبقى في send-push عبر
-- web_push_targets وnative_push_targets (صلاحيات الإداري وصلاحية الكابتن).

create or replace function public.push_to_captain(p_captain uuid, p_title text, p_body text, p_tag text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare u text; sec text;
begin
  select value into u from push_config where key = 'fn_url';
  select value into sec from push_config where key = 'push_secret';
  if u is null or sec is null or p_captain is null then return; end if;
  if not exists (select 1 from push_subscriptions where captain_id = p_captain)
    and not exists (select 1 from native_push_devices
      where enabled and app_scope = 'captain' and captain_id = p_captain) then return; end if;
  perform net.http_post(url := u,
    body := jsonb_build_object('captain_id', p_captain, 'title', p_title, 'body', p_body, 'tag', p_tag),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', sec));
exception when others then null;  -- الإشعار لا يجوز أن يُفشل العملية الأصلية
end $$;

create or replace function public.push_to_admins(p_title text, p_body text, p_tag text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare u text; sec text;
begin
  select value into u from push_config where key = 'fn_url';
  select value into sec from push_config where key = 'push_secret';
  if u is null or sec is null then return; end if;
  if not exists (select 1 from push_subscriptions where admin_email is not null)
    and not exists (select 1 from native_push_devices
      where enabled and app_scope = 'admin' and admin_email is not null) then return; end if;
  perform net.http_post(url := u,
    body := jsonb_build_object('admins', true, 'title', p_title, 'body', p_body, 'tag', p_tag, 'url', '/admin.html', 'icon', '/icons/admin-192.png'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', sec));
exception when others then null;
end $$;
