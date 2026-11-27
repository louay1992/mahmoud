/* Operational phone flows use synthetic data; no production account is contacted. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const reference=execFileSync('git',['show','cbb852095170674ad65b794d4525ba420ea0b9ee:admin.html'],{encoding:'utf8'});
async function populate(page,screen='home'){
 await page.waitForFunction(()=>document.getElementById("splash")?.classList.contains("off"));
 await page.evaluate(screen=>{
  const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
  const base={created_at:'2026-11-25T07:00:00Z',status_at:'2026-11-25T08:00:00Z',fulfillment:'delivery',customer_phone:'0944123456',customer_address:'المزة، شارع الفيلات، بجانب الصيدلية',governorate:'دمشق',captain_id:'captain-1',marketer_id:'marketer-1',total:185000,items_total:175000,list_total:175000,delivery_fee:10000,order_items:[{id:'item-1',qty:2,unit_price:87500,list_price:87500,products:{name:'مجموعة العناية اليومية'}}]};
  const statuses=['new','in_delivery','no_answer','closed','other','cancelled','assigned','delivered','returned'];
  D.orders=statuses.map((status,n)=>({...base,id:id(n+1),order_no:1041+n,status,customer_name:['سارة أحمد','محمد الرفاعي','نور حمدان'][n%3],captain_id:status==='new'?null:'captain-1',captain_note:status==='no_answer'?'تم الاتصال مرتين، يرجى المتابعة مساءً':null}));
  const ships=['preparing','handed','in_transit','returned','cancelled','delivered'];
  window.fixtureShips=ships.map((ship_status,n)=>({...base,id:id(n+101),order_no:2011+n,status:ship_status==='delivered'?'delivered':'new',ship_status,fulfillment:'shipping',customer_name:['ليلى الحسن','أحمد محمود'][n%2],carrier_id:n===2?'carrier-2':'carrier-1',waybill:n===0?null:'SY-0049-'+n,shipping_cost:7000,ship_warehouse:'warehouse-1'}));
  D.orders.push(...window.fixtureShips);D.settings={business_name:'الصحة والجمال',currency:'ل.س'};CUR='ل.س';
if(typeof TABS!=='undefined'&&!TABS.some(t=>t[0]==='subscription'))TABS.splice(TABS.length-1,0,['subscription','إدارة الاشتراك','wallet']);
  D.products=[{id:'product-1',name:'مجموعة العناية اليومية',active:true,price:87500}];
  D.captains=[{id:'captain-1',name:'أحمد خالد',active:true,warehouse_id:'warehouse-1'}];D.marketers=[{id:'marketer-1',name:'نور',active:true}];D.warehouses=[{id:'warehouse-1',name:'المستودع الرئيسي',is_main:true}];D.carriers=[{id:'carrier-1',name:'قدموس',phone:'0944000000',active:true},{id:'carrier-2',name:'الأمانة للشحن',active:false}];
  D.stats={delivered_today:12,sales_today:2140000,owed_total:975000,low_stock:[{warehouse:'المستودع الرئيسي',product:'سيروم العناية',qty:2}]};
  D.prs=[{id:'request-1',order_id:id(2),captain_id:'captain-1',status:'pending',old_total:185000,new_total:180000,reason:'حسم متفق عليه',created_at:base.created_at}];D.pr={[id(2)]:D.prs};D.prof={};D.ev={};D.notifs=[];D.balances=[];D.stock=[];
  window.rpcCalls=[];sb.rpc=async(name,args)=>{rpcCalls.push({name,args});return name==='working_orders'?{data:D.orders,error:null}:name==='carrier_balances'?{data:[{carrier_id:'carrier-1',col:185000,fees:7000,paid:0,owed:178000,fly:2,pend:370000,n:6,dl:1,rt:0}],error:null}:{data:null,error:{message:'اختبار محلي دون حفظ'}}};
  sb.from=name=>{let selectedId;const q={select:()=>q,eq:(key,value)=>{if(key==='id')selectedId=value;return q},order:()=>q,limit:()=>q,maybeSingle:async()=>({data:fixtureShips.find(o=>o.id===selectedId)||null,error:null}),then:resolve=>Promise.resolve({data:name==='orders'?fixtureShips:[],error:null}).then(resolve)};return q};
  ACC={role:'full'};ME='admin@example.test';$('hn').textContent=D.settings.business_name;$('login').style.display='none';$('app').style.display='block';hideSplash();renderNav();go(screen);
 },screen);
 await page.addStyleTag({content:'*{animation:none!important;transition:none!important;caret-color:transparent!important}'});
}
(async()=>{
 const root=process.cwd();let browser;
 const server=http.createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/reference.html'){res.setHeader('content-type','text/html');res.end(reference);return}
  const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep))throw Error();res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));
 }catch(_){res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await fs.mkdir('test-results',{recursive:true});browser=await chromium.launch({headless:true});
  const origin='http://127.0.0.1:'+server.address().port,context=await browser.newContext({timezoneId:'Asia/Amman',reducedMotion:'reduce',serviceWorkers:'block'}),errors=[];
  context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  await context.route('**/*',route=>route.request().url().match(/cdn\.jsdelivr\.net|\/vendor\/supabase\.js/)?route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})}'}):route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  for(const width of [320,360,390,430]){
   const page=await context.newPage();await page.setViewportSize({width,height:844});await page.goto(origin+'/admin.html');await populate(page);
   assert.equal(await page.locator('.am-home').count(),1);
   assert.equal(await page.locator('#main table').count(),0,'home is an operational dashboard rather than a compressed table');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:`test-results/admin-redesign-${width}-home.png`,fullPage:true});
   await page.locator('[data-am="delivery-status"][data-value="new"]').first().click();
   assert.deepEqual(await page.locator('#ochips button').evaluateAll(buttons=>buttons.map(b=>b.dataset.value)),['new','in_delivery','no_answer','closed','other','cancelled','all']);
   assert.equal(await page.locator('#olist .am-order').count(),1);
   assert.match(await page.locator('#olist .am-delivery-team').innerText(),/بانتظار الإسناد[\s\S]*المسوّقة[\s\S]*نور/);
   await page.screenshot({path:`test-results/admin-redesign-${width}-delivery.png`,fullPage:true});
   // Filters preserve every existing state, including assigned/delivered/returned.
   await page.locator('[data-am="filters"]').click();await page.locator('#am-f-status').selectOption('assigned');await page.locator('[data-am="apply-filters"]').click();
   assert.equal(await page.locator('#olist .am-order[data-status="assigned"]').count(),1);
   await page.locator('#ochips [data-value="all"]').click();
   assert.deepEqual(await page.locator('#olist .am-order').evaluateAll(cards=>cards.map(c=>c.dataset.status)),['new','assigned','in_delivery','no_answer','closed','other','cancelled','delivered','returned']);
   const viewport=await page.evaluate(()=>{
    scrollTo({top:0,behavior:'instant'});
    const cards=[...document.querySelectorAll('#olist .am-delivery-card')].slice(0,3).map(card=>card.getBoundingClientRect().toJSON());
    return {top:cards[0].top,bottom:cards[2].bottom,nav:document.getElementById('bnav').getBoundingClientRect().top,heights:cards.map(card=>card.height)};
   });
   assert.ok(viewport.bottom<=viewport.nav,`${width}px: three full order cards fit above the bottom bar ${JSON.stringify(viewport)}`);
   if(width===390)await page.screenshot({path:'test-results/admin-delivery-cards.png'});
   const list=page.locator('#olist'), delivered=list.locator('[data-status="delivered"]'), pending=list.locator('[data-status="in_delivery"]');
   assert.equal(await delivered.locator('.am-order-footer small').textContent(),'إجمالي الطلب');
   assert.match(await pending.locator('.am-order-attention').innerText(),/بانتظار قرارك/);
   await pending.getByRole('button',{name:/مراجعة السعر/}).click();
   assert.match(await page.getByRole('dialog',{name:/مراجعة سعر الطلب/}).innerText(),/185,000[\s\S]*180,000[\s\S]*حسم متفق عليه/);
   await page.keyboard.press('Escape');
   await delivered.getByRole('button',{name:/خيارات الطلب/}).click();
   assert.equal(await page.getByRole('link',{name:'اتصال بالزبون'}).getAttribute('href'),'tel:0944123456');
   await page.keyboard.press('Escape');
   await page.evaluate(()=>{D.captains.push({id:'captain-2',name:'سليم إبراهيم',active:true});D.orders.find(o=>o.status==='assigned').captain_id='captain-2'});
   await page.locator('#ochips [data-value="new"]').click();
   const captainFilter=page.getByRole('button',{name:/فلترة حسب الكابتن/});
   await captainFilter.click();
   assert.equal(await page.locator('[data-am="choose-captain"][data-value="captain-1"] b').innerText(),'7');
   await page.getByRole('searchbox',{name:'بحث باسم الكابتن'}).fill('ابراهيم');
   assert.equal(await page.locator('#am-captain-results button').count(),1);
   await page.getByRole('button',{name:/سليم إبراهيم/}).click();
   assert.match(await captainFilter.innerText(),/سليم إبراهيم/);
   assert.equal(await page.locator('#ochips [data-value="all"]').getAttribute('aria-pressed'),'true');
   assert.deepEqual(await list.locator('.am-order').evaluateAll(cards=>cards.map(c=>c.dataset.status)),['assigned']);
   await page.locator('[data-am="filters"]').click();
   assert.equal(await page.locator('#am-f-owner').inputValue(),'captain-2');
   await page.keyboard.press('Escape');
   await captainFilter.click();
   await page.getByRole('button',{name:/بدون كابتن/}).click();
   assert.deepEqual(await list.locator('.am-order').evaluateAll(cards=>cards.map(c=>c.dataset.status)),['new']);
   await captainFilter.click();
   await page.getByRole('button',{name:/^كل الكباتن/}).click();
   assert.equal(await list.locator('.am-order').count(),9);
   await page.locator('#oq').fill('1043');assert.equal(await page.locator('#olist .am-order').count(),1);assert.equal(await page.locator('#oq').inputValue(),'1043');
   await page.locator('#oq').fill('not-found');assert.equal(await page.locator('.am-empty').count(),1);
   await page.locator('[data-am="show-all"]').click();
   await page.locator('#olist .am-order').first().locator('.am-primary').click();
   await page.locator('#as_00000000-0000-0000-0000-000000000001').selectOption('captain-1');
   await page.locator('#modal button').filter({hasText:'إسناد'}).click();
   assert.equal(await page.evaluate(()=>rpcCalls.at(-1).name),'assign_order');assert.equal(await page.evaluate(()=>rpcCalls.at(-1).args.p_captain),'captain-1');
   await page.evaluate(()=>{closeStatus();$('toast').classList.remove('on')});
   await page.locator('#bnr [data-value="ship"]').click();await page.locator('#am-shipping').waitFor();
   assert.equal(await page.locator('#shlist .am-order[data-status="preparing"]').count(),1);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const shipments=page.locator('#shlist .am-shipment-card');
   assert.match(await shipments.locator('.am-order-heading').innerText(),/قدموس[\s\S]*جديدة/);
   assert.match(await shipments.locator('.am-waybill').innerText(),/لم تُسجّل بعد/);
   const carrierFilter=page.getByRole('button',{name:/فلترة حسب شركة الشحن/});
   await carrierFilter.click();
   assert.equal(await page.locator('[data-am="choose-carrier"][data-value="carrier-1"] b').innerText(),'5');
   await page.getByRole('searchbox',{name:'بحث باسم شركة الشحن'}).fill('الامانة');
   assert.equal(await page.locator('#am-carrier-results button').count(),1);
   await page.getByRole('button',{name:/الأمانة للشحن/}).click();
   assert.match(await carrierFilter.innerText(),/الأمانة للشحن/);
   assert.equal(await page.locator('#am-ship-chips [data-value="all"]').getAttribute('aria-pressed'),'true');
   assert.equal(await shipments.count(),1);
   assert.match(await shipments.locator('.am-order-heading').innerText(),/الأمانة للشحن[\s\S]*عند الشركة/);
   assert.equal(await shipments.locator('.am-waybill bdi').innerText(),'SY-0049-2');
   await shipments.getByRole('button',{name:/خيارات الشحنة/}).click();
   assert.equal(await page.getByRole('link',{name:'اتصال بالزبون'}).getAttribute('href'),'tel:0944123456');
   await page.keyboard.press('Escape');
   await page.locator('#am-shipping [data-am="filters"]').click();
   assert.equal(await page.locator('#am-f-owner').inputValue(),'carrier-2');
   await page.keyboard.press('Escape');
   await carrierFilter.click();
   await page.getByRole('button',{name:/^كل الشركات/}).click();
   assert.equal(await shipments.count(),6);
   assert.equal(await shipments.filter({has:page.locator('.am-status', {hasText:'مسلّمة'})}).locator('.am-order-footer small').innerText(),'إجمالي الطلب');
   assert.ok(await page.evaluate(()=>{
    scrollTo({top:0,behavior:'instant'});
    const third=document.querySelectorAll('#shlist .am-shipment-card')[2];
    return third.getBoundingClientRect().bottom<=document.getElementById('bnav').getBoundingClientRect().top;
   }),`${width}px: three complete shipment cards fit above the bottom bar`);
   await page.screenshot({path:`test-results/admin-redesign-${width}-shipping.png`,fullPage:true});
   await page.locator('#am-ship-chips [data-value="handed"]').click();assert.equal(await page.locator('#shlist .am-order').count(),2,'legacy transit status remains at the carrier stage');
   await page.locator('#am-ship-chips [data-value="cancelled"]').click();assert.equal(await page.locator('#shlist .am-order').count(),1);
   await page.locator('#am-ship-chips [data-value="all"]').click();await page.locator('#am-ship-query').fill('SY-0049-3');assert.equal(await page.locator('#shlist .am-order').count(),1);
   await page.locator('#shlist .am-primary').click();await page.locator('#modal .sheet').waitFor();assert.match(await page.locator('#modal').innerText(),/SY-0049-3/);await page.evaluate(()=>closeStatus());
   // More keeps navigation accessible, and logout is now inside Settings.
   await page.locator('#admin-more-toggle').click();
   assert.equal(await page.locator('#bnav').isVisible(),true);
   const more=page.getByRole('dialog',{name:'المزيد'});
   assert.equal(await more.getByRole('button',{name:'تسجيل الخروج'}).count(),0);
   await more.getByRole('button',{name:'الإعدادات'}).click();
   await page.getByRole('button',{name:'تسجيل الخروج'}).click();
   await page.locator('.dlg #dc').click();
   assert.equal(await page.locator('#app').isVisible(),true);
   if(width===390){
    // A slow or failed shipment load must never replace a newer destination.
    await page.evaluate(()=>{window.savedRpc=sb.rpc;sb.rpc=(name,args)=>name==='working_orders'?new Promise(done=>window.completeShipping=done):savedRpc(name,args);window.savedFrom=sb.from;sb.from=name=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,then:resolve=>name==='orders'?new Promise(done=>window.completeShipping=done).then(resolve):Promise.resolve({data:[],error:null}).then(resolve)};return q};go('ship')});
    await page.locator('.am-loading').waitFor();await page.locator('#bnr [data-value="orders"]').click();
    await page.evaluate(()=>completeShipping({data:fixtureShips,error:null}));assert.equal(await page.locator('#am-delivery').count(),1);
    await page.evaluate(()=>{sb.rpc=(name,args)=>name==='working_orders'?Promise.resolve({data:[],error:{message:'fixture offline'}}):savedRpc(name,args);sb.from=name=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,then:resolve=>Promise.resolve({data:[],error:{message:'fixture offline'}}).then(resolve)};return q};go('ship')});
    await page.locator('.am-load-error').waitFor();await page.evaluate(()=>{sb.from=savedFrom;sb.rpc=savedRpc});await page.locator('[data-am="retry-shipping"]').click();await page.locator('#am-shipping').waitFor();
    await page.evaluate(()=>{go('orders');orderFilter='all';const original=D.orders.find(o=>o.fulfillment==='delivery');D.orders=Array.from({length:75},(_,n)=>({...original,id:'fixture-'+n,order_no:3000+n,customer_name:n===0?'<img src=x onerror="window.injected=true">':'زبون '+n}));renderOrderList()});
    assert.equal(await page.locator('#olist .am-order').count(),30);await page.locator('[data-am="load-more"]').click();assert.equal(await page.locator('#olist .am-order').count(),60);
    assert.equal(await page.locator('#olist img').count(),0);assert.equal(await page.evaluate(()=>!!window.injected),false);
    await page.locator('#oq').focus();await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>400});visualViewport.dispatchEvent(new Event('resize'))});
    assert.equal(await page.locator('#bnav').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    await page.locator('[data-am="filters"]').click();assert.ok((await page.locator('.am-sheet').boundingBox()).height<=400);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#modal .am-sheet').count(),0);
   }
   await page.close();console.log(width+'px: home, status priority, extra states, search, filters, assignment RPC, shipping aliases/details, empty state and logout verified');
  }
  // Desktop content still matches the reference after moving logout out of the header.
  for(const screen of ['home','ship']){
   const before=await context.newPage(),after=await context.newPage();
   for(const page of [before,after])await page.setViewportSize({width:1440,height:1100});
   await before.goto(origin+'/reference.html');await after.goto(origin+'/admin.html');await populate(before,screen);await populate(after,screen);
   if(screen==='ship')for(const page of [before,after])await page.locator('#shlist').waitFor();
   const height=Math.max(1100,...await Promise.all([before,after].map(p=>p.evaluate(()=>document.documentElement.scrollHeight))));
   for(const p of [before,after]){
    await p.setViewportSize({width:1440,height});
    await p.locator('#app > header').evaluate(header=>{header.style.visibility='hidden';});
   }
   assert.equal(await after.locator('#app > header #lo').count(),0);
   const a=await before.screenshot({path:`test-results/admin-redesign-desktop-${screen}-before.png`,fullPage:true}),b=await after.screenshot({path:`test-results/admin-redesign-desktop-${screen}.png`,fullPage:true});
   assert.equal(Buffer.compare(a,b),0,screen+' desktop changed');await before.close();await after.close();
  }
  const staff=await context.newPage();await staff.setViewportSize({width:390,height:844});await staff.goto(origin+'/admin.html');await populate(staff);
  await staff.evaluate(()=>{ACC={role:'staff',perms:['view_orders']};renderNav();go('orders')});
  assert.equal(await staff.locator('.am-home,.am-list-page').count(),0);assert.deepEqual(await staff.locator('#side button span').allTextContents(),['طلبات التوصيل','الإعدادات']);await staff.close();
  assert.deepEqual(errors,[]);await context.close();console.log('Desktop home/shipping unchanged; staff destinations remain restricted.');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
