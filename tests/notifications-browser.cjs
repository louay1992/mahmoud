/* Run with Playwright installed: node tests/notifications-browser.cjs. No live backend is contacted. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { chromium } = require('playwright');

(async () => {
  const root = process.cwd();
  const server = http.createServer(async (req, res) => {
    try {
      let pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/captain' || pathname === '/admin') pathname += '.html';
      const filename = path.resolve(root, '.' + pathname);
      if (!filename.startsWith(root + path.sep)) throw new Error('invalid path');
      const data = await fs.readFile(filename);
      res.setHeader('content-type', filename.endsWith('.js') ? 'application/javascript' :
        filename.endsWith('.json') ? 'application/json' : filename.endsWith('.png') ? 'image/png' : 'text/html');
      res.end(data);
    } catch (_) { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let context;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-notifications-'));
  try {
    // Use a regular profile for persistent notifications, rather than an incognito context.
    context = await chromium.launchPersistentContext(profile, { headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox'],
      viewport: { width: 390, height: 844 } });
    await context.grantPermissions(['notifications']);
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/')) return route.continue();
      if (url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2')) {
        return route.fulfill({ contentType: 'application/javascript', body:
          'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};' });
      }
      return route.abort();
    });
    const pages = [];
    for (const role of ['captain', 'admin']) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/' + role);
      await page.evaluate(() => pushClient.registration());
      assert.deepEqual(errors, [], role + ' page must load without script errors');
      assert.equal(await page.evaluate(() => pushClient.registration().then(r => new URL(r.scope).pathname)), '/' + role);

      // Reproduce the screenshot: granted callback, unchanged default permission.
      await page.evaluate(() => {
        window.nativeNotificationPermission = Object.getOwnPropertyDescriptor(Notification, 'permission');
        window.nativeNotificationRequest = Notification.requestPermission;
        Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
        Notification.requestPermission = async () => 'granted';
      });
      await page.evaluate(() => pushDiag());
      await page.locator('#pdg-ask').click();
      await page.waitForFunction(() => document.getElementById('pdg').textContent.includes('بقي default'));
      const mismatch = await page.locator('#pdg').innerText();
      assert.match(mismatch, /requestPermission → granted; Notification.permission → default/);
      assert.equal(await page.evaluate(() => pushClient.enabled), false);
      await page.locator('#pdg-close').click();

      await page.evaluate(async role => {
        Object.defineProperty(Notification, 'permission', window.nativeNotificationPermission);
        Notification.requestPermission = window.nativeNotificationRequest;
        const permission = await Notification.requestPermission();
        if (permission !== 'granted' || Notification.permission !== 'granted') {
          throw new Error('Real browser permission was not granted: ' + permission + '/' + Notification.permission);
        }
        if (role === 'captain') me = { id: 'test-captain' };
        else { ME = 'admin@example.test'; ACC = { role: 'full' }; }
        PushManager.prototype.getSubscription = async () => ({
          endpoint: 'https://push.example/' + role,
          toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'public', auth: 'auth' } }; }
        });
        sb.rpc = async name => name.startsWith('save_') ?
          { error: { message: '<img src=x onerror="window.injected=true">database failed' } } : { error: null };
      }, role);
      await page.evaluate(() => pushDiag());
      await page.locator('#pdg-sub').click();
      await page.waitForFunction(() => document.getElementById('pdg').textContent.includes('database failed'));
      assert.equal(await page.locator('#pdg img').count(), 0, 'diagnostic errors must be escaped');
      assert.equal(await page.evaluate(() => !!window.injected), false);
      assert.equal(await page.evaluate(() => pushClient.enabled), false);
      assert.doesNotMatch(await page.locator('#pdg').innerText(), /OK: اشتراك/);

      await page.evaluate(() => { sb.rpc = async () => ({ error: null }); });
      await page.locator('#pdg-sub').click();
      await page.waitForFunction(() => pushClient.enabled && document.getElementById('pdg').textContent.includes('OK: اشتراك الجهاز'));
      assert.match(await page.locator('#pdg').innerText(), /OK: اشتراك الجهاز وحفظ الخادم نجحا/);
      await page.locator('#pdg-local').click();
      await page.waitForFunction(() => !document.getElementById('pdg-local').disabled);
      const localDiagnostic = await page.locator('#pdg').innerText();
      console.log(role + ' local diagnostic:', localDiagnostic);
      console.log(role + ' browser permission:', await page.evaluate(async () => (await navigator.permissions.query({ name: 'notifications' })).state));
      assert.match(localDiagnostic, /showNotification OK/);
      const notifications = await page.evaluate(async () => (await (await pushClient.registration()).getNotifications()).length);
      assert.ok(notifications >= 1, 'the real browser service worker must display the local notification');
      assert.deepEqual(errors, [], role + ' diagnostics must not raise page errors');
      pages.push(page);
      console.log(role + ': real scoped worker, permission mismatch, escaped save failure, successful save and local notification verified');
    }
    const scopes = await pages[0].evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(r => new URL(r.scope).pathname).sort());
    assert.deepEqual(scopes, ['/admin', '/captain']);
  } finally {
    if (context) await context.close();
    await fs.rm(profile, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
