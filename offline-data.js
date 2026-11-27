/* Private, read-only snapshots. This module never queues or replays a write. */
const OFFLINE_LEASE_MAX_MS=4*60*60*1000;
const OFFLINE_LEASE_REFRESH_MS=10*60*1000;
const OFFLINE_SNAPSHOT_MAX_BYTES=4*1024*1024;
const OFFLINE_QUERY_MAX_BYTES=512*1024;
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
    const request=indexedDB.open('delivery-private-'+this.role,2);
    request.onupgradeneeded=event=>{
      const store=event.oldVersion===0?request.result.createObjectStore('data',{keyPath:'key'}):request.transaction.objectStore('data');
      if(event.oldVersion!==0)store.clear();
      store.createIndex('savedAt','savedAt');
    };
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
  claims(session){
    if(!session?.user?.id||!session.access_token)return null;
    try{const payload=JSON.parse(atob(session.access_token.split('.')[1].replaceAll('-','+').replaceAll('_','/')));return payload.sub===session.user.id?payload:null;}catch(_){return null;}
  }
  owner(session){return this.claims(session)?.sub??null;}
  leaseFor(session){
    const state=this.subscription.state,serverAt=Date.parse(state?.checked_at),deviceAt=Date.now(),tokenUntil=this.claims(session)?.exp*1000;
    if(state?.allowed!==true||!Number.isFinite(serverAt)||!Number.isFinite(tokenUntil)||tokenUntil<=serverAt)return null;
    const termUntil=state.configured?Date.parse(state.expires_at):Infinity;
    return {serverAt,deviceAt,until:Math.min(tokenUntil,termUntil,serverAt+OFFLINE_LEASE_MAX_MS)};
  }
  leaseValid(lease,session=this.session()){
    const exp=this.claims(session)?.exp*1000,now=Date.now();
    if(!lease||!Number.isFinite(exp)||!Number.isFinite(lease.deviceAt)||!Number.isFinite(lease.serverAt)||!Number.isFinite(lease.until)||now<lease.deviceAt)return false;
    const elapsed=now-lease.deviceAt;
    const monotonic=this.leaseClock?.lease===lease?performance.now()-this.leaseClock.started+this.leaseClock.elapsed:0;
    return lease.serverAt+Math.max(elapsed,monotonic)<Math.min(lease.until,exp);
  }
  setLease(lease){this.lease=lease;this.leaseClock=lease?{lease,started:performance.now(),elapsed:Math.max(0,Date.now()-lease.deviceAt)}:null;}
  async seal(key,owner,value,cryptoKey=this.cryptoKey){
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const data=new TextEncoder().encode(JSON.stringify(value));
    if(data.byteLength>(key.startsWith('query:')?OFFLINE_QUERY_MAX_BYTES:OFFLINE_SNAPSHOT_MAX_BYTES))throw Error('Offline record exceeds retention size');
    const body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(JSON.stringify([key,owner]))},cryptoKey,data);
    return {key,owner,iv,body};
  }
  async unseal(entry,owner,cryptoKey=this.cryptoKey){
    if(!entry||entry.owner!==owner||!cryptoKey)return null;
    const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:entry.iv,additionalData:new TextEncoder().encode(JSON.stringify([entry.key,owner]))},cryptoKey,entry.body);
    return JSON.parse(new TextDecoder().decode(clear));
  }
  offlineAllowed(){
    this.subscription.expire();
    if(this.subscription.locked)return false;
    if(this.leaseValid(this.lease))return true;
    this.subscription.lock(this.subscription.state,true);return false;
  }
  expireOffline(){if(this.readonly&&this.ownerId)this.offlineAllowed();}
  armOfflineTimer(){
    clearTimeout(this.leaseTimer);
    if(!this.lease||!this.readonly)return;
    const delay=this.lease.until-this.lease.serverAt-Math.max(0,Date.now()-this.lease.deviceAt);
    this.leaseTimer=setTimeout(()=>{this.expireOffline();if(this.readonly&&this.ownerId)this.armOfflineTimer();},Math.max(1,delay));
  }
  denied(){return this.readonly||navigator.onLine===false||this.blocked()||this.subscription.locked;}
  error(code='OFFLINE_READ_ONLY'){return {data:null,error:{code,message:code==='OFFLINE_NOT_CACHED'?'هذه البيانات غير محفوظة على هذا الجهاز. افتحها عند الاتصال أولاً.':'هذه العملية تتطلب اتصالاً بالإنترنت. وضع عدم الاتصال للعرض فقط.'},status:0};}
  networkError(result){return !!result?.error&&(result.status===0||/fetch|network|offline|connection|timeout/i.test(result.error.message||''));}
  async attach(session,profile){
    const owner=this.owner(session);if(!owner||this.blocked())return false;
    const generation=++this.generation;this.ownerId=null;this.queryAt=null;this.savedAt=null;this.cryptoKey=null;
    await this.ready;if(this.unavailable){this.cacheError=true;return false;}
    try{
    const previous=await this.get('owner'),access=profile.access,captain=profile.captain;
    const permissions=await this.digest([profile.email,access?.role,[...(access?.perms||[])].sort(),captain?.id,captain?.email,captain?.warehouse_id,captain?.active]);
    if(generation!==this.generation||this.blocked())return false;
    const sameAccount=previous?.owner===owner&&previous.permissions===permissions;
    if(!sameAccount)await this.purge();
    const cryptoKey=(sameAccount&&previous.cryptoKey)||await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    if(generation!==this.generation||this.blocked())return false;
    const profileRecord=await this.seal('profile',owner,{email:profile.email,captain},cryptoKey);
    await this.tx('readwrite',s=>s.put({key:'owner',owner,permissions,cryptoKey,profileRecord}));
    if(generation!==this.generation||this.blocked())return false;
    this.ownerId=owner;this.cryptoKey=cryptoKey;this.profile=structuredClone(profile);this.setLease(this.leaseFor(session));this.readonly=false;this.cacheError=false;
    return true;
    }catch(_){this.cacheError=true;this.paint();return false;}
  }
  async renewLease(owner){
    const lease=this.lease;
    if(!lease||lease.until-lease.serverAt-(Date.now()-lease.deviceAt)>OFFLINE_LEASE_REFRESH_MS||Date.now()<this.nextLeaseAttempt)return;
    this.nextLeaseAttempt=Date.now()+60*1000;
    try{
      const {data:{session}}=await this.onlineSession(this.client.auth);
      if(this.owner(session)!==owner||this.denied())return;
      if(await this.subscription.verify()&&this.ownerId===owner&&!this.denied())this.setLease(this.leaseFor(session));
    }catch(error){
      if(error?.code==='ACCESS_DENIED'&&this.ownerId===owner){void this.invalidate();this.options?.login();}
    }
  }
  async checkpoint(data){
    if(!this.ownerId||this.denied())return false;
    const generation=this.generation,owner=this.ownerId;
    if(this.lease)await this.renewLease(owner);
    if(generation!==this.generation||this.denied()||!this.leaseValid(this.lease))return false;
    const {schema,allowed,configured,expires_at,valid_until,starts_on,reason,checked_at,clock_offset}=this.subscription.state;
    const record={profile:{...this.profile,subscription:{schema,allowed,configured,expires_at,valid_until,starts_on,reason,checked_at,clock_offset}},lease:this.lease,data,savedAt:new Date().toISOString()};
    try{const stored=await this.seal('snapshot',owner,record);if(generation!==this.generation||this.denied())return false;
      await this.tx('readwrite',s=>s.put(stored));if(generation!==this.generation||this.blocked())return false;this.savedAt=record.savedAt;this.paint();return true;}
    catch(_){this.cacheError=true;this.paint();return false;}
  }
  async restore(){
    if(this.blocked()||localStorage.getItem(this.purgeKey))return false;
    const session=this.session(),owner=this.owner(session),generation=this.generation;
    if(!owner){await this.invalidate();return false;}
    let record,cryptoKey;
    try{const metadata=await this.get('owner');if(metadata?.owner!==owner)return false;cryptoKey=metadata.cryptoKey;record=await this.unseal(await this.get('snapshot'),owner,cryptoKey);}catch(_){return false;}
    if(!record||generation!==this.generation||this.owner(this.session())!==owner||this.blocked()||localStorage.getItem(this.purgeKey))return false;
    if(!this.subscription.restore(record.profile.subscription))return true;
    if(!this.leaseValid(record.lease,session)){this.subscription.lock(record.profile.subscription,true);return true;}
    this.ownerId=owner;this.cryptoKey=cryptoKey;this.profile=record.profile;this.savedAt=record.savedAt;this.readonly=true;this.generation++;
    this.setLease(record.lease);this.armOfflineTimer();await this.options.restore(record);this.paint();return true;
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
  lost(){if(this.ownerId&&!this.blocked()){this.readonly=true;if(this.offlineAllowed())this.armOfflineTimer();this.paint();}}
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
    }catch(e){if(e?.code==='ACCESS_DENIED'){await this.invalidate();this.options.login();}else{this.readonly=true;if(this.offlineAllowed()){this.armOfflineTimer();this.options.toast('لم يكتمل الاتصال. ما زلت تعرض البيانات المحفوظة.','err');}}}
    finally{this.retrying=false;this.paint();}
  }
  invalidate(){
    this.generation++;this.ownerId=null;this.profile=null;this.cryptoKey=null;this.savedAt=null;this.readonly=false;this.setLease(null);clearTimeout(this.leaseTimer);
    localStorage.setItem(this.purgeKey,'1');this.paint();
    return this.ready.then(()=>this.purge()).catch(()=>{});
  }
  async purge(){
    if(this.db){
      const previous=await this.tx('readonly',s=>s.get('owner'));
      let profile;try{profile=await this.unseal(previous?.profileRecord,previous?.owner,previous?.cryptoKey);}catch(_){}
      if(profile?.captain){localStorage.removeItem('cap_seen_'+profile.captain.id);localStorage.removeItem('nseen_'+String(profile.captain.email||'').toLowerCase());}
      if(profile?.email){localStorage.removeItem('adm_seen_'+profile.email);localStorage.removeItem('nseen_'+profile.email);}
      await this.tx('readwrite',s=>s.clear());
    }
    sessionStorage.removeItem('delivery-refresh-view-'+this.role);localStorage.removeItem(this.purgeKey);
  }
  wrap(client){
    this.client=client;
    const offline=this,readRPC=new Set(['get_subscription','working_orders','carrier_balances','carrier_statement','captain_statement','order_history','my_access','staff_lookups','admin_products','dashboard_stats','admin_profit_items','marketer_return_impact']);
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
    const generation=this.generation,owner=this.ownerId,key=!write&&owner?'query:'+await this.digest(path):null;
    if(!write&&this.readonly){
      if(!owner||this.blocked()||!this.offlineAllowed())return this.error('OFFLINE_NOT_CACHED');
      try{const entry=await this.get(key),cached=await this.unseal(entry,owner);if(this.blocked()||this.ownerId!==owner||generation!==this.generation)return this.error('OFFLINE_NOT_CACHED');
        if(cached){if(!this.queryAt||entry.savedAt<this.queryAt)this.queryAt=entry.savedAt;this.paint();return cached;}
      }catch(_){}this.options?.toast('هذه التفاصيل لم تُحفظ على هذا الجهاز بعد. افتحها عند الاتصال.','err');return this.error('OFFLINE_NOT_CACHED');
    }
    let result,timer,abort,onAbort;
    try{
      if(!write&&target.abortSignal){abort=new AbortController();target=target.abortSignal(abort.signal);}
      result=write?await target:await Promise.race([Promise.resolve(target),new Promise(resolve=>{timer=setTimeout(()=>{abort?.abort();resolve({data:null,error:{message:'network timeout'},status:0});},12000);onAbort=()=>{abort?.abort();resolve(cancelled());};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();})]);
    }catch(e){result={data:null,error:{message:String(e)},status:0};}finally{clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}
    if(signal?.aborted)return cancelled();
    if(result?.error?.code==='PT503'){this.subscription.lock({...this.subscription.state,allowed:false,reason:'maintenance'});return result;}
    if(result?.status===402||result?.error?.code==='PT402'){this.subscription.lock();return result;}
    if(this.networkError(result))this.lost();
    // An authoritative permission rejection must never unlock a stale copy.
    if([401,403].includes(result?.status)&&owner){void this.invalidate();this.options?.login();return result;}
    if(!write&&!result?.error&&owner&&owner===this.ownerId&&generation===this.generation&&!this.denied()&&this.leaseValid(this.lease)){
      try{
        const copy=JSON.parse(JSON.stringify(result)),stored=await this.seal(key,owner,copy);
        if(generation===this.generation&&!this.denied())await this.tx('readwrite',s=>{
          s.put({...stored,savedAt:new Date().toISOString()});
          const request=s.index('savedAt').openKeyCursor(null,'prev');let count=0;
          request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(++count>120)s.delete(cursor.primaryKey);cursor.continue();};
        });
      }catch(_){this.cacheError=true;}
    }
    return result;
  }
  configure(options){
    this.options=options;
    addEventListener('focus',()=>this.expireOffline());
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.expireOffline();});
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
