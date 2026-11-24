-- Retain account notification preferences after device logout; never delete browser subscriptions.
create table public.native_push_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  app_scope text not null check(app_scope in ('admin','captain')),
  captain_id uuid references public.captains(id) on delete cascade,
  admin_email text,
  native_only boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key(user_id,app_scope),
  check((app_scope='captain' and captain_id is not null and admin_email is null) or
    (app_scope='admin' and admin_email is not null and captain_id is null))
);
alter table public.native_push_preferences enable row level security;
revoke all on public.native_push_preferences from public,anon,authenticated;
grant all on public.native_push_preferences to service_role;
create index native_push_preference_captain on public.native_push_preferences(captain_id) where native_only;
create index native_push_preference_admin on public.native_push_preferences(admin_email) where native_only;

create or replace function public.native_device_action(
  p_id uuid, p_scope text, p_secret_hash text, p_action text,
  p_token text default null, p_user uuid default null,
  p_captain uuid default null, p_email text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.native_push_devices; bid uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text, 0));
  select * into d from public.native_push_devices where installation_id = p_id for update;
  if found and (d.secret_hash <> p_secret_hash or d.app_scope <> p_scope) then
    raise exception 'Invalid device credentials';
  end if;
  if p_action = 'bind' then
    if p_user is null or p_token is null or
      (p_scope = 'captain' and p_captain is null) or (p_scope = 'admin' and p_email is null) then
      raise exception 'Invalid binding';
    end if;
    bid := case when d.user_id = p_user and d.enabled then d.binding_id else gen_random_uuid() end;
    insert into public.native_push_devices(installation_id, app_scope, secret_hash, fcm_token, user_id, captain_id, admin_email, binding_id, enabled)
    values(p_id, p_scope, p_secret_hash, p_token, p_user, p_captain, p_email, bid, true)
    on conflict (installation_id) do update set fcm_token = excluded.fcm_token,
      user_id = excluded.user_id, captain_id = excluded.captain_id, admin_email = excluded.admin_email,
      binding_id = excluded.binding_id, enabled = true, updated_at = now()
    returning * into d;
    insert into public.native_push_preferences(user_id,app_scope,captain_id,admin_email,native_only)
    values(p_user,p_scope,p_captain,p_email,true)
    on conflict(user_id,app_scope) do update set captain_id=excluded.captain_id,
      admin_email=excluded.admin_email,native_only=true,updated_at=now();
  elsif p_action = 'sync' then
    if d.installation_id is not null and p_token is not null then
      update public.native_push_devices set fcm_token = p_token, updated_at = now()
      where installation_id = p_id returning * into d;
    end if;
  elsif p_action = 'unbind' then
    update public.native_push_devices set user_id = null, captain_id = null, admin_email = null,
      binding_id = null, enabled = false, updated_at = now() where installation_id = p_id returning * into d;
  elsif p_action = 'test' then
    if d.installation_id is null or not d.enabled or d.user_id is distinct from p_user then raise exception 'Device is not bound to this account'; end if;
    if d.last_test_at > now() - interval '10 seconds' then raise exception 'Please wait before testing again'; end if;
    update public.native_push_devices set last_test_at = now() where installation_id = p_id returning * into d;
  else
    raise exception 'Unknown device action';
  end if;
  return jsonb_build_object('saved', coalesce(d.enabled, false), 'binding_id', d.binding_id,
    'account_id', d.user_id, 'fcm_token', d.fcm_token, 'app_scope', d.app_scope);
end $$;
revoke all on function public.native_device_action(uuid,text,text,text,text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.native_device_action(uuid,text,text,text,text,uuid,uuid,text) to service_role;


create function public.web_push_targets(p_admins boolean,p_captain uuid default null)
returns setof public.push_subscriptions language sql stable security invoker set search_path='' as $$
 select s.* from public.push_subscriptions s
 where ((p_admins and s.admin_email is not null and exists(select 1 from public.admins a where lower(a.email)=lower(s.admin_email)
   and (to_jsonb(a)->'perms' is null or to_jsonb(a)->'perms'='null'::jsonb)))
  or (not p_admins and s.captain_id=p_captain and exists(select 1 from public.captains c where c.id=s.captain_id and c.active)))
 and not exists(select 1 from public.native_push_preferences p where p.native_only and
  ((p_admins and p.app_scope='admin' and lower(p.admin_email)=lower(s.admin_email)) or
   (not p_admins and p.app_scope='captain' and p.captain_id=s.captain_id)));
$$;
revoke all on function public.web_push_targets(boolean,uuid) from public,anon,authenticated;
grant execute on function public.web_push_targets(boolean,uuid) to service_role;
