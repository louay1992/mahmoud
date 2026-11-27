const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const {serve, route, populate} = require('./workspace-fixture.cjs');

(async () => {
  const {server, origin} = await serve();
  let browser;
  try {
    await fs.mkdir('test-results', {recursive:true});
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    });
    const context = await browser.newContext({viewport:{width:390,height:844}, serviceWorkers:'block'});
    await route(context, origin);
    for (const role of ['admin','captain']) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/' + role + '.html');
      await page.locator('#splash').waitFor({state:'hidden'});
      if (role === 'admin') {
        await populate(page, 'new');
        await page.locator('#on').fill('مسودة اختبار الإشعارات');
      }
      // Open through the real bell in both apps. The modal should expand from its position.
      await page.evaluate(role => {
        if (role === 'captain') me = {id:'captain', email:'captain@example.test'};
        const now = new Date();
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
        D.notifs = [
          {id: 'shipment-46', kind: 'status', level: 'danger', title: '📦 شحنة #46 — ملغاة', body: 'الشركة: مسارات\nالزبون: زبون شحن\nالمحافظة: إدلب\nالمنتجات: منتج تجريبي ×1\nالمطلوب من الزبون: 300,200 ل.س\nملاحظة: إلغاء', order_id: 'order-46', read_by: [], created_at: now.toISOString()},
          {id: 'order-44', kind: 'status', level: 'success', title: '✅ تم تسليم الطلب #44', body: 'الكابتن: كابتن تجريبي\nالزبون: طلب جديد\nالمبلغ المستحق للإدارة: 300,000 ل.س\nأجرة التوصيل: 20 ل.س\nالمطلوب من الزبون: 300,020 ل.س', order_id: 'order-44', read_by: [], created_at: now.toISOString()},
          {id: 'note-43', kind: 'admin_note', title: 'ملاحظة من الإدارة', body: 'يرجى الاتصال قبل التسليم\n<img src=x>', read_by: [NME()], created_at: yesterday.toISOString()}
        ];
        window.readAttempts = [];
        sb.rpc = async (name, args) => {
          if (name !== 'mark_notifications_read') throw new Error('Unexpected notification RPC');
          readAttempts.push(args.p_ids);
          return {error: window.rejectRead ? {message: 'offline'} : null};
        };
        $('app').style.display = 'block';
        $('login').style.display = 'none';
        $('hn').textContent = role === 'admin' ? 'الصحة والجمال' : 'كابتن تجريبي';
        if (role === 'captain') $('main').innerHTML = '<div class="card"><h2>الطلبات</h2><input id="notification-draft" value="مسودة"></div>';
        initNotifUI();
      }, role);
      const bell = page.locator('#bell'), panel = page.getByRole('dialog', {name:'الإشعارات'});
      await bell.focus();
      const anchor = await page.evaluate(() => {
        $('bell').click();
        const motion = notificationCenter.motion;
        motion.pause();
        motion.currentTime = 0;
        const dialog = notificationCenter.dialog.getBoundingClientRect();
        const button = $('bell').getBoundingClientRect();
        const distance = Math.hypot(dialog.x + dialog.width / 2 - button.x - button.width / 2,
          dialog.y + dialog.height / 2 - button.y - button.height / 2);
        motion.finish();
        return distance;
      });
      assert.ok(anchor < 2, 'opening motion starts at the bell');
      await panel.waitFor();
      assert.equal(await bell.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#bell .nbd').innerText(), '2');
      assert.deepEqual(await page.evaluate(() => readAttempts), [], 'opening preserves unread state');
      assert.equal(await panel.locator('.dn-card').count(), 3);
      assert.match(await panel.locator('.dn-amount').first().innerText(), /300,200/);
      assert.equal(await panel.locator('img').count(), 0);
      await page.screenshot({path: path.join('test-results', role + '-notifications.png')});

      for (const width of [320, 430, 1100]) {
        await page.setViewportSize({width, height: 700});
        const bounds = await panel.boundingBox();
        assert.ok(bounds.x >= 11 && bounds.x + bounds.width <= width - 11 && bounds.y + bounds.height <= 689);
      }
      await page.setViewportSize({width:390,height:844});
      await panel.getByRole('button', {name:'الملاحظات'}).click();
      assert.equal(await panel.locator('.dn-card').count(), 1);
      assert.match(await panel.innerText(), /أمس/);
      await panel.getByRole('button', {name:'غير مقروء', exact:true}).click();
      assert.equal(await panel.locator('.dn-card').count(), 2);
      const firstDetails = panel.getByRole('button', {name:'التفاصيل', exact:true}).first();
      await page.evaluate(() => window.rejectRead = true);
      await firstDetails.click();
      await panel.getByText('تعذّر تعليم الإشعارات كمقروءة. حاول مجددًا.').waitFor();
      assert.equal(await page.locator('#bell .nbd').innerText(), '2');
      assert.match(await panel.locator('.dn-details:visible').innerText(), /المحافظة: إدلب/);

      await page.evaluate(() => window.rejectRead = false);
      await panel.getByRole('button', {name:'تعليم الكل كمقروء'}).click();
      await page.waitForFunction(() => !document.querySelector('#bell .nbd'));
      assert.deepEqual(await page.evaluate(() => readAttempts), [['shipment-46'], ['shipment-46', 'order-44']]);
      assert.equal(await panel.locator('.dn-card').count(), 0);
      await page.keyboard.press('Escape');
      await panel.waitFor({state:'hidden'});
      assert.equal(await bell.evaluate(element => element === document.activeElement), true);
      assert.equal(await page.locator(role === 'admin' ? '#on' : '#notification-draft').inputValue(),
        role === 'admin' ? 'مسودة اختبار الإشعارات' : 'مسودة');
      await bell.click();
      await page.waitForFunction(() => !notificationCenter.dialog.getAnimations().length);
      await page.mouse.click(2, 2);
      await panel.waitFor({state:'hidden'});

      // The native back callback and the order link both close the popover.
      await page.emulateMedia({reducedMotion:'reduce'});
      await bell.click();
      assert.equal(await page.evaluate(() => notificationCenter.dialog.getAnimations().length), 0);
      assert.equal(await page.evaluate(() => handleNativeBack()), true);
      await panel.waitFor({state:'hidden'});
      await page.evaluate(async () => {
        window.openedNotificationOrder = '';
        notificationCenter.options.openOrder = id => window.openedNotificationOrder = id;
        history.replaceState(null, '', location.pathname + '?notification=1');
        await openPushTarget();
      });
      await panel.getByRole('button', {name:'فتح الطلب'}).first().click();
      await panel.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(() => openedNotificationOrder), 'order-46');
      await bell.click();
      await page.evaluate(() => offline.subscription.lock());
      await panel.waitFor({state:'hidden'});
      assert.equal(await page.locator('#delivery-notifications .dn-card').count(), 0);
      assert.equal(await page.locator('#subscription-lock').isVisible(), true);
      assert.deepEqual(errors, [], role + ' notifications must not raise page errors');
      await page.close();
      console.log(role + ': anchored motion, responsive layout, filters, read retry, focus, order action, and subscription lock passed');
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
