(function(){
 'use strict';
 const $=id=>document.getElementById(id),gate=new DeliverySession('sb-admin-setup-auth'),callback=new URLSearchParams(location.hash.slice(1));
 const incoming=['invite','recovery'].includes(callback.get('type'));
 const callbackError=callback.has('error')||callback.has('error_code');
 if(incoming&&gate.blocked)gate.beginLogin();
 const client=supabase.createClient(DELIVERY_CONFIG.supabaseUrl,DELIVERY_CONFIG.supabaseAnonKey,{auth:{storageKey:'sb-admin-setup-auth'}});
 let epoch=0,user=null,saving=false,passwordSaved=false;
 const status=(text,error=false)=>{$('setup-status').textContent=text;$('setup-status').className=error?'error':'';};
 async function request(query){let timer;try{return await Promise.race([Promise.resolve(query),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),15000);})]);}catch(error){return {data:null,error};}finally{clearTimeout(timer);}}
 function lock(){++epoch;user=null;saving=false;passwordSaved=false;$('setup-form').hidden=true;$('setup-form').reset();$('setup-fields').disabled=true;$('setup-email').textContent='';$('setup-cancel').hidden=true;}
 async function boot(){
  if(callbackError){lock();status('رابط البريد غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا من شاشة دخول التطبيق أو من مالك النظام.',true);return;}
  const seq=++epoch;if(gate.blocked&&!incoming){gate.clearSession();lock();status('افتح رابط التحقق المرسل إلى بريدك، أو اطلب رابطًا جديدًا من شاشة دخول التطبيق.',true);return;}
  const {data,error}=await request(client.auth.getSession());if(seq!==epoch)return;
  if(error||!data?.session){lock();status('رابط البريد غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا من شاشة دخول التطبيق أو من مالك النظام.',true);return;}
  const access=await request(client.rpc('admin_setup_access'));if(seq!==epoch)return;
  if(access.error||access.data?.allowed!==true){lock();status('تعذّر اعتماد هذا الحساب الإداري. تحقق من الدعوة أو تواصل مع مالك النظام.',true);return;}
  gate.completeLogin();user=data.session.user;$('setup-email').textContent=access.data.email;$('setup-form').hidden=false;$('setup-fields').disabled=false;$('setup-cancel').hidden=false;status('تم التحقق من بريدك. اختر كلمة المرور وأكّدها لإكمال الدخول.');
 }
 $('setup-cancel').onclick=()=>gate.logout({auth:client.auth,detach:()=>{},lock:()=>{lock();status('أُلغي تعيين كلمة المرور.');},reload:()=>location.replace('/admin.html')});
 $('setup-form').addEventListener('submit',async event=>{
  event.preventDefault();if(saving||!user||gate.blocked)return;
  const password=$('setup-password').value;
  if(!passwordSaved&&(password.length<8||password!==$('setup-confirm').value)){status('أدخل كلمة مرور من 8 أحرف على الأقل وتأكد أن الكلمتين متطابقتان.',true);return;}
  const seq=++epoch,who=user.id;saving=true;$('setup-fields').disabled=true;$('setup-save').disabled=true;status('جارٍ حفظ بيانات الحساب…');
  if(!passwordSaved){
   const result=await request(client.auth.updateUser({password}));if(seq!==epoch||user?.id!==who||gate.blocked)return;
   if(result.error){saving=false;$('setup-fields').disabled=false;$('setup-save').disabled=false;status('تعذّر حفظ كلمة المرور. تحقق من الرابط وحاول مجددًا.',true);return;}
   passwordSaved=true;$('setup-password').value='';$('setup-confirm').value='';
  }
  const result=await request(client.rpc('complete_admin_setup'));if(seq!==epoch||user?.id!==who||gate.blocked)return;
  if(result.error||result.data?.active!==true){saving=false;$('setup-save').disabled=false;$('setup-save').textContent='إكمال تفعيل الحساب';status('حُفظت كلمة المرور، لكن تعذّر إكمال تفعيل الحساب. اضغط لإعادة محاولة التفعيل أو تواصل مع المالك.',true);return;}
  sessionStorage.setItem('delivery-admin-account-ready','1');
  await gate.logout({auth:client.auth,detach:()=>{},lock, reload:()=>location.replace('/admin.html')});
 });
 void boot();
})();
