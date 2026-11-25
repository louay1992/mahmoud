const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
test('a missing, malformed, or different Firebase project configuration cannot break existing Web Push',async()=>{
  const {parseFcmAccount}=await import('../supabase/functions/_shared/fcm.ts');
  assert.equal(parseFcmAccount(undefined),null); assert.equal(parseFcmAccount('{invalid'),null);
  assert.equal(parseFcmAccount(JSON.stringify({project_id:'wrong-project',client_email:'test@test',private_key:'BEGIN PRIVATE KEY'}),'expected-project'),null);
  assert.ok(parseFcmAccount(JSON.stringify({project_id:'expected-project',client_email:'test@test',private_key:'BEGIN PRIVATE KEY'}),'expected-project'));
});

test('FCM uses an OAuth service-account signature and account-bound data-only messages', async () => {
  const { createFcmSender } = await import('../supabase/functions/_shared/fcm.ts');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const sender = createFcmSender({ project_id: 'test-project', client_email: 'sender@example.test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.includes('oauth2') ? { access_token: 'oauth-token', expires_in: 3600 } : { name: 'messages/test' });
  });
  const device = { fcm_token: 'device-token', binding_id: 'account-generation', app_scope: 'captain' };
  const result = await sender(device, { title: 'order', body: 'new order', url: 'https://evil.test/', order_id: '00000000-0000-0000-0000-000000000001' });
  assert.equal(result.ok, true);
  const jwt = calls[0].options.body.get('assertion'), [head, body, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(body, 'base64url')).iss, 'sender@example.test');
  assert.ok(require('node:crypto').verify('RSA-SHA256', Buffer.from(head + '.' + body), publicKey, Buffer.from(signature, 'base64url')));
  const message = JSON.parse(calls[1].options.body).message;
  assert.equal(message.notification, undefined); assert.equal(message.data.binding_id, 'account-generation');
  assert.equal(message.android.restricted_package_name, 'app.hhyyw.captain'); assert.equal(message.android.priority, 'HIGH');
  assert.match(message.data.url, /^\/captain.html\?order=/);
  await sender(device, { title: 'second', body: '' }); assert.equal(calls.length, 3, 'OAuth token should be cached');
});
test('only a confirmed UNREGISTERED token is eligible for deletion', async () => {
  const { createFcmSender } = await import('../supabase/functions/_shared/fcm.ts');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let code = 'INVALID_ARGUMENT';
  const sender = createFcmSender({ project_id: 'test', client_email: 'test@test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, async url =>
    url.includes('oauth2') ? Response.json({ access_token: 'token' }) : Response.json({ error: { details: [{ errorCode: code }] } }, { status: 400 }));
  const device = { fcm_token: 'token', binding_id: 'binding', app_scope: 'admin' };
  assert.equal((await sender(device, { title: '', body: '' })).unregistered, false);
  code = 'UNREGISTERED'; assert.equal((await sender(device, { title: '', body: '' })).unregistered, true);
});
