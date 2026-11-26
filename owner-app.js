(function(){
 'use strict';
 const $=id=>document.getElementById(id),ui=DeliverySubscription,gate=new DeliverySession('sb-subscription-owner-auth');
 const client=supabase.createClient(DELIVERY_CONFIG.supabaseUrl,DELIVERY_CONFIG.supabaseAnonKey,{auth:{storageKey:'sb-subscription-owner-auth'}});
 let epoch=0,user=null,snapshot=null,saving=false,dirty=false;
 const message=(text,kind='')=>{$('owner-message').textContent=text;$('owner-message').className='owner-message '+kind;};
 async function request(query){const controller=new AbortController();let timer;try{if(query.abortSignal)query=query.abortSignal(controller.signal);return await Promise.race([Promise.resolve(query),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('انتهت مهلة الاتصال'));},15000);})]);}catch(error){return {data:null,error};}finally{clearTimeout(timer);}}
 function lock(){++epoch;user=null;snapshot=null;dirty=false;saving=false;$('owner-dashboard').hidden=true;$('owner-login').hidden=false;$('owner-preview').replaceChildren();$('owner-history').replaceChildren();$('owner-subscription-form').reset();$('owner-password').value='';}
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
  draw(data);message('');
 }
 async function boot(){
  const seq=++epoch;if(gate.blocked){gate.clearSession();lock();return;}
  const {data,error}=await request(client.auth.getSession());
  if(seq!==epoch||gate.blocked)return;
  if(error){message('تعذّر التحقق من الجلسة. حاول تسجيل الدخول.','error');return;}
  if(!data?.session){lock();return;}
  const access=await request(client.rpc('is_subscription_owner'));
  if(seq!==epoch||gate.blocked)return;
  if(access.error){message('تعذّر التحقق من صلاحية الحساب. حاول مجددًا.','error');return;}
  if(access.data!==true){lock();message('هذا الحساب لا يملك صلاحية لوحة المالك. استخدم حساب المالك المعتمد.','error');return;}
  user=data.session.user;$('owner-password').value='';$('owner-login').hidden=true;$('owner-dashboard').hidden=false;$('owner-fields').disabled=true;await load();
 }
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
 void boot();
})();
