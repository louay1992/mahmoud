const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker(role, windows = []) {
  const events = {}, shown = [], opened = [], deleted = [];
  const context = vm.createContext({ URL, location: { origin: 'https://app.example' },
    self: { registration: { scope: 'https://app.example/' + role,
      showNotification: async (title, options) => shown.push({ title, ...options }) },
      addEventListener: (name, handler) => { events[name] = handler; },
      skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => windows,
        openWindow: async url => opened.push(url) } },
    caches: { keys: async () => ['shell-admin-v4', 'shell-captain-v4', 'shell-v4'],
      delete: async key => deleted.push(key) }
  });
  vm.runInContext(fs.readFileSync('sw.js', 'utf8'), context);
  async function emit(name, data) {
    let pending;
    events[name]({ ...data, waitUntil: promise => { pending = promise; } });
    await pending;
  }
  return { emit, shown, opened, deleted };
}

for (const role of ['admin', 'captain']) {
  test(role + ': incoming push has the correct app fallback', async () => {
    const w = worker(role);
    await w.emit('push', { data: { json: () => ({ body: 'test' }) } });
    assert.equal(w.shown[0].data.url, '/' + role + '.html');
    assert.equal(w.shown[0].renotify, false);
    assert.equal(w.shown[0].icon, '/icons/' + role + '-192.png');
  });

  test(role + ': activation keeps the other application cache', async () => {
    const w = worker(role);
    await w.emit('activate', {});
    assert.deepEqual(w.deleted, ['shell-' + role + '-v4']);
  });
}

test('clicking a captain notification focuses the captain window even if admin is first', async () => {
  let focused;
  const w = worker('captain', [
    { url: 'https://app.example/admin.html', focus: () => { focused = 'admin'; } },
    { url: 'https://app.example/captain.html', focus: () => { focused = 'captain'; } }
  ]);
  await w.emit('notificationclick', { notification: { close() {}, data: { url: '/captain.html' } } });
  assert.equal(focused, 'captain');
  assert.equal(w.opened.length, 0);
});

test('clicking an admin notification opens admin if only captain is open', async () => {
  const w = worker('admin', [{ url: 'https://app.example/captain.html', focus() { throw new Error('wrong app'); } }]);
  await w.emit('notificationclick', { notification: { close() {}, data: { url: '/admin.html' } } });
  assert.deepEqual(w.opened, ['https://app.example/admin.html']);
});

test('an external notification URL cannot navigate away from the app', async () => {
  const w = worker('admin');
  await w.emit('notificationclick', { notification: { close() {}, data: { url: 'https://external.example' } } });
  assert.deepEqual(w.opened, ['https://app.example/admin.html']);
});
