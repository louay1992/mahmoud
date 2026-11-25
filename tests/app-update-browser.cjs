const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const feed={schema:1,sourceCommit:'a'.repeat(40),apps:Object.fromEntries(['admin','captain'].map(role=>[role,{packageName:'app.hhyyw.'+role,versionName:'1.4.0',versionCode:7,minSdk:23,size:3200000,sha256:'a'.repeat(64),notes:'تنزيل التحديثات من داخل التطبيق مع عرض نسبة التقدم.',url:'https://github.com/louay1992/mahmoud/releases/download/android-v1.4.0/Delivery-'+(role==='admin'?'Admin':'Captain')+'-1.4.0.apk'}]))};
(async()=>{
 const root=process.cwd(),server=http.createServer(async(req,res)=>{try{
  const name=new URL(req.url,'http://localhost').pathname;
  if(name==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app-updates.css"></head><body><button id="before">دخول</button><script src="/app-updates.js"></script></body></html>');return;}
  if(!['/app-updates.js','/app-updates.css'].includes(name)){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',(name.endsWith('.js')?'application/javascript':'text/css')+'; charset=utf-8');res.end(await fs.readFile(path.join(root,name.slice(1))));
 }catch(_){res.writeHead(500).end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;const origin='http://127.0.0.1:'+server.address().port;
 try{browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});for(const role of ['admin','captain']){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});let requests=0;
  await context.route('https://raw.githubusercontent.com/**',route=>{requests++;return route.fulfill({contentType:'application/json',body:JSON.stringify(feed)});});
  const page=await context.newPage();await page.goto(origin);await page.locator('#before').focus();
  assert.equal(requests,0,'ordinary browser sessions must not check for Android updates');
  await page.evaluate(role=>{window.nativeFixture={embedded:true,role,state:{app_version:'1.3.0'}};DeliveryAppUpdates.connected(window.nativeFixture);},role);
  const dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/تحديث جديد متاح/);
  assert.equal(await dialog.getByRole('link',{name:'تنزيل التحديث'}).getAttribute('href'),feed.apps[role].url);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await fs.mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/'+role+'-apk-update.png',fullPage:true,animations:'disabled'});
  await dialog.getByRole('button',{name:'لاحقًا'}).click();await dialog.waitFor({state:'detached'});assert.equal(await page.locator('#before').evaluate(el=>document.activeElement===el),true);
  await page.evaluate(()=>DeliveryAppUpdates.connected(window.nativeFixture));assert.equal(requests,1,'a deferred offer must not repeat during the same session');
  await page.reload();const before=requests;
  await page.evaluate(role=>{window.calls=[];window.nativeFixture={embedded:true,role,state:{app_version:'1.4.0',app_update_supported:true},request:type=>{window.calls.push(type);return Promise.resolve();}};DeliveryAppUpdates.connected(window.nativeFixture);return DeliveryAppUpdates.check();},role);
  assert.equal(requests,before,'new hosts use the native updater without a duplicate web dialog');assert.deepEqual(await page.evaluate(()=>window.calls),['check-app-update']);assert.equal(await page.getByRole('dialog').count(),0);
  await context.close();console.log(role+': legacy offer, correct package, deferred prompt, focus, and native handoff passed');
 }}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
