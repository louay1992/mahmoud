begin;
-- One company's invitations. No Auth tokens, password values or provider error bodies are stored.
create table public.subscription_admin_invites (
 email text primary key check(email=lower(btrim(email)) and char_length(email)<=254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 name text check(char_length(name)<=100),
 auth_user_id uuid unique references auth.users(id) on delete set null,
 approved_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 send_requested_at timestamptz not null default now(),
 email_sent_at timestamptz,
 send_token uuid,
 send_error boolean not null default false,
 activated_at timestamptz
);
alter table public.subscription_admin_invites enable row level security;
revoke all on public.subscription_admin_invites from public,anon,authenticated;
grant all on public.subscription_admin_invites to service_role;

-- Service-only reservation serializes duplicate clicks and never grants a business role.
create function public.reserve_subscription_admin_invite(p_owner uuid,p_email text,p_name text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare em text:=lower(btrim(p_email)); target uuid; invitation public.subscription_admin_invites; request_token uuid:=gen_random_uuid();
begin
 if not exists(select 1 from public.subscription_owners where user_id=p_owner and active) then raise exception 'غير مسموح: الدعوة لمالك النظام فقط'; end if;
 if em is null or char_length(em)>254 or em !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'أدخل بريدًا إلكترونيًا صحيحًا'; end if;
 if char_length(coalesce(p_name,''))>100 then raise exception 'الاسم طويل جدًا'; end if;
 perform pg_advisory_xact_lock(hashtextextended('subscription-admin-invite:'||em,0));
 select id into target from auth.users where lower(email)=em;
 if exists(select 1 from public.subscription_owners where user_id=target) then raise exception 'حساب المالك مستقل عن حسابات المشتركين'; end if;
 if exists(select 1 from public.captains where lower(email)=em) then raise exception 'هذا البريد مرتبط بحساب كابتن. استخدم بريدًا إداريًا آخر'; end if;
 select * into invitation from public.subscription_admin_invites where email=em for update;
 if invitation.send_requested_at>clock_timestamp()-interval '60 seconds' then raise exception 'انتظر دقيقة قبل إعادة إرسال الدعوة'; end if;
 insert into public.subscription_admin_invites(email,name,auth_user_id,approved_by,send_token)
 values(em,nullif(btrim(p_name),''),target,p_owner,request_token)
 on conflict(email) do update set name=coalesce(excluded.name,subscription_admin_invites.name),auth_user_id=target,approved_by=p_owner,
  send_requested_at=clock_timestamp(),send_token=request_token,send_error=false,email_sent_at=null,
  activated_at=case when exists(select 1 from public.admins where lower(email)=em) then subscription_admin_invites.activated_at else null end;
 return jsonb_build_object('email',em,'send_token',request_token,'existing_user',target is not null,'auth_user_id',target);
end $$;
revoke all on function public.reserve_subscription_admin_invite(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_subscription_admin_invite(uuid,text,text) to service_role;

create function public.finish_subscription_admin_invite(p_email text,p_token uuid,p_success boolean,p_auth_user_id uuid default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_auth_user_id is not null and not exists(select 1 from auth.users where id=p_auth_user_id and lower(email)=p_email) then raise exception 'الحساب لا يطابق البريد'; end if;
 update public.subscription_admin_invites set email_sent_at=case when p_success then clock_timestamp() else email_sent_at end,
  send_error=not p_success,send_token=null,auth_user_id=coalesce(p_auth_user_id,auth_user_id)
 where email=p_email and send_token=p_token;
 return found;
end $$;
revoke all on function public.finish_subscription_admin_invite(text,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.finish_subscription_admin_invite(text,uuid,boolean,uuid) to service_role;

create function public.owner_admin_invites() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.is_subscription_owner() then raise exception 'غير مسموح'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('email',i.email,'name',i.name,'email_sent_at',i.email_sent_at,
  'send_requested_at',i.send_requested_at,'send_error',i.send_error,
  'status',case when i.activated_at is not null and exists(select 1 from public.admins a where lower(a.email)=i.email) then 'active'
   when i.send_error then 'failed' when i.email_sent_at is not null then 'pending' else 'sending' end)
  order by i.created_at desc),'[]'::jsonb) from public.subscription_admin_invites i);
end $$;
revoke all on function public.owner_admin_invites() from public,anon;
grant execute on function public.owner_admin_invites() to authenticated;

create function public.admin_setup_access() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare em text; confirmed timestamptz;
begin
 select lower(email),email_confirmed_at into em,confirmed from auth.users where id=auth.uid();
 if em is null or confirmed is null or exists(select 1 from public.subscription_owners where user_id=auth.uid()) then return jsonb_build_object('allowed',false); end if;
 return jsonb_build_object('email',em,'allowed',
  exists(select 1 from public.admins where lower(email)=em) or exists(
   select 1 from public.subscription_admin_invites i join public.subscription_owners o on o.user_id=i.approved_by and o.active
   where i.email=em and i.email_sent_at is not null and i.activated_at is null and (i.auth_user_id is null or i.auth_user_id=auth.uid())));
end $$;
revoke all on function public.admin_setup_access() from public,anon;
grant execute on function public.admin_setup_access() to authenticated;

-- Activation reads the authoritative Auth row, not editable user metadata or a caller-supplied email.
create function public.complete_admin_setup() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare em text; confirmed timestamptz; password_set boolean; invitation public.subscription_admin_invites;
begin
 select lower(email),email_confirmed_at,coalesce(encrypted_password,'')<>'' into em,confirmed,password_set from auth.users where id=auth.uid();
 if em is null or confirmed is null or not coalesce(password_set,false) or exists(select 1 from public.subscription_owners where user_id=auth.uid()) then raise exception 'يلزم تأكيد البريد وتعيين كلمة المرور لحساب المشترك'; end if;
 perform pg_advisory_xact_lock(hashtextextended('subscription-admin-invite:'||em,0));
 select * into invitation from public.subscription_admin_invites where email=em for update;
 if invitation.email is not null and invitation.activated_at is null and invitation.email_sent_at is not null
  and (invitation.auth_user_id is null or invitation.auth_user_id=auth.uid())
  and exists(select 1 from public.subscription_owners where user_id=invitation.approved_by and active)
  and not exists(select 1 from public.captains where lower(email)=em) then
  insert into public.admins(email,name,perms) values(em,invitation.name,null)
  on conflict(email) do update set name=coalesce(excluded.name,admins.name),perms=null;
  update public.subscription_admin_invites set activated_at=clock_timestamp(),auth_user_id=auth.uid() where email=em;
 end if;
 if not exists(select 1 from public.admins where lower(email)=em) then raise exception 'الدعوة غير جاهزة أو لم تعد معتمدة. تواصل مع مالك النظام'; end if;
 return jsonb_build_object('active',true);
end $$;
revoke all on function public.complete_admin_setup() from public,anon;
grant execute on function public.complete_admin_setup() to authenticated;
notify pgrst,'reload schema';
commit;
