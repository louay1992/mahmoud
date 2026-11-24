/* Real SDK, IndexedDB and service worker. Synthetic backend only; no production requests. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const root=process.cwd(),uid='00000000-0000-0000-0000-000000000001',captainId='00000000-0000-0000-0000-000000000002';
const token=id=>Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url')+'.fixture';
const session=id=>({access_token:token(id),refresh_token:'fixture-refresh',expires_at:Math.floor(Date.now()/1000)+86400,expires_in:86400,token_type:'bearer',user:{id,email:'offline@example.test',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{}}});
const captain={id:captainId,email:'offline@example.test',name:'كابتن محفوظ',active:true,warehouse_id:'warehouse-1'};
const product={id:'product-1',name:'منتج محفوظ',price:50000,cost:25000,active:true};
const order={id:'order-1',order_no:501,fulfillment:'delivery',status:'assigned',captain_id:captainId,customer_name:'عميل محفوظ للاختبار',customer_phone:'0944000000',customer_address:'دمشق',created_at:'2026-11-25T09:00:00Z',total:55000,items_total:50000,delivery_fee:5000,order_items:[{id:'item-1',qty:1,unit_price:50000,products:{name:product.name}}]};
const tables={captains:[captain],orders:[order],settings:[{key:'business_name',value:'متجر محفوظ'},{key:'currency',value:'ل.س'}],warehouses:[{id:'warehouse-1',name:'مستودع محفوظ',is_main:true}],stock:[{warehouse_id:'warehouse-1',product_id:product.id,qty:12,products:{name:product.name}}],captain_balances:[{captain_id:captainId,balance:55000,delivered_count:1}],stock_movements:[{id:'movement-1',qty:2,kind:'invoice',warehouse_id:'warehouse-1',product_id:product.id,created_at:order.created_at,products:{name:product.name}}]};
(async()=>{
 execFileSync(process.execPath,['scripts/build-web.cjs'],{stdio:'pipe'});
 let shellBroken=false,fakeRelease=false;const server=http.createServer(async(req,res)=>{try{
  let name=new URL(req.url,'http://localhost').pathname;if(name==='/'){res.end('<html><head></head><body>Fixture</body></html>');return;}
  if(['/admin','/captain'].includes(name))name+='.html';const file=path.resolve(root,'dist','.'+name);if(!file.startsWith(path.join(root,'dist')+path.sep))throw Error();
  if(shellBroken&&name==='/mobile.css'){res.writeHead(503);res.end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Service-Worker-Allowed','/');res.setHeader('content-type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':name.endsWith('.png')?'image/png':'text/html');
  let body=await fs.readFile(file);if(fakeRelease&&name==='/offline-shell-manifest.json'){const manifest=JSON.parse(body);for(const role of ['admin','captain'])manifest[role].version='b'.repeat(64);body=JSON.stringify(manifest);}res.end(body);
 }catch(_){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;let context;
 try{
  for(const role of ['admin','captain']){
   const profile=await fs.mkdtemp(path.join(root,'.tools','offline-profile-'));let calls=0,denied=false;
   async function launch(){
    context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:390,height:844}});
    await context.routeWebSocket('**/*',socket=>socket.close());
    await context.route('**/*',async route=>{
     const url=new URL(route.request().url());if(url.origin===origin)return route.continue();
     if(url.hostname!=='jabapvnmfdflysxfxwwf.supabase.co')return route.abort();
     calls++;let data=[];if(denied)return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({message:'Access revoked',code:'42501'})});
     if(url.pathname.includes('/rpc/')){const rpc=url.pathname.split('/').pop();data=rpc==='my_access'?{role:'full'}:rpc==='admin_products'?[product]:rpc==='dashboard_stats'?{}:[];}
     else {const table=url.pathname.split('/').pop();data=tables[table]||[];if(table==='orders'&&url.searchParams.get('fulfillment')==='eq.shipping')data=[];}
     return route.fulfill({status:200,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify(data)});
    });return context.pages()[0]||context.newPage();
   }
   let page=await launch(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin+'/');await page.evaluate(({role,session})=>localStorage.setItem('sb-'+role+'-auth',JSON.stringify(session)),{role,session:session(uid)});
   await page.goto(origin+'/'+role);await page.waitForFunction(()=>!!offline.savedAt);
   assert.equal(await page.evaluate(()=>offline.readonly),false);
   // Cache a separately loaded page and distinguish it from an unopened page.
   await page.evaluate(async()=>{const r=await sb.from('stock_movements').select('*').range(0,19);if(r.error)throw Error(r.error.message);});
   await page.waitForFunction(async()=>{const names=await caches.keys();return names.some(n=>n.startsWith('offline-bundle-'));});
   await page.evaluate(()=>navigator.serviceWorker.ready);
   // A failed package update must keep the previous complete shell intact.
   shellBroken=true;fakeRelease=true;
   const installation=await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready;return new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=e=>resolve(e.data);registration.active.postMessage('PREPARE_OFFLINE',[channel.port2]);});});
   assert.equal(installation.ok,false);assert.equal(await page.evaluate(()=>caches.keys().then(keys=>keys.some(k=>k.endsWith('b'.repeat(64))))),false);shellBroken=false;fakeRelease=false;
   await page.close();await context.close();
   // Cold browser process, expired access token, no network, same private storage.
   page=await launch();await page.goto(origin+'/');await page.evaluate(role=>{const key='sb-'+role+'-auth',s=JSON.parse(localStorage.getItem(key));s.expires_at=1;localStorage.setItem(key,JSON.stringify(s));},role);
   await context.setOffline(true);await page.goto(origin+'/'+role);await page.waitForFunction(()=>offline.readonly&&!!offline.savedAt);
   await page.locator('#delivery-offline-state').waitFor();await page.locator('#splash').waitFor({state:'hidden'});assert.ok(await page.locator('#main').innerText());
   const before=calls;
   const results=await page.evaluate(async()=>({
    cached:await sb.from('stock_movements').select('*').range(0,19),
    missing:await sb.from('stock_movements').select('*').range(100,119),
    rpc:await sb.rpc('deliver_order',{p_order:'order-1'}),
    insert:await sb.from('orders').insert({customer_name:'must not save'}),
    auth:await sb.auth.updateUser({password:'must-not-save'})
   }));
   assert.equal(results.cached.data[0].id,'movement-1');assert.equal(results.missing.error.code,'OFFLINE_NOT_CACHED');
   for(const name of ['rpc','insert','auth'])assert.equal(results[name].error.code,'OFFLINE_READ_ONLY');assert.equal(calls,before);
   assert.equal(await page.evaluate(async()=>{const original=await offline.get('snapshot'),broken=structuredClone(original);broken.record.data.orders[0].customer_name='CORRUPT';await offline.tx('readwrite',s=>s.put(broken));const restored=await offline.restore();await offline.tx('readwrite',s=>s.put(original));return restored;}),false);
   await page.evaluate(()=>document.getElementById('toast')?.classList.remove('on'));await page.screenshot({path:path.join(root,'test-results',role+'-offline.png'),fullPage:true,animations:'disabled'});
   // Account mismatch cannot restore the old data, even when a session is present.
   await page.evaluate(({role,s})=>localStorage.setItem('sb-'+role+'-auth',JSON.stringify(s)),{role,s:session('00000000-0000-0000-0000-000000000099')});
   await page.reload();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#app').isVisible(),false);
   // Restore the real cached owner, log out offline, and verify physical cache purge.
   await page.evaluate(({role,s})=>localStorage.setItem('sb-'+role+'-auth',JSON.stringify(s)),{role,s:session(uid)});await page.reload();await page.waitForFunction(()=>offline.readonly&&!!offline.savedAt);
   await page.evaluate(()=>{void logout();});await Promise.all([page.waitForNavigation(),page.locator('.dlg #dk').click()]);await page.locator('#login').waitFor({state:'visible'});
   await page.waitForFunction(async()=>!await offline.get('snapshot'));
   assert.equal(await page.evaluate(role=>localStorage.getItem('sb-'+role+'-auth'),role),null);
   // A first launch offline has a working shell but no access to private data.
   await page.reload();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#app').isVisible(),false);
   // Reconnect with server-revoked permission must erase an otherwise valid cache.
   await context.setOffline(false);await page.goto(origin+'/');await page.evaluate(({role,s})=>{localStorage.removeItem('sb-'+role+'-auth-signed-out');localStorage.setItem('sb-'+role+'-auth',JSON.stringify(s));},{role,s:session(uid)});
   await page.goto(origin+'/'+role);await page.waitForFunction(()=>!!offline.savedAt);
   denied=true;await page.evaluate(()=>offline.lost());await page.evaluate(()=>offline.retry());
   await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>offline.ownerId),null);
   assert.deepEqual(errors,[]);await context.close();context=null;
   // Only remove the known generated profile in our test workspace.
   assert.ok(path.resolve(profile).startsWith(path.join(root,'.tools')+path.sep));await fs.rm(profile,{recursive:true,force:true});
   console.log(role+': cold offline startup, expired session, exact cached queries, missing data, blocked writes, account isolation, logout purge and revoked access passed');
  }
 }finally{await context?.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1});
