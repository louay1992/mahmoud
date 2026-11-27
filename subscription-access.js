/* The server is authoritative. Offline snapshots carry the last verified expiry, never an indefinite allow flag. */
(function(global){
 'use strict';
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 class SubscriptionAccess {
  constructor(offline){this.offline=offline;this.state=null;this.generation=0;this.locked=false;
   addEventListener('focus',()=>{this.expire();if(this.locked&&navigator.onLine!==false)void this.retry();});
   document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.expire();});
  }
  expired(state=this.state){return state?.allowed===false||(state?.configured===true&&(!Number.isFinite(Date.parse(state.expires_at))||Date.now()+(Number(state.clock_offset)||0)>=Date.parse(state.expires_at)));}
  accept(state){this.state=state;clearTimeout(this.timer);if(this.expired()){this.lock(state);return false;}
   if(state?.configured){const wait=Date.parse(state.expires_at)-Date.now()-(Number(state.clock_offset)||0);this.timer=setTimeout(()=>this.expire(),Math.min(Math.max(wait,1),2147483647));}return true;
  }
  expire(){if(this.state&&this.expired())this.lock(this.state);else if(this.state)this.accept(this.state);}
  async verify(){
   const generation=++this.generation;let timer,result;
   try{result=await Promise.race([this.offline.client.rpc('subscription_access'),new Promise(resolve=>{timer=setTimeout(()=>resolve({error:{message:'network timeout'}}),12000);})]);}catch(error){result={error};}finally{clearTimeout(timer);}
   if(generation!==this.generation||this.offline.blocked())return false;
   if(result.error||result.data?.schema!==1||typeof result.data.allowed!=='boolean')throw Object.assign(Error(result.error?.message||'Subscription verification unavailable'),{code:this.offline.networkError(result)?'NETWORK':'ACCESS_DENIED'});
   this.locked=false;document.getElementById('subscription-lock')?.remove();document.body.classList.remove('subscription-stopped');
   const checked=Date.parse(result.data.checked_at);return this.accept({...result.data,clock_offset:Number.isFinite(checked)?checked-Date.now():0});
  }
  restore(state){
   // Snapshots written before expiry enforcement require one online verification.
   if(state?.schema!==1||typeof state.allowed!=='boolean'){this.lock(null,true);return false;}
   return this.accept(state);
  }
  lock(state=this.state,unknown=false){
   this.locked=true;clearTimeout(this.timer);this.state=state;document.body.classList.add('subscription-stopped');
   this.offline.options?.login();void this.offline.invalidate();Promise.resolve(this.offline.client?.removeAllChannels?.()).catch(()=>{});
   document.getElementById('splash')?.classList.add('off');document.getElementById('subscription-lock')?.remove();
   const box=document.createElement('section');box.id='subscription-lock';box.setAttribute('role','region');box.setAttribute('aria-label','حالة اشتراك الشركة');
   const date=state?.valid_until?new Date(state.valid_until+'T00:00:00Z').toLocaleDateString('ar-SY',{timeZone:'UTC',year:'numeric',month:'long',day:'numeric'}):'';
   const price=state?.renewal_amount!=null&&state.currency?`<div class="subscription-lock-price"><span>قيمة التجديد</span><strong dir="ltr">${esc(new Intl.NumberFormat('en-US').format(state.renewal_amount)+' '+state.currency)}</strong></div>`:'';
   box.innerHTML=`<div class="subscription-lock-card"><div class="subscription-lock-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></div><span>حالة اشتراك الشركة</span><h1>${unknown?'يلزم التحقق من الاشتراك':'انتهى اشتراك الشركة'}</h1><p>${unknown?'اتصل بالإنترنت للتحقق من صلاحية الاشتراك قبل استخدام التطبيق.':'توقّف استخدام التطبيق لانتهاء الاشتراك. تواصل مع '+(this.offline.role==='admin'?'مالك النظام لتجديده.':'إدارة الشركة لتجديده.')}</p>${date?`<p>كان الاشتراك صالحًا لغاية <b>${esc(date)}</b></p>`:''}${price}<button type="button" id="subscription-recheck">التحقق من التجديد</button><button type="button" id="subscription-signout" class="subscription-lock-secondary">تسجيل الخروج</button><p id="subscription-lock-message" role="status" aria-live="polite"></p></div>`;
   document.body.append(box);box.querySelector('#subscription-recheck').onclick=()=>this.retry();
   box.querySelector('#subscription-signout').onclick=()=>new DeliverySession(this.offline.storageKey).logout({auth:this.offline.client.auth,detach:()=>{},lock:()=>{this.reset();void this.offline.invalidate();this.offline.options?.login();},reload:()=>location.reload()});
  }
  async retry(){
   if(this.retrying)return;this.retrying=true;const button=document.getElementById('subscription-recheck');if(button)button.disabled=true;
   try{if(navigator.onLine===false)throw Error();if(await this.verify())await this.offline.onlineBoot();else{const m=document.getElementById('subscription-lock-message');if(m)m.textContent='لم يتم تجديد الاشتراك بعد. حاول بعد تأكيد التجديد من المالك.';}}
   catch(_){const m=document.getElementById('subscription-lock-message');if(m)m.textContent='تعذّر التحقق. اتصل بالإنترنت وحاول مجددًا.';}
   finally{this.retrying=false;const b=document.getElementById('subscription-recheck');if(b)b.disabled=false;}
  }
  reset(){++this.generation;clearTimeout(this.timer);this.state=null;this.locked=false;document.getElementById('subscription-lock')?.remove();document.body.classList.remove('subscription-stopped');}
 }
 global.DeliverySubscriptionAccess=SubscriptionAccess;
})(globalThis);
