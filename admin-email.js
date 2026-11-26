(function(global){
 'use strict';
 function open({auth,email=''}){
  if(document.getElementById('admin-email-dialog'))return;
  const dialog=document.createElement('dialog');dialog.id='admin-email-dialog';dialog.className='admin-email-dialog';dialog.dir='rtl';dialog.setAttribute('aria-labelledby','admin-email-title');
  dialog.innerHTML='<form><h2 id="admin-email-title">إعادة تعيين كلمة المرور</h2><p>نرسل رابطًا إلى بريد حسابك الإداري لتختار كلمة مرور جديدة.</p><label>البريد الإلكتروني<input name="email" type="email" dir="ltr" autocomplete="email" inputmode="email" required maxlength="254"></label><p class="admin-email-status" role="status" aria-live="polite"></p><div class="admin-email-actions"><button type="submit">إرسال الرابط</button><button type="button" class="secondary" data-close>إغلاق</button></div></form>';
  const input=dialog.querySelector('input'),button=dialog.querySelector('[type=submit]'),message=dialog.querySelector('[role=status]');input.value=email;
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  dialog.querySelector('form').onsubmit=async event=>{
   event.preventDefault();if(button.disabled)return;button.disabled=true;input.disabled=true;message.classList.remove('error');message.textContent='جارٍ إرسال رابط البريد…';let timer;
   try{
    const result=await Promise.race([auth.resetPasswordForEmail(input.value.trim(),{redirectTo:new URL('/account-setup.html',location.origin).href}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),15000);})]);
    if(result.error)throw result.error;
    message.textContent='إذا كان البريد مرتبطًا بحساب، ستصلك رسالة تحتوي رابط تعيين كلمة المرور. تحقق من البريد الوارد والرسائل غير المرغوبة.';
   }catch{message.classList.add('error');message.textContent='تعذّر تأكيد إرسال الرابط. تحقق من بريدك قبل المحاولة مجددًا، أو تواصل مع مسؤول النظام.';}
   finally{clearTimeout(timer);if(dialog.isConnected){button.disabled=false;input.disabled=false;}}
  };
  document.body.append(dialog);dialog.showModal();input.focus();
 }
 global.DeliveryAdminEmail={open};
})(globalThis);
