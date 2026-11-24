const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(scope = 'captain', search = '?native=1') {
  const listeners = {}, calls = [];
  const context = vm.createContext({ URLSearchParams, setTimeout, clearTimeout, Map, Event,
    location: { origin: 'https://hhyyw.netlify.app', search }, document: { referrer: '' }, navigator: { userAgent: 'test' },
    addEventListener: (name, fn) => listeners[name] = fn, dispatchEvent() {} });
  vm.runInContext(fs.readFileSync('native-push.js', 'utf8'), context);
  const client = new context.NativeDeliveryPush({ role: scope, session: async () => ({ data: { session: { access_token: 'jwt-current', user: { id: 'current-user' } } } }) });
  const port = { start() {}, close() {}, postMessage(raw) {
    const data = JSON.parse(raw); calls.push(data);
    const reply = { ...data, ok: true, saved: data.type !== 'unbind', account_id: 'current-user', permission: 'granted' };
    queueMicrotask(() => port.onmessage({ data: JSON.stringify(reply) }));
  } };
  const connect = (origin = context.location.origin, role = scope) => listeners.message({ origin, ports: [port],
    data: JSON.stringify({ type: 'delivery.native.ready', version: 1, role, permission: 'granted', configured: true, saved: false }) });
  return { client, calls, connect, port };
}
test('native channel rejects other origins and the other application role', () => {
  const f = fixture(); f.connect('https://evil.example'); assert.equal(f.client.port, undefined);
  f.connect(undefined, 'admin'); assert.equal(f.client.port, undefined);
  f.connect(); assert.equal(f.client.port, f.port);
});
test('a browser visit keeps Web Push mode until a verified native channel exists', () => {
  const f = fixture('admin', ''); assert.equal(f.client.expected, false);
});
test('device binding uses the current session and logout waits for native acknowledgement', async () => {
  const f = fixture(); f.connect(); await f.client.bind();
  assert.equal(f.calls[0].access_token, 'jwt-current'); assert.equal(f.client.enabled, true);
  await f.client.unbind(); assert.equal(f.client.enabled, false);
  assert.equal(f.calls[1].type, 'unbind'); assert.equal(f.calls[1].access_token, undefined);
});
test('a binding response for a different account never enables notifications', async () => {
  const f = fixture(); f.connect();
  f.port.postMessage = raw => { const { id } = JSON.parse(raw); queueMicrotask(() => f.port.onmessage({ data: { id, saved: true, account_id: 'wrong-user', permission: 'granted' } })); };
  await assert.rejects(f.client.bind(), /ربط الجهاز/); assert.equal(f.client.enabled, false);
});
test('native errors are preserved rather than reported as successful activation', async () => {
  const f = fixture(); f.connect();
  f.port.postMessage = raw => { const { id } = JSON.parse(raw); queueMicrotask(() => f.port.onmessage({ data: { id, ok: false, saved: false, error: 'FCM unavailable' } })); };
  await assert.rejects(f.client.bind(), /FCM unavailable/); assert.equal(f.client.enabled, false);
});

test('FCM endpoint derives ownership and hashes the installation secret', async () => {
  const { nativeDeviceHandler } = await import('../supabase/functions/_shared/native-device.ts');
  let params;
  const handler = nativeDeviceHandler({ authenticate: async () => ({ userId: 'verified', captainId: 'captain-real', email: null }),
    action: async p => { params = p; return { data: { saved: true, binding_id: 'binding', account_id: 'verified', fcm_token: 'private-token' } }; }, send: async () => ({ ok: true }) });
  const result = await handler(new Request('https://api.example', { method: 'POST', headers: { authorization: 'Bearer valid' }, body: JSON.stringify({
    installation_id: '00000000-0000-0000-0000-000000000001', secret: 'a'.repeat(64), app_scope: 'captain', action: 'bind',
    fcm_token: 'token'.repeat(12), user_id: 'attacker-selected', captain_id: 'attacker-selected' }) }));
  assert.equal(result.status, 200); assert.equal(params.p_user, 'verified'); assert.equal(params.p_captain, 'captain-real');
  assert.match(params.p_secret_hash, /^[0-9a-f]{64}$/); assert.notEqual(params.p_secret_hash, 'a'.repeat(64));
  const body = await result.json(); assert.equal(body.fcm_token, undefined); assert.equal(body.secret_hash, undefined);
});
test('FCM endpoint rejects account binding without authorization and cross-origin requests', async () => {
  const { nativeDeviceHandler } = await import('../supabase/functions/_shared/native-device.ts');
  let actions = 0;
  const handler = nativeDeviceHandler({ authenticate: async () => null, action: async () => { actions++; }, send() {} });
  const data = { installation_id: '00000000-0000-0000-0000-000000000001', secret: 'a'.repeat(64), app_scope: 'admin', action: 'bind', fcm_token: 't'.repeat(30) };
  const unauthorized = await handler(new Request('https://api.example', { method: 'POST', body: JSON.stringify(data) }));
  assert.equal(unauthorized.status, 403); assert.equal(actions, 0);
  const crossOrigin = await handler(new Request('https://api.example', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify(data) }));
  assert.equal(crossOrigin.status, 403); assert.equal(actions, 0);
});
test('FCM activation is refused while the server service account is missing', async()=>{
  const {nativeDeviceHandler}=await import('../supabase/functions/_shared/native-device.ts');
  let bound=false;
  const handler=nativeDeviceHandler({configured:false,authenticate:async()=>({userId:'user'}),action:async()=>{bound=true},send(){}});
  const response=await handler(new Request('https://api.example',{method:'POST',body:JSON.stringify({installation_id:'00000000-0000-0000-0000-000000000001',secret:'a'.repeat(64),app_scope:'captain',action:'bind',fcm_token:'t'.repeat(30)})}));
  assert.equal(response.status,503);assert.equal(bound,false);
});
