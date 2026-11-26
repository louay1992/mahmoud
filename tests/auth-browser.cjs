/* Exercise the real page handlers with synthetic accounts and an offline sign-out API. */
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const sdk=`window.supabase={createClient:(_url,_key,options)=>{
 const key=options.auth.storageKey;let session=JSON.parse(localStorage.getItem(key)||'null');
 const auth={getSession:async()=>({data:{session}}),stopAutoRefresh:async()=>{},
 signOut:async()=>({error:{message:'Simulated offline sign-out; cached SDK retains session'}}),
 signInWithPassword:async({email,password})=>{if(password!=='correct-password')return {error:{message:'invalid'}};
 session={access_token:'fixture-token',user:{id:'user-'+email,email}};localStorage.setItem(key,JSON.stringify(session));return {data:{session},error:null}}};
 const table=name=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,then:resolve=>Promise.resolve({data:name==='captains'?[{id:'captain-1',email:session?.user.email,name:'كابتن تجريبي',active:true}]:[],error:null}).then(resolve)};return q};
 const channel={on:()=>channel,subscribe:()=>channel};
 return {auth,from:table,rpc:name=>name==='working_orders'?table('orders'):Promise.resolve({data:name==='my_access'?{role:'full'}:[],error:null}),channel:()=>channel,removeAllChannels:async()=>{}};
}};`;
(async()=>{
 const root=process.cwd();
 const server=http.createServer(async(req,res)=>{try{
  const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(!file.startsWith(root+path.sep))throw Error();
  const body=await fs.readFile(file);res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);
 }catch(_){res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const role of ['admin','captain']){
   const context=await browser.newContext();
   await context.route('**/*',route=>route.request().url().match(/cdn\.jsdelivr\.net|\/vendor\/supabase\.js/)?route.fulfill({contentType:'application/javascript',body:sdk}):route.request().url().startsWith(origin+'/')?route.continue():route.abort());
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin+'/'+role+'.html?native=1');
   await page.locator('#em').fill(role==='admin'?'first@example.test':'0944000000');await page.locator('#pw').fill('correct-password');await page.locator('#lbtn').click();
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('#app')).display!=='none');
   const key='sb-'+role+'-auth';assert.ok(await page.evaluate(key=>localStorage.getItem(key),key));
   await page.locator('#lo').click();
   await Promise.all([page.waitForNavigation(),page.locator('.dlg #dk').click()]);
   await page.locator('#login').waitFor({state:'visible'});
   assert.equal(await page.locator('#app').isVisible(),false);
   assert.equal(await page.locator('#pw').inputValue(),'');
   assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);
   assert.equal(await page.evaluate(key=>localStorage.getItem(key+'-signed-out'),key),'1');
   assert.equal(await page.evaluate(role=>localStorage.getItem('delivery-native-unbind-'+role),role),'1');
   // A delayed old refresh must not restore the dashboard on the next launch.
   await page.evaluate(key=>localStorage.setItem(key,JSON.stringify({access_token:'old',user:{id:'old',email:'old@example.test'}})),key);
   await page.reload();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#app').isVisible(),false);
   assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);
   await page.locator('#em').fill(role==='admin'?'second@example.test':'0944111111');await page.locator('#pw').fill('wrong-password');await page.locator('#lbtn').click();
   await page.waitForFunction(()=>!document.querySelector('#lbtn').disabled);assert.equal(await page.locator('#app').isVisible(),false);
   assert.equal(await page.evaluate(key=>localStorage.getItem(key+'-signed-out'),key),'1');
   // The channel comes back advertising the previous native binding. It must unbind first.
   await page.evaluate(role=>{
    const channel=new MessageChannel();window.nativeCalls=[];window.fixtureHost=channel.port1;
    channel.port1.onmessage=async event=>{const msg=JSON.parse(event.data);window.nativeCalls.push(msg.type);const {data}=await sb.auth.getSession();channel.port1.postMessage(JSON.stringify({id:msg.id,ok:true,saved:msg.type==='bind',permission:'granted',configured:true,account_id:data.session?.user.id||''}))};
    window.postMessage('',location.origin,[channel.port2]);
    channel.port1.postMessage(JSON.stringify({type:'delivery.native.ready',version:1,role,permission:'granted',configured:true,saved:true,account_id:'old'}));
   },role);
   await page.waitForFunction(role=>!localStorage.getItem('delivery-native-unbind-'+role),role);
   assert.deepEqual(await page.evaluate(()=>window.nativeCalls),['unbind']);
   await page.locator('#pw').fill('correct-password');
   await page.waitForTimeout(850); // The existing page ignores repeated clicks on the same button within 800ms.
   await page.locator('#lbtn').click();
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('#app')).display!=='none');
   assert.equal(await page.evaluate(key=>localStorage.getItem(key+'-signed-out'),key),null);
   await page.waitForFunction(()=>window.nativeCalls.includes('bind'));
   await page.locator('#lo').click();await page.locator('.dlg #dc').click();assert.equal(await page.locator('#app').isVisible(),true);
   assert.deepEqual(errors,[]);await context.close();
   console.log(role+': offline logout, native-channel failure, reload, stale refresh, invalid credentials, new account, native unbind-before-bind and cancel verified');
  }
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
