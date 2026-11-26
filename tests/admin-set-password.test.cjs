const { test } = require('node:test');
const assert = require('node:assert/strict');

const shared = () => import('../supabase/functions/_shared/admin-set-password.ts');

test('CORS answers the app origin only and never a wildcard', async () => {
  const { corsHeaders, normalizeOrigin, originRejected, DEFAULT_APP_ORIGIN } = await shared();
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
  for (const foreign of ['https://evil.test', 'http://hhyyw.netlify.app', 'null', 'https://hhyyw.netlify.app.evil.test',
    'https://hhyyw.netlify.app:8443', 'https://hhyyw.netlify.app/']) {
    assert.equal(originRejected(foreign, origin), true, foreign);
  }
  assert.equal(originRejected(origin, origin), false);
  // بلا Origin (curl أو خادم) يبقى الحارس هو تحقق الجلسة، لا CORS.
  assert.equal(originRejected(null, origin), false);
  assert.equal(originRejected(undefined, origin), false);
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
