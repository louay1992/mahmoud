(function(){
 'use strict';
 const $=id=>document.getElementById(id),ui=DeliverySubscription,gate=new DeliverySession('sb-subscription-owner-auth');
 const callback=new URLSearchParams(location.hash.slice(1)),callbackError=callback.has('error')||callback.has('error_code');
 const recoveryCallback=callback.get('type')==='recovery';
 let recovering=recoveryCallback||sessionStorage.getItem('delivery-owner-recovery')==='1';
 // A real email callback can start a new login after local sign-out, but must not revive the old stored session.
 if(gate.blocked){if(recoveryCallback)gate.beginLogin();else{recovering=false;sessionStorage.removeItem('delivery-owner-recovery');}}
 const client=supabase.createClient(DELIVERY_CONFIG.supabaseUrl,DELIVERY_CONFIG.supabaseAnonKey,{auth:{storageKey:'sb-subscription-owner-auth'}});
 let epoch=0,user=null,snapshot=null,saving=false,dirty=false;
 const message=(text,kind='')=>{$('owner-message').textContent=text;$('owner-message').className='owner-message '+kind;};
 async function request(query){const controller=new AbortController();let timer;try{if(query.abortSignal)query=query.abortSignal(controller.signal);return await Promise.race([Promise.resolve(query),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('انتهت مهلة الاتصال'));},15000);})]);}catch(error){return {data:null,error};}finally{clearTimeout(timer);}}
 function lock(){++epoch;user=null;snapshot=null;dirty=false;saving=false;recovering=false;globalThis.OwnerInvitations?.reset();sessionStorage.removeItem('delivery-owner-recovery');$('owner-dashboard').hidden=true;$('owner-recovery').hidden=true;$('owner-recovery-fields').disabled=true;$('owner-recovery-form').reset();$('owner-login').hidden=false;$('owner-preview').replaceChildren();$('owner-history').replaceChildren();$('owner-subscription-form').reset();$('owner-password').value='';}
 function draw(payload){
  snapshot=payload;const s=payload.subscription,form=$('owner-subscription-form');
  $('owner-preview').innerHTML=ui.card(s);for(const k of ['starts_on','valid_until','renewal_amount','currency'])form.elements[k].value=s.configured?s[k]:'';
  $('owner-updated').textContent=s.updated_at?'آخر تحديث: '+new Date(s.updated_at).toLocaleString('ar-SY'):'أدخل بيانات الاشتراك للمرة الأولى.';
  $('owner-history').innerHTML=(payload.changes||[]).map(x=>`<div class="owner-history-entry"><div><b>الصلاحية حتى ${ui.date(x.new_value.valid_until)}</b><br><span>${ui.esc(ui.amount(x.new_value.renewal_amount,x.new_value.currency))}</span></div><small>${ui.esc(new Date(x.created_at).toLocaleString('ar-SY'))}</small></div>`).join('')||'<p class="owner-muted">لا توجد تعديلات مسجلة بعد.</p>';
  dirty=false;$('owner-fields').disabled=false;
 }
 async function load(){
  if(!user||gate.blocked)return;const seq=++epoch,who=user.id;$('owner-refresh').disabled=true;
  const {data,error}=await request(client.rpc('owner_subscription'));
  if(seq!==epoch||gate.blocked||user?.id!==who)return;
  $('owner-refresh').disabled=false;
  if(error){message('تعذّر تحميل بيانات الاشتراك. حاول مجددًا.','error');return;}
  draw(data);message('');globalThis.OwnerInvitations?.activate(client,who,()=>user?.id===who&&!gate.blocked);
 }
 async function boot(){
  const seq=++epoch;if(gate.blocked&&!recovering){gate.clearSession();lock();if(callbackError)message('رابط البريد غير صالح أو انتهت صلاحيته. أدخل بريدك واطلب رابطًا جديدًا.','error');return;}
  const {data,error}=await request(client.auth.getSession());
  if(seq!==epoch||(gate.blocked&&!recovering))return;
  if(error){message(recovering?'تعذّر التحقق من رابط البريد. اطلب رابطًا جديدًا.':'تعذّر التحقق من الجلسة. حاول تسجيل الدخول.','error');return;}
  if(!data?.session){const needsLink=recovering||callbackError;lock();if(needsLink)message('رابط البريد غير صالح أو انتهت صلاحيته. أدخل بريدك واطلب رابطًا جديدًا.','error');return;}
  const access=await request(client.rpc('is_subscription_owner'));
  if(seq!==epoch||(gate.blocked&&!recovering))return;
  if(access.error){message('تعذّر التحقق من صلاحية الحساب. حاول مجددًا.','error');return;}
  if(access.data!==true){lock();message('هذا الحساب لا يملك صلاحية لوحة المالك. استخدم حساب المالك المعتمد.','error');return;}
  user=data.session.user;$('owner-password').value='';$('owner-login').hidden=true;
  if(recovering){gate.completeLogin();sessionStorage.setItem('delivery-owner-recovery','1');$('owner-dashboard').hidden=true;$('owner-recovery').hidden=false;$('owner-recovery-fields').disabled=false;message('تم التحقق من رابط البريد. عيّن كلمة المرور الجديدة.');return;}
  $('owner-recovery').hidden=true;$('owner-dashboard').hidden=false;$('owner-fields').disabled=true;await load();
 }
 // Do not await SDK calls inside this callback: Supabase holds its auth lock while notifying listeners.
 client.auth.onAuthStateChange?.(event=>{if(event==='PASSWORD_RECOVERY'){recovering=true;setTimeout(()=>{void boot();},0);}});
 $('owner-reset-request').onclick=async()=>{
  const email=$('owner-email');if(!email.reportValidity())return;
  const seq=epoch,button=$('owner-reset-request');button.disabled=true;message('جارٍ إرسال رابط تعيين كلمة المرور…');
  const {error}=await request(client.auth.resetPasswordForEmail(email.value.trim(),{redirectTo:new URL('/owner.html',location.origin).href}));button.disabled=false;
  if(seq!==epoch)return;
  message(error?'تعذّر إرسال الرابط. حاول مجددًا لاحقًا.':'إذا كان البريد مرتبطًا بحساب، ستصلك رسالة تحتوي رابط تعيين كلمة المرور.',error?'error':'success');
 };
 $('owner-recovery-exit').onclick=()=>gate.logout({auth:client.auth,detach:()=>{},lock:()=>{lock();message('');},reload:()=>location.replace('/owner.html')});
 $('owner-recovery-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!recovering||!user||saving||gate.blocked)return;
  const password=$('owner-new-password').value;
  if(password.length<8||password!==$('owner-confirm-password').value){message('أدخل كلمة مرور من 8 أحرف على الأقل، وتأكد أن الكلمتين متطابقتان.','error');return;}
  saving=true;$('owner-recovery-fields').disabled=true;message('جارٍ حفظ كلمة المرور…');const seq=++epoch,who=user.id;
  const {error}=await request(client.auth.updateUser({password}));
  if(seq!==epoch||gate.blocked||user?.id!==who)return;
  saving=false;$('owner-recovery-fields').disabled=false;
  if(error){message('تعذّر حفظ كلمة المرور. تحقق من صلاحية الرابط وحاول مجددًا.','error');return;}
  sessionStorage.setItem('delivery-owner-password-updated','1');
  await gate.logout({auth:client.auth,detach:()=>{},lock:()=>{lock();message('');},reload:()=>location.replace('/owner.html')});
 });
 $('owner-login-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('owner-login-button');button.disabled=true;message('جارٍ تسجيل الدخول…');if(gate.blocked)gate.beginLogin();
  const {error}=await request(client.auth.signInWithPassword({email:$('owner-email').value.trim(),password:$('owner-password').value}));button.disabled=false;
  if(error){message('تعذّر تسجيل الدخول. تحقق من البيانات والاتصال.','error');return;}gate.completeLogin();await boot();
 });
 $('owner-logout').onclick=()=>gate.logout({auth:client.auth,detach:()=>{},lock:()=>{lock();message('');},reload:()=>location.reload()});
 $('owner-refresh').onclick=()=>{if(dirty){message('توجد تعديلات غير محفوظة. احفظها أو أعد فتح الصفحة لتجاهلها.','error');return;}load();};
 $('owner-subscription-form').addEventListener('input',()=>{dirty=true;});
 $('owner-subscription-form').addEventListener('submit',async event=>{
  event.preventDefault();if(saving||!user||!snapshot||gate.blocked)return;
  const form=event.currentTarget,values=Object.fromEntries(['starts_on','valid_until','renewal_amount','currency'].map(k=>[k,form.elements[k].value.trim()]));
  const invalid=ui.validate(values);if(invalid){message(invalid,'error');return;}
  saving=true;$('owner-fields').disabled=true;$('owner-refresh').disabled=true;message('جارٍ حفظ بيانات الاشتراك…');const seq=++epoch,who=user.id;
  const {data,error}=await request(client.rpc('save_subscription',{p_starts_on:values.starts_on,p_valid_until:values.valid_until,p_renewal_amount:values.renewal_amount,p_currency:values.currency,p_expected_revision:snapshot.subscription.revision||0}));
  if(seq!==epoch||gate.blocked||user?.id!==who)return;
  saving=false;$('owner-fields').disabled=false;$('owner-refresh').disabled=false;
  if(error){message('تعذّر تأكيد الحفظ. '+(error.message||'حدّث البيانات للتحقق قبل المحاولة مجددًا.'),'error');return;}
  const previous=snapshot.subscription.configured?snapshot.subscription:null;
  draw({subscription:data,changes:[{new_value:data,previous_value:previous,created_at:data.updated_at},...(snapshot.changes||[])].slice(0,20)});message('حُفظت بيانات الاشتراك، وتظهر للشركة عند تحديث قسم إدارة الاشتراك.','success');
 });
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 if(sessionStorage.getItem('delivery-owner-password-updated')==='1'){sessionStorage.removeItem('delivery-owner-password-updated');message('حُفظت كلمة المرور. سجّل دخولك بالبريد وكلمة المرور الجديدة.','success');}
 void boot();
})();
