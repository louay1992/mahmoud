/* UI fixtures use no production account or database. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const orderId = '00000000-0000-0000-0000-000000000001';

async function populate(page, role, screen) {
  await page.evaluate(({ role, screen, orderId }) => {
    const now = '2026-11-24T09:00:00Z';
    const order = { id: orderId, order_no: 1234, status: 'assigned', fulfillment: 'delivery', customer_name: 'أحمد محمد',
      customer_phone: '0944123456', customer_address: 'دمشق، المزة، بجانب المركز التجاري', governorate: 'دمشق',
      captain_id: 'captain-1', marketer_id: 'marketer-1', total: 30000, items_total: 25000, list_total: 22000,
      delivery_fee: 5000, created_at: now, status_at: now, note: 'يرجى الاتصال قبل الوصول',
      map_url: 'https://maps.google.com/?q=Damascus', order_items: [{ id: 'item-1', qty: 1, unit_price: 25000, list_price: 22000, products: { name: 'مجموعة العناية اليومية' } }] };
    D.orders = [order, { ...order, id: '00000000-0000-0000-0000-000000000002', order_no: 1235, status: 'in_delivery', customer_name: 'سارة أحمد' }];
    D.settings = { business_name: 'الصحة والجمال', currency: 'ل.س', phone_country: '963' }; CUR = 'ل.س';
    D.ev = {}; D.pr = {}; D.notifs = []; D.payments = []; D.stock = [{ warehouse_id: 'warehouse-1', product_id: 'product-1', qty: 12, products: { name: 'مجموعة العناية اليومية' } }];
    if (role === 'admin') {
      ME = 'admin@example.test'; ACC = { role: 'full' };
      D.products = [{ id: 'product-1', name: 'مجموعة العناية اليومية', price: 22000, cost: 18000, active: true }];
      D.captains = [{ id: 'captain-1', name: 'محمد', active: true, delivery_fee: 5000, warehouse_id: 'warehouse-1' }];
      D.marketers = [{ id: 'marketer-1', name: 'نور', active: true, governorate: 'دمشق' }];
      D.warehouses = [{ id: 'warehouse-1', name: 'مستودع دمشق', is_main: true, governorates: ['دمشق'] }];
      D.prof = {}; D.prs = []; D.balances = []; D.mbal = []; D.mpay = []; D.carriers = []; D.stats = null;
      renderNav(); go(screen);
    } else {
      me = { id: 'captain-1', name: 'محمد', email: 'captain@example.test', warehouse_id: 'warehouse-1' };
      D.balance = { balance: 50000, delivered_count: 8, delivered_total: 100000, paid_total: 50000 };
      BIZ = 'الصحة والجمال'; $('hn').textContent = me.name; go(screen);
    }
    $('login').style.display = 'none'; $('app').style.display = 'block'; hideSplash();
  }, { role, screen, orderId });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(80);
}

(async () => {
  const root = process.cwd();
  await fs.mkdir('test-results', { recursive: true });
  // Keep the desktop comparison anchored to the approved 1.0.2 UI after this change is committed.
  const desktopReference = '176e81ab08f0301153a6873e3cc7cec3595c3652';
  const baseline = Object.fromEntries(['admin', 'captain'].map(role => [role, execFileSync('git', ['show', desktopReference + ':' + role + '.html'], { encoding: 'utf8' })]));
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.startsWith('/baseline/')) { res.setHeader('content-type', 'text/html'); res.end(baseline[path.basename(pathname, '.html')]); return; }
      const file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep)) throw new Error('invalid path');
      const content = await fs.readFile(file);
      res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html');
      res.end(content);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ timezoneId: 'Asia/Amman', reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      if (route.request().url().includes('cdn.jsdelivr.net')) return route.fulfill({ contentType: 'application/javascript', body:
        'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};' });
      return route.abort();
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    for (const role of ['admin', 'captain']) {
      for (const width of [360, 390, 430]) {
        const page = await context.newPage(); await page.setViewportSize({ width, height: 844 });
        await page.goto(origin + '/' + role + '.html'); await populate(page, role, 'orders');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), role + ' must not overflow at ' + width);
        await page.screenshot({ path: `test-results/${role}-${width}-orders.png`, fullPage: true });
        if (role === 'admin') {
          await page.evaluate(() => go('new'));
          await page.locator('#on').fill('زبون تجريبي'); await page.locator('#op').fill('0944000000');
          await page.locator('#oa').fill('عنوان طويل لاختبار قابلية الكتابة على الهاتف');
          assert.equal(await page.locator('#on').getAttribute('autocomplete'), 'name');
          assert.equal(await page.locator('#op').getAttribute('inputmode'), 'tel');
          await page.evaluate(() => addRow('orows'));
          await page.locator('#orows .q').fill('2'); await page.locator('#orows .pr').fill('26000');
          await page.screenshot({ path: `test-results/admin-${width}-form.png`, fullPage: true });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'new order form overflow');
          const fields = await page.locator('#on,#op,#oa,#om').evaluateAll(inputs => inputs.map(el => { const box = el.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
          assert.ok(fields.every(field => field.height >= 48 && field.width > 240), 'phone fields should have readable full-width controls');
          await page.evaluate(()=>{sb.rpc=async(name,args)=>{window.reviewOrder={name,args};return {error:{message:'اختبار محلي دون حفظ بيانات'}}}});
          await page.locator('.mobile-submit').click();
          const submitted=await page.evaluate(()=>window.reviewOrder);
          assert.equal(submitted.name,'create_order'); assert.equal(submitted.args.p_items[0].qty,2); assert.equal(submitted.args.p_items[0].unit_price,26000);
          await page.evaluate(() => openMore());
        } else {
          await page.evaluate(id => openStatus(id), orderId);
          await page.locator('#sm_note').fill('ملاحظة تجريبية أثناء ظهور لوحة المفاتيح');
        }
        const modal = page.locator('#modal .sheet'); await modal.waitFor({ state: 'visible' });
        const box = await modal.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        await page.screenshot({ path: `test-results/${role}-${width}-sheet.png` });
        if(role==='captain'){
          await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>400});visualViewport.dispatchEvent(new Event('resize'))});
          assert.equal(await page.evaluate(()=>document.body.classList.contains('mobile-keyboard-open')),true);
          assert.ok((await modal.boundingBox()).height<=400,'sheet must fit above the keyboard');
          assert.equal(await page.locator('nav').evaluate(el=>getComputedStyle(el).visibility),'hidden');
        }
        await page.close();
      }
      // Compare actual pixels with the original source at desktop width.
      for (const screen of role === 'admin' ? ['orders', 'new'] : ['orders', 'acc']) {
        const before = await context.newPage(), after = await context.newPage();
        for (const page of [before, after]) await page.setViewportSize({ width: 1440, height: 1000 });
        await before.goto(origin + '/baseline/' + role + '.html'); await after.goto(origin + '/' + role + '.html');
        await populate(before, role, screen); await populate(after, role, screen);
        const a = await before.screenshot({ path: `test-results/${role}-desktop-${screen}-before.png`, fullPage: true });
        const b = await after.screenshot({ path: `test-results/${role}-desktop-${screen}-after.png`, fullPage: true });
        if(Buffer.compare(a,b)!==0){
          const diff=await after.evaluate(async ({a,b})=>{
            const load=async raw=>{const image=new Image(); image.src='data:image/png;base64,'+raw; await image.decode(); const canvas=document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height; const c=canvas.getContext('2d');c.drawImage(image,0,0);return {w:image.width,h:image.height,p:c.getImageData(0,0,image.width,image.height).data} };
            const x=await load(a),y=await load(b);let count=0,maxDelta=0,left=x.w,top=x.h,right=0,bottom=0;
            if(x.w!==y.w||x.h!==y.h)return {size:[x.w,x.h,y.w,y.h]};
            for(let i=0;i<x.p.length;i+=4)if(x.p[i]!==y.p[i]||x.p[i+1]!==y.p[i+1]||x.p[i+2]!==y.p[i+2]){count++;maxDelta=Math.max(maxDelta,Math.abs(x.p[i]-y.p[i]),Math.abs(x.p[i+1]-y.p[i+1]),Math.abs(x.p[i+2]-y.p[i+2]));const px=(i/4)%x.w,py=Math.floor(i/4/x.w);left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py)}
            return {count,maxDelta,left,top,right,bottom};
          },{a:a.toString('base64'),b:b.toString('base64')});
          assert.equal(diff.count,0,role+'/'+screen+': desktop pixels changed '+JSON.stringify(diff));
        }
        await before.close(); await after.close();
      }
      console.log(role + ': 360/390/430px layouts and original desktop appearance verified');
      const nativePage=await context.newPage(); await nativePage.goto(origin+'/'+role+'.html?native=1'); await populate(nativePage,role,'orders');
      await nativePage.evaluate(role=>{
        sb.auth.getSession=async()=>({data:{session:{access_token:'test-current-session',user:{id:'current-user'}}}});
        const channel=new MessageChannel(); window.nativeCalls=[];
        channel.port1.onmessage=event=>{const message=JSON.parse(event.data);window.nativeCalls.push(message.type);channel.port1.postMessage(JSON.stringify({id:message.id,ok:true,saved:message.type!=='unbind',permission:'granted',configured:true,account_id:'current-user'}))};
        window.nativeHostPort=channel.port1;
        window.postMessage(JSON.stringify({type:'delivery.native.ready',version:1,role,permission:'granted',configured:true,saved:false}),location.origin,[channel.port2]);
      },role);
      await nativePage.waitForFunction(()=>pushClient.enabled);
      await nativePage.evaluate(()=>pushDiag());
      assert.match(await nativePage.locator('#pdg').innerText(),/Firebase FCM/);
      await nativePage.evaluate(()=>pushClient.unsubscribe());
      assert.equal(await nativePage.evaluate(()=>pushClient.enabled),false);
      assert.ok((await nativePage.evaluate(()=>window.nativeCalls)).includes('unbind'));
      await nativePage.close();
    }
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
