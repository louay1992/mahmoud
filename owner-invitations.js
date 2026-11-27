(function(global){
 'use strict';const $=id=>document.getElementById(id),esc=DeliverySubscription.esc;
 let client=null,key=null,current=()=>false,generation=0,readSequence=0,busy=false,records=[];
 const message=(text,error=false)=>{$('owner-invite-message').textContent=text;$('owner-invite-message').style.color=error?'#b91c1c':'';};
 function controls(disabled){$('owner-invite-fields').disabled=disabled;$('owner-invites-list').querySelectorAll('button').forEach(b=>b.disabled=disabled);}
 async function request(query){let timer;try{return await Promise.race([Promise.resolve(query),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),15000);})]);}catch(error){return {data:null,error};}finally{clearTimeout(timer);}}
 async function load(){
  if(!client||!current())return;const seq=++readSequence,gen=generation;
  const {data,error}=await request(client.rpc('owner_admin_invites'));if(gen!==generation||seq!==readSequence||!current())return;
  if(error){document.dispatchEvent(new CustomEvent('owner-invites-change',{detail:{records,error:true}}));$('owner-invites-list').textContent='تعذّر تحميل حالة الدعوات. حدّث بيانات اللوحة للمحاولة مجددًا.';return;}
  records=Array.isArray(data)?data:[];render();document.dispatchEvent(new CustomEvent('owner-invites-change',{detail:{records,error:false}}));

 }
 function render(){
  const query=$('owner-invite-search').value.trim().toLowerCase(),filter=$('owner-invite-filter').value;
  const visible=records.filter(x=>(filter==='all'||x.status===filter)&&(!query||(x.email+' '+(x.name||'')).toLowerCase().includes(query)));
  const labels={active:'حساب مفعّل',pending:'بانتظار تأكيد البريد والتعيين',failed:'تعذّر إرسال البريد',sending:'جارٍ تجهيز الدعوة',deleting:'الوصول ملغى · إكمال حذف حساب الدخول'};
  $('owner-invites-list').innerHTML=visible.map(x=>`<div class="owner-invite-row"><div><b>${esc(x.name||'الحساب الإداري')}</b><span dir="ltr">${esc(x.email)}</span><small class="owner-invite-status ${esc(x.status)}">${labels[x.status]||'بانتظار التفعيل'}</small>${x.pending_email?`<small>تغيير البريد بانتظار تفعيل: <span dir="ltr">${esc(x.pending_email)}</span></small>`:''}${x.email_sent_at?`<small class="owner-invite-date">آخر إرسال: ${esc(new Date(x.email_sent_at).toLocaleString('ar-SY',{timeZone:'Asia/Damascus'}))}</small>`:''}</div><div class="owner-account-actions">${x.status!=='deleting'?`<button class="b secondary" type="button" data-edit="${esc(x.email)}">تعديل</button><button class="b secondary" type="button" data-resend="${esc(x.email)}" ${busy?'disabled':''}>${x.status==='active'?'إرسال رابط كلمة المرور':'إعادة إرسال رابط التفعيل'}</button>`:''}<button class="b danger" type="button" data-delete="${esc(x.email)}" ${busy?'disabled':''}>${x.status==='deleting'?'إكمال الحذف':'حذف الحساب'}</button></div></div>`).join('')||'<p class="owner-empty">'+(records.length?'لا توجد حسابات تطابق البحث أو الحالة.':'لا توجد حسابات مضافة من لوحة المالك بعد.')+'</p>';
 }
 $('owner-invite-search').oninput=render;$('owner-invite-filter').onchange=render;$('owner-invites-refresh').onclick=()=>{if(!busy)void load();};
 async function send(email,name,fromForm=false){
  if(!client||!current()||busy)return;const gen=generation;busy=true;controls(true);message('جارٍ إرسال رسالة التحقق وتعيين كلمة المرور…');
  try{
   if(!await OwnerMfa.ensure()||gen!==generation||!current()){if(gen===generation)message('');return;}
   const {data,error}=await request(client.functions.invoke('owner-invite-admin',{body:{email,name}}));
   if(gen!==generation||!current())return;
   if(error||data?.ok!==true){let detail='تعذّر تأكيد إرسال الدعوة. حدّث الحالة قبل المحاولة مجددًا.';if(error?.context?.json){try{const body=await error.context.json();if(typeof body.error==='string')detail=body.error;}catch{}}if(gen===generation&&current())message(detail,true);return;}
   if(fromForm)$('owner-invite-form').reset();message('أُرسلت رسالة التحقق وتعيين كلمة المرور إلى '+data.email+'. تظهر حالة التفعيل في القائمة.');
  }finally{if(gen===generation&&current()){busy=false;controls(false);await load();}}
 }
 $('owner-invite-form').onsubmit=event=>{event.preventDefault();void send($('owner-invite-email').value.trim(),$('owner-invite-name').value.trim(),true);};
 const dialog=document.createElement('dialog');dialog.id='owner-account-dialog';dialog.setAttribute('aria-label','تعديل الحساب الإداري');document.body.append(dialog);let editing=null;
 function edit(record,deleting){
  editing={record,deleting};dialog.innerHTML=`<form id="owner-account-form" class="owner-confirm-inner"><h2>${deleting?'حذف الحساب الإداري':'تعديل معلومات الإداري'}</h2><p>${deleting?'سيُلغى وصول الحساب ودعواته، وتُحذف بيانات تسجيل دخوله. تبقى الطلبات والسجلات التشغيلية محفوظة.':'تعديل البريد يرسل رابطًا للبريد الجديد. تنتقل الصلاحيات بعد تأكيده وتعيين كلمة المرور؛ يبقى الحساب الحالي حتى ذلك الوقت.'}</p><p dir="ltr">${esc(record.email)}</p>${deleting?'<label>اكتب البريد لتأكيد الحذف<input name="confirmation" type="email" dir="ltr" required autocomplete="off"></label>':`<label>الاسم<input name="name" maxlength="100" value="${esc(record.name||'')}"></label><label>البريد الإلكتروني<input name="email" type="email" dir="ltr" required maxlength="254" value="${esc(record.email)}"></label>`}<p id="owner-account-message" role="status"></p><div class="owner-form-actions"><button class="b ${deleting?'danger':''}" type="submit">${deleting?'تأكيد الحذف':'حفظ التعديل'}</button><button class="b secondary" type="button" id="owner-account-cancel">إلغاء</button></div></form>`;
  dialog.querySelector('#owner-account-cancel').onclick=()=>dialog.close();dialog.querySelector('form').onsubmit=async event=>{
   event.preventDefault();if(busy||!current())return;const gen=generation,form=event.currentTarget;busy=true;controls(true);form.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{if(!await OwnerMfa.ensure()||gen!==generation||!current())return;
    const {data,error}=await request(client.functions.invoke('owner-manage-admin',{body:{action:deleting?'delete':'update',email:record.email,name:form.elements.name?.value||'',new_email:form.elements.email?.value||record.email,confirmation:form.elements.confirmation?.value||''}}));if(gen!==generation||!current())return;
    let detail=data?.message||data?.error;if(error?.context?.json)try{detail=(await error.context.json()).error;}catch{}
    if(error||data?.ok!==true){dialog.querySelector('#owner-account-message').textContent=detail||'تعذّر تأكيد العملية. حدّث القائمة قبل المحاولة مجددًا.';if(data?.access_revoked)message(detail,true);return;}
    dialog.close();message(detail||'تم حفظ العملية');
   }finally{if(gen===generation&&current()){busy=false;controls(false);form.querySelectorAll('button').forEach(b=>b.disabled=false);await load();}}
  };dialog.showModal();
 }
 $('owner-invites-list').onclick=event=>{const button=event.target.closest('button');if(!button||busy)return;const email=button.dataset.resend||button.dataset.edit||button.dataset.delete,record=records.find(x=>x.email===email);if(!record)return;if(button.dataset.resend)void send(record.email,record.name||'');else edit(record,!!button.dataset.delete);};
 global.OwnerInvitations={
  activate(nextClient,nextKey,valid){if(client!==nextClient||key!==nextKey){++generation;client=nextClient;key=nextKey;}current=valid;controls(busy);void load();},
  reset(){dialog.close();editing=null;++generation;++readSequence;client=null;key=null;current=()=>false;busy=false;records=[];$('owner-invite-search').value='';$('owner-invite-filter').value='all';$('owner-invite-form').reset();$('owner-invites-list').replaceChildren();message('');controls(true);},
 };
})(globalThis);
