(function(global){
 'use strict';
 const $=id=>document.getElementById(id),dialog=$('owner-mfa-dialog');
 const form=$('owner-mfa-form'),code=$('owner-mfa-code'),enroll=$('owner-mfa-enroll'),verify=$('owner-mfa-verify'),cancel=$('owner-mfa-cancel');
 const message=text=>{$('owner-mfa-message').textContent=text;};
 let client,current=()=>false,serial=0,pending=null,finish=null,factor=null,provisional=false,busy=false;
 function setBusy(value){busy=value;enroll.disabled=value;verify.disabled=value;cancel.disabled=value;}
 function clear(){form.reset();$('owner-mfa-enrollment').hidden=true;$('owner-mfa-qr').removeAttribute('src');$('owner-mfa-secret').textContent='';enroll.hidden=true;$('owner-mfa-code-field').hidden=true;verify.hidden=true;message('');setBusy(false);}
 function choose(id){factor=id;$('owner-mfa-code-field').hidden=false;verify.hidden=false;code.focus();}
 function complete(value){
  const resolve=finish,unused=provisional&&factor,auth=client?.auth;
  ++serial;factor=null;provisional=false;finish=null;clear();
  if(dialog.open)dialog.close();
  if(unused)void auth?.mfa.unenroll({factorId:unused}).catch(()=>{});
  resolve?.(value);
 }
 async function needVerification(){
  if(!client||!current())return false;
  const api=client,gen=serial;
  try{
   const {data,error}=await api.rpc('owner_has_strong_session');
   if(gen!==serial||!current())return false;
   if(!error&&data===true)return true;
   if(error)throw error;
   const result=await api.auth.mfa.listFactors();
   if(gen!==serial||!current())return false;
   if(result.error)throw result.error;
   const factors=result.data.totp.filter(item=>item.status==='verified');
   return new Promise(resolve=>{
    finish=resolve;clear();dialog.showModal();
    if(factors.length){choose(factors[0].id);message('أدخل الرمز الحالي من تطبيق المصادقة.');}
    else{enroll.hidden=false;enroll.focus();message('اربط حساب المالك بتطبيق مصادقة لتأكيد العمليات الحساسة.');}
   });
  }catch(_){if(gen===serial&&current()){const node=$('owner-message');node.className='owner-message error';node.textContent='تعذّر التحقق من المصادقة الإضافية. حدّث اللوحة وحاول مجددًا.';}return false;}
 }
 enroll.onclick=async()=>{
  if(!finish||busy||!current())return;
  const gen=serial,api=client;setBusy(true);message('جارٍ تجهيز رمز الربط…');
  try{
   const {data,error}=await api.auth.mfa.enroll({factorType:'totp',friendlyName:'NatureCare Owner'});
   if(gen!==serial||!current()){if(data?.id)void api.auth.mfa.unenroll({factorId:data.id}).catch(()=>{});return;}
   if(error||!data?.id)throw error||Error('Missing factor');
   provisional=true;choose(data.id);
   const qr=data.totp?.qr_code||'';
   const image=$('owner-mfa-qr');
   if(qr.startsWith('data:image/svg+xml;utf-8,'))image.src=qr;
   else if(qr.startsWith('<svg'))image.src='data:image/svg+xml,'+encodeURIComponent(qr);
   image.hidden=!image.hasAttribute('src');
   $('owner-mfa-secret').textContent=data.totp?.secret||'';
   $('owner-mfa-enrollment').hidden=false;enroll.hidden=true;message('أضف الحساب في تطبيق المصادقة، ثم أدخل رمز التحقق.');
  }catch(_){if(gen===serial)message('تعذّر إنشاء عامل المصادقة. حاول مجددًا.');}
  finally{if(gen===serial)setBusy(false);}
 };
 form.onsubmit=async event=>{
  event.preventDefault();if(!finish||!factor||busy||!current())return;
  const digits=code.value.trim().replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
  if(!/^\d{6}$/.test(digits)){message('أدخل رمز المصادقة من ستة أرقام.');return;}
  const gen=serial,api=client,factorId=factor;setBusy(true);message('جارٍ التحقق…');
  try{
   const {error}=await api.auth.mfa.challengeAndVerify({factorId,code:digits});
   if(gen!==serial||!current())return;
   if(error)throw error;
   provisional=false;
   const strong=await api.rpc('owner_has_strong_session');
   if(gen!==serial||!current())return;
   if(strong.error||strong.data!==true)throw Error('MFA verification unavailable');
   complete(true);
  }catch(_){if(gen===serial){code.value='';message('تعذّر تأكيد الرمز. تأكد من الرمز الحالي وحاول مجددًا.');code.focus();}}
  finally{if(gen===serial)setBusy(false);}
 };
 cancel.onclick=()=>{if(!busy)complete(false);};
 dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy)complete(false);});
 global.OwnerMfa={
  activate(nextClient,valid){client=nextClient;current=valid;},
  ensure(){if(!pending){const request=needVerification();pending=request;void request.finally(()=>{if(pending===request)pending=null;});}return pending;},
  reset(){complete(false);pending=null;current=()=>false;client=null;},
 };
})(globalThis);
