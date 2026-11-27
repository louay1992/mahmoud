begin;
set local lock_timeout='5s';

-- No scheduled job or cached JWT claim decides expiry. The last contract day is inclusive in Damascus.
create function public.subscription_is_current() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select not exists(select 1 from public.project_subscription where id and valid_until < (now() at time zone 'Asia/Damascus')::date);
$$;
revoke all on function public.subscription_is_current() from public,anon;
grant execute on function public.subscription_is_current() to authenticated,service_role;

create function public.subscription_access() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare em text:=lower(auth.jwt()->>'email'); s public.project_subscription; full_admin boolean;
begin
 full_admin:=exists(select 1 from public.admins where lower(email)=em and perms is null);
 if auth.uid() is null or not (exists(select 1 from public.admins where lower(email)=em)
  or exists(select 1 from public.captains where lower(email)=em and active) or public.is_subscription_owner()) then raise exception 'غير مسموح'; end if;
 select * into s from public.project_subscription where id;
 return jsonb_build_object('schema',1,'allowed',public.subscription_is_current(),'configured',found,
  'valid_until',s.valid_until,'starts_on',s.starts_on,'checked_at',now(),
  'expires_at',(s.valid_until+1)::timestamp at time zone 'Asia/Damascus',
  'renewal_amount',case when full_admin then s.renewal_amount end,'currency',case when full_admin then s.currency end);
end $$;
revoke all on function public.subscription_access() from public,anon;
grant execute on function public.subscription_access() to authenticated;

-- These shared authorization helpers also protect SECURITY DEFINER business RPCs.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.subscription_is_current() and exists(select 1 from public.admins where lower(email)=lower(auth.jwt()->>'email') and perms is null);
$$;
create or replace function public.has_perm(p text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select public.subscription_is_current() and exists(select 1 from public.admins where lower(email)=lower(auth.jwt()->>'email') and (perms is null or p=any(perms)));
$$;
create or replace function public.my_captain_id() returns uuid
language sql stable security definer set search_path=public,pg_temp as $$
 select id from public.captains where public.subscription_is_current() and lower(email)=lower(auth.jwt()->>'email') and active limit 1;
$$;

-- Read-only renewal terms remain available after expiry. Business admin identity alone never grants owner access.
create or replace function public.get_subscription() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s public.project_subscription; today date:=(now() at time zone 'Asia/Damascus')::date;
begin
 if not (exists(select 1 from public.admins where lower(email)=lower(auth.jwt()->>'email') and perms is null) or public.is_subscription_owner()) then raise exception 'غير مسموح'; end if;
 select * into s from public.project_subscription where id;
 if not found then return jsonb_build_object('schema',1,'configured',false,'checked_on',today); end if;
 return jsonb_build_object('schema',1,'configured',true,'plan_code',s.plan_code,'starts_on',s.starts_on,
  'valid_until',s.valid_until,'renewal_amount',s.renewal_amount,'currency',s.currency,'revision',s.revision,
  'updated_at',s.updated_at,'checked_on',today,'days_remaining',s.valid_until-today,'duration_days',s.valid_until-s.starts_on+1,
  'status',case when today<s.starts_on then 'upcoming' when today>s.valid_until then 'expired' else 'active' end);
end $$;

-- Queued notifications must not reveal new business data to an expired subscriber.
create or replace function public.native_push_targets(p_admins boolean, p_captain uuid default null)
returns table(installation_id uuid, fcm_token text, binding_id uuid, app_scope text)
language sql stable security invoker set search_path = '' as $$
  select d.installation_id, d.fcm_token, d.binding_id, d.app_scope
  from public.native_push_devices d
  where public.subscription_is_current() and d.enabled and (
    (p_admins and d.app_scope = 'admin' and exists (
      select 1 from public.admins a where lower(a.email) = d.admin_email
      and (to_jsonb(a)->'perms' is null or to_jsonb(a)->'perms' = 'null'::jsonb)))
    or (not p_admins and d.app_scope = 'captain' and d.captain_id = p_captain and exists (
      select 1 from public.captains c where c.id = d.captain_id and c.active))
  );
$$;
create or replace function public.web_push_targets(p_admins boolean,p_captain uuid default null)
returns setof public.push_subscriptions language sql stable security invoker set search_path='' as $$
 select s.* from public.push_subscriptions s
 where public.subscription_is_current() and ((p_admins and s.admin_email is not null and exists(select 1 from public.admins a where lower(a.email)=lower(s.admin_email)
   and (to_jsonb(a)->'perms' is null or to_jsonb(a)->'perms'='null'::jsonb)))
  or (not p_admins and s.captain_id=p_captain and exists(select 1 from public.captains c where c.id=s.captain_id and c.active)))
 and not exists(select 1 from public.native_push_preferences p where p.native_only and
  ((p_admins and p.app_scope='admin' and lower(p.admin_email)=lower(s.admin_email)) or
   (not p_admins and p.app_scope='captain' and p.captain_id=s.captain_id)));
$$;

-- RESTRICTIVE policies AND the existing row/permission rules, including Realtime and Storage.
do $policies$
declare t record;
begin
 for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p') and c.relrowsecurity and
   ((n.nspname='public' and c.relname not in ('subscription_owners','project_subscription','subscription_changes','subscription_admin_invites'))
    or (n.nspname='storage' and c.relname='objects')) loop
  execute format('create policy subscription_required on %I.%I as restrictive for all to authenticated using ((select public.subscription_is_current())) with check ((select public.subscription_is_current()))',t.nspname,t.relname);
 end loop;
end $policies$;

-- Deny the whole Data API request before any business RPC/table/view executes, including older APKs.
create function public.enforce_subscription_request() returns void
language plpgsql stable security invoker set search_path=public,pg_temp as $$
begin
 if current_user<>'authenticated' or public.subscription_is_current() then return; end if;
 if current_setting('request.path',true)=any(array[
  '/rpc/subscription_access','/rpc/get_subscription','/rpc/is_subscription_owner','/rpc/owner_subscription',
  '/rpc/save_subscription','/rpc/owner_admin_invites','/rpc/admin_setup_access','/rpc/complete_admin_setup'
 ]) then return; end if;
 raise sqlstate 'PT402' using message='SUBSCRIPTION_EXPIRED',detail='انتهى اشتراك الشركة. تواصل مع مالك النظام لتجديد الاشتراك.';
end $$;
revoke all on function public.enforce_subscription_request() from public;
grant execute on function public.enforce_subscription_request() to anon,authenticated,service_role;
-- Refuse to silently replace an operator's existing pre-request hook.
do $hook$
declare existing text;
begin
 select split_part(setting,'=',2) into existing from pg_roles r cross join lateral unnest(r.rolconfig) setting
  where r.rolname='authenticator' and setting like 'pgrst.db_pre_request=%';
 if existing is not null and existing<>'' and existing<>'public.enforce_subscription_request' then raise exception 'Existing API pre-request hook needs explicit integration'; end if;
 if exists(select 1 from pg_roles where rolname='authenticator') then
  alter role authenticator set pgrst.db_pre_request='public.enforce_subscription_request';
 end if;
end $hook$;
notify pgrst,'reload config';
notify pgrst,'reload schema';
commit;
