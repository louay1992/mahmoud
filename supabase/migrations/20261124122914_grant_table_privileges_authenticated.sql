grant usage on schema public to authenticated;
grant select, insert, update, delete on products, captains, warehouses, stock, stock_invoices, stock_invoice_items, orders, order_items, captain_payments to authenticated;
grant select on admins, captain_balances to authenticated;
grant usage, select on all sequences in schema public to authenticated;