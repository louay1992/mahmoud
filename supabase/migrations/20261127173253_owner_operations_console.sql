begin;
set local lock_timeout='5s';
create schema if not exists owner_private;
revoke all on schema owner_private from public,anon,authenticated;
grant usage on schema owner_private to service_role;
create table owner_private.admin_audit(
 id uuid primary key default gen_random_uuid(),actor_id uuid references auth.users(id) on delete set null,
 action text not null,email text not null,auth_user_id uuid,old_value jsonb,new_value jsonb,
 status text not null default 'complete',created_at timestamptz not null default now(),finished_at timestamptz
);
create table owner_private.email_changes(
 old_email text primary key,new_email text unique not null,actor_id uuid not null references auth.users(id),
 was_admin boolean not null,status text not null default 'pending',created_at timestamptz not null default now(),activated_at timestamptz
);
alter table subscription_admin_invites add column replaces_email text;
create table owner_private.backup_catalog(
 object_key text primary key,created_at timestamptz not null,size_bytes bigint not null check(size_bytes>=0),sha256 text,
 verified boolean not null default false,metadata jsonb not null default '{}',last_seen_at timestamptz not null default now()
);
create table owner_private.backup_keys(
 id uuid primary key default gen_random_uuid(),public_jwk jsonb not null,encrypted_private_key bytea not null,
 salt bytea not null,nonce bytea not null,created_at timestamptz not null default now()
);
create table owner_private.backup_jobs(
 id uuid primary key default gen_random_uuid(),actor_id uuid references auth.users(id) on delete set null,
 action text not null check(action in ('catalog','create','download','restore','cleanup')),
 object_key text references owner_private.backup_catalog(object_key),
 encrypted_identity text,transport_key_id uuid references owner_private.backup_keys(id),
 status text not null default 'queued' check(status in ('queued','running','succeeded','failed','recovery_required')),
 stage text not null default 'queued',result jsonb not null default '{}',error_code text,
 created_at timestamptz not null default now(),started_at timestamptz,finished_at timestamptz,heartbeat_at timestamptz,lease_id uuid
);
create unique index owner_backup_pending on owner_private.backup_jobs(action,coalesce(object_key,'')) where status in ('queued','running');
create table owner_private.runtime_state(
 id boolean primary key default true check(id),maintenance boolean not null default false,
 session_cutoff timestamptz,worker_seen_at timestamptz,worker_run_url text,current_job uuid references owner_private.backup_jobs(id),
 updated_at timestamptz not null default now()
);
insert into owner_private.runtime_state(id) values(true);
create table owner_private.disposable_files(
 bucket_id text not null,object_name text not null,expected_etag text not null,expires_at timestamptz not null,
 reason text not null check(reason in ('temporary_export','aborted_upload')),
 created_at timestamptz not null default now(),primary key(bucket_id,object_name),
 check(object_name like 'owner-temp/%')
);
do $tables$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='owner_private' loop
  execute format('alter table owner_private.%I enable row level security',t.tablename);
  execute format('revoke all on owner_private.%I from public,anon,authenticated',t.tablename);
  execute format('grant all on owner_private.%I to service_role',t.tablename);
 end loop;
end $tables$;

create function public.owner_assert_account_target(p_email text) returns text
language plpgsql stable security definer set search_path=public,owner_private,pg_temp as $$
declare em text:=lower(btrim(p_email));
begin
 if not is_subscription_owner() then raise exception 'غير مسموح: لمالك النظام فقط'; end if;
 if em is null or char_length(em)>254 or em !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'أدخل بريدًا صحيحًا'; end if;
 if exists(select 1 from auth.users u join subscription_owners o on o.user_id=u.id where lower(u.email)=em) then raise exception 'حساب المالك محمي ولا يمكن تعديله أو حذفه من حسابات الشركة'; end if;
 return em;
end $$;
revoke all on function owner_assert_account_target(text) from public,anon,authenticated;

-- The application owner can recover by inviting a replacement; company users retain their last-admin guard.
create or replace function public.trg_keep_one_admin() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if (select count(*) from admins)<=1 and not is_subscription_owner() then raise exception 'لا يمكن حذف آخر إداري'; end if;
 return old;
end $$;
create function public.protect_owner_auth_delete() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from subscription_owners where user_id=old.id) then raise exception 'حساب مالك النظام محمي من الحذف'; end if;
 if exists(select 1 from admins where lower(email)=lower(old.email)) or exists(select 1 from captains where lower(email)=lower(old.email)) then raise exception 'ألغ صلاحيات الحساب قبل حذف بيانات دخوله'; end if;
 return old;
end $$;
revoke all on function protect_owner_auth_delete() from public,anon,authenticated,service_role;
create trigger protect_project_owner before delete on auth.users for each row execute function protect_owner_auth_delete();

create function public.owner_update_admin_profile(p_email text,p_name text) returns jsonb
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
declare em text:=owner_assert_account_target(p_email); previous jsonb; nm text:=nullif(btrim(p_name),'');
begin
 if char_length(coalesce(nm,''))>100 then raise exception 'الاسم لا يتجاوز 100 حرف'; end if;
 perform pg_advisory_xact_lock(hashtextextended('owner-admin-accounts',0));
 select to_jsonb(a) into previous from admins a where lower(email)=em for update;
 if previous is null then select to_jsonb(i)-'send_token' into previous from subscription_admin_invites i where email=em for update; end if;
 if previous is null then raise exception 'الحساب غير موجود'; end if;
 update admins set name=nm where lower(email)=em;update subscription_admin_invites set name=nm where email=em;
 insert into admin_audit(actor_id,action,email,old_value,new_value) values(auth.uid(),'profile_updated',em,previous,jsonb_build_object('name',nm));
 return jsonb_build_object('ok',true);
end $$;
revoke all on function owner_update_admin_profile(text,text) from public,anon;
grant execute on function owner_update_admin_profile(text,text) to authenticated;

create function public.owner_begin_admin_email_change(p_email text,p_new_email text,p_name text) returns jsonb
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
declare em text:=owner_assert_account_target(p_email); target text:=owner_assert_account_target(p_new_email); registered boolean; prior record;
begin
 if em=target then raise exception 'البريد الجديد مطابق للحالي'; end if;
 if char_length(coalesce(p_name,''))>100 then raise exception 'الاسم طويل جدًا'; end if;
 perform pg_advisory_xact_lock(hashtextextended('owner-admin-accounts',0));
 if exists(select 1 from captains where lower(email) in (em,target)) then raise exception 'البريد مرتبط بحساب كابتن. استخدم حسابًا إداريًا مستقلًا'; end if;
 registered:=exists(select 1 from admins where lower(email)=em);
 if not registered and not exists(select 1 from subscription_admin_invites where email=em) then raise exception 'الحساب غير موجود'; end if;
 if exists(select 1 from admins where lower(email)=target) or exists(select 1 from subscription_admin_invites where email=target) then
  if exists(select 1 from email_changes where old_email=em and new_email=target and status='pending') then return jsonb_build_object('ok',true,'email',target); end if;
  raise exception 'البريد الجديد مرتبط بحساب أو دعوة أخرى';
 end if;
 select * into prior from email_changes where old_email=em and status='pending';
 if found then update subscription_admin_invites set approved_by=null,email_sent_at=null where email=prior.new_email and replaces_email=em; end if;
 insert into email_changes(old_email,new_email,actor_id,was_admin)values(em,target,auth.uid(),registered)
 on conflict(old_email) do update set new_email=excluded.new_email,actor_id=excluded.actor_id,was_admin=excluded.was_admin,status='pending',created_at=now(),activated_at=null;
 insert into subscription_admin_invites(email,name,approved_by,send_requested_at,replaces_email)
 values(target,nullif(btrim(p_name),''),auth.uid(),clock_timestamp()-interval '2 minutes',em);
 insert into admin_audit(actor_id,action,email,new_value)values(auth.uid(),'email_change_requested',em,jsonb_build_object('new_email',target));
 return jsonb_build_object('ok',true,'email',target);
end $$;
revoke all on function owner_begin_admin_email_change(text,text,text) from public,anon;
grant execute on function owner_begin_admin_email_change(text,text,text) to authenticated;

create function public.owner_prepare_admin_delete(p_email text,p_confirmation text) returns jsonb
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
declare em text:=owner_assert_account_target(p_email); previous jsonb; target uuid; operation uuid;
begin
 if lower(btrim(p_confirmation)) is distinct from em then raise exception 'اكتب بريد الحساب لتأكيد الحذف'; end if;
 perform pg_advisory_xact_lock(hashtextextended('owner-admin-accounts',0));
 if exists(select 1 from captains where lower(email)=em) then raise exception 'الحساب مرتبط بكابتن أيضًا. لا يمكن حذف حساب دخوله من إدارة الإداريين'; end if;
 select id into target from auth.users where lower(email)=em;
 select to_jsonb(a) into previous from admins a where lower(email)=em for update;
 if previous is null then select to_jsonb(i)-'send_token' into previous from subscription_admin_invites i where email=em for update; end if;
 if previous is null then
  select id into operation from admin_audit where email=em and action='deleted' and status='cleanup_pending' order by created_at desc limit 1;
  if operation is not null then return jsonb_build_object('ok',true,'operation_id',operation); end if;
  raise exception 'الحساب غير موجود';
 end if;
 update subscription_admin_invites set approved_by=null,email_sent_at=null
 where email in (select new_email from email_changes where old_email=em and status='pending');
 update email_changes set status='cancelled' where (old_email=em or new_email=em) and status='pending';
 delete from subscription_admin_invites where email=em;
 delete from admins where lower(email)=em;
 insert into admin_audit(actor_id,action,email,auth_user_id,old_value,status)
 values(auth.uid(),'deleted',em,target,previous,case when target is null then 'complete' else 'cleanup_pending' end) returning id into operation;
 return jsonb_build_object('ok',true,'operation_id',operation);
end $$;
revoke all on function owner_prepare_admin_delete(text,text) from public,anon;
grant execute on function owner_prepare_admin_delete(text,text) to authenticated;
create function public.owner_admin_delete_target(p_owner uuid,p_operation uuid) returns jsonb
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
declare a admin_audit;
begin
 if not exists(select 1 from subscription_owners where user_id=p_owner and active) then raise exception 'غير مسموح'; end if;
 select * into a from admin_audit where id=p_operation and action='deleted';
 if a.id is null or a.status<>'cleanup_pending' then return jsonb_build_object('complete',true); end if;
 if exists(select 1 from subscription_owners where user_id=a.auth_user_id) or exists(select 1 from admins where lower(email)=a.email)
  or exists(select 1 from captains where lower(email)=a.email) then raise exception 'لا يمكن حذف حساب محمي أو أعيد استخدامه'; end if;
 return jsonb_build_object('complete',false,'auth_user_id',a.auth_user_id);
end $$;
revoke all on function owner_admin_delete_target(uuid,uuid) from public,anon,authenticated;
grant execute on function owner_admin_delete_target(uuid,uuid) to service_role;
create function public.owner_finish_admin_delete(p_owner uuid,p_operation uuid) returns boolean
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
begin
 if not exists(select 1 from subscription_owners where user_id=p_owner and active) then raise exception 'غير مسموح'; end if;
 update admin_audit set status='complete',finished_at=now() where id=p_operation and action='deleted' and not exists(select 1 from auth.users where id=admin_audit.auth_user_id);
 return found;
end $$;
revoke all on function owner_finish_admin_delete(uuid,uuid) from public,anon,authenticated;
grant execute on function owner_finish_admin_delete(uuid,uuid) to service_role;

create or replace function public.owner_admin_invites() returns jsonb
language plpgsql stable security definer set search_path=public,owner_private,pg_temp as $$
begin
 if not is_subscription_owner() then raise exception 'غير مسموح'; end if;
 return (with ems as (select lower(email) email from admins union select email from subscription_admin_invites
  union select email from admin_audit where action='deleted' and status='cleanup_pending'),
 rows as(select ems.email,coalesce(a.name,i.name) as name,i.email_sent_at,i.send_requested_at,i.send_error,
  case when a.email is not null then 'active' when exists(select 1 from admin_audit x where x.email=ems.email and x.action='deleted' and x.status='cleanup_pending') then 'deleting'
   when i.send_error then 'failed' when i.email_sent_at is not null then 'pending' else 'sending' end status,
  a.email is not null as registered,case when a.email is not null and a.perms is not null then 'staff' else 'full' end role,
  exists(select 1 from auth.users u where lower(u.email)=ems.email and u.email_confirmed_at is not null) as email_confirmed,
  i.replaces_email,(select new_email from email_changes c where c.old_email=ems.email and c.status='pending') as pending_email
  from ems left join admins a on lower(a.email)=ems.email left join subscription_admin_invites i on i.email=ems.email
  where not exists(select 1 from auth.users u join subscription_owners o on o.user_id=u.id where lower(u.email)=ems.email))
 select coalesce(jsonb_agg(to_jsonb(rows) order by email),'[]'::jsonb) from rows);
end $$;

create or replace function public.complete_admin_setup() returns jsonb
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
declare em text; confirmed timestamptz; password_set boolean; invitation subscription_admin_invites;
 replacement email_changes; original admins;
begin
 if exists(select 1 from runtime_state where maintenance) then raise exception 'انتظر انتهاء استعادة البيانات قبل تفعيل الحساب'; end if;
 select lower(email),email_confirmed_at,coalesce(encrypted_password,'')<>'' into em,confirmed,password_set from auth.users where id=auth.uid();
 if em is null or confirmed is null or not coalesce(password_set,false) or exists(select 1 from subscription_owners where user_id=auth.uid()) then raise exception 'يلزم تأكيد البريد وتعيين كلمة المرور لحساب المشترك'; end if;
 perform pg_advisory_xact_lock(hashtextextended('owner-admin-accounts',0));
 perform pg_advisory_xact_lock(hashtextextended('subscription-admin-invite:'||em,0));
 select * into invitation from subscription_admin_invites where email=em for update;
 if invitation.email is not null and invitation.activated_at is null and invitation.email_sent_at is not null
  and (invitation.auth_user_id is null or invitation.auth_user_id=auth.uid())
  and exists(select 1 from subscription_owners where user_id=invitation.approved_by and active)
  and not exists(select 1 from captains where lower(email)=em) then
  if invitation.replaces_email is not null then
   select * into replacement from email_changes where new_email=em and old_email=invitation.replaces_email and status='pending' and actor_id=invitation.approved_by for update;
   if replacement.old_email is null then raise exception 'طلب تغيير البريد لم يعد معتمدًا'; end if;
   select * into original from admins where lower(email)=replacement.old_email for update;
   if replacement.was_admin and original.email is null then raise exception 'الحساب القديم أزيل؛ يلزم دعوة جديدة من المالك'; end if;
   if exists(select 1 from auth.users u join subscription_owners o on o.user_id=u.id where lower(u.email)=replacement.old_email) then raise exception 'حساب المالك محمي'; end if;
   insert into admins(email,name,perms)values(em,invitation.name,original.perms);
   -- New account exists before the old role is revoked, preserving the last-admin invariant.
   delete from admins where lower(email)=replacement.old_email;
   delete from subscription_admin_invites where email=replacement.old_email;
   update email_changes set status='activated',activated_at=now() where old_email=replacement.old_email;
   insert into admin_audit(actor_id,action,email,new_value)values(replacement.actor_id,'email_changed',replacement.old_email,jsonb_build_object('email',em));
  else
   insert into admins(email,name,perms) values(em,invitation.name,null)
   on conflict(email) do update set name=coalesce(excluded.name,admins.name);
  end if;
  update subscription_admin_invites set activated_at=clock_timestamp(),auth_user_id=auth.uid() where email=em;
 end if;
 if not exists(select 1 from admins where lower(email)=em) then raise exception 'الدعوة غير جاهزة أو لم تعد معتمدة. تواصل مع مالك النظام'; end if;
 return jsonb_build_object('active',true);
end $$;

create function public.owner_backup_console(p_limit integer default 50,p_before timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path=public,owner_private,pg_temp as $$
begin
 if not is_subscription_owner() then raise exception 'غير مسموح'; end if;
 return jsonb_build_object('files',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]'::jsonb)
  from(select object_key,created_at,size_bytes,sha256,verified,metadata from backup_catalog where p_before is null or created_at<p_before order by created_at desc limit greatest(1,least(p_limit,100)))x),
  'total_files',(select count(*) from backup_catalog),
  'jobs',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]'::jsonb) from(select id,action,object_key,status,stage,case when action='download' and (result->>'expires_at')::timestamptz<now() then result-'url' else result end result,error_code,created_at,started_at,finished_at,heartbeat_at from backup_jobs order by created_at desc limit 30)x),
  'worker',(select jsonb_build_object('last_seen_at',worker_seen_at,'maintenance',maintenance,'current_job',current_job) from runtime_state where id),
  'transport_key',(select jsonb_build_object('id',id,'jwk',public_jwk) from backup_keys order by created_at desc limit 1));
end $$;
revoke all on function owner_backup_console(integer,timestamptz) from public,anon;
grant execute on function owner_backup_console(integer,timestamptz) to authenticated;

create function public.owner_request_backup(p_action text,p_object_key text default null,p_encrypted_identity text default null,p_transport_key uuid default null,p_confirmation text default null) returns jsonb
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
declare operation uuid; target backup_catalog;
begin
 if not is_subscription_owner() then raise exception 'غير مسموح'; end if;
 if p_action not in ('catalog','create','download','restore','cleanup') or p_action is null then raise exception 'عملية غير صالحة'; end if;
 perform pg_advisory_xact_lock(hashtextextended('owner-backup-queue',0));
 if p_action in ('download','restore') then
  select * into target from backup_catalog where object_key=p_object_key;
  if target.object_key is null or not target.verified then raise exception 'اختر نسخة موثقة من القائمة'; end if;
 end if;
 if p_action not in ('download','restore') and p_object_key is not null then raise exception 'هذه العملية لا تقبل ملفًا محددًا'; end if;
 if p_action='restore' then
  if p_confirmation is distinct from 'استعادة' then raise exception 'اكتب استعادة لتأكيد استبدال بيانات الشركة'; end if;
  if p_encrypted_identity is null or char_length(p_encrypted_identity) not between 300 and 2048
   or p_encrypted_identity !~ '^[A-Za-z0-9+/=]+$' or not exists(select 1 from backup_keys where id=p_transport_key) then raise exception 'اختر ملف مفتاح الاستعادة وأعد تشفيره للطلب'; end if;
  if exists(select 1 from backup_jobs where action='restore' and status in ('queued','running','recovery_required')) then raise exception 'توجد عملية استعادة لم تنته بعد'; end if;
 end if;
 if p_action='cleanup' and p_confirmation is distinct from 'تنظيف' then raise exception 'يلزم تأكيد التنظيف الآمن'; end if;
 select id into operation from backup_jobs where action=p_action and coalesce(object_key,'')=coalesce(p_object_key,'') and status in ('queued','running') limit 1;
 if operation is not null then return jsonb_build_object('id',operation,'status','queued','existing',true); end if;
 if (select count(*) from backup_jobs where actor_id=auth.uid() and created_at>now()-interval '1 minute')>=5 then raise exception 'انتظر دقيقة قبل إرسال طلب جديد'; end if;
 insert into backup_jobs(actor_id,action,object_key,encrypted_identity,transport_key_id)
 values(auth.uid(),p_action,case when p_action in ('download','restore') then p_object_key end,
 case when p_action='restore' then p_encrypted_identity end,case when p_action='restore' then p_transport_key end) returning id into operation;
 return jsonb_build_object('id',operation,'status','queued','existing',false);
end $$;
revoke all on function owner_request_backup(text,text,text,uuid,text) from public,anon;
grant execute on function owner_request_backup(text,text,text,uuid,text) to authenticated;

create function public.owner_runtime_available() returns boolean
language sql stable security definer set search_path=public,owner_private,pg_temp as $$
 select not maintenance and (session_cutoff is null or coalesce(to_timestamp(nullif(auth.jwt()->>'iat','')::double precision),'-infinity'::timestamptz)>=session_cutoff)
 from runtime_state where id;
$$;
revoke all on function owner_runtime_available() from public,anon;
grant execute on function owner_runtime_available() to authenticated,service_role;
-- Additional policies protect direct/Realtime/Storage business access throughout a restore.
do $runtime$ declare t record; begin
 for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where c.relkind in ('r','p') and c.relrowsecurity and ((n.nspname='public' and c.relname not in ('subscription_owners','project_subscription','subscription_changes','subscription_admin_invites')) or(n.nspname='storage' and c.relname='objects')) loop
  execute format('create policy owner_runtime_required on %I.%I as restrictive for all to authenticated using ((select public.owner_runtime_available())) with check ((select public.owner_runtime_available()))',t.nspname,t.relname);
 end loop;
end $runtime$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select subscription_is_current() and owner_runtime_available() and exists(select 1 from admins where lower(email)=lower(auth.jwt()->>'email') and perms is null);
$$;
create or replace function public.has_perm(p text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select subscription_is_current() and owner_runtime_available() and exists(select 1 from admins where lower(email)=lower(auth.jwt()->>'email') and(perms is null or p=any(perms)));
$$;
create or replace function public.my_captain_id() returns uuid language sql stable security definer set search_path=public,pg_temp as $$
 select id from captains where subscription_is_current() and owner_runtime_available() and lower(email)=lower(auth.jwt()->>'email') and active limit 1;
$$;
create or replace function public.subscription_access() returns jsonb
language plpgsql stable security definer set search_path=public,owner_private,pg_temp as $$
declare em text:=lower(auth.jwt()->>'email'); s project_subscription; full_admin boolean; rt runtime_state; permitted boolean;
begin
 full_admin:=exists(select 1 from admins where lower(email)=em and perms is null);
 if auth.uid() is null or not(exists(select 1 from admins where lower(email)=em) or exists(select 1 from captains where lower(email)=em and active) or is_subscription_owner()) then raise exception 'غير مسموح'; end if;
 select * into rt from runtime_state where id;
 select * into s from project_subscription where id;
 permitted:=subscription_is_current() and owner_runtime_available();
 return jsonb_build_object('schema',1,'allowed',permitted,'configured',found,'reason',case when rt.maintenance then 'maintenance' when not owner_runtime_available() then 'session_refresh' when not subscription_is_current() then 'expired' end,
 'valid_until',s.valid_until,'starts_on',s.starts_on,'checked_at',now(),'expires_at',(s.valid_until+1)::timestamp at time zone 'Asia/Damascus',
 'renewal_amount',case when full_admin then s.renewal_amount end,'currency',case when full_admin then s.currency end);
end $$;
create or replace function public.enforce_subscription_request() returns void
language plpgsql stable security invoker set search_path=public,pg_temp as $$
begin
 if current_user<>'authenticated' then return; end if;
 if current_setting('request.path',true)=any(array['/rpc/subscription_access','/rpc/get_subscription','/rpc/is_subscription_owner','/rpc/owner_subscription','/rpc/save_subscription','/rpc/owner_admin_invites','/rpc/admin_setup_access','/rpc/complete_admin_setup'])
 or (left(current_setting('request.path',true),11)='/rpc/owner_' and is_subscription_owner()) then return; end if;
 if not subscription_is_current() then raise sqlstate 'PT402' using message='SUBSCRIPTION_EXPIRED',detail='انتهى اشتراك الشركة. تواصل مع المالك'; end if;
 if not owner_runtime_available() then raise sqlstate 'PT503' using message='PROJECT_MAINTENANCE',detail='التطبيق متوقف مؤقتًا لتحديث البيانات أو استعادتها. أعد تسجيل الدخول بعد انتهاء العملية'; end if;
end $$;

-- Registered disposable files are immutable from client sessions: cleanup cannot race a user upload.
create function public.owner_storage_file_available(p_bucket text,p_name text) returns boolean
language sql stable security definer set search_path=owner_private,pg_temp as $$
 select not exists(select 1 from disposable_files where bucket_id=p_bucket and object_name=p_name);
$$;
revoke all on function owner_storage_file_available(text,text) from public,anon;
grant execute on function owner_storage_file_available(text,text) to authenticated;
do $$ begin
 if to_regclass('storage.objects') is not null then
  execute 'create policy owner_disposable_protected on storage.objects as restrictive for all to authenticated using ((select public.owner_storage_file_available(bucket_id,name))) with check ((select public.owner_storage_file_available(bucket_id,name)))';
 end if;
end $$;

create function public.owner_project_resources() returns jsonb
language plpgsql stable security definer set search_path=public,owner_private,pg_temp as $$
declare result jsonb; buckets jsonb:='[]'; objects bigint:=0; bytes numeric:=0; missing bigint:=0; queries jsonb:=null;
begin
 if not is_subscription_owner() then raise exception 'غير مسموح'; end if;
 if to_regclass('storage.objects') is not null then
  execute $q$select count(*),coalesce(sum(case when metadata->>'size' ~ '^[0-9]+$' then (metadata->>'size')::numeric else 0 end),0),count(*) filter(where metadata->>'size' is null) from storage.objects$q$ into objects,bytes,missing;
  execute $q$select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select b.id,b.public,count(o.name) as object_count,coalesce(sum(case when o.metadata->>'size' ~ '^[0-9]+$' then (o.metadata->>'size')::numeric else 0 end),0) as size_bytes from storage.buckets b left join storage.objects o on o.bucket_id=b.id group by b.id,b.public order by b.id)x$q$ into buckets;
 end if;
 if to_regclass('extensions.pg_stat_statements') is not null then
  execute 'select jsonb_build_object(''calls'',sum(calls),''mean_exec_ms'',sum(total_exec_time)/nullif(sum(calls),0),''max_mean_exec_ms'',max(mean_exec_time)) from extensions.pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())' into queries;
 end if;
 select jsonb_build_object('checked_at',now(),'database_bytes',pg_database_size(current_database()),
 'tables',(select coalesce(jsonb_agg(to_jsonb(t) order by total_bytes desc),'[]'::jsonb) from(select schemaname,relname,n_live_tup as estimated_rows,pg_total_relation_size(relid) as total_bytes,pg_indexes_size(relid) as index_bytes from pg_stat_user_tables where schemaname in ('public','auth','storage','owner_private'))t),
 'database_stats',(select jsonb_build_object('transactions_committed',xact_commit,'transactions_rolled_back',xact_rollback,'cache_hit_percent',round(100.0*blks_hit/nullif(blks_hit+blks_read,0),2),'deadlocks',deadlocks,'stats_since',stats_reset) from pg_stat_database where datname=current_database()),
 'connections',(select jsonb_build_object('active',count(*) filter(where state='active' and pid<>pg_backend_pid()),'total',count(*),'maximum',current_setting('max_connections')::integer) from pg_stat_activity where datname=current_database()),
 'storage',jsonb_build_object('objects',objects,'bytes',bytes,'size_unknown',missing,'buckets',buckets),
 'query_performance',queries,'safe_cleanup',(select jsonb_build_object('files',count(*),'expires_before',now(),'candidates',coalesce(jsonb_agg(jsonb_build_object('bucket',bucket_id,'name',object_name,'reason',reason,'expired_at',expires_at)),'[]')) from disposable_files where expires_at<now()),
 'worker',(select jsonb_build_object('last_seen_at',worker_seen_at,'maintenance',maintenance) from runtime_state where id),
 'cpu_percent',null,'memory_bytes',null) into result;
 return result;
end $$;
revoke all on function owner_project_resources() from public,anon;
grant execute on function owner_project_resources() to authenticated;
notify pgrst,'reload schema';
commit;
