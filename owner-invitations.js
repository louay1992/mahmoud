(function(global){
 'use strict';const $=id=>document.getElementById(id),esc=DeliverySubscription.esc;
 let client=null,key=null,current=()=>false,generation=0,readSequence=0,busy=false,records=[];
 const message=(text,error=false)=>{$('owner-invite-message').textContent=text;$('owner-invite-message').style.color=error?'#b91c1c':'';};
 function controls(disabled){$('owner-invite-fields').disabled=disabled;$('owner-invites-list').querySelectorAll('button').forEach(b=>b.disabled=disabled);}
 async function request(query){let timer;try{return await Promise.race([Promise.resolve(query),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),15000);})]);}catch(error){return {data:null,error};}finally{clearTimeout(timer);}}
 async function load(){
  if(!client||!current())return;const seq=++readSequence,gen=generation;
  const {data,error}=await request(client.rpc('owner_admin_invites'));if(gen!==generation||seq!==readSequence||!current())return;
  if(error){$('owner-invites-list').textContent='تعذّر تحميل حالة الدعوات. حدّث بيانات اللوحة للمحاولة مجددًا.';return;}
  records=Array.isArray(data)?data:[];const labels={active:'حساب مفعّل',pending:'بانتظار تأكيد البريد والتعيين',failed:'تعذّر إرسال البريد',sending:'جارٍ تجهيز الدعوة'};
  $('owner-invites-list').innerHTML=records.map(x=>`<div class="owner-invite-row"><div><b>${esc(x.name||'الحساب الإداري')}</b><span dir="ltr">${esc(x.email)}</span><small class="owner-invite-status ${esc(x.status)}">${labels[x.status]||'بانتظار التفعيل'}</small></div><button class="b secondary" type="button" data-resend="${esc(x.email)}" ${busy?'disabled':''}>${x.status==='active'?'إرسال رابط كلمة المرور':'إعادة إرسال رابط التفعيل'}</button></div>`).join('')||'<p class="owner-muted">لا توجد حسابات مضافة من لوحة المالك بعد.</p>';
 }
 async function send(email,name){
  if(!client||!current()||busy)return;const gen=generation;busy=true;controls(true);message('جارٍ إرسال رسالة التحقق وتعيين كلمة المرور…');
  try{
   const {data,error}=await request(client.functions.invoke('owner-invite-admin',{body:{email,name}}));
   if(gen!==generation||!current())return;
   if(error||data?.ok!==true){let detail='تعذّر تأكيد إرسال الدعوة. حدّث الحالة قبل المحاولة مجددًا.';if(error?.context?.json){try{const body=await error.context.json();if(typeof body.error==='string')detail=body.error;}catch{}}if(gen===generation&&current())message(detail,true);return;}
   $('owner-invite-form').reset();message('أُرسلت رسالة التحقق وتعيين كلمة المرور إلى '+data.email+'. تظهر حالة التفعيل في القائمة.');
  }finally{if(gen===generation&&current()){busy=false;controls(false);await load();}}
 }
 $('owner-invite-form').onsubmit=event=>{event.preventDefault();void send($('owner-invite-email').value.trim(),$('owner-invite-name').value.trim());};
 $('owner-invites-list').onclick=event=>{const button=event.target.closest('button[data-resend]');if(!button)return;const record=records.find(x=>x.email===button.dataset.resend);if(record)void send(record.email,record.name||'');};
 global.OwnerInvitations={
  activate(nextClient,nextKey,valid){if(client!==nextClient||key!==nextKey){++generation;client=nextClient;key=nextKey;}current=valid;controls(busy);void load();},
  reset(){++generation;++readSequence;client=null;key=null;current=()=>false;busy=false;records=[];$('owner-invite-form').reset();$('owner-invites-list').replaceChildren();message('');controls(true);},
 };
})(globalThis);
