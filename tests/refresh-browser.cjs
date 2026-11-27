const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const sdk=`window.fixtureApi={counts:{},fail:false,hold:false};window.supabase={createClient:()=>{
 const role=location.pathname.includes('admin')?'admin':'captain';const id='00000000-0000-0000-0000-000000000001';
 const order={id,order_no:921,fulfillment:'delivery',status:role==='admin'?'new':'assigned',captain_id:'captain-1',customer_name:'زبون تجريبي',customer_phone:'0944000000',customer_address:'دمشق، المزة',created_at:'2026-11-25T09:00:00Z',status_at:'2026-11-25T09:00:00Z',total:30000,items_total:25000,list_total:25000,delivery_fee:5000,order_items:[{id:'item-1',qty:1,unit_price:25000,list_price:25000,products:{name:'منتج تجريبي'}}]};
 const captain={id:'captain-1',auth_user_id:'fixture-user',email:'fixture@example.test',name:'كابتن تجريبي',active:true,warehouse_id:'warehouse-1'};
 const table=name=>{let signal,shipping=false;const q={select:()=>q,eq:(k,v)=>{if(k==='fulfillment')shipping=true;return q},order:()=>q,limit:()=>q,range:()=>q,abortSignal:s=>{signal=s;return q},maybeSingle:async()=>({data:captain,error:null}),then:resolve=>{
   fixtureApi.counts[name]=(fixtureApi.counts[name]||0)+1;
   const result=()=>({data:name==='orders'?(shipping?[]:[order]):name==='captains'?[captain]:name==='settings'?[{key:'business_name',value:'متجر تجريبي'},{key:'currency',value:'ل.س'}]:[],error:fixtureApi.fail?{message:'fixture network failure'}:null});
   if(fixtureApi.hold)return new Promise(done=>signal?.addEventListener('abort',()=>done({data:null,error:{message:'aborted'}}),{once:true})).then(resolve);
   return new Promise(done=>setTimeout(done,fixtureApi.delay||0)).then(result).then(resolve);
 }};return q};
 const channel={on:()=>channel,subscribe:()=>channel};
 return {auth:{getSession:async()=>({data:{session:{user:{id:'fixture-user',email:'fixture@example.test'},access_token:'fixture-jwt'}}})},from:table,
 rpc:name=>name==='working_orders'?table('orders'):Promise.resolve({data:name==='subscription_access'?{schema:1,allowed:true,configured:false}:name==='my_access'?{role:'full'}:name==='dashboard_stats'?{}:[],error:null}),channel:()=>channel,removeAllChannels:async()=>{}};
}};`;
(async()=>{
 const root=process.cwd(),versions={admin:'a'.repeat(64),captain:'a'.repeat(64)};let browser;
 const server=http.createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/app-version.json'){res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify({schema:1,...versions}));return;}
  const file=path.resolve(root,'.'+pathname);if(!file.startsWith(root+path.sep))throw Error();
  let data=await fs.readFile(file);if(pathname.endsWith('.html')){const role=pathname.includes('admin')?'admin':'captain';data=data.toString().replace('content="__APP_BUILD__"','content="'+versions[role]+'"');}
  res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);
 }catch(_){res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  browser=await chromium.launch({headless:true});const origin='http://127.0.0.1:'+server.address().port;
  for(const role of ['admin','captain']){
   const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',timezoneId:'Asia/Amman'});
   await context.route('**/*',route=>route.request().url().match(/cdn\.jsdelivr\.net|\/vendor\/supabase\.js/)?route.fulfill({contentType:'application/javascript',body:sdk}):route.request().url().startsWith(origin+'/')?route.continue():route.abort());
   const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(origin+'/'+role+'.html?native=1&host=android');await page.locator('#app').waitFor({state:'visible'});await page.locator('#splash').waitFor({state:'hidden'});
   await page.waitForFunction(()=>!appRefresh.flight);if(role==='admin')await page.evaluate(()=>go('orders'));
   await page.addStyleTag({content:'html{scroll-behavior:auto!important}'});
   const cdp=await context.newCDPSession(page);
   async function pull(x=190,y=330,dx=0,dy=185,cancel=false){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/5,y:y+dy*i/5}]});
    // Release a settled finger; otherwise the ignored native scroll can keep
    // flinging during the next independent scroll-preservation assertion.
    await page.waitForTimeout(130);
    await cdp.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
   }
   let before=await page.evaluate(()=>fixtureApi.counts.orders||0);await pull();
   await page.waitForFunction(n=>(fixtureApi.counts.orders||0)>n,before,{timeout:3000});
   await page.waitForFunction(()=>!appRefresh.flight);assert.match(await page.locator('#delivery-refresh-indicator').innerText(),/تم التحديث/);
   // Horizontal gestures and partial/cancelled pulls must not issue reads.
   before=await page.evaluate(()=>fixtureApi.counts.orders);await pull(120,330,130,10);await pull(190,330,0,35);await pull(190,330,0,185,true);
   assert.equal(await page.evaluate(()=>fixtureApi.counts.orders),before);
   await page.evaluate(()=>{document.querySelector('#main').style.minHeight='2000px';scrollTo(0,240)});await pull();assert.equal(await page.evaluate(()=>fixtureApi.counts.orders),before);await page.evaluate(()=>scrollTo(0,0));
   // Concurrent manual requests share one real page data load.
   before=await page.evaluate(()=>fixtureApi.counts.orders);await page.evaluate(()=>Promise.all([manualRefresh(),manualRefresh()]));assert.equal(await page.evaluate(()=>fixtureApi.counts.orders),before+1);
   const scroll=await page.evaluate(async()=>{fixtureApi.delay=60;const task=manualRefresh();scrollTo({top:240,behavior:'instant'});const before=scrollY;await task;fixtureApi.delay=0;return {before,after:scrollY}});assert.ok(scroll.before>100&&Math.abs(scroll.after-scroll.before)<=1,'scrolling during refresh must not jump back: '+JSON.stringify(scroll));await page.evaluate(()=>scrollTo(0,0));
   await page.evaluate(()=>{fixtureApi.fail=true});await page.evaluate(()=>manualRefresh());
   assert.equal(await page.evaluate(()=>D.orders.length),1);assert.equal(await page.locator('#rf').evaluate(el=>el.classList.contains('sp')),false);assert.match(await page.locator('#toast').innerText(),/تعذّر التحديث/);
   await page.evaluate(()=>{fixtureApi.fail=false;fixtureApi.hold=true;appRefresh.timeout=40});await page.evaluate(()=>manualRefresh());assert.equal(await page.evaluate(()=>appRefresh.flight),null);
   await page.evaluate(()=>{fixtureApi.hold=false;appRefresh.timeout=15000});
   await context.setOffline(true);before=await page.evaluate(()=>fixtureApi.counts.orders);await page.evaluate(()=>manualRefresh());assert.equal(await page.evaluate(()=>fixtureApi.counts.orders),before);
   await context.setOffline(false);await page.waitForFunction(()=>!appRefresh.flight);
   // UI releases wait for an unsaved field, then restore the current screen/filter.
   await page.evaluate(()=>{const draft=document.createElement('textarea');draft.id='refresh-draft';document.querySelector('#main').appendChild(draft)});
   await page.locator('#refresh-draft').fill('ملاحظة غير محفوظة');await page.locator('#refresh-draft').blur();versions[role]='b'.repeat(64);
   await page.evaluate(()=>checkUpdate());assert.equal(await page.locator('meta[name="delivery-build"]').getAttribute('content'),'a'.repeat(64));assert.equal(await page.locator('#refresh-draft').inputValue(),'ملاحظة غير محفوظة');
   assert.equal(await page.locator('#upd').isVisible(),false,'a deferred update must not cover the form or its save action');
   before=await page.evaluate(()=>fixtureApi.counts.orders);await page.evaluate(()=>appRefresh.refresh());assert.equal(await page.evaluate(()=>fixtureApi.counts.orders),before);
   await page.evaluate(async role=>{
    document.querySelector('#refresh-draft').remove();
    if(role==='admin'){orderFilter='closed';orderQuery='921';SHF.st='handed';SHF.q='SY921';AdminMobile.restoreView({sort:'priority'});await go('ship');}else{TF='no_answer';q='921';go('orders');}
   },role);
   await page.evaluate(async role=>{await caches.open('shell-'+role+'-fixture');await caches.open('shell-'+(role==='admin'?'captain':'admin')+'-fixture');},role);
   await Promise.all([page.waitForNavigation(),page.evaluate(()=>appRefresh.applyUpdate(true))]);
   await page.locator('#app').waitFor({state:'visible'});assert.equal(await page.locator('meta[name="delivery-build"]').getAttribute('content'),'b'.repeat(64));
   if(role==='admin')await page.locator('#am-shipping').waitFor();
   assert.equal(await page.evaluate(()=>tab),role==='admin'?'ship':'orders');assert.equal(await page.locator(role==='admin'?'#am-ship-query':'#oq').inputValue(),role==='admin'?'SY921':'921');
   assert.equal(await page.evaluate(role=>role==='admin'?orderFilter:TF,role),role==='admin'?'closed':'no_answer');
   assert.deepEqual(await page.evaluate(()=>caches.keys()),['shell-'+(role==='admin'?'captain':'admin')+'-fixture']);
   assert.deepEqual(errors,[]);await context.close();console.log(role+': real touch pull, cancelled/horizontal/scrolled gestures, coalescing, failure/timeout/offline recovery, draft protection and automatic interface update/view restore verified');
  }
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
