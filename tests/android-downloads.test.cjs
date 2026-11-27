const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

test('download aliases advance with the release feed while pinned APKs retain their version and hash', async t => {
  const { default: handle } = await import('../netlify/edge-functions/android-downloads.js');
  const { origin } = await import('../scripts/android-downloads.mjs');
  const releases = new Map();
  let latest;
  function publish(versionName, versionCode) {
    const apps = Object.fromEntries(['admin', 'captain'].map(role => {
      const bytes = Buffer.from(`${role} APK ${versionName}`);
      const label = role === 'admin' ? 'Admin' : 'Captain';
      const url = `https://github.com/louay1992/mahmoud/releases/download/android-v${versionName}/Delivery-${label}-${versionName}.apk`;
      releases.set(url, bytes);
      return [role, {
        packageName: `app.hhyyw.${role}`, versionName, versionCode, minSdk: 23, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), url, notes: 'Test release',
      }];
    }));
    latest = { schema: 1, sourceCommit: 'a'.repeat(40), apps };
  }
  const redirects = new Map();
  t.mock.method(globalThis, 'fetch', async url => {
    const address = String(url);
    if (address.startsWith('https://raw.githubusercontent.com/')) return Response.json(latest);
    if (releases.has(address)) {
      const target = `https://release-assets.githubusercontent.com/${encodeURIComponent(address)}`;
      redirects.set(target, releases.get(address));
      return new Response(null, { status: 302, headers: { Location: target } });
    }
    const bytes = redirects.get(address);
    return bytes ? new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }) : new Response(null, { status: 404 });
  });
  const get = path => handle(new Request(new URL(path, origin)));
  publish('1.4.1', 8);
  const prior = await (await get('/downloads/latest.json')).json();
  assert.equal(await (await get('/downloads/delivery-admin.apk')).text(), 'admin APK 1.4.1');

  publish('1.4.2', 9);
  const current = await (await get('/downloads/latest.json')).json();
  for (const role of ['admin', 'captain']) {
    assert.equal(new URL(current.apps[role].url).origin, origin);
    assert.equal(await (await get(`/downloads/delivery-${role}.apk`)).text(), `${role} APK 1.4.2`);
    assert.equal(await (await get(current.apps[role].url)).text(), `${role} APK 1.4.2`);
    assert.equal(await (await get(prior.apps[role].url)).text(), `${role} APK 1.4.1`);
  }
  const differentRole = current.apps.admin.url.replace('delivery-admin.apk', 'delivery-captain.apk');
  assert.equal(await get(differentRole), undefined, 'must not return bytes whose digest fails');
  latest.apps.captain.versionCode--;
  assert.equal(await get('/downloads/latest.json'), undefined, 'an incomplete pair must use the verified snapshot');
});
