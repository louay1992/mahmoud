const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Postgres device migration isolates accounts, rotates bindings, and denies frontend table access', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create table public.captains(id uuid primary key, active boolean not null default true);
      create table public.admins(email text primary key, perms text[]);
      create table public.push_subscriptions(endpoint text primary key,captain_id uuid,admin_email text);
      insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
      insert into captains values ('10000000-0000-0000-0000-000000000001',true),('10000000-0000-0000-0000-000000000002',true);
      insert into push_subscriptions values ('web-a','10000000-0000-0000-0000-000000000001',null),('web-b','10000000-0000-0000-0000-000000000002',null);
      grant usage on schema public to service_role; grant select on captains,admins,push_subscriptions to service_role;`);
    await db.exec(fs.readFileSync('supabase/migrations/20261124180741_native_fcm_devices.sql', 'utf8'));
    await db.exec(fs.readFileSync('supabase/migrations/20261124203345_native_app_notifications.sql', 'utf8'));
    const id = '20000000-0000-0000-0000-000000000001', secret = 'a'.repeat(64);
    const action = async (kind, user = null, captain = null, token = null, key = secret) =>
      (await db.query(`select public.native_device_action($1::uuid,'captain',$2,$3,$4,$5::uuid,$6::uuid,null) as result`, [id, key, kind, token, user, captain])).rows[0].result;
    await db.exec('set role service_role');
    const web = async captain => (await db.query('select endpoint from web_push_targets(false,$1::uuid)',[captain])).rows;
    assert.equal((await web('10000000-0000-0000-0000-000000000001')).length,1);
    const first = await action('bind', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'first-token');
    assert.equal(first.saved, true);
    assert.equal((await web('10000000-0000-0000-0000-000000000001')).length,0,'native binding disables old browser targets for this captain');
    assert.equal((await web('10000000-0000-0000-0000-000000000002')).length,1,'web-only captain remains subscribed');
    const repeat = await action('bind', first.account_id, '10000000-0000-0000-0000-000000000001', 'first-token');
    assert.equal(repeat.binding_id, first.binding_id);
    await assert.rejects(action('sync', null, null, 'stolen-token', 'b'.repeat(64)), /Invalid device credentials/);
    const second = await action('bind', '00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'second-token');
    assert.notEqual(second.binding_id, first.binding_id);
    const oldTargets = await db.query(`select * from native_push_targets(false,'10000000-0000-0000-0000-000000000001')`);
    assert.equal(oldTargets.rows.length, 0);
    assert.equal((await db.query(`select * from native_push_targets(false,'10000000-0000-0000-0000-000000000002')`)).rows.length, 1);
    await action('unbind');
    assert.equal((await web('10000000-0000-0000-0000-000000000002')).length,0,'logout must not resume old browser notifications');
    assert.equal((await db.query('select count(*)::int as n from push_subscriptions')).rows[0].n,2,'old subscriptions are preserved');
    const rotated = await action('sync', null, null, 'rotated-after-logout');
    assert.equal(rotated.saved, false, 'token refresh must not restore logged-out ownership');
    assert.equal((await db.query(`select * from native_push_targets(false,'10000000-0000-0000-0000-000000000002')`)).rows.length, 0);
    await db.exec(`reset role;
      insert into admins values ('owner@test',null),('staff@test',array['orders']),('web@test',null);
      insert into push_subscriptions values ('admin-old',null,'OWNER@test'),('staff',null,'staff@test'),('admin-web',null,'web@test');
      set role service_role;`);
    assert.equal((await db.query('select * from web_push_targets(true,null)')).rows.length,2,'staff do not receive full admin push');
    await db.query(`select native_device_action('20000000-0000-0000-0000-000000000002','admin',$1,'bind','admin-token','00000000-0000-0000-0000-000000000001',null,'owner@test')`,[secret]);
    assert.deepEqual((await db.query('select endpoint from web_push_targets(true,null)')).rows,[{endpoint:'admin-web'}],'native admin suppression is scoped and case insensitive');
    await db.exec('reset role; set role authenticated');
    await assert.rejects(db.query('select * from public.native_push_devices'), /permission denied/);
    await assert.rejects(db.query('select * from public.native_push_preferences'), /permission denied/);
    await assert.rejects(db.query('select * from web_push_targets(true,null)'), /permission denied/);
    await assert.rejects(action('bind', first.account_id, '10000000-0000-0000-0000-000000000001', 'token'), /permission denied/);
  } finally { await db.close(); }
});
