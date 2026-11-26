
create or replace function marketer_return_impact(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o record; b record; prof numeric;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  select * into o from order_profits where order_id = p_order;
  if not found or o.marketer_id is null or o.status <> 'delivered' then return jsonb_build_object('marketer', false); end if;
  select * into b from marketer_balances where marketer_id = o.marketer_id;
  prof := o.profit;
  return jsonb_build_object('marketer', true, 'name', b.name, 'profit', prof, 'balance', b.balance,
    'after', b.balance - prof, 'shortfall', greatest(0, prof - b.balance));
end $$;
revoke execute on function marketer_return_impact(uuid) from public, anon;
grant execute on function marketer_return_impact(uuid) to authenticated;
