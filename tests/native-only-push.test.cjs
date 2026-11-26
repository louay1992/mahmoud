/* A recipient with only an Android device (no Web Push subscription) must still trigger send-push. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const MIGRATION = 'supabase/migrations/20261126123000_native_only_push_delivery.sql';
const CAPTAIN = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'admin@example.test';

async function setup() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create table public.push_config (key text primary key, value text);
    insert into public.push_config values
      ('fn_url', 'https://example.test/functions/v1/send-push');
    insert into public.push_config values ('push_secret', 'test-secret');
    create table public.push_subscriptions (id serial primary key, captain_id uuid, admin_email text, endpoint text);
    create table public.native_push_devices (installation_id uuid primary key, app_scope text not null,
      captain_id uuid, admin_email text, enabled boolean not null default false);
    create schema net;
    create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
    create function net.http_post(url text, body jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb)
      returns bigint language sql as $$ insert into net.calls(url, body, headers) values (url, body, headers) returning id $$;
  `);
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  await db.exec(sql);
  await db.exec(sql); // idempotent: replacing the functions twice must not fail
  return db;
}

const clean = db => db.exec('delete from net.calls; delete from push_subscriptions; delete from native_push_devices');
const calls = async db => (await db.query('select body from net.calls order by id')).rows;
const captain = db => db.query('select public.push_to_captain($1, $2, $3, $4)', [CAPTAIN, 't', 'b', 'tag']);
const admins = db => db.query('select public.push_to_admins($1, $2, $3)', ['t', 'b', 'tag']);

test('a captain with only a native device still reaches send-push', async () => {
  const db = await setup();
  try {
    await clean(db);
    await db.exec(`insert into native_push_devices(installation_id, app_scope, captain_id, enabled)
      values (gen_random_uuid(), 'captain', '${CAPTAIN}', true)`);
    await captain(db);
    const sent = await calls(db);
    assert.equal(sent.length, 1, 'FCM-only captain must trigger a send');
    assert.equal(sent[0].body.captain_id, CAPTAIN);
  } finally { await db.close(); }
});

test('a captain with only a Web subscription still reaches send-push', async () => {
  const db = await setup();
  try {
    await clean(db);
    await db.exec(`insert into push_subscriptions(captain_id, endpoint) values ('${CAPTAIN}', 'https://web.test/1')`);
    await captain(db);
    assert.equal((await calls(db)).length, 1);
  } finally { await db.close(); }
});

test('a captain with both channels triggers exactly one send', async () => {
  const db = await setup();
  try {
    await clean(db);
    await db.exec(`insert into push_subscriptions(captain_id, endpoint) values ('${CAPTAIN}', 'https://web.test/1');
      insert into native_push_devices(installation_id, app_scope, captain_id, enabled)
        values (gen_random_uuid(), 'captain', '${CAPTAIN}', true)`);
    await captain(db);
    assert.equal((await calls(db)).length, 1, 'a single request fans out to both channels');
  } finally { await db.close(); }
});

test('a captain with no reachable target never calls send-push', async () => {
  const db = await setup();
  try {
    await clean(db);
    await db.exec(`insert into native_push_devices(installation_id, app_scope, captain_id, enabled)
      values (gen_random_uuid(), 'captain', '${CAPTAIN}', false)`);
    await captain(db);
    await captain(db);
    assert.equal((await calls(db)).length, 0, 'a logged-out device is not a target');
  } finally { await db.close(); }
});

test('admins with only a native device still reach send-push', async () => {
  const db = await setup();
  try {
    await clean(db);
    await db.exec(`insert into native_push_devices(installation_id, app_scope, admin_email, enabled)
      values (gen_random_uuid(), 'admin', '${ADMIN}', true)`);
    await admins(db);
    const sent = await calls(db);
    assert.equal(sent.length, 1, 'FCM-only admin must trigger a send');
    assert.equal(sent[0].body.admins, true);
  } finally { await db.close(); }
});

test('admins with only a Web subscription still reach send-push', async () => {
  const db = await setup();
  try {
    await clean(db);
    await db.exec(`insert into push_subscriptions(admin_email, endpoint) values ('${ADMIN}', 'https://web.test/2')`);
    await admins(db);
    assert.equal((await calls(db)).length, 1);
  } finally { await db.close(); }
});

test('admins with no reachable target never call send-push', async () => {
  const db = await setup();
  try {
    await clean(db);
    await db.exec(`insert into native_push_devices(installation_id, app_scope, admin_email, enabled)
      values (gen_random_uuid(), 'captain', '${ADMIN}', false)`);
    await admins(db);
    assert.equal((await calls(db)).length, 0);
  } finally { await db.close(); }
});
