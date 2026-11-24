/* Coordinates live data, phone pull-to-refresh and safe web-interface updates. */
class DeliveryRefresh {
  constructor(options) {
    this.options=options;this.role=options.role;this.pending=false;this.pendingVersion=null;this.dirty=new Set();
    this.build=options.buildVersion||document.querySelector('meta[name="delivery-build"]')?.content||'';
    this.viewKey='delivery-refresh-view-'+this.role;this.attemptKey='delivery-update-attempt-'+this.role;
    this.lastData=0;this.lastInteraction=0;this.timeout=options.timeout||15000;
    if(options.mount!==false)this.mount();
  }
  active(){return this.options.active()&&!document.hidden;}
  hasDraft(){
    for(const el of this.dirty)if(!el.isConnected||el.value===el.defaultValue)this.dirty.delete(el);
    return this.dirty.size>0;
  }
  safe(){return this.active()&&!document.body?.classList?.contains('busy')&&!this.hasDraft()&&this.options.safe();}
  async refresh({manual=false,force=false,reason='auto'}={}){
    if(this.applying)return {ok:false};
    if(!this.active()||navigator.onLine===false){if(manual)this.options.toast('لا يوجد اتصال بالإنترنت. حاول مجددًا عند عودته.','err');return {ok:false};}
    if(!force&&!this.safe()){
      this.pending=true;if(manual)this.options.toast('احفظ التغييرات أو أغلق النموذج قبل التحديث.','err');return {deferred:true};
    }
    if(this.flight){if(force||reason==='live'){this.queuedForce=force||this.queuedForce;this.queued=true;}if(manual){this.foreground=true;this.paint('loading');}return this.flight;}
    if(!manual&&!force&&reason!=='live'&&Date.now()-this.lastData<1200)return {ok:true};
    this.foreground=manual;this.pending=false;this.queued=false;this.queuedForce=false;
    this.flight=(async()=>{
      let cycles=0,ok=false,nextForce=force;
      try{
        do{
          this.queued=false;this.queuedForce=false;const abort=new AbortController();let timer;
          this.paint('loading');
          try{
            ok=(await Promise.race([
              Promise.resolve().then(()=>this.options.fetchData({signal:abort.signal,force:nextForce})),
              new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('refresh timeout'));},this.timeout);})
            ]))!==false;
          }finally{clearTimeout(timer);abort.abort();}
          if(ok)this.lastData=Date.now();else if(this.active()&&!this.safe())this.pending=true;
          nextForce=this.queuedForce;cycles++;
        }while(this.queued&&cycles<2&&this.active()&&(nextForce||this.safe()));
        if(this.queued)this.pending=true;
        if(this.foreground){this.paint(ok?'success':'deferred');if(ok)this.options.toast('تم التحديث','ok');}
        return {ok};
      }catch(_){if(this.foreground){this.paint('error');this.options.toast('تعذّر التحديث. بقيت البيانات الحالية محفوظة؛ حاول مجددًا.','err');}return {ok:false};}
      finally{this.flight=null;document.getElementById('rf')?.classList.remove('sp');document.getElementById('main')?.removeAttribute('aria-busy');if(this.foreground)this.hideLater();this.foreground=false;}
    })();
    return this.flight;
  }
  async manual(){const result=await this.refresh({manual:true,reason:'manual'});if(result.ok)await this.checkUpdate();return result;}
  async checkUpdate(){
    if(!this.active()||navigator.onLine===false||!/^\w{64}$/.test(this.build))return;
    if(this.versionFlight)return this.versionFlight;
    this.versionFlight=(async()=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),6000);
      try{
        const response=await fetch('/app-version.json',{cache:'no-store',signal:abort.signal});if(!response.ok)return;
        const manifest=await response.json(),version=manifest[this.role];
        if(manifest.schema!==1||typeof version!=='string'||!/^[a-f0-9]{64}$/.test(version))return;
        if(version===this.build){this.pendingVersion=null;try{sessionStorage.removeItem(this.attemptKey)}catch(_){}return;}
        this.pendingVersion=version;this.updateNotice();await this.applyUpdate(false);
      }catch(_){/* Offline/version endpoint failures never interrupt the application. */}
      finally{clearTimeout(timer);this.versionFlight=null;}
    })();return this.versionFlight;
  }
  updateNotice(){
    const box=document.getElementById('upd');if(!box)return;box.style.display=this.safe()?'block':'none';
    if(!box.querySelector('#delivery-update-now')){
      box.innerHTML='<div class="delivery-update-note" role="status"><span>تحديث جديد جاهز؛ سيُطبّق تلقائيًا بعد الانتهاء من العمل الحالي.</span><button type="button" id="delivery-update-now">تحديث الآن</button></div>';
      box.querySelector('button').onclick=()=>this.applyUpdate(true);
    }
  }
  async applyUpdate(manual=false){
    if(!this.pendingVersion||this.applying||navigator.onLine===false)return;
    if(this.flight||!this.safe()||(!manual&&Date.now()-this.lastInteraction<1200)){
      if(manual)this.options.toast('احفظ التغييرات أو أغلق النموذج قبل تطبيق التحديث.','err');return;
    }
    const version=this.pendingVersion;
    try{const attempt=JSON.parse(sessionStorage.getItem(this.attemptKey)||'null');if(!manual&&attempt?.version===version&&Date.now()-attempt.at<300000)return;}catch(_){}
    this.applying=true;
    // A release may have waited behind a draft for hours. Verify connectivity
    // and the current deployment before clearing any offline shell.
    const probe=new AbortController(),probeTimer=setTimeout(()=>probe.abort(),4000);
    try{
      const response=await fetch('/app-version.json',{cache:'no-store',signal:probe.signal});
      const manifest=response.ok?await response.json():null;
      if(manifest?.schema!==1||manifest[this.role]!==version){this.applying=false;return;}
    }catch(_){this.applying=false;if(manual)this.options.toast('تعذّر تحميل التحديث. حاول مجددًا عند استقرار الاتصال.','err');return;}
    finally{clearTimeout(probeTimer);}
    // Only this application's shell cache is touched. Auth and the other app remain intact.
    let timer;
    try{
      if(globalThis.caches)await Promise.race([(async()=>{const names=await caches.keys();await Promise.all(names.filter(k=>k.startsWith('shell-'+this.role+'-')).map(k=>caches.delete(k)));})(),new Promise(resolve=>{timer=setTimeout(resolve,1500)})]);
    }catch(_){}finally{clearTimeout(timer);}
    if(!this.safe()||navigator.onLine===false){this.applying=false;return;}
    try{
      sessionStorage.setItem(this.attemptKey,JSON.stringify({version,at:Date.now()}));
      sessionStorage.setItem(this.viewKey,JSON.stringify(this.options.captureView?.()||{}));
    }catch(_){}
    (this.options.reload||(()=>location.reload()))();
  }
  restoreView(){
    let view;try{view=JSON.parse(sessionStorage.getItem(this.viewKey)||'null');sessionStorage.removeItem(this.viewKey);}catch(_){}
    if(view&&this.options.restoreView)this.options.restoreView(view);
  }
  tick(){
    if(!this.active())return;
    if(this.pending&&this.safe())void this.refresh({reason:'idle'});
    if(this.pendingVersion){const box=document.getElementById('upd');if(box)box.style.display=this.safe()?'block':'none';void this.applyUpdate(false);}
  }
  resume(){if(this.active()){void this.refresh({reason:'resume'});void this.checkUpdate();}}
  paint(state){
    const rf=document.getElementById('rf'),main=document.getElementById('main');
    if(state==='loading'){rf?.classList.add('sp');main?.setAttribute('aria-busy','true');}
    if(!this.indicator||!this.foreground)return;
    clearTimeout(this.hideTimer);this.indicator.dataset.state=state;this.indicator.classList.add('visible');
    this.indicator.querySelector('span').textContent=({loading:'جارٍ التحديث…',success:'تم التحديث',error:'تعذّر التحديث',deferred:'التحديث مؤجّل'})[state];
  }
  hideLater(){if(this.indicator)this.hideTimer=setTimeout(()=>this.indicator.classList.remove('visible'),1400);}
  mount(){
    const node=document.createElement('div');node.id='delivery-refresh-indicator';node.setAttribute('role','status');node.setAttribute('aria-live','polite');
    node.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/></svg><span>اسحب للتحديث</span>';document.body.appendChild(node);this.indicator=node;
    document.documentElement.classList.add('delivery-pull-enabled');
    const interact=()=>{this.lastInteraction=Date.now();};
    document.addEventListener('input',event=>{
      interact();const el=event.target;
      if(!el.closest?.('#app,#modal')||el.type==='search'||el.id==='oq'||el.id==='hq'||(el.placeholder||'').startsWith('بحث'))return;
      if(el.matches('input,textarea'))this.dirty.add(el);
    });
    document.addEventListener('pointerdown',interact,{passive:true});document.addEventListener('scroll',interact,{passive:true,capture:true});
    document.addEventListener('visibilitychange',()=>this.resume());addEventListener('focus',()=>this.resume());
    addEventListener('online',()=>{document.getElementById('offline')?.classList.remove('on');this.resume();});
    addEventListener('offline',()=>document.getElementById('offline')?.classList.add('on'));
    document.getElementById('offline')?.classList.toggle('on',navigator.onLine===false);
    setInterval(()=>{if(this.active())void this.refresh({reason:'timer'});},this.options.interval||20000);
    setInterval(()=>{void this.checkUpdate();},60000);setInterval(()=>this.tick(),1500);
    this.installPull();
  }
  installPull(){
    let gesture=null,suppressClick=0;
    document.addEventListener('touchstart',event=>{
      if(this.foreground)return;
      clearTimeout(this.hideTimer);if(gesture)this.indicator.classList.remove('visible');
      gesture=null;
      if(!matchMedia('(max-width:719px)').matches||!this.safe()||navigator.onLine===false||scrollY>1||event.touches.length!==1)return;
      const target=event.target;if(!target.closest?.('#main')||target.closest('input,textarea,select,[contenteditable],.chips,.am-status-rail,.sbar'))return;
      for(let el=target;el&&el!==document.body;el=el.parentElement){const style=getComputedStyle(el);if(/auto|scroll/.test(style.overflowY)&&el.scrollHeight>el.clientHeight+1)return;}
      const touch=event.touches[0];gesture={x:touch.clientX,y:touch.clientY,distance:0};
    },{passive:true});
    document.addEventListener('touchmove',event=>{
      if(!gesture)return;if(event.touches.length!==1||scrollY>1||!this.safe()){gesture=null;this.indicator.classList.remove('visible');return;}
      const t=event.touches[0],dy=t.clientY-gesture.y,dx=Math.abs(t.clientX-gesture.x);
      if(dy<0||dx>Math.max(12,dy)){gesture=null;this.indicator.classList.remove('visible');return;}
      if(dy<12)return;if(event.cancelable)event.preventDefault();
      gesture.distance=Math.min(96,dy*.5);this.lastInteraction=Date.now();
      this.indicator.style.top=Math.max(8,(document.querySelector('#app header')?.getBoundingClientRect().bottom||0)+8)+'px';
      this.indicator.style.setProperty('--pull-offset',Math.min(0,gesture.distance-64)+'px');this.indicator.dataset.state=gesture.distance>=64?'ready':'pull';
      this.indicator.querySelector('span').textContent=gesture.distance>=64?'اترك للتحديث':'اسحب للتحديث';this.indicator.classList.add('visible');
    },{passive:false});
    const finish=event=>{if(!gesture)return;const ready=gesture.distance>=64&&event.type!=='touchcancel';gesture=null;if(ready){suppressClick=Date.now()+500;this.indicator.style.setProperty('--pull-offset','0px');void this.manual();}else this.indicator.classList.remove('visible');};
    document.addEventListener('touchend',finish,{passive:true});document.addEventListener('touchcancel',finish,{passive:true});
    document.addEventListener('click',event=>{if(Date.now()<suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
  }
}
globalThis.DeliveryRefresh=DeliveryRefresh;
