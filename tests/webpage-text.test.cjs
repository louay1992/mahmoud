const { test } = require('node:test');
const assert = require('node:assert/strict');

const shared = () => import('../supabase/functions/_shared/webpage-text.ts');

test('only public http(s) URLs are accepted; internal targets are refused', async () => {
  const { parsePublicHttpUrl } = await shared();
  for (const url of ['https://apyhub.com/pricing', 'http://example.com/a?b=1']) assert.ok(parsePublicHttpUrl(url), url);
  for (const url of [undefined, '', 'ftp://example.com', 'javascript:alert(1)', 'https://user:pass@example.com',
    'http://localhost:3000', 'http://intranet', 'http://printer.local', 'http://127.0.0.1', 'http://10.1.2.3',
    'http://172.20.0.1', 'http://192.168.1.1', 'http://169.254.169.254/latest/meta-data', 'http://0.0.0.0',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:7f00:1]/',
    'http://localhost./', 'http://intranet./', 'http://2130706433/', 'https://x'.repeat(1100)]) {
    assert.equal(parsePublicHttpUrl(url), null, String(url));
  }
});

test('ApyHub is called with the documented endpoint, apy-token header and url field', async () => {
  const { extractVisibleText, APYHUB_TEXT_ENDPOINT } = await shared();
  const calls = [];
  const result = await extractVisibleText(new URL('https://example.com/news'), {
    token: 'test-token',
    fetch: async (input, init) => { calls.push({ input, init }); return Response.json({ data: 'Home\r\nAbout\u0000  \n\n Contact ' }); }
  });
  assert.equal(result.ok, true);
  const called = new URL(calls[0].input);
  assert.equal(called.origin + called.pathname, APYHUB_TEXT_ENDPOINT);
  assert.equal(called.searchParams.get('url'), 'https://example.com/news');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.headers['apy-token'], 'test-token');
  assert.equal(result.value.text, 'Home\nAbout\n\n Contact');
  assert.equal(result.value.truncated, false);
});

test('a missing token never reaches ApyHub and long pages are truncated', async () => {
  const { extractVisibleText } = await shared();
  let called = false;
  const missing = await extractVisibleText(new URL('https://example.com'), {
    token: '  ', fetch: async () => { called = true; return Response.json({ data: 'x' }); }
  });
  assert.equal(called, false);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 503);
  const long = await extractVisibleText(new URL('https://example.com'), {
    token: 't', maxCharacters: 5, fetch: async () => Response.json({ data: '0123456789' })
  });
  assert.equal(long.value.text, '01234');
  assert.equal(long.value.characters, 5);
  assert.equal(long.value.truncated, true);
});

test('ApyHub failures map to clear statuses and never leak the token', async () => {
  const { extractVisibleText } = await shared();
  const run = status => extractVisibleText(new URL('https://example.com'), {
    token: 'secret-token', fetch: async () => new Response('{"error":"unauthorized"}', { status })
  });
  assert.deepEqual([(await run(400)).status, (await run(401)).status, (await run(429)).status, (await run(503)).status], [400, 503, 429, 502]);
  const bad = await extractVisibleText(new URL('https://example.com'), { token: 'secret-token', fetch: async () => Response.json({ data: 5 }) });
  assert.equal(bad.ok, false);
  assert.doesNotMatch(JSON.stringify(await run(401)), /secret-token/);
});

test('the handler requires an admin session and a public url, then returns plain text', async () => {
  const { webpageTextHandler } = await shared();
  const handler = webpageTextHandler({
    token: 't', authenticate: async jwt => jwt === 'admin-jwt',
    fetch: async () => Response.json({ data: '<img src=x onerror=alert(1)> مرحبا\nCookies' })
  });
  assert.equal((await handler(new Request('https://x.test/?url=https://example.com', { method: 'POST' }))).status, 405);
  assert.equal((await handler(new Request('https://x.test/?url=https://example.com'))).status, 401);
  assert.equal((await handler(new Request('https://x.test/?url=https://example.com', { headers: { authorization: 'Bearer nope' } }))).status, 403);
  assert.equal((await handler(new Request('https://x.test/?url=http://192.168.0.1', { headers: { authorization: 'Bearer admin-jwt' } }))).status, 400);
  const ok = await handler(new Request('https://x.test/?url=https://example.com', { headers: { authorization: 'Bearer admin-jwt' } }));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.url, 'https://example.com/');
  assert.match(body.text, /^<img src=x onerror=alert\(1\)> مرحبا\nCookies$/);
  assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  const blocked = await handler(new Request('https://x.test/?url=https://example.com', { headers: { origin: 'https://evil.test', authorization: 'Bearer admin-jwt' } }));
  assert.equal(blocked.status, 403);
  const origin = 'https://applications.nature-care.net';
  const preflight = await handler(new Request('https://x.test/', { method: 'OPTIONS', headers: { origin } }));
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal((await handler(new Request('https://x.test/?url=https://example.com', { headers: { origin } }))).status, 401);
});
