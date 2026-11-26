create extension if not exists pg_net with schema extensions;

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  captain_id uuid not null references captains(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create table if not exists push_config (key text primary key, value text not null);
alter table push_subscriptions enable row level security;
alter table push_config enable row level security;
revoke all on push_subscriptions, push_config from anon, authenticated;
grant all on push_subscriptions, push_config to service_role;

insert into push_config(key, value) values
  ('push_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('fn_url', 'https://jabapvnmfdflysxfxwwf.supabase.co/functions/v1/send-push')
on conflict (key) do nothing;

create or replace function save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare cid uuid := my_captain_id();
begin
  if cid is null then raise exception 'غير مسموح'; end if;
  insert into push_subscriptions(captain_id, endpoint, p256dh, auth) values (cid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set captain_id = excluded.captain_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

create or replace function remove_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from push_subscriptions where endpoint = p_endpoint and captain_id = my_captain_id();
end $$;

create or replace function push_to_captain(p_captain uuid, p_title text, p_body text, p_tag text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare u text; sec text;
begin
  select value into u from push_config where key = 'fn_url';
  select value into sec from push_config where key = 'push_secret';
  if u is null or sec is null or p_captain is null then return; end if;
  if not exists (select 1 from push_subscriptions where captain_id = p_captain) then return; end if;
  perform net.http_post(url := u,
    body := jsonb_build_object('captain_id', p_captain, 'title', p_title, 'body', p_body, 'tag', p_tag),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', sec));
exception when others then null;  -- الإشعار لا يجوز أن يُفشل العملية الأصلية
end $$;

create or replace function trg_orders_push() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then return new; end if;   -- إشعار الكابتن فقط عند تصرّف الإداري
  if new.captain_id is null then return new; end if;
  if tg_op = 'INSERT' then
    perform push_to_captain(new.captain_id, 'طلب جديد #' || new.order_no, new.customer_name || ' — ' || new.total, 'o' || new.id);
  elsif new.captain_id is distinct from old.captain_id then
    perform push_to_captain(new.captain_id, 'طلب جديد #' || new.order_no, new.customer_name || ' — ' || new.total, 'o' || new.id);
  elsif new.note is distinct from old.note and new.note is not null then
    perform push_to_captain(new.captain_id, 'ملاحظة من الإداري — طلب #' || new.order_no, new.note, 'n' || new.id);
  elsif new.total is distinct from old.total or new.customer_address is distinct from old.customer_address or new.map_url is distinct from old.map_url then
    perform push_to_captain(new.captain_id, 'تم تعديل الطلب #' || new.order_no, 'الإجمالي الآن ' || new.total, 'e' || new.id);
  elsif new.status is distinct from old.status then
    perform push_to_captain(new.captain_id, 'تغيّرت حالة الطلب #' || new.order_no, 'أصبحت: ' || new.status, 's' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists orders_push on orders;
create trigger orders_push after insert or update on orders for each row execute function trg_orders_push();

create or replace function trg_pr_push() returns trigger language plpgsql security definer set search_path = public as $$
declare no int;
begin
  if old.status = 'pending' and new.status <> 'pending' and is_admin() then
    select order_no into no from orders where id = new.order_id;
    perform push_to_captain(new.captain_id,
      case when new.status = 'approved' then 'تمت الموافقة على تعديل السعر' else 'تم رفض تعديل السعر' end,
      'طلب #' || no || coalesce(' — ' || new.admin_note, ''), 'r' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists pr_push on price_requests;
create trigger pr_push after update on price_requests for each row execute function trg_pr_push();

create or replace function trg_pay_push() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform push_to_captain(new.captain_id, 'تم تسجيل دفعة', new.amount || coalesce(' — ' || new.note, ''), 'p' || new.id);
  return new;
end $$;
drop trigger if exists pay_push on captain_payments;
create trigger pay_push after insert on captain_payments for each row execute function trg_pay_push();

revoke execute on function push_to_captain, trg_orders_push, trg_pr_push, trg_pay_push from public, anon, authenticated;
revoke execute on function save_push_subscription, remove_push_subscription from public, anon;
grant execute on function save_push_subscription, remove_push_subscription to authenticated;