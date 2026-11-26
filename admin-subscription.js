(function(global){
 'use strict';let sequence=0;
 async function render(){
  const seq=++sequence,who=ME;
  if(ACC.role!=='full'||authGate.blocked)return;
  $('main').innerHTML='<div class="subscription-page"><div class="subscription-heading"><div><span class="subscription-kicker">حساب الشركة</span><h1>إدارة الاشتراك</h1><p>مدة اشتراكك وقيمة التجديد في مكان واحد.</p></div></div><p role="status">جارٍ تحميل بيانات الاشتراك…</p></div>';
  const {data,error}=await timedRead(sb.rpc('get_subscription'));
  if(seq!==sequence||ME!==who||authGate.blocked||tab!=='subscription')return;
  if(error){$('main').innerHTML='<section class="subscription-page subscription-error"><h1>تعذّر تحميل بيانات الاشتراك</h1><p>تحقق من اتصالك وحاول مجددًا.</p><button class="b" type="button" id="subscription-retry">إعادة المحاولة</button></section>';$('subscription-retry').onclick=render;return;}
  $('main').innerHTML='<div class="subscription-page"><div class="subscription-heading"><div><span class="subscription-kicker">حساب الشركة</span><h1>إدارة الاشتراك</h1><p>مدة اشتراكك وقيمة التجديد في مكان واحد.</p></div><button class="b o" type="button" id="subscription-refresh">تحديث البيانات</button></div>'+(offline.denied()?'<p class="subscription-cache-note">تُعرض آخر بيانات اشتراك محفوظة على هذا الجهاز. اتصل بالإنترنت لتحديث الصلاحية.</p>':'')+DeliverySubscription.card(data,D.settings.business_name||'اشتراك النظام')+'<section class="subscription-future"><span aria-hidden="true">✦</span><div><h2>الخدمات والإضافات</h2><p>ستظهر هنا الخدمات والباقات الإضافية عند توفرها، مع تفاصيلها وأسعارها.</p></div></section></div>';
  $('subscription-refresh').onclick=render;
 }
 global.AdminSubscription={render};
})(globalThis);
