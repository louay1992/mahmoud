begin;
set local lock_timeout='5s';

create unique index if not exists orders_order_no_unique on public.orders(order_no);

alter table owner_private.backup_jobs
 add column safety_backup_key text references owner_private.backup_catalog(object_key),
 add column storage_dirty boolean not null default false,
 add constraint backup_jobs_storage_recovery_check
 check (not storage_dirty or (action='restore' and safety_backup_key is not null));

alter table owner_private.runtime_state
 add column worker_last_success_at timestamptz,
 add column worker_error_code text;

create or replace function owner_private.owner_backup_console(p_limit integer default 50,p_before timestamptz default null,p_before_key text default null) returns jsonb
language plpgsql stable security definer set search_path=public,owner_private,pg_temp as $$
begin
 if not public.is_subscription_owner() then raise exception 'غير مسموح'; end if;
 return jsonb_build_object(
  'files',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc,object_key desc),'[]'::jsonb)
   from(select object_key,created_at,size_bytes,sha256,verified,metadata
    from backup_catalog where p_before is null or created_at<p_before or(created_at=p_before and object_key<coalesce(p_before_key,''))
    order by created_at desc,object_key desc limit greatest(1,least(p_limit,100)))x),
  'total_files',(select count(*) from backup_catalog),
  'jobs',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]'::jsonb)
   from(select j.id,j.action,j.object_key,j.status,j.stage,
    case when j.action='download' and (j.result->>'expires_at')::timestamptz<now() then j.result-'url' else j.result end result,
    j.error_code,j.created_at,j.started_at,j.finished_at,j.heartbeat_at,j.safety_backup_key,
    (j.storage_dirty and j.status='recovery_required' and j.stage='recovery_waiting' and r.maintenance and r.current_job=j.id) is true as recoverable
    from backup_jobs j cross join runtime_state r where r.id order by j.created_at desc limit 30)x),
  'worker',(select jsonb_build_object('last_seen_at',worker_seen_at,'last_success_at',worker_last_success_at,
    'error_code',worker_error_code,'latest_backup_at',(select max(created_at) from backup_catalog where verified),
    'maintenance',maintenance,'current_job',current_job) from runtime_state where id),
  'transport_key',(select jsonb_build_object('id',id,'jwk',public_jwk) from backup_keys order by created_at desc limit 1));
end $$;
revoke all on function owner_private.owner_backup_console(integer,timestamptz,text) from public,anon,authenticated;

create function public.owner_resume_backup_restore(p_job_id uuid,p_encrypted_identity text,p_transport_key uuid,p_confirmation text) returns jsonb
language plpgsql security definer set search_path=public,owner_private,pg_temp as $$
begin
 perform owner_private.require_owner_mfa();
 if p_confirmation is distinct from 'استعادة' then raise exception 'اكتب استعادة لتأكيد إصلاح الملفات'; end if;
 if p_encrypted_identity is null or char_length(p_encrypted_identity) not between 300 and 2048
  or p_encrypted_identity !~ '^[A-Za-z0-9+/=]+$'
  or not exists(select 1 from backup_keys where id=p_transport_key) then
  raise exception 'اختر ملف مفتاح الاستعادة وأعد تشفيره للطلب';
 end if;
 update backup_jobs j set stage='recovery_queued',encrypted_identity=p_encrypted_identity,
  transport_key_id=p_transport_key,error_code=null,finished_at=null
 where j.id=p_job_id and j.status='recovery_required' and j.stage='recovery_waiting' and j.storage_dirty
  and exists(select 1 from runtime_state r where r.id and r.maintenance and r.current_job=j.id);
 if not found then raise exception 'عملية إصلاح الاستعادة غير متاحة'; end if;
 return jsonb_build_object('id',p_job_id,'status','recovery_required','stage','recovery_queued');
end $$;

revoke all on function public.owner_resume_backup_restore(uuid,text,uuid,text) from public,anon;
grant execute on function public.owner_resume_backup_restore(uuid,text,uuid,text) to authenticated;
commit;
