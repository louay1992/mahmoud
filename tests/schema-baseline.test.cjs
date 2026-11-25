/* Applies the v17–v23 production baseline to a real Postgres (PGlite) on a minimal base. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('production baseline builds the shipping, notifications and staff schema idempotently', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(auth.jwt() ->> 'sub', '')::uuid $$;

      create table public.admins (email text primary key);
      create table public.captains (id uuid primary key, name text not null, email text unique,
        delivery_fee numeric not null default 0, active boolean not null default true);
      create table public.warehouses (id uuid primary key, name text not null, captain_id uuid unique);
      create table public.products (id uuid primary key, name text not null, price numeric not null,
        active boolean not null default true);
      create table public.orders (id uuid primary key, order_no bigint not null, customer_name text not null,
        customer_phone text not null, note text, captain_note text, captain_id uuid references captains(id),
        status text not null default 'new', items_total numeric not null default 0,
        delivery_fee numeric not null default 0, total numeric not null default 0,
        list_total numeric not null default 0, owed_amount numeric, marketer_id uuid);
      create table public.order_items (id uuid primary key, order_id uuid not null references orders(id),
        product_id uuid not null, qty integer not null, unit_price numeric not null, list_price numeric not null);
      create table public.order_item_capital (item_id uuid primary key references order_items(id) on delete cascade,
        capital numeric not null default 0);
      create table public.stock (warehouse_id uuid, product_id uuid, qty integer not null default 0,
        primary key (warehouse_id, product_id));
      create table public.stock_movements (id uuid primary key default gen_random_uuid(), warehouse_id uuid not null,
        product_id uuid not null, qty integer not null, kind text not null, order_id uuid, note text,
        created_at timestamptz not null default now());
      create table public.settings (key text primary key, value text);
      create table public.captain_payments (id uuid primary key default gen_random_uuid(), captain_id uuid not null,
        amount numeric not null, note text);
      create table public.marketers (id uuid primary key default gen_random_uuid(), name text not null);
      create table public.marketer_payments (id uuid primary key default gen_random_uuid(),
        marketer_id uuid not null, amount numeric not null, note text);
      create function public.is_admin() returns boolean language sql stable as $$ select true $$;
      create function public.my_captain_id() returns uuid language sql stable as $$ select null::uuid $$;
      create function public.push_to_admins(text, text, text) returns void language plpgsql as $$ begin end $$;
      create function public.push_to_captain(uuid, text, text, text) returns void language plpgsql as $$ begin end $$;
      set check_function_bodies = off;
    `);

    const migrations = [
      'supabase/migrations/20261125091500_production_baseline_v17_v23.sql',
      'supabase/migrations/20261125103000_staff_policies_and_constraint_parity.sql',
    ].map(file => fs.readFileSync(file, 'utf8'));
    for (const migration of migrations) await db.exec(migration);
    // idempotent: a second application of the whole set must not fail
    for (const migration of migrations) await db.exec(migration);

    const columns = async table =>
      (await db.query(`select attname from pg_attribute
        where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum`, [table])).rows.map(r => r.attname);

    assert.deepEqual((await columns('public.orders')).filter(c => [
      'created_by', 'governorate', 'fulfillment', 'carrier_id', 'waybill',
      'shipping_cost', 'ship_status', 'ship_warehouse', 'stock_out',
    ].includes(c)).sort(), [
      'carrier_id', 'created_by', 'fulfillment', 'governorate', 'ship_status',
      'ship_warehouse', 'shipping_cost', 'stock_out', 'waybill',
    ].sort());

    for (const table of ['customers', 'op_guard', 'carriers', 'carrier_payments', 'shipment_events', 'notifications']) {
      const row = (await db.query(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).rows[0];
      assert.equal(row.relrowsecurity, true, table + ' must have RLS enabled');
    }

    const policies = await db.query(`select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename in
      ('customers','carriers','carrier_payments','shipment_events','notifications')`);
    assert.equal(policies.rows[0].n, 7);

    const staffPolicies = await db.query(`select tablename, policyname from pg_policies
      where schemaname = 'public' and policyname in ('staff_orders','staff_order_items') order by 1`);
    assert.deepEqual(staffPolicies.rows.map(r => r.tablename), ['order_items', 'orders']);

    const legacy = await db.query(`select count(*)::int as n from pg_constraint
      where conrelid = 'public.warehouses'::regclass and conname = 'main_no_captain'`);
    assert.equal(legacy.rows[0].n, 0, 'the superseded main_no_captain constraint must not exist');

    const functions = await db.query(`select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in
      ('my_access','staff_lookups','create_order','create_shipment','set_shipment_status','update_shipment',
       'add_carrier_payment','mark_notifications_read','admin_profit_items','guard_once','notify','trg_customer')`);
    assert.equal(functions.rows.length, 12);
    assert.equal(functions.rows.find(r => r.proname === 'create_order')?.args,
      'p_name text, p_phone text, p_note text, p_captain uuid, p_items jsonb, p_address text, p_map text, p_marketer uuid, p_governorate text');

    const triggers = await db.query(`select count(*)::int as n from pg_trigger where not tgisinternal
      and tgrelid in ('public.orders'::regclass, 'public.captain_payments'::regclass, 'public.marketer_payments'::regclass)
      and tgname in ('trg_customer','trg_dup_guard')`);
    assert.equal(triggers.rows[0].n, 4);

    assert.equal((await db.query(`select public.norm_phone('00963 999 123 456') as p`)).rows[0].p, '0999123456');
    assert.equal((await db.query(`select public.norm_phone('٠٩٩٩١٢٣٤٥٦') as p`)).rows[0].p, '0999123456');
  } finally { await db.close(); }
});
