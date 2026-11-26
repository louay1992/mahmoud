
alter table orders add column if not exists status_at timestamptz;
alter table orders add column if not exists captain_note_at timestamptz;
update orders o set status_at = coalesce((select max(e.created_at) from order_events e where e.order_id = o.id and e.status = o.status), o.created_at) where status_at is null;
update orders set captain_note_at = status_at where captain_note is not null and captain_note_at is null;

create or replace function trg_order_times() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.status_at := coalesce(new.status_at, now());
  else
    if new.status is distinct from old.status then new.status_at := now(); end if;
    if new.captain_note is distinct from old.captain_note then
      new.captain_note_at := case when new.captain_note is null then null else now() end;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists order_times on orders;
create trigger order_times before insert or update on orders for each row execute function trg_order_times();
revoke execute on function trg_order_times() from public, anon, authenticated;
