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
      insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
      insert into captains values ('10000000-0000-0000-0000-000000000001',true),('10000000-0000-0000-0000-000000000002',true);
      grant usage on schema public to service_role; grant select on captains,admins to service_role;`);
    await db.exec(fs.readFileSync('supabase/migrations/20261124180741_native_fcm_devices.sql', 'utf8'));
    const id = '20000000-0000-0000-0000-000000000001', secret = 'a'.repeat(64);
    const action = async (kind, user = null, captain = null, token = null, key = secret) =>
      (await db.query(`select public.native_device_action($1::uuid,'captain',$2,$3,$4,$5::uuid,$6::uuid,null) as result`, [id, key, kind, token, user, captain])).rows[0].result;
    await db.exec('set role service_role');
    const first = await action('bind', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'first-token');
    assert.equal(first.saved, true);
    const repeat = await action('bind', first.account_id, '10000000-0000-0000-0000-000000000001', 'first-token');
    assert.equal(repeat.binding_id, first.binding_id);
    await assert.rejects(action('sync', null, null, 'stolen-token', 'b'.repeat(64)), /Invalid device credentials/);
    const second = await action('bind', '00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'second-token');
    assert.notEqual(second.binding_id, first.binding_id);
    const oldTargets = await db.query(`select * from native_push_targets(false,'10000000-0000-0000-0000-000000000001')`);
    assert.equal(oldTargets.rows.length, 0);
    assert.equal((await db.query(`select * from native_push_targets(false,'10000000-0000-0000-0000-000000000002')`)).rows.length, 1);
    await action('unbind');
    const rotated = await action('sync', null, null, 'rotated-after-logout');
    assert.equal(rotated.saved, false, 'token refresh must not restore logged-out ownership');
    assert.equal((await db.query(`select * from native_push_targets(false,'10000000-0000-0000-0000-000000000002')`)).rows.length, 0);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(db.query('select * from public.native_push_devices'), /permission denied/);
    await assert.rejects(action('bind', first.account_id, '10000000-0000-0000-0000-000000000001', 'token'), /permission denied/);
  } finally { await db.close(); }
});
