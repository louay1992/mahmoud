const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{chromium}=require('playwright');
const {serve,route,populate}=require('./workspace-fixture.cjs');
(async()=>{
 const {server,origin}=await serve();let browser;
 try{
  await fs.mkdir('test-results/admin-workspace/video',{recursive:true});browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block',timezoneId:'Asia/Amman',recordVideo:{dir:'test-results/admin-workspace/video',size:{width:390,height:844}}});await route(ctx,origin);
  const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/admin.html');await populate(p,'stock');
  // Move one indicator between destinations and keep the order actions above the bar during the blur.
  await p.evaluate(async()=>{
    go('home');
    const indicator=document.querySelector('.am-nav-indicator');
    indicator.getBoundingClientRect();
    await Promise.all(indicator.getAnimations().map(a=>a.finished));
  });
  const nav=await p.evaluate(()=>{
    const indicator=document.querySelector('.am-nav-indicator');
    const orders=document.querySelector('#bnr [data-value="orders"]');
    const from=indicator.getBoundingClientRect().left;
    orders.click();
    indicator.getBoundingClientRect();
    const slide=indicator.getAnimations().find(a=>a.transitionProperty==='transform');
    if(!slide)return {sliding:false};
    slide.pause();slide.currentTime=130;
    const midway=indicator.getBoundingClientRect().left;
    slide.finish();
    const destination=orders.getBoundingClientRect().left;
    const aligned=Math.abs(indicator.getBoundingClientRect().left-destination)<1;
    const hasBlur=node=>{
      const animation=node.getAnimations().find(a=>a.effect.getKeyframes()[0]?.filter==='blur(5px)');
      if(!animation)return false;
      animation.pause();
      animation.currentTime=0;
      const startsBlurred=getComputedStyle(node).filter==='blur(5px)';
      animation.finish();
      return startsBlurred&&getComputedStyle(node).filter==='none';
    };
    const pageBlur=hasBlur($('main').firstElementChild);
    go('new');
    const footer=document.querySelector('.aw-form-footer'),bar=$('bnav');
    const docked=Math.abs(footer.getBoundingClientRect().bottom-bar.getBoundingClientRect().top)<1;
    document.documentElement.style.setProperty('--bot','24px');
    const safeArea=bar.getBoundingClientRect().height===95&&Math.abs(footer.getBoundingClientRect().bottom-bar.getBoundingClientRect().top)<1;
    document.documentElement.style.removeProperty('--bot');
    const orderBlur=hasBlur(document.querySelector('.aw-order-content'));
    $('on').value='زبون تجريبي';
    $('op').value='0944123456';
    footer.querySelector('[data-aw="new-next"]').click();
    const stepBlur=hasBlur(document.querySelector('.aw-order-section[data-step="1"]:not([hidden])'));
    return {sliding:true,sameButton:orders.isConnected,landed:aligned&&destination<midway&&midway<from,docked,safeArea,pageBlur,orderBlur,stepBlur,footerMotion:footer.getAnimations().length};
  });
  assert.deepEqual(nav,{sliding:true,sameButton:true,landed:true,docked:true,safeArea:true,pageBlur:true,orderBlur:true,stepBlur:true,footerMotion:0});
  const anchored=await p.evaluate(async()=>{
    const verify=(trigger,target)=>{
      const icon=trigger.querySelector('svg').getBoundingClientRect();
      trigger.click();
      const node=document.querySelector(target),animation=node.getAnimations()[0];
      const [first,last]=animation.effect.getKeyframes();
      animation.finish();
      const box=node.getBoundingClientRect(),[x,y]=first.transformOrigin.split(' ').map(parseFloat);
      return first.transform==='scale(0.9)'&&last.transform==='scale(1)'&&
        Math.abs(box.left+x-icon.left-icon.width/2)<1&&Math.abs(box.top+y-icon.top-icon.height/2)<1;
    };
    go('orders');
    const bottom=verify(document.querySelector('#bnr [data-value="new"]'),'.aw-order-content');
    await go('ship');
    const header=verify(document.querySelector('.am-page-title [data-am="create"]'),'.aw-order-content');
    const shipping=NOM==='shipping';
    const more=verify(document.querySelector('#bnr [data-value="more"]'),'#modal .sheet');
    const sheetOpacity=getComputedStyle($('modal').firstElementChild).opacity;
    const backdropOpacity=getComputedStyle($('modal')).opacity;
    closeStatus();
    return {bottom,header,shipping,more,sheetOpacity,backdropOpacity};
  });
  assert.deepEqual(anchored,{bottom:true,header:true,shipping:true,more:true,sheetOpacity:'1',backdropOpacity:'1'});
  await p.evaluate(()=>go('stock'));
  const bell=await p.evaluate(async()=>{
    const button=$('bell'),icon=button.querySelector('svg');
    D.notifs=[{id:'unread-test',kind:'new_order',title:'طلب جديد',read_by:[]}];
    initNotifUI();
    const ring=icon.getAnimations().find(a=>a.animationName==='dn-bell-ring');
    ring.pause();ring.currentTime=200;
    const shaking=getComputedStyle(icon).transform!=='none';
    const count=button.querySelector('.nbd').textContent;
    initNotifUI();
    const stable=ring===icon.getAnimations()[0]&&icon.isConnected;
    await notificationCenter.mark(D.notifs);
    return {shaking,count,stable,stopped:!button.querySelector('.nbd')&&icon.getAnimations().length===0};
  });
  assert.deepEqual(bell,{shaking:true,count:'1',stable:true,stopped:true});
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
  await p.emulateMedia({reducedMotion:'reduce'});await p.evaluate(()=>go('stock'));assert.equal(await p.evaluate(()=>$('main').getAnimations({subtree:true}).length+document.querySelector('.am-nav-indicator').getAnimations().length),0);
  assert.equal(await p.evaluate(()=>{D.notifs[0].read_by=[];initNotifUI();return $('bell').querySelector('svg').getAnimations().length;}),0);
  await p.evaluate(()=>{go('new');document.getElementById('on').value='مسودة اختبار';document.getElementById('on').dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await p.evaluate(()=>handleNativeBack()),true);await p.locator('.dlg #dc').click();assert.equal(await p.locator('#on').inputValue(),'مسودة اختبار');
  // The keyboard viewport keeps sheets above the keyboard and hides bottom navigation.
  await p.locator('#op').focus();await p.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>400});visualViewport.dispatchEvent(new Event('resize'));openMore();});assert.ok((await p.locator('#modal .sheet').boundingBox()).height<=400);await p.keyboard.press('Escape');
  await p.evaluate(()=>{AdminWorkspace.reset();$('main').innerHTML='';});await p.close();const videoPath=await p.video().path();await ctx.close();
  const report={environment:process.platform+' Playwright headless Chromium '+browser.version(),viewport:'390x844 CSS px',cpuThrottle:4,measurement:'Synthetic 65 products, 35 captains, 36 marketers and 80 orders; scripted navigation/sheet sequence, not a physical Android FPS certification',...metrics,verified:['sliding navigation selection','stationary order actions and safe-area spacing','anchored new order and More','bell rings until notifications are read','reduced motion','focus trap and return','real touch sheet dismissal','rapid close does not erase newer overlay','native back protects draft','keyboard viewport fits sheet'],video:path.basename(videoPath)};
  await fs.writeFile('test-results/admin-workspace/motion-report.json',JSON.stringify(report,null,2)+'\n');await fs.copyFile(videoPath,'test-results/admin-workspace/motion.webm');assert.deepEqual(errors,[]);console.log(JSON.stringify(report));
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
