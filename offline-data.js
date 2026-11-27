/* Private, read-only snapshots. This module never queues or replays a write. */
class DeliveryOffline {
  constructor({role,storageKey,blocked=()=>false}) {
    this.role=role;this.storageKey=storageKey;this.blocked=blocked;this.generation=0;
    this.purgeKey=storageKey+'-offline-purge';this.readonly=false;this.savedAt=null;
    this.subscription=new DeliverySubscriptionAccess(this);
    this.ready=this.open().then(async()=>{if(localStorage.getItem(this.purgeKey))await this.purge();}).catch(()=>{this.unavailable=true;});
    addEventListener('offline',()=>this.lost());
    addEventListener('online',()=>this.paint());
  }
  open(){return new Promise((resolve,reject)=>{
    const request=indexedDB.open('delivery-private-'+this.role,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('data',{keyPath:'key'});
    request.onsuccess=()=>{this.db=request.result;this.db.onversionchange=()=>this.db.close();resolve();};request.onerror=()=>reject(request.error);
  });}
  async tx(mode,work){if(!this.db)throw Error('Storage unavailable');return new Promise((resolve,reject)=>{
    const transaction=this.db.transaction('data',mode),store=transaction.objectStore('data');let result;
    try{result=work(store);}catch(e){transaction.abort();reject(e);return;}
    transaction.oncomplete=()=>resolve(result?.result);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error||Error('Storage aborted'));
  });}
  async get(key){await this.ready;return this.tx('readonly',s=>s.get(key));}
  async digest(value){const bytes=new TextEncoder().encode(JSON.stringify(value));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
  session(){try{const session=JSON.parse(localStorage.getItem(this.storageKey)||'null');return session?.user?.id?session:null;}catch(_){return null;}}
  async onlineSession(auth){let timer;try{return await Promise.race([auth.getSession(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('session network timeout')),12000);})]);}finally{clearTimeout(timer);}}
  owner(session){
    if(!session?.user?.id||!session.access_token)return null;
    try{const payload=JSON.parse(atob(session.access_token.split('.')[1].replaceAll('-','+').replaceAll('_','/')));return payload.sub===session.user.id?session.user.id:null;}catch(_){return null;}
  }
  denied(){return this.readonly||navigator.onLine===false||this.blocked()||this.subscription.locked;}
  error(code='OFFLINE_READ_ONLY'){return {data:null,error:{code,message:code==='OFFLINE_NOT_CACHED'?'هذه البيانات غير محفوظة على هذا الجهاز. افتحها عند الاتصال أولاً.':'هذه العملية تتطلب اتصالاً بالإنترنت. وضع عدم الاتصال للعرض فقط.'},status:0};}
  networkError(result){return !!result?.error&&(result.status===0||/fetch|network|offline|connection|timeout/i.test(result.error.message||''));}
  async attach(session,profile){
    const owner=this.owner(session);if(!owner||this.blocked())return false;
    this.generation++;this.ownerId=null;this.queryAt=null;
    await this.ready;if(this.unavailable){this.cacheError=true;return false;}
    try{
    const previous=await this.get('owner');
    // Re-check server permissions each online boot. Old query caches are discarded,
    // including when the same account's permissions/profile have changed.
    if(previous?.owner!==owner||JSON.stringify(previous?.profile)!==JSON.stringify(profile)){await this.purge();this.savedAt=null;}
    this.ownerId=owner;this.profile=structuredClone({...profile,subscription:this.subscription.state});this.generation++;this.readonly=false;
    await this.tx('readwrite',s=>s.put({key:'owner',owner,profile:this.profile}));return true;
    }catch(_){this.cacheError=true;this.paint();return false;}
  }
  async checkpoint(data){
    if(!this.ownerId||this.denied())return false;
    const generation=this.generation,record={schema:1,owner:this.ownerId,profile:this.profile,data:structuredClone(data),savedAt:new Date().toISOString()};
    const checksum=await this.digest(record);
    if(generation!==this.generation||this.denied())return false;
    try{await this.tx('readwrite',s=>s.put({key:'snapshot',record,checksum}));if(generation!==this.generation||this.blocked())return false;this.savedAt=record.savedAt;this.paint();return true;}
    catch(_){this.cacheError=true;this.paint();return false;}
  }
  async restore(){
    if(this.blocked()||localStorage.getItem(this.purgeKey))return false;
    const owner=this.owner(this.session());if(!owner)return false;
    let stored;try{stored=await this.get('snapshot');}catch(_){return false;}
    if(!stored||stored.record.schema!==1||stored.record.owner!==owner||await this.digest(stored.record)!==stored.checksum)return false;
    if(this.blocked()||localStorage.getItem(this.purgeKey))return false;
    if(!this.subscription.restore(stored.record.profile.subscription))return true;
    this.ownerId=owner;this.profile=stored.record.profile;this.savedAt=stored.record.savedAt;this.readonly=true;this.generation++;
    await this.options.restore(structuredClone(stored.record));this.paint();return true;
  }
  async boot(onlineBoot){
    this.onlineBoot=onlineBoot;
    if(this.blocked())for(const suffix of ['', '-user', '-code-verifier'])localStorage.removeItem(this.storageKey+suffix);
    await this.ready;
    if(this.blocked()){await this.invalidate();this.options.login();return;}
    const bundled=!!document.querySelector('meta[name="delivery-offline-shell"]');
    if(navigator.onLine===false||bundled){if(await this.restore())return;this.options.login();this.options.toast('لا توجد بيانات محفوظة لهذا الحساب. يلزم تسجيل الدخول وتحميل البيانات مع اتصال بالإنترنت أولاً.','err');return;}
    try{await onlineBoot();}catch(e){
      if(e?.code==='ACCESS_DENIED'){await this.invalidate();this.options.login();return;}
      if(await this.restore())return;
      this.ownerId=null;this.readonly=false;this.options.login();this.options.toast('تعذّر الاتصال ولا توجد نسخة محفوظة صالحة لهذا الحساب. حاول عند عودة الاتصال.','err');
    }
  }
  lost(){if(this.ownerId&&!this.blocked()){this.readonly=true;this.paint();}}
  async retry(){
    if(this.retrying)return;this.retrying=true;this.paint();
    try{
      if(navigator.onLine===false)throw Error('offline');
      if(this.options.safe&&!this.options.safe()){this.options.toast('أغلق النموذج أو احتفظ ببياناته قبل إعادة الاتصال.','err');return;}
      const view=this.options.capture?.();
      if(document.querySelector('meta[name="delivery-offline-shell"]')){
        const response=await fetch('/app-version.json',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('offline');
        if(view)sessionStorage.setItem('delivery-refresh-view-'+this.role,JSON.stringify(view));
        const target=new URL(location.href);target.searchParams.set('__delivery_online','1');location.replace(target);return;
      }
      // Never replace an in-progress form while reconnecting.
      this.readonly=false;await this.onlineBoot();
      if(this.readonly)throw Error('offline');this.options.reconnected?.(view);this.options.toast('عاد الاتصال وتم تحديث البيانات والصلاحيات','ok');
    }catch(e){if(e?.code==='ACCESS_DENIED'){await this.invalidate();this.options.login();}else{this.readonly=true;this.options.toast('لم يكتمل الاتصال. ما زلت تعرض البيانات المحفوظة.','err');}}
    finally{this.retrying=false;this.paint();}
  }
  invalidate(){
    this.generation++;this.ownerId=null;this.profile=null;this.savedAt=null;this.readonly=false;
    localStorage.setItem(this.purgeKey,'1');this.paint();
    return this.ready.then(()=>this.purge()).catch(()=>{});
  }
  async purge(){
    if(this.db){
      const previous=await this.tx('readonly',s=>s.get('owner')),profile=previous?.profile;
      if(profile?.captain){localStorage.removeItem('cap_seen_'+profile.captain.id);localStorage.removeItem('nseen_'+String(profile.captain.email||'').toLowerCase());}
      if(profile?.email){localStorage.removeItem('adm_seen_'+profile.email);localStorage.removeItem('nseen_'+profile.email);}
      await this.tx('readwrite',s=>s.clear());
    }
    sessionStorage.removeItem('delivery-refresh-view-'+this.role);localStorage.removeItem(this.purgeKey);
  }
  wrap(client){
    this.client=client;
    const offline=this,readRPC=new Set(['get_subscription','working_orders','carrier_balances','carrier_statement','my_access','staff_lookups','admin_products','dashboard_stats','admin_profit_items','marketer_return_impact']);
    const overrides=new Map();
    const builder=(target,path,write=false,signal)=>new Proxy(target,{
      get(object,name){
        if(name==='then')return (resolve,reject)=>offline.execute(object,path,write,signal).then(resolve,reject);
        if(name==='catch')return reject=>offline.execute(object,path,write,signal).catch(reject);
        if(name==='finally')return callback=>offline.execute(object,path,write,signal).finally(callback);
        const value=Reflect.get(object,name);if(typeof value!=='function')return value;
        return (...args)=>builder(value.apply(object,args),name==='abortSignal'?path:[...path,[name,args]],write||['insert','update','upsert','delete'].includes(name),name==='abortSignal'?args[0]:signal);
      }
    });
    const auth=new Proxy(client.auth,{get(object,name){const value=Reflect.get(object,name);if(typeof value!=='function')return value;
      return (...args)=>{if(['signInWithPassword','signUp','updateUser','resetPasswordForEmail','signInWithOtp','verifyOtp'].includes(name)&&(offline.readonly||navigator.onLine===false))return Promise.resolve(offline.error());return value.apply(object,args);};}});
    return new Proxy(client,{set(_object,name,value){overrides.set(name,value);return true;},get(object,name){
      if(overrides.has(name))return overrides.get(name);
      if(name==='auth')return auth;
      if(name==='from')return table=>builder(object.from(table),[['from',[table]]]);
      if(name==='rpc')return (rpc,args,options)=>builder(object.rpc(rpc,args,options),[['rpc',[rpc,args||null]]],!readRPC.has(rpc));
      const value=Reflect.get(object,name);return typeof value==='function'?value.bind(object):value;
    }});
  }
  async execute(target,path,write,signal){
    const cancelled=()=>({data:null,error:{code:'ABORTED',message:'Read cancelled'},status:0});
    if(signal?.aborted)return cancelled();
    if(this.subscription.locked)return {data:null,error:{code:'SUBSCRIPTION_EXPIRED',message:'انتهى اشتراك الشركة'},status:402};
    const detach=path[0]?.[0]==='rpc'&&['remove_push_subscription','remove_admin_push_subscription'].includes(path[0]?.[1]?.[0]);
    if(write&&this.denied()&&!(detach&&!this.readonly&&navigator.onLine!==false))return this.error();
    const generation=this.generation,owner=this.ownerId,key='query:'+JSON.stringify(path);
    if(!write&&this.readonly){
      if(!owner||this.blocked())return this.error('OFFLINE_NOT_CACHED');
      try{const entry=await this.get(key);if(this.blocked()||this.ownerId!==owner||generation!==this.generation)return this.error('OFFLINE_NOT_CACHED');
        if(entry?.owner===owner&&entry.checksum===await this.digest(entry.result)){if(!this.queryAt||entry.savedAt<this.queryAt)this.queryAt=entry.savedAt;this.paint();return structuredClone(entry.result);}
      }catch(_){}this.options?.toast('هذه التفاصيل لم تُحفظ على هذا الجهاز بعد. افتحها عند الاتصال.','err');return this.error('OFFLINE_NOT_CACHED');
    }
    let result,timer,abort,onAbort;
    try{
      if(!write&&target.abortSignal){abort=new AbortController();target=target.abortSignal(abort.signal);}
      result=write?await target:await Promise.race([Promise.resolve(target),new Promise(resolve=>{timer=setTimeout(()=>{abort?.abort();resolve({data:null,error:{message:'network timeout'},status:0});},12000);onAbort=()=>{abort?.abort();resolve(cancelled());};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();})]);
    }catch(e){result={data:null,error:{message:String(e)},status:0};}finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}
    if(signal?.aborted)return cancelled();
    if(result?.status===402||result?.error?.code==='PT402'){this.subscription.lock();return result;}
    if(this.networkError(result))this.lost();
    // An authoritative permission rejection must never unlock a stale copy.
    if([401,403].includes(result?.status)&&owner){void this.invalidate();this.options?.login();return result;}
    if(!write&&!result?.error&&owner&&owner===this.ownerId&&generation===this.generation&&!this.denied()){
      try{
        const copy=JSON.parse(JSON.stringify(result)),checksum=await this.digest(copy);
        if(generation===this.generation&&!this.denied())await this.tx('readwrite',s=>{
          s.put({key,owner,result:copy,checksum,savedAt:new Date().toISOString()});
          const request=s.getAll();request.onsuccess=()=>{const queries=request.result.filter(x=>x.key.startsWith('query:')).sort((a,b)=>b.savedAt.localeCompare(a.savedAt));queries.slice(120).forEach(x=>s.delete(x.key));};
        });
      }catch(_){this.cacheError=true;}
    }
    return result;
  }
  configure(options){
    this.options=options;
    // Capture phase also covers delegated controls and a form opened before a
    // network loss. The transport gate above remains the final write barrier.
    document.addEventListener('click',event=>{
      if(!this.denied())return;const control=event.target.closest?.('button,[onclick],a');if(!control)return;
      if(this.mutator(control)){event.preventDefault();event.stopImmediatePropagation();const fieldError=document.getElementById('aw-save-error');if(fieldError)fieldError.textContent='لا يوجد اتصال مؤكّد. '+this.error().error.message;options.toast(this.error().error.message,'err');}
    },true);
    const observer=new MutationObserver(records=>{if(records.every(r=>r.target.closest?.('#delivery-offline-state')))return;if(!this.paintQueued){this.paintQueued=true;queueMicrotask(()=>{this.paintQueued=false;this.paint();});}});
    observer.observe(document.body,{childList:true,subtree:true});this.paint();
  }
  watch(auth){auth.onAuthStateChange?.(event=>{
    if(event==='SIGNED_OUT'&&this.ownerId){void this.invalidate();this.options.sessionEnded?.();}
  });}
  mutator(control){
    const action=control.getAttribute('onclick')||'',name=control.dataset.aw||control.dataset.am||'',value=control.dataset.value;
    return /\b(save\w*|submit\w*|add\w*|edit\w*|del\w*|delete\w*|toggleCaptain|toggleProduct|toggleMarketer|assign|cancelO|restoreO|returnO|transferStock|adjustOne|createStaff|changePw|staffPw|setCapPw|payMarketer|carPay|carPayDel|carEdit|shipEdit|shipSet|quick|restore|sendPriceReq|openStatus|pickStatus|openEdit|openPrices|openNote|decidePR|markAllRead)\s*\(/.test(action)||/^(new-|.*-save$|.*-delete$|.*-add$|.*-edit$|.*-pay$|.*-toggle$|.*-submit$)/.test(name)||['create','invoice','transfer','adjust','captain-fee','captain-password','notification-read'].includes(name)||(['navigate','more-navigate'].includes(name)&&value==='new')||/go\(['"]new['"]\)/.test(action);
  }
  paint(){
    if(!this.options)return;const main=document.getElementById('main');if(!main)return;
    const visible=(!!this.ownerId&&(this.readonly||navigator.onLine===false))||(this.cacheError&&document.getElementById('app')?.style.display!=='none');
    let box=document.getElementById('delivery-offline-state');
    document.querySelectorAll('[data-offline-blocked]').forEach(el=>{el.removeAttribute('aria-disabled');el.removeAttribute('data-offline-blocked');});
    document.querySelectorAll('[data-offline-field]').forEach(el=>{el.disabled=el.dataset.offlineField==='1';delete el.dataset.offlineField;});
    if(!visible){box?.remove();document.body.classList.remove('delivery-readonly');return;}
    document.body.classList.toggle('delivery-readonly',this.denied());
    if(this.denied()){
      document.querySelectorAll('#app button,#modal button').forEach(el=>{if(this.mutator(el)){el.setAttribute('aria-disabled','true');el.dataset.offlineBlocked='1';}});
      const forms=[];if(this.options.editing?.())forms.push(document.getElementById('main'));
      const modal=document.getElementById('modal');if(modal&&[...modal.querySelectorAll('button')].some(el=>this.mutator(el)))forms.push(modal);
      forms.forEach(form=>form?.querySelectorAll('input,textarea,select').forEach(el=>{el.dataset.offlineField=el.disabled?'1':'0';el.disabled=true;}));
    }
    if(!box){box=document.createElement('aside');box.id='delivery-offline-state';box.setAttribute('role','status');main.prepend(box);}
    const at=this.savedAt?new Date(this.savedAt).toLocaleString('ar-SY'):'غير متاح',readAt=this.queryAt?new Date(this.queryAt).toLocaleString('ar-SY'):null;
    const message=(this.denied()?'دون اتصال — عرض فقط':'تعذّر حفظ نسخة للعمل دون اتصال')+'|'+at+'|'+readAt+'|'+!!this.retrying;
    if(box.dataset.message===message)return;box.dataset.message=message;box.replaceChildren();
    const title=document.createElement('strong');title.textContent=this.denied()?'دون اتصال · عرض فقط':'الحفظ المحلي غير مكتمل';
    const detail=document.createElement('span');detail.textContent='آخر حفظ للبيانات الأساسية: '+at+'. الأرصدة والكميات قد تكون تغيّرت.'+(readAt?' آخر حفظ للتفاصيل المفتوحة: '+readAt+'.':'')+(this.cacheError?' تعذّر حفظ بعض التفاصيل محليًا.':'');
    const button=document.createElement('button');button.type='button';button.textContent=this.retrying?'جارٍ التحقق…':'إعادة الاتصال';button.disabled=!!this.retrying;button.onclick=()=>this.retry();
    box.append(title,detail,button);
  }
}
globalThis.DeliveryOffline=DeliveryOffline;
