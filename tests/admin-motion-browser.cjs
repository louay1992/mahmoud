const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{chromium}=require('playwright');
const {serve,route,populate}=require('./workspace-fixture.cjs');
(async()=>{
 const {server,origin}=await serve();let browser;
 try{
  await fs.mkdir('test-results/admin-workspace/video',{recursive:true});browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',timezoneId:'Asia/Amman',recordVideo:{dir:'test-results/admin-workspace/video',size:{width:390,height:844}}});await route(ctx,origin);
  const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/admin.html');await populate(p,'stock');
  const cdp=await ctx.newCDPSession(p);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await p.evaluate(()=>{window.frameTimes=[];window.longTasks=[];let prev=performance.now();const loop=t=>{frameTimes.push(t-prev);prev=t;window.frameRequest=requestAnimationFrame(loop);};window.frameRequest=requestAnimationFrame(loop);if(PerformanceObserver.supportedEntryTypes.includes('longtask'))new PerformanceObserver(l=>longTasks.push(...l.getEntries().map(e=>e.duration))).observe({type:'longtask'});});
  for(const screen of ['warehouses','marketers','captains','profit','stats','stock']){await p.evaluate(k=>go(k),screen);await p.waitForTimeout(330);}
  await p.locator('[data-aw="stock-filters"]').click();await p.locator('.aw-sheet').waitFor();
  assert.equal(await p.locator('.aw-sheet').getAttribute('role'),'dialog');assert.equal(await p.locator('#app').getAttribute('inert'),'');
  await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>!!document.activeElement.closest('#modal')),true);await p.keyboard.press('Shift+Tab');assert.equal(await p.evaluate(()=>!!document.activeElement.closest('#modal')),true);
  await p.keyboard.press('Escape');await p.waitForTimeout(180);assert.equal(await p.locator('.aw-retiring').count(),0);assert.equal(await p.locator('[data-aw="stock-filters"]').evaluate(n=>n===document.activeElement),true);
  // Real touch dismissal from the sheet header, with no nested scroller gesture.
  await p.locator('[data-aw="stock-filters"]').click();const box=await p.locator('#modal .sh-h').boundingBox();const x=box.x+box.width/2,y=box.y+box.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+115}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.locator('#modal .sheet').waitFor({state:'detached'});
  const metrics=await p.evaluate(()=>{cancelAnimationFrame(frameRequest);const frames=frameTimes.slice(2).sort((a,b)=>a-b);return {frameCount:frames.length,medianFrameMs:frames[Math.floor(frames.length*.5)],p95FrameMs:frames[Math.floor(frames.length*.95)],worstFrameMs:frames.at(-1),longTasks:longTasks.length,maxLongTaskMs:Math.max(0,...longTasks)};});
  // Interrupting open/close sequences cannot erase a newer overlay or trap focus.
  await p.evaluate(()=>{for(let i=0;i<12;i++){openMore();closeStatus();}openMore();});await p.locator('#modal .aw-sheet').waitFor();await p.waitForTimeout(220);assert.equal(await p.locator('#modal .sheet').count(),1);await p.keyboard.press('Escape');
  await p.emulateMedia({reducedMotion:'reduce'});await p.evaluate(()=>go('stock'));assert.equal(await p.evaluate(()=>document.getElementById('main').getAnimations().length),0);
  await p.evaluate(()=>{go('new');document.getElementById('on').value='مسودة اختبار';document.getElementById('on').dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await p.evaluate(()=>handleNativeBack()),true);await p.locator('.dlg #dc').click();assert.equal(await p.locator('#on').inputValue(),'مسودة اختبار');
  // The keyboard viewport keeps sheets above the keyboard and hides bottom navigation.
  await p.locator('#op').focus();await p.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>400});visualViewport.dispatchEvent(new Event('resize'));openMore();});assert.ok((await p.locator('#modal .sheet').boundingBox()).height<=400);await p.keyboard.press('Escape');
  await p.evaluate(()=>{AdminWorkspace.reset();$('main').innerHTML='';});await p.close();const videoPath=await p.video().path();await ctx.close();
  const report={environment:'Windows, bundled Playwright headless Chromium '+browser.version(),viewport:'390x844 CSS px',cpuThrottle:4,measurement:'Synthetic 65 products, 35 captains, 36 marketers and 80 orders; scripted navigation/sheet sequence, not a physical Android FPS certification',...metrics,verified:['motion can be interrupted','reduced motion has no main transition','focus trap and return','real touch sheet dismissal','rapid close does not erase newer overlay','native back protects draft','keyboard viewport fits sheet'],video:path.basename(videoPath)};
  await fs.writeFile('test-results/admin-workspace/motion-report.json',JSON.stringify(report,null,2)+'\n');await fs.copyFile(videoPath,'test-results/admin-workspace/motion.webm');assert.deepEqual(errors,[]);console.log(JSON.stringify(report));
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
