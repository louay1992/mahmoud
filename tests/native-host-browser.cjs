/* Exercise both real HTML pages with the AndroidX WebKit named host protocol. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
(async()=>{
 const root=process.cwd();let browser;
 const server=http.createServer(async(req,res)=>{try{
  const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep))throw Error();
  res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));
 }catch(_){res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  browser=await chromium.launch({headless:true});const origin='http://127.0.0.1:'+server.address().port;
  for(const role of ['admin','captain']){
   const context=await browser.newContext({viewport:{width:390,height:844}});
   await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.request().url().includes('cdn.jsdelivr.net')?route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})}'}):route.abort());
   await context.addInitScript(role=>{
    window.hostCalls=[];window.workerCalls=0;window.browserPermissionCalls=0;let saved=false;
    navigator.serviceWorker.register=async()=>{window.workerCalls++;throw Error('Native apps must not register browser push')};
    Notification.requestPermission=async()=>{window.browserPermissionCalls++;throw Error('Native apps must use Android permission')};
    window.DeliveryAndroidHost={postMessage(raw){
     const request=JSON.parse(raw);window.hostCalls.push(request);
     if(request.type==='bind')saved=true;if(request.type==='unbind')saved=false;
     const state={host:'android',app_version:'1.2.0',app_name:role==='admin'?'الإدارة':'كابتن التوصيل',permission:'granted',configured:true,saved,account_id:saved?'user-current':''};
     queueMicrotask(()=>window.DeliveryAndroidHost.onmessage?.({data:JSON.stringify(request.type==='hello'?{...state,type:'delivery.native.ready',role,version:1}:{...state,id:request.id,ok:true})}));
    }};
   },role);
   const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(origin+'/'+role+'.html?native=1&host=android');
   await page.waitForFunction(()=>pushClient.native?.port&&hostCalls.some(r=>r.type==='unbind'));
   await page.evaluate(async()=>{
    sb.auth.getSession=async()=>({data:{session:{access_token:'test-jwt',user:{id:'user-current'}}}});
    await pushClient.requestPermission();await pushClient.subscribe();
   });
   assert.equal(await page.evaluate(()=>pushClient.enabled),true);
   if(role==='captain'){
   await page.evaluate(()=>{void pushDiag()});
   await page.waitForFunction(()=>document.querySelector('#pdg-status').textContent==='اكتمل الفحص');
   const text=await page.locator('#pdg').innerText();assert.match(text,/1\.2\.0/);assert.doesNotMatch(text,/Chrome|Firefox|Mozilla|قناة Android غير متصلة/);
   await page.locator('#pdg-local').click();await page.waitForFunction(()=>!document.querySelector('#pdg-local').disabled);
   await page.locator('#pdg-server').click();await page.waitForFunction(()=>document.querySelector('#pdg').textContent.includes('FCM accepted'));
   await page.locator('#pdg-close').click();
   }else{
    assert.equal(await page.evaluate(()=>typeof pushDiag),'undefined');
    await page.evaluate(async()=>{await pushClient.showTest('اختبار',{body:'FCM'});await pushClient.native.serverTest()});
   }
   await page.evaluate(async()=>{await copyText("test ' \" بوليصة");await saveCsv('profit.csv','\ufeffa,b\n1,2');});
   await page.evaluate(role=>{if(role==='admin')void ask3('اختبار',{title:'رجوع',yes:'نعم',no:'لا'});else void ask('رجوع','اختبار','نعم','g');},role);
   assert.equal(await page.evaluate(()=>handleNativeBack()),true);assert.equal(await page.locator('.dlg').count(),0);
   const result=await page.evaluate(()=>({calls:hostCalls.map(r=>r.type),workers:workerCalls,browserPermission:browserPermissionCalls}));
   for(const type of ['hello','permission','bind','test','server-test','copy','save-csv'])assert.ok(result.calls.includes(type),type);
   assert.equal(result.workers,0);assert.equal(result.browserPermission,0);assert.deepEqual(errors,[]);
   await context.close();console.log(role+': named Android host, permission, binding, diagnostics, tests, copy/export, and zero browser push calls verified');
  }
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
