/* Diagnostic UI stays usable with a missing native channel or permanently stalled service. */
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
(async()=>{
 const root=process.cwd();let browser;
 const server=http.createServer(async(req,res)=>{try{
  const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep))throw Error();
  const bytes=await fs.readFile(file);res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(bytes);
 }catch(_){res.writeHead(404);res.end()}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  browser=await chromium.launch({headless:true});const origin='http://127.0.0.1:'+server.address().port;
  for(const role of ['admin','captain']){
   const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
   await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.request().url().includes('cdn.jsdelivr.net')?route.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})}'}):route.abort());
   const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(origin+'/'+role+'.html?native=1');
   await page.evaluate(()=>{void pushDiag()});
   await page.locator('#pdg-close').waitFor({state:'visible',timeout:500});
   await page.waitForFunction(()=>document.querySelector('#pdg-status').textContent==='اكتمل الفحص');
   assert.match(await page.locator('#pdg').innerText(),/قناة Android غير متصلة/);
   const bounds=await page.locator('#pdg-close').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y+bounds.height<=844);
   await page.locator('#pdg-ask').click();await page.waitForFunction(()=>document.querySelector('#pdg').textContent.includes('ERR:'));
   assert.equal(await page.locator('#pdg-close').isEnabled(),true);await page.locator('#pdg-close').click();
   assert.equal(await page.locator('#pdg').count(),0);
   // A read that never completes used to leave only a black overlay.
   await page.evaluate(()=>{pushClient.inspect=()=>new Promise(resolve=>window.finishProbe=resolve);void pushDiag();busy=1});
   await page.locator('#pdg-close').waitFor({state:'visible',timeout:500});await page.locator('#pdg-close').click();
   await page.evaluate(()=>{window.finishProbe(pushClient.snapshot());busy=0});
   assert.equal(await page.locator('#pdg').count(),0,'a late read must not recreate a closed dialog');
   // A permanently stalled read reports its timeout, rather than blocking the overlay.
   await page.evaluate(()=>{pushClient.inspect=()=>new Promise(()=>{});void pushDiag()});
   await page.waitForFunction(()=>document.querySelector('#pdg')?.textContent.includes('انتهت مهلة الفحص'),{},{timeout:4500});
   assert.equal(await page.locator('#pdg-close').isEnabled(),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#pdg').count(),0);
   // A permission request that never returns keeps Close usable, including during other app work.
   await page.evaluate(()=>{pushClient.inspect=async()=>pushClient.snapshot();pushClient.requestPermission=()=>new Promise(()=>{});void pushDiag()});
   await page.locator('#pdg-ask').click();assert.equal(await page.locator('#pdg-ask').isEnabled(),false);
   assert.equal(await page.locator('#pdg-close').isEnabled(),true);await page.evaluate(()=>{busy=1});await page.locator('#pdg-close').click();
   assert.equal(await page.locator('#pdg').count(),0);assert.deepEqual(errors,[]);
   await context.close();console.log(role+': immediate diagnostics, missing channel, stalled read/action, timeout, busy state, Escape and late-result cancellation verified');
  }
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
