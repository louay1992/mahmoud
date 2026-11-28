const assert = require('node:assert/strict');
const { test } = require('node:test');

test('owner host serves the dashboard at its root and legacy owner bookmarks redirect', async () => {
  const { default: route } = await import('../netlify/edge-functions/owner-domain.js');
  const request = url => route(new Request(url));
  assert.equal(request('https://owner.nature-care.net/?code=example').href, 'https://owner.nature-care.net/owner.html?code=example');
  assert.equal(route(new Request('https://owner.nature-care.net/', { method: 'HEAD' })).pathname, '/owner.html');
  assert.equal(route(new Request('https://owner.nature-care.net/', { method: 'POST' })), undefined);
  for (const oldHost of ['hhyyw.netlify.app', 'applications.nature-care.net']) {
    for (const path of ['/owner', '/owner/', '/owner.html']) {
      const response = request(`https://${oldHost}${path}?code=example`);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://owner.nature-care.net/?code=example');
    }
    assert.equal(request(`https://${oldHost}/`), undefined);
    assert.equal(request(`https://${oldHost}/account-setup.html`), undefined);
  }
  assert.equal(request('https://owner.nature-care.net/owner.html'), undefined);
  for (const path of ['/admin', '/captain/', '/account-setup.html']) {
    const response = request(`https://owner.nature-care.net${path}?code=example`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `https://applications.nature-care.net${path.replace(/\/$/, '')}?code=example`);
  }
  assert.equal(request('https://hhyyw.netlify.app/captain'), undefined);
  for (const path of ['/naturecare', '/naturecare/']) {
    const response = request(`https://owner.nature-care.net${path}?code=example`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://naturecare-operations.netlify.app/owner#');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(request(`https://applications.nature-care.net${path}`), undefined);
  }
});

test('owner account functions allow the new origin without granting anonymous access', async () => {
  const { createOwnerInviteHandler } = await import('../supabase/functions/_shared/owner-invite-admin.ts');
  const { createOwnerAccountHandler } = await import('../supabase/functions/_shared/owner-manage-admin.ts');
  const allowedOrigin = 'https://hhyyw.netlify.app';
  const invite = createOwnerInviteHandler({ allowedOrigin });
  const manage = createOwnerAccountHandler({ allowedOrigin, invite });
  for (const handler of [invite, manage]) {
    const origin = 'https://owner.nature-care.net';
    const options = await handler(new Request(origin, { method: 'OPTIONS', headers: { origin } }));
    assert.equal(options.headers.get('access-control-allow-origin'), origin);
    assert.equal((await handler(new Request(origin, { method: 'POST', headers: { origin } }))).status, 401);
    assert.equal((await handler(new Request(origin, { method: 'OPTIONS', headers: { origin: 'https://other.example' } }))).status, 403);
  }
});
