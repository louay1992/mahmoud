revoke execute on function trg_order_created(), trg_stock_invoice_item() from public, anon, authenticated;
alter function trg_keep_one_admin() set search_path = public;