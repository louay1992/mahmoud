create or replace view captain_balances with (security_invoker = true) as
select c.id as captain_id, c.name,
  coalesce((select sum(items_total) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as delivered_total,
  coalesce((select sum(delivery_fee) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as fees_total,
  coalesce((select count(*) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0) as delivered_count,
  coalesce((select sum(amount) from captain_payments p where p.captain_id = c.id), 0) as paid_total,
  coalesce((select sum(items_total) from orders o where o.captain_id = c.id and o.status = 'delivered'), 0)
   - coalesce((select sum(amount) from captain_payments p where p.captain_id = c.id), 0) as balance
from captains c;