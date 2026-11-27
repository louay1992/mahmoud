(function(global){
 'use strict';const $=id=>document.getElementById(id),ui=DeliverySubscription,fields=['starts_on','valid_until','renewal_amount','currency'];
 let payload=null,confirmation=null;
 const day=864e5,iso=d=>d.toISOString().slice(0,10),calendar=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&iso(new Date(value+'T00:00:00Z'))===value;
 function annualEnd(start){if(!calendar(start))return null;const d=new Date(start+'T00:00:00Z');d.setUTCFullYear(d.getUTCFullYear()+1);return iso(new Date(d.getTime()-day));}
 const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Damascus',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const values=()=>Object.fromEntries(fields.map(k=>[k,$('owner-subscription-form').elements[k].value.trim()]));
 const fieldLabels={starts_on:'بداية الاشتراك',valid_until:'نهاية الاشتراك',renewal_amount:'قيمة التجديد',currency:'العملة'};
 const display=(key,value)=>key.endsWith('_on')||key==='valid_until'?ui.date(value):key==='renewal_amount'?new Intl.NumberFormat('en-US').format(value):ui.esc(value);
 function changes(a,b){return fields.filter(k=>k==='renewal_amount'?Number(a?.[k])!==Number(b?.[k]):a?.[k]!==b?.[k]);}
 function differences(a,b){return changes(a,b).map(k=>`<div class="owner-diff"><b>${fieldLabels[k]}</b><span>${a?display(k,a[k]):'لم يكن محددًا'}</span><span aria-hidden="true">←</span><strong>${display(k,b[k])}</strong></div>`).join('');}
 function drawHistory(){
  const filter=$('owner-history-filter').value,all=payload?.changes||[],rows=all.filter(x=>filter==='all'||changes(x.previous_value,x.new_value).some(k=>filter==='dates'?['starts_on','valid_until'].includes(k):['renewal_amount','currency'].includes(k)));
  $('owner-history-count').textContent=all.length?(all.length===1?'آخر تعديل':all.length===2?'آخر تعديلين':'آخر '+all.length+' تعديلًا'):'لا يوجد سجل بعد';
  $('owner-history').innerHTML=rows.map(x=>`<details class="owner-history-entry"><summary><span><b>${x.previous_value?'تعديل بيانات الاشتراك':'اعتماد الاشتراك للمرة الأولى'}</b><small>${ui.esc(new Date(x.created_at).toLocaleString('ar-SY',{timeZone:'Asia/Damascus'}))} · دمشق</small></span><span class="owner-detail-label">عرض التفاصيل</span></summary><div class="owner-differences">${differences(x.previous_value,x.new_value)}</div></details>`).join('')||'<p class="owner-empty">لا توجد تعديلات تطابق هذا الاختيار.</p>';
 }
 function draft(){
  const v=values(),invalid=ui.validate(v),original=payload?.subscription;
  const changed=original?.configured?changes(original,v).length>0:fields.some(k=>v[k]);
  $('owner-draft-state').textContent=changed?'تعديلات غير محفوظة':'البيانات المحفوظة معتمدة';$('owner-draft-state').className=changed?'owner-draft-state dirty':'owner-draft-state';
  $('owner-discard').disabled=!changed;
  $('owner-draft-summary').textContent=invalid?'حدّد المدة وقيمة التجديد لمراجعتها قبل الحفظ.':'المدة: '+Math.round((Date.parse(v.valid_until)-Date.parse(v.starts_on))/day+1)+' يومًا · قيمة التجديد: '+ui.amount(v.renewal_amount,v.currency);
 }
 function draw(next){
  payload=next;const s=next.subscription,c=s.configured===true;
  const status=c?{active:'ساري',expired:'متوقف لانتهاء الاشتراك',upcoming:'لم يبدأ بعد'}[s.status]:'بانتظار الإعداد';
  $('owner-state-value').textContent=status||'غير محدد';$('owner-state-value').dataset.status=s.status||'empty';
  $('owner-days-value').textContent=c?Math.max(0,Number(s.days_remaining))+' يوم':'—';
  $('owner-amount-value').textContent=c?ui.amount(s.renewal_amount,s.currency):'—';
  const duration=Number(s.duration_days)||Math.round((Date.parse(s.valid_until)-Date.parse(s.starts_on))/day+1);
  const elapsed=c?Math.max(0,Math.min(100,Math.round(100*(duration-Number(s.days_remaining)-1)/duration))):0;
  $('owner-progress').value=s.status==='upcoming'?0:elapsed;$('owner-progress-label').textContent=c?'انقضى '+(s.status==='upcoming'?0:elapsed)+'٪ من مدة الاشتراك':'تظهر المدة بعد اعتماد الاشتراك';
  const notice=$('owner-notice');notice.className='owner-notice '+(s.status==='expired'?'expired':'');
  notice.textContent=!c?'ابدأ بتحديد مدة الاشتراك ومبلغ التجديد، ثم أضف الحساب الإداري للمشترك.':s.status==='expired'?'تطبيق الشركة متوقف. جدّد مدة الاشتراك وأكّد الحفظ لإعادة تشغيله.':Number(s.days_remaining)<=30?'اقترب انتهاء الاشتراك. يتوقف التطبيق بعد نهاية '+ui.date(s.valid_until)+' بتوقيت دمشق.':'يتوقف تطبيق الإداري والكابتن تلقائيًا بعد نهاية '+ui.date(s.valid_until)+' بتوقيت دمشق، ويعود بعد التجديد.';
  drawHistory();draft();
 }
 function setTerm(renew){
  if(!payload||$('owner-fields').disabled)return;const form=$('owner-subscription-form'),s=payload.subscription;
  let start=form.elements.starts_on.value;
  if(renew){if(s.configured&&s.status!=='expired'){const next=iso(new Date(Date.parse(s.valid_until+'T00:00:00Z')+day));start=s.starts_on;form.elements.valid_until.value=annualEnd(next)||'';}else{start=payload.subscription.checked_on||today();form.elements.valid_until.value=annualEnd(start)||'';}}
  else{if(!calendar(start))start=payload.subscription.checked_on||today();form.elements.valid_until.value=annualEnd(start)||'';}
  form.elements.starts_on.value=start;form.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('owner-terms').scrollIntoView({behavior:'smooth',block:'start'});
 }
 $('owner-year').onclick=()=>setTerm(false);$('owner-renew').onclick=()=>setTerm(true);$('owner-renew-top').onclick=()=>setTerm(true);
 $('owner-discard').onclick=()=>{if(!payload)return;const s=payload.subscription;for(const k of fields)$('owner-subscription-form').elements[k].value=s.configured?s[k]:'';$('owner-subscription-form').dispatchEvent(new Event('input',{bubbles:true}));draft();};
 $('owner-subscription-form').addEventListener('input',draft);$('owner-history-filter').onchange=drawHistory;
 $('owner-confirm-back').onclick=()=>$('owner-confirm-dialog').close('cancel');$('owner-confirm-save').onclick=()=>$('owner-confirm-dialog').close('save');
 $('owner-confirm-dialog').addEventListener('close',()=>{const done=confirmation;confirmation=null;done?.($('owner-confirm-dialog').returnValue==='save');});
 document.addEventListener('owner-invites-change',event=>{const {records,error}=event.detail;$('owner-admins-value').textContent=error?'غير متاح':records.length.toString();const pending=records.filter(x=>x.status==='pending'||x.status==='sending').length,failed=records.filter(x=>x.status==='failed').length;$('owner-admins-note').textContent=error?'تعذّر تحديث الحالة':failed?failed+' دعوة تعذّر إرسالها':pending?pending+' بانتظار التفعيل':'الحسابات المضافة من اللوحة';});
 global.OwnerDashboard={draw,values,annualEnd,draft,changed:()=>!!payload&&(payload.subscription.configured?changes(payload.subscription,values()).length>0:fields.some(k=>values()[k])),
  confirm(v){if(confirmation)return Promise.resolve(false);$('owner-confirm-content').innerHTML=differences(payload.subscription.configured?payload.subscription:null,v);$('owner-confirm-warning').textContent=v.valid_until<(payload.subscription.checked_on||today())?'التاريخ المحدد منتهٍ: سيتوقف تطبيق الشركة فور اعتماد الحفظ.':'التطبيق يتوقف تلقائيًا بعد نهاية التاريخ المحدد بتوقيت دمشق.';$('owner-confirm-dialog').returnValue='';$('owner-confirm-dialog').showModal();return new Promise(resolve=>confirmation=resolve);},
  reset(){if($('owner-confirm-dialog').open)$('owner-confirm-dialog').close('cancel');payload=null;$('owner-state-value').textContent='—';$('owner-days-value').textContent='—';$('owner-amount-value').textContent='—';$('owner-admins-value').textContent='—';$('owner-admins-note').textContent='';$('owner-notice').textContent='';$('owner-confirm-content').replaceChildren();$('owner-updated').textContent='';$('owner-draft-summary').textContent='';$('owner-history-count').textContent='';$('owner-progress-label').textContent='مدة الاشتراك';$('owner-progress').value=0;}
 };
})(globalThis);
