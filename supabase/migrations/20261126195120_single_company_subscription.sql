begin;
-- Owner identity is configured explicitly by the project operator, never inferred from company admins.
create table public.subscription_owners (
 user_id uuid primary key references auth.users(id) on delete cascade,
 active boolean not null default true,
 created_at timestamptz not null default now()
);
create table public.project_subscription (
 id boolean primary key default true check(id),
 plan_code text not null default 'annual' check(plan_code ~ '^[a-z][a-z0-9_]{0,49}$'),
 starts_on date not null check(isfinite(starts_on)),
 valid_until date not null check(isfinite(valid_until) and valid_until>=starts_on),
 renewal_amount numeric(12,2) not null check(renewal_amount between 0 and 9999999999.99),
 currency text not null check(currency ~ '^[A-Z]{3}$'),
 revision bigint not null default 1 check(revision>0),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null
);
create table public.subscription_changes (
 id bigint generated always as identity primary key,
 actor_id uuid references auth.users(id) on delete set null,
 previous_value jsonb,
 new_value jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.subscription_owners enable row level security;
alter table public.project_subscription enable row level security;
alter table public.subscription_changes enable row level security;
revoke all on public.subscription_owners,public.project_subscription,public.subscription_changes from public,anon,authenticated;
grant all on public.subscription_owners,public.project_subscription,public.subscription_changes to service_role;
grant usage,select on sequence public.subscription_changes_id_seq to service_role;

create function public.is_subscription_owner() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.subscription_owners where user_id=auth.uid() and active);
$$;
revoke all on function public.is_subscription_owner() from public,anon;
grant execute on function public.is_subscription_owner() to authenticated;

-- The customer reads terms only; expiry does not change business permissions in this display-only release.
create function public.get_subscription() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s public.project_subscription; today date := (now() at time zone 'Asia/Damascus')::date;
begin
 if not (public.is_admin() or public.is_subscription_owner()) then raise exception 'غير مسموح'; end if;
 select * into s from public.project_subscription where id;
 if not found then return jsonb_build_object('schema',1,'configured',false,'checked_on',today); end if;
 return jsonb_build_object('schema',1,'configured',true,'plan_code',s.plan_code,'starts_on',s.starts_on,
  'valid_until',s.valid_until,'renewal_amount',s.renewal_amount,'currency',s.currency,
  'revision',s.revision,'updated_at',s.updated_at,'checked_on',today,
  'days_remaining',s.valid_until-today,'duration_days',s.valid_until-s.starts_on+1,
  'status',case when today<s.starts_on then 'upcoming' when today>s.valid_until then 'expired' else 'active' end);
end $$;
revoke all on function public.get_subscription() from public,anon;
grant execute on function public.get_subscription() to authenticated;

create function public.owner_subscription() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.is_subscription_owner() then raise exception 'غير مسموح'; end if;
 return jsonb_build_object('subscription',public.get_subscription(),'changes',
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb)
    from (select id,previous_value,new_value,created_at from public.subscription_changes order by id desc limit 20)x));
end $$;
revoke all on function public.owner_subscription() from public,anon;
grant execute on function public.owner_subscription() to authenticated;

create function public.save_subscription(p_starts_on date,p_valid_until date,p_renewal_amount numeric,p_currency text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare previous public.project_subscription; current_value public.project_subscription;
begin
 if not public.is_subscription_owner() then raise exception 'غير مسموح: تعديل الاشتراك لمالك النظام فقط'; end if;
 if not coalesce(isfinite(p_starts_on) and isfinite(p_valid_until) and p_valid_until>=p_starts_on,false) then
  raise exception 'تاريخ البداية والنهاية غير صالحين'; end if;
 if not coalesce(p_renewal_amount between 0 and 9999999999.99 and p_renewal_amount=round(p_renewal_amount,2),false) then
  raise exception 'قيمة التجديد غير صالحة'; end if;
 if not coalesce(p_currency ~ '^[A-Z]{3}$',false) then raise exception 'اختر رمز عملة صحيحًا'; end if;
 perform pg_advisory_xact_lock(hashtextextended('single-company-subscription',0));
 select * into previous from public.project_subscription where id for update;
 if p_expected_revision is distinct from coalesce(previous.revision,0) then
  raise exception 'تغيرت بيانات الاشتراك من جلسة أخرى. حدّث الصفحة قبل الحفظ'; end if;
 insert into public.project_subscription(id,starts_on,valid_until,renewal_amount,currency,revision,updated_by)
 values(true,p_starts_on,p_valid_until,p_renewal_amount,p_currency,coalesce(previous.revision,0)+1,auth.uid())
 on conflict(id) do update set starts_on=excluded.starts_on,valid_until=excluded.valid_until,
  renewal_amount=excluded.renewal_amount,currency=excluded.currency,revision=excluded.revision,
  updated_at=clock_timestamp(),updated_by=excluded.updated_by returning * into current_value;
 insert into public.subscription_changes(actor_id,previous_value,new_value)
 values(auth.uid(),case when previous.id is null then null else to_jsonb(previous)-'updated_by' end,to_jsonb(current_value)-'updated_by');
 return public.get_subscription();
end $$;
revoke all on function public.save_subscription(date,date,numeric,text,bigint) from public,anon;
grant execute on function public.save_subscription(date,date,numeric,text,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
