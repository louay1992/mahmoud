/* شاشة تعديل صلاحيات الموظف تنادي admins.update مباشرة، فيجب أن يملك authenticated صلاحية UPDATE،
   وتبقى RLS (admins_admin_all → is_admin()) هي الحارس على الصفوف. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');

test('authenticated may update admins while RLS still limits it to full admins', async () => {
  const file = fs.readdirSync(MIGRATIONS).filter(name => /admins_update/.test(name)).sort().pop();
  assert.ok(file, 'a migration granting UPDATE on admins must exist');
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const grant = sql.match(/grant\s+update\s+on\s+(?:public\.)?admins\s+to\s+authenticated\s*;/i);
  assert.ok(grant, 'the migration must grant update on admins to authenticated');

  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      create table public.admins (email text primary key, perms text[]);
      create function public.is_admin() returns boolean language sql stable security definer
        set search_path = public as $$
          select exists (select 1 from admins where email = auth.jwt() ->> 'email' and perms is null) $$;
      alter table public.admins enable row level security;
      create policy admins_admin_all on public.admins for all to authenticated
        using (is_admin()) with check (is_admin());
      insert into public.admins values ('boss@example.com', null), ('staff@example.com', array['view_orders']);
      grant select on public.admins to authenticated;
    `);
    await db.exec(grant[0]);
    const allowed = await db.query("select has_table_privilege('authenticated','public.admins','UPDATE') as ok");
    assert.equal(allowed.rows[0].ok, true);

    await db.exec(`
      set role authenticated;
      set "request.jwt.claims" = '{"email":"staff@example.com"}';
      update public.admins set perms = array['view_orders','create_orders'] where email = 'staff@example.com';
      reset role;
    `);
    const staffRows = await db.query('select perms from public.admins where email = $1', ['staff@example.com']);
    assert.deepEqual(staffRows.rows[0].perms, ['view_orders'], 'a staff member must not change permissions through RLS');

    await db.exec(`
      set role authenticated;
      set "request.jwt.claims" = '{"email":"boss@example.com"}';
      update public.admins set perms = array['view_orders','create_orders'] where email = 'staff@example.com';
      reset role;
    `);
    const bossRows = await db.query('select perms from public.admins where email = $1', ['staff@example.com']);
    assert.deepEqual(bossRows.rows[0].perms, ['view_orders', 'create_orders'], 'a full admin must be able to save permissions');
  } finally {
    await db.close();
  }
});
