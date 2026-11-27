const assert = require('node:assert/strict');
const { test } = require('node:test');

const delivery = () => import('../supabase/functions/_shared/web-push-delivery.ts');

test('web push accepts the supported HTTPS providers', async () => {
  const { parseWebPushEndpoint } = await delivery();
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/example',
    'https://android.googleapis.com/gcm/send/example',
    'https://updates.push.services.mozilla.com/wpush/v2/example',
    'https://web.push.apple.com/Q/example',
    'https://region.push.apple.com:443/Q/example',
    'https://region.notify.windows.com/w/?token=example',
  ]) assert.ok(parseWebPushEndpoint(endpoint), endpoint);
});

test('web push rejects unsupported destinations before building a request or calling fetch', async () => {
  const { deliverWebPush } = await delivery();
  function unexpected() { assert.fail('Unsupported endpoints must make no network request'); }
  for (const endpoint of [
    undefined, 'https://example.test/notify', 'http://fcm.googleapis.com/notify',
    'https://fcm.googleapis.com:9443/notify', 'https://fcm.googleapis.com/notify#preview',
  ]) assert.equal(await deliverWebPush(endpoint, unexpected, unexpected), 'unsupported');
});

test('web push sends without redirects and distinguishes expired subscriptions', async () => {
  const { deliverWebPush } = await delivery();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/example';
  const build = target => {
    assert.equal(target, endpoint);
    return { body: new Uint8Array([1, 2]), headers: { 'Content-Type': 'application/octet-stream' } };
  };
  for (const [status, outcome] of [[201, 'sent'], [410, 'expired'], [307, 'failed'], [503, 'failed']]) {
    assert.equal(await deliverWebPush(endpoint, build, async (target, request) => {
      assert.equal(target, endpoint);
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      assert.ok(request.signal instanceof AbortSignal);
      assert.deepEqual(request.body, new Uint8Array([1, 2]));
      return new Response(null, { status });
    }), outcome);
  }
});
