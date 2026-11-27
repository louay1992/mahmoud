begin;
set local lock_timeout = '5s';

alter table public.admins add column auth_user_id uuid unique references auth.users(id) on delete set null;
alter table public.captains add column auth_user_id uuid unique references auth.users(id) on delete set null;
alter table public.orders add column created_by_auth_user_id uuid;
alter table public.push_subscriptions add column auth_user_id uuid references auth.users(id) on delete cascade;
create index push_subscriptions_auth_user_id on public.push_subscriptions(auth_user_id);

-- Resolve existing accounts exactly once using the confirmed Auth address. Ambiguous legacy
-- records stay unbound until an operator verifies and provisions the intended account.
with matches as (
  select a.email, u.id, count(*) over(partition by lower(a.email)) as matches
  from public.admins a join auth.users u on lower(u.email) = lower(a.email)
  where u.email_confirmed_at is not null
)
update public.admins a set auth_user_id = m.id
from matches m where m.email = a.email and m.matches = 1;
with matches as (
  select c.id as captain_id, u.id, count(*) over(partition by lower(c.email)) as matches
  from public.captains c join auth.users u on lower(u.email) = lower(c.email)
  where u.email_confirmed_at is not null
)
update public.captains c set auth_user_id = m.id
from matches m where m.captain_id = c.id and m.matches = 1;
update public.orders o set created_by_auth_user_id = a.auth_user_id
from public.admins a where lower(a.email) = o.created_by and a.auth_user_id is not null;
alter table public.orders alter column created_by_auth_user_id set default auth.uid();
create index orders_created_by_auth_user_id on public.orders(created_by_auth_user_id);

revoke insert, update on public.admins, public.captains from public, anon, authenticated;
grant insert (email, name, perms), update (name, perms) on public.admins to authenticated;
grant insert (id, name, phone, email, delivery_fee, active, created_at, warehouse_id),
      update (name, phone, email, delivery_fee, active, warehouse_id) on public.captains to authenticated;

-- A signed token for a deleted or revoked Auth session must not keep business access.
create function public.current_business_auth_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.user_id from auth.sessions s
  where s.id = nullif(auth.jwt()->>'session_id', '')::uuid and s.user_id = auth.uid()
    and (s.not_after is null or s.not_after > pg_catalog.now())
$$;
revoke all on function public.current_business_auth_id() from public, anon;
grant execute on function public.current_business_auth_id() to authenticated, service_role;

create or replace function public.is_subscription_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.subscription_owners o where o.user_id = public.current_business_auth_id() and o.active)
$$;

create or replace function public.subscription_is_current() returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.project_subscription s where s.id
    and (pg_catalog.now() at time zone 'Asia/Damascus')::date not between s.starts_on and s.valid_until
  )
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.subscription_is_current() and public.owner_runtime_available() and exists (
    select 1 from public.admins a where a.auth_user_id = public.current_business_auth_id() and a.perms is null
  )
$$;
create or replace function public.has_perm(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.subscription_is_current() and public.owner_runtime_available() and exists (
    select 1 from public.admins a where a.auth_user_id = public.current_business_auth_id() and (a.perms is null or p = any(a.perms))
  )
$$;
create or replace function public.my_captain_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.captains c where c.auth_user_id = public.current_business_auth_id() and c.active
    and public.subscription_is_current() and public.owner_runtime_available()
$$;
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select pg_catalog.jsonb_build_object('role', case when a.perms is null then 'full' else 'staff' end,
      'perms', coalesce(pg_catalog.to_jsonb(a.perms), '[]'::jsonb))
    from public.admins a where a.auth_user_id = public.current_business_auth_id()
    and public.subscription_is_current() and public.owner_runtime_available()
  ), '{"role":"none","perms":[]}'::jsonb)
$$;

alter policy admins_self on public.admins using (auth_user_id = (select public.current_business_auth_id()));
alter policy staff_orders on public.orders to authenticated
  using ((select public.has_perm('view_orders')) and created_by_auth_user_id = (select public.current_business_auth_id()));
alter policy staff_order_items on public.order_items to authenticated
  using ((select public.has_perm('view_orders')) and exists (
    select 1 from public.orders o where o.id = order_id
      and o.created_by_auth_user_id = (select public.current_business_auth_id())
  ));
alter policy cap_products on public.products using (
  (select public.my_captain_id()) is not null or (select public.my_access()->>'role') <> 'none'
);
alter policy settings_read on public.settings using (
  (select public.is_admin()) or (key <> 'usd_exchange_rate' and (
    (select public.my_captain_id()) is not null or (select public.my_access()->>'role') <> 'none'
  ))
);

create or replace function public.subscription_access() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := public.current_business_auth_id();
  terms public.project_subscription;
  runtime owner_private.runtime_state;
  configured boolean;
  full_admin boolean;
  current_subscription boolean;
  runtime_available boolean;
begin
  if actor is null or not (public.is_subscription_owner()
    or exists(select 1 from public.admins where auth_user_id = actor)
    or exists(select 1 from public.captains where auth_user_id = actor and active)) then
    raise exception 'غير مسموح';
  end if;
  select * into runtime from owner_private.runtime_state where id;
  select * into terms from public.project_subscription where id;
  configured := found;
  full_admin := exists(select 1 from public.admins where auth_user_id = actor and perms is null);
  current_subscription := public.subscription_is_current();
  runtime_available := public.owner_runtime_available();
  return pg_catalog.jsonb_build_object('schema', 1, 'allowed', current_subscription and runtime_available,
    'configured', configured, 'reason', case
      when runtime.maintenance then 'maintenance'
      when not runtime_available then 'session_refresh'
      when not current_subscription and (pg_catalog.now() at time zone 'Asia/Damascus')::date < terms.starts_on then 'upcoming'
      when not current_subscription then 'expired' end,
    'valid_until', terms.valid_until, 'starts_on', terms.starts_on, 'checked_at', pg_catalog.now(),
    'expires_at', (terms.valid_until+1)::timestamp at time zone 'Asia/Damascus',
    'renewal_amount', case when full_admin then terms.renewal_amount end,
    'currency', case when full_admin then terms.currency end);
end $$;

create or replace function public.get_subscription() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  terms public.project_subscription;
  today date := (pg_catalog.now() at time zone 'Asia/Damascus')::date;
begin
  if not (public.is_subscription_owner() or exists (
    select 1 from public.admins a where a.auth_user_id = public.current_business_auth_id() and a.perms is null
  )) then raise exception 'غير مسموح'; end if;
  select * into terms from public.project_subscription where id;
  if not found then return pg_catalog.jsonb_build_object('schema', 1, 'configured', false, 'checked_on', today); end if;
  return pg_catalog.jsonb_build_object('schema', 1, 'configured', true, 'plan_code', terms.plan_code,
    'starts_on', terms.starts_on, 'valid_until', terms.valid_until, 'renewal_amount', terms.renewal_amount,
    'currency', terms.currency, 'revision', terms.revision, 'updated_at', terms.updated_at, 'checked_on', today,
    'days_remaining', terms.valid_until-today, 'duration_days', terms.valid_until-terms.starts_on+1,
    'status', case when today < terms.starts_on then 'upcoming' when today > terms.valid_until then 'expired' else 'active' end);
end $$;

-- Only the server that created or reset the verified Auth account can complete a legacy add flow.
create function public.bind_business_identity(p_auth_user uuid, p_captain uuid default null, p_email text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare em text;
begin
  if (p_captain is null) = (p_email is null) then raise exception 'حدد حسابًا واحدًا'; end if;
  if exists(select 1 from public.subscription_owners where user_id = p_auth_user) then
    raise exception 'حساب مالك النظام مستقل عن حسابات الشركة';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('business-identity:'||p_auth_user, 0));
  select lower(u.email) into em from auth.users u where u.id = p_auth_user and u.email_confirmed_at is not null;
  if em is null then raise exception 'يلزم تأكيد هوية حساب الدخول'; end if;
  if p_captain is not null then
    if exists(select 1 from public.admins a where a.auth_user_id = p_auth_user) then raise exception 'الهوية مرتبطة بحساب إداري'; end if;
    update public.captains c set auth_user_id = p_auth_user
    where c.id = p_captain and lower(c.email) = em and (c.auth_user_id is null or c.auth_user_id = p_auth_user);
  else
    if exists(select 1 from public.captains c where c.auth_user_id = p_auth_user) then raise exception 'الهوية مرتبطة بحساب كابتن'; end if;
    update public.admins a set auth_user_id = p_auth_user
    where lower(a.email) = em and em = lower(btrim(p_email)) and (a.auth_user_id is null or a.auth_user_id = p_auth_user);
  end if;
  if not found then raise exception 'هوية حساب الدخول لا تطابق حساب الشركة'; end if;
  return true;
end $$;
revoke all on function public.bind_business_identity(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.bind_business_identity(uuid,uuid,text) to service_role;

-- Snapshot only a password verifier comparison for the verified setup session. An
-- implicit Auth invitation can assign a temporary password before this step.
create table owner_private.admin_setup_sessions (
  email text not null references public.subscription_admin_invites(email) on delete cascade,
  session_id uuid not null references auth.sessions(id) on delete cascade,
  invite_requested_at timestamptz not null,
  password_version text not null,
  primary key(email,session_id)
);
alter table owner_private.admin_setup_sessions enable row level security;
revoke all on owner_private.admin_setup_sessions from public, anon, authenticated;
create index admin_setup_sessions_session_id on owner_private.admin_setup_sessions(session_id);

create function owner_private.session_proves_mailbox(p_invite_requested_at timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select public.current_business_auth_id() is not null and exists (
    select 1 from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(auth.jwt()->'amr') = 'array'
      then auth.jwt()->'amr' else '[]'::jsonb end) method
    where (method->>'method' in ('invite','recovery') or (method->>'method' = 'otp' and exists (
      select 1 from auth.users u where u.id = auth.uid() and coalesce(u.phone,'') = '')))
    and case when pg_catalog.jsonb_typeof(method->'timestamp') = 'number'
      then (method->>'timestamp')::numeric >= pg_catalog.date_part('epoch', pg_catalog.date_trunc('second', p_invite_requested_at))
      else false end
  )
$$;
revoke all on function owner_private.session_proves_mailbox(timestamptz) from public, anon, authenticated;

create or replace function public.admin_setup_access() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.current_business_auth_id();
  setup_session uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  em text;
  confirmed timestamptz;
  password_hash text;
  invitation public.subscription_admin_invites;
begin
  select lower(u.email), u.email_confirmed_at, u.encrypted_password into em, confirmed, password_hash
  from auth.users u where u.id = actor;
  if em is null or confirmed is null or exists(select 1 from public.subscription_owners where user_id = actor) then
    return '{"allowed":false}'::jsonb;
  end if;
  if exists(select 1 from public.admins a where a.auth_user_id = actor) then
    return pg_catalog.jsonb_build_object('email',em,'allowed',true);
  end if;
  select i.* into invitation from public.subscription_admin_invites i
  join public.subscription_owners o on o.user_id = i.approved_by and o.active
  where i.email = em and i.email_sent_at is not null and i.activated_at is null
    and (i.auth_user_id is null or i.auth_user_id = actor);
  if invitation.email is null or not owner_private.session_proves_mailbox(invitation.send_requested_at) then
    return pg_catalog.jsonb_build_object('email',em,'allowed',false);
  end if;
  insert into owner_private.admin_setup_sessions as setup(email,session_id,invite_requested_at,password_version)
  values(em,setup_session,invitation.send_requested_at,pg_catalog.md5(coalesce(password_hash,'')))
  on conflict(email,session_id) do update set invite_requested_at=excluded.invite_requested_at,password_version=excluded.password_version
  where setup.invite_requested_at is distinct from excluded.invite_requested_at;
  return pg_catalog.jsonb_build_object('email',em,'allowed',true);
end $$;

create or replace function public.complete_admin_setup() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.current_business_auth_id();
  setup_session uuid := nullif(auth.jwt()->>'session_id','')::uuid;
  em text;
  confirmed timestamptz;
  password_hash text;
  invitation public.subscription_admin_invites;
  replacement owner_private.email_changes;
  original public.admins;
begin
  if exists(select 1 from owner_private.runtime_state where maintenance) then
    raise exception 'انتظر انتهاء استعادة البيانات قبل تفعيل الحساب';
  end if;
  if actor is null then raise exception 'الدعوة تتطلب جلسة دخول فعالة وتأكيد البريد'; end if;
  select lower(u.email), u.email_confirmed_at, u.encrypted_password into em, confirmed, password_hash
  from auth.users u where u.id = actor;
  if em is null or confirmed is null or coalesce(password_hash,'') = ''
    or exists(select 1 from public.subscription_owners where user_id = actor) then
    raise exception 'يلزم تأكيد البريد وتعيين كلمة المرور لحساب المشترك';
  end if;
  if exists(select 1 from public.admins a where a.auth_user_id = actor) then
    return '{"active":true}'::jsonb;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('owner-admin-accounts',0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('subscription-admin-invite:'||em,0));
  select * into invitation from public.subscription_admin_invites where email = em for update;
  if invitation.email is null or invitation.activated_at is not null or invitation.email_sent_at is null
    or not exists(select 1 from owner_private.admin_setup_sessions setup where setup.email = em
      and setup.session_id = setup_session and setup.invite_requested_at = invitation.send_requested_at
      and setup.password_version <> pg_catalog.md5(password_hash))
    or (invitation.auth_user_id is not null and invitation.auth_user_id <> actor)
    or not owner_private.session_proves_mailbox(invitation.send_requested_at)
    or not exists(select 1 from public.subscription_owners where user_id = invitation.approved_by and active)
    or exists(select 1 from public.captains where lower(email) = em or auth_user_id = actor) then
    raise exception 'الدعوة غير جاهزة أو لم تعد معتمدة. افتح رابط الدعوة الجديد وعيّن كلمة المرور';
  end if;
  if invitation.replaces_email is not null then
    select * into replacement from owner_private.email_changes
    where new_email = em and old_email = invitation.replaces_email and status = 'pending' and actor_id = invitation.approved_by for update;
    if replacement.old_email is null then raise exception 'طلب تغيير البريد لم يعد معتمدًا'; end if;
    select * into original from public.admins where lower(email) = replacement.old_email for update;
    if replacement.was_admin and original.email is null then raise exception 'الحساب القديم أزيل؛ يلزم دعوة جديدة من المالك'; end if;
    if exists(select 1 from auth.users u join public.subscription_owners o on o.user_id = u.id where lower(u.email) = replacement.old_email) then
      raise exception 'حساب المالك محمي';
    end if;
    insert into public.admins(email,name,perms,auth_user_id) values(em,invitation.name,original.perms,actor);
    delete from public.admins where lower(email) = replacement.old_email;
    delete from public.subscription_admin_invites where email = replacement.old_email;
    update owner_private.email_changes set status = 'activated', activated_at = pg_catalog.now() where old_email = replacement.old_email;
    insert into owner_private.admin_audit(actor_id,action,email,new_value)
    values(replacement.actor_id,'email_changed',replacement.old_email,pg_catalog.jsonb_build_object('email',em));
  else
    insert into public.admins(email,name,perms,auth_user_id) values(em,invitation.name,null,actor)
    on conflict(email) do update set name = coalesce(excluded.name,public.admins.name), auth_user_id = actor
      where public.admins.auth_user_id is null;
    if not found then raise exception 'البريد مرتبط بهوية إدارية أخرى'; end if;
  end if;
  delete from auth.sessions where user_id = actor and id <> setup_session;
  delete from owner_private.admin_setup_sessions where email = em;
  update public.subscription_admin_invites set activated_at = pg_catalog.clock_timestamp(), auth_user_id = actor where email = em;
  return '{"active":true}'::jsonb;
end $$;

create function public.owner_has_strong_session() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_subscription_owner() and coalesce(auth.jwt()->>'aal' = 'aal2', false) and exists (
    select 1 from auth.sessions s where s.id = nullif(auth.jwt()->>'session_id','')::uuid
    and s.user_id = auth.uid() and s.aal::text = 'aal2'
  )
$$;
revoke all on function public.owner_has_strong_session() from public, anon;
grant execute on function public.owner_has_strong_session() to authenticated;

create function owner_private.require_owner_mfa() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_subscription_owner() then raise exception 'غير مسموح: لمالك النظام فقط'; end if;
  if not public.owner_has_strong_session() then
    raise sqlstate 'PT403' using message = 'OWNER_MFA_REQUIRED', detail = 'يلزم التحقق بخطوتين لإكمال هذا الإجراء';
  end if;
end $$;
revoke all on function owner_private.require_owner_mfa() from public, anon, authenticated;

alter function public.save_subscription(date,date,numeric,text,bigint) set schema owner_private;
revoke all on function owner_private.save_subscription(date,date,numeric,text,bigint) from public, anon, authenticated;
create function public.save_subscription(p_starts_on date,p_valid_until date,p_renewal_amount numeric,p_currency text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform owner_private.require_owner_mfa();
  return owner_private.save_subscription(p_starts_on,p_valid_until,p_renewal_amount,p_currency,p_expected_revision);
end $$;
revoke all on function public.save_subscription(date,date,numeric,text,bigint) from public, anon;
grant execute on function public.save_subscription(date,date,numeric,text,bigint) to authenticated;

alter function public.owner_update_admin_profile(text,text) set schema owner_private;
revoke all on function owner_private.owner_update_admin_profile(text,text) from public, anon, authenticated;
create function public.owner_update_admin_profile(p_email text,p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform owner_private.require_owner_mfa();
  return owner_private.owner_update_admin_profile(p_email,p_name);
end $$;
revoke all on function public.owner_update_admin_profile(text,text) from public, anon;
grant execute on function public.owner_update_admin_profile(text,text) to authenticated;

alter function public.owner_begin_admin_email_change(text,text,text) set schema owner_private;
revoke all on function owner_private.owner_begin_admin_email_change(text,text,text) from public, anon, authenticated;
create function public.owner_begin_admin_email_change(p_email text,p_new_email text,p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform owner_private.require_owner_mfa();
  return owner_private.owner_begin_admin_email_change(p_email,p_new_email,p_name);
end $$;
revoke all on function public.owner_begin_admin_email_change(text,text,text) from public, anon;
grant execute on function public.owner_begin_admin_email_change(text,text,text) to authenticated;

create or replace function public.owner_prepare_admin_delete(p_email text,p_confirmation text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare em text; previous jsonb; target uuid; operation uuid;
begin
  perform owner_private.require_owner_mfa();
  em := public.owner_assert_account_target(p_email);
  if lower(btrim(p_confirmation)) is distinct from em then raise exception 'اكتب بريد الحساب لتأكيد الحذف'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('owner-admin-accounts',0));
  select pg_catalog.to_jsonb(a),a.auth_user_id into previous,target from public.admins a where lower(a.email) = em for update;
  if previous is null then
    select pg_catalog.to_jsonb(i)-'send_token',i.auth_user_id into previous,target
    from public.subscription_admin_invites i where i.email = em for update;
  end if;
  if exists(select 1 from public.captains where lower(email) = em or auth_user_id = target) then
    raise exception 'الحساب مرتبط بكابتن أيضًا. لا يمكن حذف حساب دخوله من إدارة الإداريين';
  end if;
  if exists(select 1 from public.subscription_owners where user_id = target) then raise exception 'حساب المالك محمي'; end if;
  if previous is null then
    select id into operation from owner_private.admin_audit where email = em and action = 'deleted' and status = 'cleanup_pending'
    order by created_at desc limit 1;
    if operation is not null then return pg_catalog.jsonb_build_object('ok',true,'operation_id',operation); end if;
    raise exception 'الحساب غير موجود';
  end if;
  update public.subscription_admin_invites set approved_by=null,email_sent_at=null
    where email in(select new_email from owner_private.email_changes where old_email = em and status = 'pending');
  update owner_private.email_changes set status = 'cancelled' where (old_email = em or new_email = em) and status = 'pending';
  delete from public.subscription_admin_invites where email = em;
  delete from public.admins where lower(email) = em;
  insert into owner_private.admin_audit(actor_id,action,email,auth_user_id,old_value,status)
  values(auth.uid(),'deleted',em,target,previous,case when target is null then 'complete' else 'cleanup_pending' end) returning id into operation;
  return pg_catalog.jsonb_build_object('ok',true,'operation_id',operation);
end $$;

create or replace function public.owner_admin_delete_target(p_owner uuid,p_operation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare change owner_private.admin_audit;
begin
  if not exists(select 1 from public.subscription_owners where user_id = p_owner and active) then raise exception 'غير مسموح'; end if;
  select * into change from owner_private.admin_audit where id = p_operation and action = 'deleted';
  if change.id is null or change.status <> 'cleanup_pending' then return '{"complete":true}'::jsonb; end if;
  if exists(select 1 from public.subscription_owners where user_id = change.auth_user_id)
    or exists(select 1 from public.admins where auth_user_id = change.auth_user_id or lower(email) = change.email)
    or exists(select 1 from public.captains where auth_user_id = change.auth_user_id or lower(email) = change.email) then
    raise exception 'لا يمكن حذف حساب محمي أو أعيد استخدامه';
  end if;
  return pg_catalog.jsonb_build_object('complete',false,'auth_user_id',change.auth_user_id);
end $$;

create or replace function public.protect_owner_auth_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from public.subscription_owners where user_id = old.id) then raise exception 'حساب مالك النظام محمي من الحذف'; end if;
  if exists(select 1 from public.admins where auth_user_id = old.id or (auth_user_id is null and lower(email) = lower(old.email)))
    or exists(select 1 from public.captains where auth_user_id = old.id or (auth_user_id is null and lower(email) = lower(old.email))) then
    raise exception 'ألغ صلاحيات الحساب قبل حذف بيانات دخوله';
  end if;
  return old;
end $$;

alter function public.owner_request_backup(text,text,text,uuid,text) set schema owner_private;
revoke all on function owner_private.owner_request_backup(text,text,text,uuid,text) from public, anon, authenticated;
create function public.owner_request_backup(p_action text,p_object_key text default null,p_encrypted_identity text default null,
  p_transport_key uuid default null,p_confirmation text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_action is distinct from 'catalog' then perform owner_private.require_owner_mfa(); end if;
  return owner_private.owner_request_backup(p_action,p_object_key,p_encrypted_identity,p_transport_key,p_confirmation);
end $$;
revoke all on function public.owner_request_backup(text,text,text,uuid,text) from public, anon;
grant execute on function public.owner_request_backup(text,text,text,uuid,text) to authenticated;

alter function public.owner_backup_console(integer,timestamptz,text) set schema owner_private;
revoke all on function owner_private.owner_backup_console(integer,timestamptz,text) from public, anon, authenticated;
create function public.owner_backup_console(p_limit integer default 50,p_before timestamptz default null,p_before_key text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare console jsonb;
begin
  console := owner_private.owner_backup_console(p_limit,p_before,p_before_key);
  if public.owner_has_strong_session() then return console; end if;
  return pg_catalog.jsonb_set(console,'{jobs}',(
    select coalesce(pg_catalog.jsonb_agg(case when job->>'action' = 'download' then job #- '{result,url}' else job end order by rank), '[]'::jsonb)
    from pg_catalog.jsonb_array_elements(console->'jobs') with ordinality entries(job,rank)
  ));
end $$;
revoke all on function public.owner_backup_console(integer,timestamptz,text) from public, anon;
grant execute on function public.owner_backup_console(integer,timestamptz,text) to authenticated;

create function public.subscription_has_started() returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists(select 1 from public.project_subscription where id
    and starts_on > (pg_catalog.now() at time zone 'Asia/Damascus')::date)
$$;
revoke all on function public.subscription_has_started() from public, anon;
grant execute on function public.subscription_has_started() to authenticated;

create or replace function public.enforce_subscription_request() returns void
language plpgsql stable security invoker set search_path = '' as $$
declare request_path text := pg_catalog.current_setting('request.path',true);
begin
  if current_user <> 'authenticated' then return; end if;
  if request_path = any(array['/rpc/subscription_access','/rpc/get_subscription','/rpc/is_subscription_owner',
    '/rpc/owner_subscription','/rpc/save_subscription','/rpc/owner_admin_invites','/rpc/owner_has_strong_session',
    '/rpc/admin_setup_access','/rpc/complete_admin_setup'])
    or (left(request_path,11) = '/rpc/owner_' and public.is_subscription_owner()) then return; end if;
  if not public.subscription_has_started() then
    raise sqlstate 'PT402' using message = 'SUBSCRIPTION_NOT_STARTED', detail = 'اشتراك الشركة يبدأ في التاريخ المتفق عليه';
  end if;
  if not public.subscription_is_current() then
    raise sqlstate 'PT402' using message = 'SUBSCRIPTION_EXPIRED', detail = 'انتهى اشتراك الشركة. تواصل مع المالك';
  end if;
  if not public.owner_runtime_available() then
    raise sqlstate 'PT503' using message = 'PROJECT_MAINTENANCE', detail = 'التطبيق متوقف مؤقتًا لتحديث البيانات أو استعادتها. أعد تسجيل الدخول بعد انتهاء العملية';
  end if;
end $$;

-- Revoke browser notifications and live sessions when a business login is removed.
create function owner_private.revoke_removed_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.auth_user_id is not null then
    delete from auth.sessions where user_id = old.auth_user_id;
    delete from public.push_subscriptions where auth_user_id = old.auth_user_id and admin_email is not null;
  end if;
  return old;
end $$;
revoke all on function owner_private.revoke_removed_admin() from public, anon, authenticated;
create trigger revoke_removed_admin after delete on public.admins
for each row execute function owner_private.revoke_removed_admin();

create function owner_private.revoke_inactive_captain() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.auth_user_id is not null then
    delete from auth.sessions where user_id = old.auth_user_id;
    delete from public.push_subscriptions where auth_user_id = old.auth_user_id and captain_id = old.id;
  end if;
  return new;
end $$;
revoke all on function owner_private.revoke_inactive_captain() from public, anon, authenticated;
create trigger revoke_inactive_captain after update of active on public.captains
for each row when (old.active and not new.active) execute function owner_private.revoke_inactive_captain();

-- Legacy unowned subscriptions stay dormant until the authorized app proves continuity
-- with the existing subscription keys. In-flight deliveries independently recheck ownership.
create function owner_private.web_push_endpoint_allowed(p_endpoint text) returns boolean
language plpgsql immutable strict set search_path = '' as $$
declare destination text;
begin
  if pg_catalog.length(p_endpoint) > 4096 or p_endpoint !~ '^[!-~]+$'
    or pg_catalog.strpos(p_endpoint, '#') > 0 or pg_catalog.strpos(p_endpoint, pg_catalog.chr(92)) > 0 then return false; end if;
  destination := pg_catalog.lower((pg_catalog.regexp_match(p_endpoint, '^https://([a-z0-9.-]+)(?::443)?/', 'i'))[1]);
  return coalesce(pg_catalog.length(destination) <= 253 and (
    destination in ('fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','android.googleapis.com')
    or destination ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(push\.apple\.com|notify\.windows\.com)$'
  ), false);
end $$;
revoke all on function owner_private.web_push_endpoint_allowed(text) from public, anon, authenticated;

create function owner_private.save_verified_web_push(p_endpoint text,p_p256dh text,p_auth text,p_admin boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := public.current_business_auth_id();
  captain uuid;
  administrator text;
begin
  if p_admin then
    if public.is_admin() then select lower(email) into administrator from public.admins where auth_user_id = actor; end if;
  else
    captain := public.my_captain_id();
  end if;
  if administrator is null and captain is null then raise exception 'غير مسموح'; end if;
  if not coalesce(owner_private.web_push_endpoint_allowed(p_endpoint), false)
    or not coalesce(pg_catalog.length(p_p256dh) between 1 and 256, false)
    or not coalesce(pg_catalog.length(p_auth) between 1 and 128, false) then
    raise exception 'عنوان اشتراك الإشعارات أو بياناته غير صالحة';
  end if;
  insert into public.push_subscriptions as subscription(captain_id,admin_email,endpoint,p256dh,auth,auth_user_id)
  values(captain,administrator,p_endpoint,p_p256dh,p_auth,actor)
  on conflict(endpoint) do update set captain_id = excluded.captain_id,admin_email = excluded.admin_email,
      p256dh = excluded.p256dh,auth = excluded.auth,auth_user_id = excluded.auth_user_id
  where subscription.auth_user_id = actor or (subscription.auth_user_id is null
    and subscription.captain_id is not distinct from captain
    and lower(subscription.admin_email) is not distinct from administrator
    and subscription.p256dh = p_p256dh and subscription.auth = p_auth);
  if not found then raise exception 'اشتراك الإشعارات مرتبط بحساب أو جلسة أخرى'; end if;
end $$;
revoke all on function owner_private.save_verified_web_push(text,text,text,boolean) from public, anon, authenticated;

create or replace function public.save_admin_push_subscription(p_endpoint text,p_p256dh text,p_auth text) returns void
language sql security definer set search_path = '' as $$
  select owner_private.save_verified_web_push(p_endpoint,p_p256dh,p_auth,true)
$$;
create or replace function public.save_push_subscription(p_endpoint text,p_p256dh text,p_auth text) returns void
language sql security definer set search_path = '' as $$
  select owner_private.save_verified_web_push(p_endpoint,p_p256dh,p_auth,false)
$$;
create or replace function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and auth_user_id = public.current_business_auth_id()
$$;

create function owner_private.push_delivery_allowed() returns boolean
language sql stable set search_path = '' as $$
  select public.subscription_is_current() and exists(select 1 from owner_private.runtime_state where id and not maintenance)
$$;
revoke all on function owner_private.push_delivery_allowed() from public, anon, authenticated;

create or replace function public.native_push_targets(p_admins boolean,p_captain uuid default null)
returns table(installation_id uuid,fcm_token text,binding_id uuid,app_scope text)
language sql stable security definer set search_path = '' as $$
  select d.installation_id,d.fcm_token,d.binding_id,d.app_scope from public.native_push_devices d
  where owner_private.push_delivery_allowed() and d.enabled and (
    (p_admins and d.app_scope = 'admin' and exists (
      select 1 from public.admins a where a.auth_user_id = d.user_id and a.perms is null))
    or (not p_admins and d.app_scope = 'captain' and d.captain_id = p_captain and exists (
      select 1 from public.captains c where c.id = d.captain_id and c.auth_user_id = d.user_id and c.active))
  )
$$;
create or replace function public.web_push_targets(p_admins boolean,p_captain uuid default null)
returns setof public.push_subscriptions language sql stable security definer set search_path = '' as $$
  select s.* from public.push_subscriptions s
  where owner_private.push_delivery_allowed() and owner_private.web_push_endpoint_allowed(s.endpoint) and (
    (p_admins and s.admin_email is not null and exists (
      select 1 from public.admins a where a.auth_user_id = s.auth_user_id and a.perms is null))
    or (not p_admins and s.captain_id = p_captain and exists (
      select 1 from public.captains c where c.id = s.captain_id and c.auth_user_id = s.auth_user_id and c.active))
  ) and not exists(select 1 from public.native_push_preferences p where p.user_id = s.auth_user_id and p.native_only and (
    (p_admins and p.app_scope = 'admin') or (not p_admins and p.app_scope = 'captain' and p.captain_id = s.captain_id)
  ))
$$;

notify pgrst,'reload schema';
commit;
