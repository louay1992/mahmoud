alter table push_subscriptions alter column captain_id drop not null;
alter table push_subscriptions add column if not exists admin_email text;
alter table push_subscriptions drop constraint if exists push_sub_owner;
alter table push_subscriptions add constraint push_sub_owner check ((captain_id is not null) <> (admin_email is not null));

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare cid uuid := my_captain_id();
begin
  if cid is null then raise exception 'غير مسموح'; end if;
  insert into push_subscriptions(captain_id, admin_email, endpoint, p256dh, auth) values (cid, null, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set captain_id = excluded.captain_id, admin_email = null, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function save_admin_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare em text := lower(auth.jwt() ->> 'email');
begin
  if not is_admin() or em is null then raise exception 'غير مسموح'; end if;
  insert into push_subscriptions(captain_id, admin_email, endpoint, p256dh, auth) values (null, em, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set captain_id = null, admin_email = excluded.admin_email, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function remove_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint
    and (captain_id = my_captain_id() or admin_email = lower(auth.jwt() ->> 'email'));
end $$;

create or replace function push_to_admins(p_title text, p_body text, p_tag text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare u text; sec text;
begin
  select value into u from push_config where key = 'fn_url';
  select value into sec from push_config where key = 'push_secret';
  if u is null or sec is null then return; end if;
  if not exists (select 1 from push_subscriptions where admin_email is not null) then return; end if;
  perform net.http_post(url := u,
    body := jsonb_build_object('admins', true, 'title', p_title, 'body', p_body, 'tag', p_tag, 'url', '/admin.html', 'icon', '/icons/admin-192.png'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', sec));
exception when others then null;
end $$;

create or replace function status_ar(s text) returns text language sql immutable as $$
  select case s when 'new' then 'جديد' when 'assigned' then 'مُسند' when 'in_delivery' then 'قيد التوصيل' when 'no_answer' then 'لم يتم الرد'
    when 'closed' then 'مغلق' when 'other' then 'ملاحظة أخرى' when 'delivered' then 'مُسلَّم' when 'cancelled' then 'ملغي' when 'returned' then 'مُرجَع' else s end $$;

-- تصرّفات الكابتن تُنبّه الإداريين
create or replace function trg_orders_push_admin() returns trigger language plpgsql security definer set search_path = public as $$
declare cn text;
begin
  if is_admin() or old.captain_id is null then return new; end if;   -- هذا المشغّل لتصرّفات الكابتن فقط
  select name into cn from captains where id = new.captain_id;
  if new.status is distinct from old.status then
    perform push_to_admins(case new.status when 'delivered' then '✅ تم تسليم طلب' else 'تحديث حالة طلب' end,
      'طلب #' || new.order_no || ' — ' || coalesce(cn,'') || ': ' || status_ar(new.status) || ' (' || new.customer_name || ')', 'a' || new.id);
  elsif new.captain_note is distinct from old.captain_note and new.captain_note is not null then
    perform push_to_admins('ملاحظة من الكابتن — طلب #' || new.order_no, coalesce(cn,'') || ': ' || new.captain_note, 'c' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists orders_push_admin on orders;
create trigger orders_push_admin after update on orders for each row execute function trg_orders_push_admin();

create or replace function trg_pr_push_admin() returns trigger language plpgsql security definer set search_path = public as $$
declare cn text; no int;
begin
  select name into cn from captains where id = new.captain_id;
  select order_no into no from orders where id = new.order_id;
  perform push_to_admins('طلب تعديل سعر', coalesce(cn,'') || ' — طلب #' || no || ': ' || new.old_total || ' ← ' || new.new_total, 'q' || new.id);
  return new;
end $$;
drop trigger if exists pr_push_admin on price_requests;
create trigger pr_push_admin after insert on price_requests for each row execute function trg_pr_push_admin();

revoke execute on function push_to_admins, status_ar, trg_orders_push_admin, trg_pr_push_admin from public, anon, authenticated;
revoke execute on function save_admin_push_subscription from public, anon;
grant execute on function save_admin_push_subscription to authenticated;
revoke execute on function save_push_subscription, remove_push_subscription from public, anon;
grant execute on function save_push_subscription, remove_push_subscription to authenticated;