const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('push-client.js', 'utf8');

function fixture(options = {}) {
  const calls = { register: [], subscribe: 0, save: [], remove: [], notices: [] };
  const role = options.role || 'captain';
  const sub = { endpoint: 'https://push.example/' + role,
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'public', auth: 'auth' } }; },
    unsubscribe: async () => { calls.unsubscribed = true; } };
  let existing = options.existing ? sub : null;
  const reg = { scope: 'https://app.example/' + role, active: {}, pushManager: {
    getSubscription: async () => existing,
    subscribe: async () => { calls.subscribe++; if (options.subscribeError) throw options.subscribeError; return existing = sub; }
  } };
  const context = vm.createContext({ URL, Uint8Array, AbortController, atob, console: { warn() {} },
    setTimeout: (fn, ms) => ms === 100 ? setTimeout(fn, 0) : setTimeout(fn, ms), clearTimeout,
    location: { origin: 'https://app.example' }, PushManager: function () {},
    Notification: { permission: options.permission || 'granted', requestPermission: async () => 'granted' },
    navigator: { userAgent: 'Test browser', serviceWorker: {
      register: async (url, config) => { calls.register.push({ url, ...config }); return reg; },
      getRegistration: async () => options.legacy || null,
      get ready() { throw new Error('Must not use the legacy controller registration'); }
    } },
    fetch: async () => { calls.fetched = true; return { ok: options.httpError ? false : true,
      status: options.httpError || 200, json: async () => ({ key: options.badKey ? null : 'BAECAw' }) }; }
  });
  vm.runInContext(source, context);
  const client = new context.DeliveryPush({ scope: '/' + role, keyUrl: 'https://api.example/key', apiKey: 'public-key',
    save: async args => { calls.save.push(args); return options.saveError ? { error: { message: options.saveError } } : { error: null }; },
    remove: async args => { calls.remove.push(args); return { error: null }; }
  });
  return { context, calls, client, reg, sub };
}

test('a granted request with an unchanged default permission is a failure', async () => {
  const { client, calls } = fixture({ permission: 'default' });
  await assert.rejects(client.requestPermission(), /بقي default/);
  assert.equal(client.requestResult, 'granted');
  assert.equal(client.permission, 'default');
  assert.equal(client.enabled, false);
  assert.equal(calls.subscribe, 0);
});

test('permission propagation may complete after the native request returns', async () => {
  const { client, context } = fixture({ permission: 'default' });
  context.Notification.requestPermission = async () => {
    setTimeout(() => { context.Notification.permission = 'granted'; }, 2);
    return 'granted';
  };
  assert.equal(await client.requestPermission(), 'granted');
  assert.equal(client.permission, 'granted');
});

test('denied permission does not create or save a subscription', async () => {
  const { client, calls } = fixture({ permission: 'denied' });
  await assert.rejects(client.subscribe(), /denied/);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.save.length, 0);
});

for (const role of ['captain', 'admin']) {
  test(role + ': register the matching scope and wait for server save', async () => {
    const { client, calls } = fixture({ role });
    await client.subscribe();
    assert.equal(calls.register[0].scope, '/' + role);
    assert.equal(calls.register[0].updateViaCache, 'none');
    assert.equal(calls.save[0].p_endpoint, 'https://push.example/' + role);
    assert.equal(client.enabled, true);
  });

  test(role + ': a browser subscription alone does not prove server save', async () => {
    const { client, calls } = fixture({ role, existing: true, saveError: 'database unavailable' });
    await assert.rejects(client.subscribe(), /database unavailable/);
    const state = await client.inspect();
    assert.equal(state.subscription, true);
    assert.equal(state.saved, false);
    assert.equal(client.enabled, false);
    assert.equal(calls.fetched, undefined);
  });

  test(role + ': page handlers report activation errors without a success toast', async () => {
    const f = fixture({ role, existing: true, saveError: '<database failed>' });
    const html = fs.readFileSync(role + '.html', 'utf8');
    const start = html.indexOf('const pushClient=new DeliveryPush(');
    const end = html.indexOf('\n', html.indexOf('async function dropPush()', start));
    Object.assign(f.context, {
      SUPABASE_URL: 'https://api.example', SUPABASE_KEY: 'public',
      me: { id: 'captain' }, ME: 'admin@example.com', ACC: { role: 'full' },
      sb: { rpc: async (name, args) => name.startsWith('save_') ?
        { error: { message: '<database failed>' } } : { error: null } },
      $: () => ({ classList: { toggle() {} } }), ic: () => '', nBadge: () => '',
      beep() {}, render() {}, toast: (text, kind) => f.calls.notices.push({ text, kind })
    });
    vm.runInContext(html.slice(start, end), f.context);
    vm.runInContext('pushDiag=async message=>{globalThis.diagnostic=message}', f.context);
    await vm.runInContext('bellClick()', f.context);
    assert.equal(f.calls.notices.some(n => n.kind === 'ok'), false);
    assert.match(f.context.diagnostic, /database failed/);
    assert.equal(await vm.runInContext('ensurePush()', f.context), false);
    await assert.rejects(vm.runInContext('ensurePush({strict:true})', f.context), /database failed/);
  });

  test(role + ': non-strict boot activation saves an existing subscription with granted permission', async () => {
    const f = fixture({ role, existing: true });
    const saved = [];
    const html = fs.readFileSync(role + '.html', 'utf8');
    const start = html.indexOf('const pushClient=new DeliveryPush(');
    const end = html.indexOf('\n', html.indexOf('async function dropPush()', start));
    Object.assign(f.context, {
      SUPABASE_URL: 'https://api.example', SUPABASE_KEY: 'public',
      me: { id: 'captain' }, ME: 'admin@example.com', ACC: { role: 'full' },
      sb: { rpc: async (name, args) => { saved.push({ name, args }); return { error: null }; } },
      $: id => id === 'bell' ? { classList: { toggle() {} } } : null,
      ic: () => '', nBadge: () => ''
    });
    vm.runInContext(html.slice(start, end), f.context);
    assert.equal(vm.runInContext('pushClient.saved', f.context), false);
    assert.equal(await vm.runInContext('ensurePush()', f.context), true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, role === 'captain' ? 'save_push_subscription' : 'save_admin_push_subscription');
    assert.equal(saved[0].args.p_endpoint, 'https://push.example/' + role);
    assert.equal(f.calls.subscribe, 0);
    assert.equal(f.calls.fetched, undefined);
    assert.equal(vm.runInContext('pushClient.enabled', f.context), true);
  });
}

test('simultaneous activation calls create one subscription', async () => {
  const { client, calls } = fixture();
  await Promise.all([client.subscribe(), client.subscribe(), client.subscribe()]);
  assert.equal(calls.subscribe, 1);
  assert.equal(calls.save.length, 1);
});

test('HTTP and key failures never reach the subscription or save step', async () => {
  for (const options of [{ httpError: 503 }, { badKey: true }]) {
    const { client, calls } = fixture(options);
    await assert.rejects(client.subscribe(), /503|غير صالح/);
    assert.equal(calls.subscribe, 0);
    assert.equal(calls.save.length, 0);
    assert.equal(client.enabled, false);
  }
});

test('a browser subscribe failure is preserved for diagnostics', async () => {
  const { client } = fixture({ subscribeError: new Error('push service unavailable') });
  await assert.rejects(client.subscribe(), /push service unavailable/);
  assert.match((await client.inspect()).error, /push service unavailable/);
});

test('a registration with the wrong scope is rejected', async () => {
  const { client, reg } = fixture();
  reg.scope = 'https://app.example/';
  await assert.rejects(client.subscribe(), /نطاق خدمة/);
});

test('a newly installed worker must activate before subscribing', async () => {
  const { client, reg, calls } = fixture();
  reg.active = null;
  reg.installing = new EventTarget();
  reg.installing.state = 'installing';
  const pending = client.subscribe();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.subscribe, 0);
  reg.active = {};
  reg.installing.state = 'activated';
  reg.installing.dispatchEvent(new Event('statechange'));
  await pending;
  assert.equal(calls.subscribe, 1);
});

test('migration removes only the account-owned database record, keeping the shared worker and subscription', async () => {
  let unsubscribed = false, unregistered = false;
  const legacy = { scope: 'https://app.example/',
    unregister: async () => { unregistered = true; },
    pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/legacy',
      unsubscribe: async () => { unsubscribed = true; } }) } };
  const { client, calls } = fixture({ legacy });
  await client.subscribe();
  assert.equal(calls.remove[0].p_endpoint, 'https://push.example/legacy');
  assert.equal(unsubscribed, false);
  assert.equal(unregistered, false);
  assert.equal(client.enabled, true);
});

test('logout removes the scoped subscription', async () => {
  const { client, calls } = fixture({ existing: true });
  await client.subscribe();
  await client.unsubscribe();
  assert.equal(calls.remove[0].p_endpoint, 'https://push.example/captain');
  assert.equal(calls.unsubscribed, true);
  assert.equal(client.enabled, false);
});

test('both pages parse with the shared client loaded before their inline code', () => {
  for (const role of ['captain', 'admin']) {
    const html = fs.readFileSync(role + '.html', 'utf8');
    assert.ok(html.indexOf('src="/push-client.js"') < html.indexOf('const pushClient='));
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (!match[1].includes('src=')) new vm.Script(match[2], { filename: role + '.html' });
    }
  }
});
