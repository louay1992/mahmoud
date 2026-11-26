/* Shared display rules. Contract dates are calendar dates; the server supplies its evaluation date. */
(function(global){
 'use strict';
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?new Date(value+'T00:00:00Z').toLocaleDateString('ar-SY',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}):'—';
 const amount=(value,currency)=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(Number(value))+' '+(currency||'');
 const labels={active:'اشتراك ساري',expired:'انتهى الاشتراك',upcoming:'اشتراك قادم'};
 function card(s,company='اشتراك النظام'){
  if(!s||s.configured!==true)return '<section class="subscription-card subscription-empty"><span class="subscription-kicker">إدارة الاشتراك</span><h2>بيانات الاشتراك غير محددة بعد</h2><p>تظهر هنا مدة اشتراكك وقيمة تجديده بعد اعتماد بيانات الاشتراك.</p></section>';
  const status=labels[s.status]?s.status:'upcoming',remaining=Number(s.days_remaining);
  const days=status==='expired'?'انتهى منذ '+Math.abs(remaining)+' يوم':status==='upcoming'?'يبدأ في '+date(s.starts_on):remaining===0?'صالح حتى نهاية اليوم':'متبقّي '+remaining+' يومًا';
  return `<section class="subscription-card"><div class="subscription-top"><span class="subscription-kicker">${esc(company)}</span><span class="subscription-status ${status}">${labels[status]}</span></div><h2>اشتراك النظام السنوي</h2><p class="subscription-term">مدة الاشتراك: ${Number(s.duration_days)===365||Number(s.duration_days)===366?'سنة واحدة':Number.isFinite(Number(s.duration_days))?Number(s.duration_days)+' يومًا':'سنوي'}</p><p class="subscription-until">${status==='expired'?'كان صالحًا لغاية':'صالح لغاية'} <strong>${date(s.valid_until)}</strong></p><span class="subscription-days">${esc(days)}</span><div class="subscription-price"><span>المبلغ المستحق عند انتهاء الاشتراك</span><strong dir="ltr">${esc(amount(s.renewal_amount,s.currency))}</strong><small>قيمة تجديد الاشتراك السنوي</small></div><dl class="subscription-dates"><div><dt>بداية الاشتراك</dt><dd>${date(s.starts_on)}</dd></div><div><dt>نهاية الاشتراك</dt><dd>${date(s.valid_until)}</dd></div></dl></section>`;
 }
 const calendar=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
 function validate(values){
  if(!calendar(values.starts_on)||!calendar(values.valid_until)||values.valid_until<values.starts_on)return 'أدخل تاريخ بداية ونهاية صحيحين.';
  if(!/^\d+(?:\.\d{1,2})?$/.test(values.renewal_amount)||Number(values.renewal_amount)>9999999999.99)return 'أدخل قيمة تجديد صحيحة، بمنزلتين عشريتين كحد أقصى.';
  if(!/^[A-Z]{3}$/.test(values.currency))return 'اختر العملة.';
  return null;
 }
 global.DeliverySubscription={esc,date,amount,card,validate};
})(globalThis);
