const { test } = require('node:test');
const assert = require('node:assert/strict');

const shared = () => import('../supabase/functions/_shared/admin-set-password.ts');

test('CORS echoes approved business origins and isolates preview deployments', async () => {
  const { corsHeaders, normalizeOrigin, DEFAULT_APP_ORIGIN } = await shared();
  const { businessRequestOrigin, APPLICATIONS_APP_ORIGIN } = await import('../supabase/functions/_shared/app-origins.ts');
  const origin = normalizeOrigin('https://hhyyw.netlify.app/');
  assert.equal(origin, 'https://hhyyw.netlify.app');
  assert.equal(normalizeOrigin(undefined), DEFAULT_APP_ORIGIN);
  assert.equal(normalizeOrigin('   '), DEFAULT_APP_ORIGIN);
  assert.equal(normalizeOrigin('not a url'), DEFAULT_APP_ORIGIN);
  const headers = corsHeaders(origin);
  assert.equal(headers['access-control-allow-origin'], origin);
  assert.notEqual(headers['access-control-allow-origin'], '*');
  assert.equal(headers.vary, 'Origin');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.match(headers['access-control-allow-headers'], /authorization/);
  for (const foreign of ['https://owner.nature-care.net', 'http://hhyyw.netlify.app', 'null', 'https://hhyyw.netlify.app.example.test',
    'https://hhyyw.netlify.app:8443', 'https://hhyyw.netlify.app/']) {
    assert.equal(businessRequestOrigin(foreign, origin), null, foreign);
  }
  assert.equal(businessRequestOrigin(origin, origin), origin);
  assert.equal(businessRequestOrigin(APPLICATIONS_APP_ORIGIN, origin), APPLICATIONS_APP_ORIGIN);
  assert.equal(businessRequestOrigin(origin, APPLICATIONS_APP_ORIGIN), origin);
  assert.equal(businessRequestOrigin(null, origin), origin);
  const preview = 'https://preview.example.test';
  assert.equal(businessRequestOrigin(preview, preview), preview);
  assert.equal(businessRequestOrigin(APPLICATIONS_APP_ORIGIN, preview), null);
});

test('case-insensitive password target lookups retain literal email characters', async () => {
  const { exactEmailPattern } = await shared();
  assert.equal(exactEmailPattern('office_1%reports@example.test'), 'office\\_1\\%reports@example.test');
  assert.equal(exactEmailPattern('staff@example.test'), 'staff@example.test');
});

test('the server requires eight characters and caps the length', async () => {
  const { passwordProblem, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = await shared();
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.match(passwordProblem('1234567'), /8/);
  assert.equal(passwordProblem('12345678'), null);
  assert.equal(passwordProblem('كلمةمرور'), null); // 8 محارف غير لاتينية
  assert.equal(passwordProblem('        '), null); // المسافات جزء من كلمة المرور ولا تُشذّب
  assert.match(passwordProblem('x'.repeat(MAX_PASSWORD_LENGTH + 1)), new RegExp(String(MAX_PASSWORD_LENGTH)));
  assert.equal(passwordProblem('x'.repeat(MAX_PASSWORD_LENGTH)), null);
});

async function passwordFixture({ protectedOwner = false, conflictingCaptain = false, role = 'full', failFirstBind = false } = {}) {
  const { adminPasswordHandler } = await shared();
  const email = 'staff@example.test';
  const id = 'auth-user-id';
  const calls = [];
  const target = { email, auth_user_id: null };
  let existing = protectedOwner || conflictingCaptain ? { id, email } : null;
  let bindAttempts = 0;
  const handler = adminPasswordHandler({
    userClient: () => ({ rpc: async () => ({ data: { role } }) }),
    admin: {
      from(table) {
        let field;
        const query = {
          select() { return query; },
          eq(column) { field = column; return query; },
          async maybeSingle() {
            if (table === 'subscription_owners') return { data: protectedOwner ? { user_id: id } : null };
            if (table === 'captains') return { data: conflictingCaptain ? { id: 'other' } : null };
            return { data: field === 'email' || target.auth_user_id ? target : null };
          },
        };
        return query;
      },
      auth: { admin: {
        async listUsers() { return { data: { users: existing ? [existing] : [] } }; },
        async createUser() { calls.push('create'); existing = { id, email }; return { data: { user: existing } }; },
        async updateUserById(userId) { assert.equal(userId, id); calls.push('update'); return {}; },
      } },
      async rpc(name, params) {
        assert.equal(name, 'bind_business_identity');
        assert.deepEqual(params, { p_auth_user: id, p_captain: null, p_email: email });
        calls.push('bind');
        if (++bindAttempts === 1 && failFirstBind) return { error: {} };
        target.auth_user_id = id;
        return {};
      },
    },
  });
  return {
    calls,
    request: () => handler(new Request('https://api.example.test', {
      method: 'POST', headers: { authorization: 'Bearer fixture', origin: 'https://applications.nature-care.net' },
      body: JSON.stringify({ email, password: 'test password' }),
    })),
  };
}

test('only full company administrators can set passwords for identities without an ownership conflict', async () => {
  for (const [options, status] of [[{ role: 'staff' }, 403], [{ protectedOwner: true }, 403], [{ conflictingCaptain: true }, 409]]) {
    const fixture = await passwordFixture(options);
    assert.equal((await fixture.request()).status, status);
    assert.deepEqual(fixture.calls, []);
  }
});

test('password provisioning reports pending binding and a retry uses the existing identity', async () => {
  const fixture = await passwordFixture({ failFirstBind: true });
  const pending = await fixture.request();
  assert.equal(pending.status, 503);
  assert.equal((await pending.json()).code, 'IDENTITY_BIND_PENDING');
  const retried = await fixture.request();
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { ok: true, created: false });
  assert.deepEqual(fixture.calls, ['create', 'bind', 'update', 'bind']);
});
