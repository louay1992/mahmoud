/* Phone operations UI. Existing data loaders, authorization and mutations remain authoritative. */
(() => {
  const compact = matchMedia('(max-width:719px)');
  const state = { deliverySeen:false, shippingSeen:false, deliveryLimit:30, shippingLimit:30, sort:'priority' };
  const primary = ['new','in_delivery','no_answer','closed','other','cancelled','all'];
  const priority = ['new','assigned','in_delivery','no_answer','closed','other','cancelled','delivered','returned'];
  const shipStates = [['preparing','جديدة'],['handed','عند الشركة'],['returned','مرتجعة'],['cancelled','ملغية'],['delivered','مسلّمة'],['all','الكل']];
  const colors = {new:'#0f766e',assigned:'#9a5709',in_delivery:'#245bd3',no_answer:'#ad5016',closed:'#526274',other:'#08758b',cancelled:'#bd3545',delivered:'#16744e',returned:'#7a4bbb',preparing:'#0f766e',handed:'#245bd3'};
  const labels = {new:'جديدة',in_delivery:'قيد التوصيل',no_answer:'لم يتم الرد',closed:'مغلق',other:'ملاحظات أخرى',cancelled:'ملغية',all:'الكل'};
  const enabled = () => compact.matches && typeof ACC !== 'undefined' && ACC.role === 'full';
  const button = (label, action, value='', cls='am-btn', extra='') => `<button type="button" class="${cls}" data-am="${action}" data-value="${esc(value)}" ${extra}>${label}</button>`;
  const paths={search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',filter:'<path d="M4 6h16M7 12h10M10 18h4"/>',arrow:'<path d="m14 6-6 6 6 6M8 12h13"/>',pin:'<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',phone:'<path d="m5 3 4 1 1 5-3 2a16 16 0 0 0 6 6l2-3 5 1 1 4c-1 5-8 2-13-3S0 4 5 3Z"/>'};
  const icon = name => `<span aria-hidden="true">${paths[name]?'<svg class="i" viewBox="0 0 24 24">'+paths[name]+'</svg>':ic(name)}</span>`;
  const empty = (title,hint,action='show-all') => `<div class="am-empty">${icon('box')}<h3>${title}</h3><p>${hint}</p>${button('عرض كل الطلبات',action,'','am-btn am-secondary')}</div>`;
  const amount = value => esc(money(value));
  const validId = id => typeof id==='string' && /^[a-zA-Z0-9-]+$/.test(id);
  const shipments = () => SHIPS || [];
  const delivery = () => D.orders.filter(o=>o.fulfillment!=='shipping');
  const shippingStatus = o => o.ship_status==='cancelled' ? 'cancelled' : NS(o.ship_status);
  function sorted(list, shipping=false) {
    const ranks=shipping?['preparing','handed','returned','cancelled','delivered']:priority;
    return [...list].sort((a,b)=>{
      if(state.sort==='priority'){
        const rank=k=>{const i=ranks.indexOf(k);return i<0?ranks.length:i};
        const diff=rank(shipping?shippingStatus(a):a.status)-rank(shipping?shippingStatus(b):b.status);
        if(diff) return diff;
      }
      const diff=(new Date(a.created_at).getTime()||0)-(new Date(b.created_at).getTime()||0);
      return state.sort==='recent'?-diff:diff;
    });
  }
  function navigation(){
    document.body.classList.toggle('admin-phone',enabled());
    if(!enabled()) return;
    const entries=[['home','الرئيسية','home'],['orders','التوصيل','truck'],['ship','الشحن','box'],['new','طلب جديد','plus'],['more','المزيد','menu']];
    $('bnr').innerHTML=entries.map(([key,label,glyph])=>button(`${icon(glyph)}<span>${label}</span>${key==='home'&&pendingPR()?'<i class="bd">'+pendingPR()+'</i>':''}`,'navigate',key,tab===key||(key==='more'&&!MAIN_TABS.includes(tab))?'on':'',`aria-label="${label}" ${tab===key?'aria-current="page"':''}`)).join('');
  }
  function heading(title,subtitle,shipping=false){
    return `<div class="am-page-title"><div><h1>${title}</h1><p>${subtitle}</p></div>${button(icon('plus'),'create',shipping?'shipping':'delivery','am-icon-btn',`aria-label="${shipping?'إنشاء طلب شحن':'إنشاء طلب توصيل'}"`)}</div>`;
  }
  function badge(o,shipping){
    const key=shipping?shippingStatus(o):o.status;
    const label=shipping?(shipStates.find(x=>x[0]===key)?.[1]||shl(o.ship_status)[1]):(ST[key]||key);
    return `<span class="am-status" style="--status:${colors[key]||'#526274'}"><i></i>${esc(label)}</span>`;
  }
  function card(o,shipping=false){
    const key=shipping?shippingStatus(o):o.status, action=shipping?'open-shipment':'open-order';
    const items=(o.order_items||[]).map(i=>`${i.products?.name||'منتج'} ×${i.qty}`).join('، ');
    const pending=!shipping&&(D.pr[o.id]||[]).some(x=>x.status==='pending');
    const age=Math.floor((Date.now()-new Date(o.status_at||o.created_at).getTime())/864e5);
    const address=[o.governorate,o.customer_address].filter(Boolean).join('، ');
    const phone=String(o.customer_phone||'').replace(/[^+0-9*#]/g,'');
    const owner=shipping?carName(o.carrier_id):(o.captain_id?cname(o.captain_id):'بانتظار إسناد كابتن');
    return `<article class="am-order" data-order-id="${esc(o.id)}" data-status="${esc(key)}">
      <button type="button" class="am-order-main" data-am="${action}" data-value="${esc(o.id)}" aria-label="تفاصيل ${shipping?'الشحنة':'الطلب'} ${esc(o.order_no)} للزبون ${esc(o.customer_name)}">
        <span class="am-order-top"><span class="am-order-number">#${esc(o.order_no)}</span>${badge(o,shipping)}</span>
        <strong class="am-customer">${esc(o.customer_name||'زبون')}</strong>
        <span class="am-address">${icon('pin')}${esc(address||'لا يوجد عنوان مسجّل')}</span>
        <span class="am-products">${esc(items||'لا توجد منتجات')}</span>
        <span class="am-order-meta"><span>${icon(shipping?'store':'users')}${esc(owner)}</span><time>${esc(when(o.status_at||o.created_at))}</time></span>
        ${shipping?`<span class="am-waybill">البوليصة <b dir="ltr">${esc(o.waybill||'لم تُضف بعد')}</b></span>`:''}
        ${pending?'<span class="am-note am-warning">طلب تعديل سعر ينتظر قرارك</span>':''}
        ${shipping&&key==='handed'&&age>=5?`<span class="am-note am-warning">لدى الشركة منذ ${age} أيام، تحتاج متابعة</span>`:''}
        ${o.captain_note?`<span class="am-note">${esc(o.captain_note)}</span>`:''}
      </button>
      <div class="am-order-footer"><span><small>المطلوب تحصيله</small><b>${amount(o.total)}</b></span><div>
        ${phone?`<a class="am-icon-btn am-call" href="tel:${esc(phone)}" aria-label="اتصال بالزبون ${esc(o.customer_name)}">${icon('phone')}</a>`:''}
        ${button(shipping?'إدارة الشحنة':o.status==='new'?'إسناد':'التفاصيل',action,o.id,'am-btn am-primary',!shipping&&o.status==='new'?'aria-label="إسناد الكابتن للطلب '+esc(o.order_no)+'"':'')}
        ${button(icon('menu'),'order-options',(shipping?'s:':'d:')+o.id,'am-icon-btn',`aria-label="خيارات الطلب ${esc(o.order_no)}"`)}
      </div></div></article>`;
  }
  function home(){
    const list=delivery(), fresh=list.filter(o=>o.status==='new'), pending=pendingPR(), stats=D.stats||{};
    const active=list.filter(o=>['assigned','in_delivery','no_answer','closed','other'].includes(o.status));
    const shipping=D.orders.filter(o=>o.fulfillment==='shipping'&&!['delivered','returned','cancelled'].includes(shippingStatus(o)));
    const queue=sorted(list.filter(o=>['new','assigned','no_answer','closed','other'].includes(o.status))).slice(0,3);
    const low=stats.low_stock||[], today=new Date().toLocaleDateString('ar',{weekday:'long',day:'numeric',month:'long'});
    $('main').innerHTML=`<div class="am-home">
      ${heading('المتابعة اليومية',esc(today))}
      <section class="am-dispatch" aria-label="طلبات تنتظر الإسناد"><div class="am-dispatch-title">${icon('truck')}<span>${fresh.length?'طلبات جديدة تنتظر الإسناد':'لا طلبات تنتظر الإسناد'}</span><b>${fresh.length}</b></div><p>${fresh.length?'راجع الطلب واختر الكابتن ليبدأ التوصيل.':'تظهر الطلبات الجديدة هنا فور تحميلها.'}</p>${button((fresh.length?'مراجعة الطلبات الجديدة':'فتح طلبات التوصيل')+' '+icon('arrow'),'delivery-status',fresh.length?'new':'all','am-btn am-primary')}</section>
      ${pending?button(`<span class="am-notice-icon">${icon('alert')}</span><span><b>${pending} طلب تعديل سعر</b><small>بانتظار موافقتك أو رفضك</small></span>${icon('arrow')}`,'price-requests','','am-notice'):''}
      <div class="am-destinations">${button(`${icon('truck')}<b>طلبات التوصيل</b><span>${active.length} طلب قيد المتابعة</span>`,'delivery-status','new','am-destination')}${button(`${icon('box')}<b>طلبات الشحن</b><span>${shipping.length} شحنة ضمن أحدث الطلبات</span>`,'shipping-status','preparing','am-destination am-shipping-destination')}</div>
      ${button(`${icon('search')}<span>بحث في طلبات التوصيل</span>`,'search-orders','','am-home-search')}
      <section class="am-section"><div class="am-section-heading"><div><h2>أولوية المتابعة</h2><p>من أحدث طلبات التوصيل</p></div>${button('عرض الكل','delivery-status','all','am-text-btn')}</div>${queue.length?queue.map(o=>card(o)).join(''):empty('لا توجد طلبات تحتاج متابعة','يمكنك مراجعة الطلبات أو إنشاء طلب جديد.')}</section>
      <section class="am-today" aria-label="ملخص اليوم"><div><small>سُلِّم اليوم</small><b>${Number(stats.delivered_today||0)} <span>طلب</span></b></div><div><small>مبيعات اليوم</small><b>${amount(stats.sales_today)}</b></div></section>
      <section class="am-accounts">${button(`${icon('wallet')}<span><small>المستحق على الكباتن</small><b>${amount(stats.owed_total)}</b></span>${icon('arrow')}`,'navigate','captains','am-account-link')}${low.length?button(`${icon('alert')}<span><b>${low.length} صنف بمخزون منخفض</b><small>راجع الكميات قبل إسناد الطلبات</small></span>${icon('arrow')}`,'low-stock','','am-account-link'):''}</section>
    </div>`;
  }
  function orders(){
    if(!state.deliverySeen){state.deliverySeen=true;orderFilter='new';}
    $('main').innerHTML=`<div id="am-delivery" class="am-list-page">${heading('طلبات التوصيل','الجديدة أولًا، ثم متابعة ما يحتاج إجراءك')}
      <div class="am-list-tools"><div class="am-search">${icon('search')}<input id="oq" type="search" aria-label="بحث في طلبات التوصيل" placeholder="اسم الزبون، الموبايل أو رقم الطلب" value="${esc(orderQuery)}" enterkeyhint="search" oninput="orderQuery=this.value;AdminMobile.resetLimit();renderOrderList()"></div>${button(icon('filter')+'<span>فلاتر</span>','filters','delivery','am-filter-btn')}</div>
      <div class="am-status-rail" id="ochips" role="group" aria-label="حالات طلبات التوصيل"></div>
      <div id="am-active-filters"></div><div id="osum" class="am-list-summary" aria-live="polite"></div><div id="olist"></div></div>`;
    orderList();
  }
  function orderList(){
    if(!$('am-delivery')) return;
    const base=ordBase(true), counts={all:base.length};base.forEach(o=>counts[o.status]=(counts[o.status]||0)+1);
    const keys=primary.includes(orderFilter)?primary:[...primary.slice(0,-1),orderFilter,'all'];
    const rail=$('ochips'), offset=rail.scrollLeft;
    rail.innerHTML=keys.map(k=>button(`${esc(labels[k]||ST[k])}<b>${counts[k]||0}</b>`,'delivery-status',k,'am-status-filter',`aria-pressed="${orderFilter===k}"`)).join('');rail.scrollLeft=offset;
    const tags=[orderCap&&(orderCap==='none'?'بلا كابتن':cname(orderCap)),orderMk&&(orderMk==='none'?'بلا مسوّقة':mname(orderMk)),orderPer!=='all'&&({'today':'اليوم',week:'آخر 7 أيام',month:'هذا الشهر'})[orderPer],orderGrp!=='none'&&'تجميع مفعّل'].filter(Boolean);
    $('am-active-filters').innerHTML=tags.length?`<div class="am-applied">${tags.map(t=>`<span>${esc(t)}</span>`).join('')}${button('مسح','reset-filters','delivery','am-text-btn')}</div>`:'';
    const list=sorted(ordBase(false));
    $('osum').innerHTML=`<span><b>${list.length}</b> طلب ${esc(labels[orderFilter]||ST[orderFilter]||'')}</span><span>${state.sort==='recent'?'الأحدث أولًا':state.sort==='oldest'?'الأقدم أولًا':'حسب الأولوية'}</span>`;
    const page=list.slice(0,state.deliveryLimit);
    let html='';
    if(orderGrp==='none') html=page.map(o=>card(o)).join('');
    else{
      const keyOf={status:o=>o.status,captain:o=>o.captain_id||'-',marketer:o=>o.marketer_id||'-',day:o=>new Date(o.created_at).toLocaleDateString('ar')}[orderGrp];
      const groups=new Map();page.forEach(o=>{const k=keyOf(o);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(o)});
      for(const [k,records] of groups){const label=orderGrp==='status'?ST[k]:orderGrp==='captain'?(k==='-'?'بلا كابتن':cname(k)):orderGrp==='marketer'?(k==='-'?'بلا مسوّقة':mname(k)):k;html+=`<h2 class="am-group">${esc(label)} <span>${records.length}</span></h2>`+records.map(o=>card(o)).join('');}
    }
    $('olist').innerHTML=html||empty(orderFilter==='new'&&!orderQuery?'لا توجد طلبات جديدة':'لا توجد نتائج مطابقة','جرّب بحثًا آخر أو اعرض كل الطلبات.');
    globalThis.AdminWorkspace?.decorateEvents();
    if(list.length>page.length) $('olist').insertAdjacentHTML('beforeend',button(`عرض طلبات إضافية (${page.length} من ${list.length})`,'load-more','delivery','am-btn am-load-more'));
  }
  function shipBase(skipStatus=false){
    const n=new Date(),d0=new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime(),q=nrm(SHF.q);
    const from=SHF.per==='today'?d0:SHF.per==='week'?d0-6*864e5:SHF.per==='month'?new Date(n.getFullYear(),n.getMonth(),1).getTime():0;
    return shipments().filter(o=>(skipStatus||SHF.st==='all'||(SHF.st==='open'?!['delivered','returned','cancelled'].includes(shippingStatus(o)):shippingStatus(o)===SHF.st))&&(!SHF.car||o.carrier_id===SHF.car)&&(!SHF.mk||(SHF.mk==='none'?!o.marketer_id:o.marketer_id===SHF.mk))&&(!SHF.gov||o.governorate===SHF.gov)&&(!from||new Date(o.created_at).getTime()>=from)&&(!q||[o.customer_name,o.customer_phone,o.waybill,String(o.order_no),o.governorate,mname(o.marketer_id)].some(v=>nrm(v).includes(q))));
  }
  function shipping(){
    if(!state.shippingSeen){state.shippingSeen=true;if(SHF.st==='open')SHF.st='preparing';}
    $('shbody').innerHTML=`<div id="am-shipping" class="am-list-page">${heading('طلبات الشحن','من التجهيز إلى استلام الزبون',true)}
      <div class="am-list-tools"><div class="am-search">${icon('search')}<input id="am-ship-query" type="search" aria-label="بحث في طلبات الشحن" placeholder="اسم الزبون، الموبايل أو البوليصة" value="${esc(SHF.q)}" enterkeyhint="search" oninput="SHF.q=this.value;AdminMobile.resetLimit();drawShipList()"></div>${button(icon('filter')+'<span>فلاتر</span>','filters','shipping','am-filter-btn')}</div>
      <div class="am-status-rail" id="am-ship-chips" role="group" aria-label="حالات طلبات الشحن"></div><div id="am-shipping-filters"></div><div id="am-ship-summary" class="am-list-summary" aria-live="polite"></div><div id="shlist"></div></div>`;
    shippingList();
  }
  function shippingLoading(){
    $('shbody').innerHTML=`${heading('طلبات الشحن','من التجهيز إلى استلام الزبون',true)}<div class="am-loading" role="status" aria-live="polite"><p>جارٍ تحميل الشحنات…</p><div aria-hidden="true"></div><div aria-hidden="true"></div></div>`;
  }
  function shippingError(){
    $('shbody').innerHTML=`${heading('طلبات الشحن','من التجهيز إلى استلام الزبون',true)}<div class="am-empty am-load-error" role="alert">${icon('alert')}<h3>تعذّر تحميل الشحنات</h3><p>حاول مجددًا لتحميل أحدث الطلبات.</p>${button('إعادة المحاولة','retry-shipping','','am-btn am-primary')}</div>`;
  }
  function shippingList(){
    if(!$('am-shipping')) return;
    const base=shipBase(true),list=sorted(shipBase(),true), rail=$('am-ship-chips'),offset=rail.scrollLeft;
    const states=SHF.st==='open'?[...shipStates.slice(0,-1),['open','الجارية'],['all','الكل']]:shipStates;
    rail.innerHTML=states.map(([k,l])=>button(`${l}<b>${k==='all'?base.length:base.filter(o=>k==='open'?!['delivered','returned','cancelled'].includes(shippingStatus(o)):shippingStatus(o)===k).length}</b>`,'shipping-status',k,'am-status-filter',`aria-pressed="${SHF.st===k}"`)).join('');rail.scrollLeft=offset;
    const tags=[SHF.car&&carName(SHF.car),SHF.mk&&(SHF.mk==='none'?'بلا مسوّقة':mname(SHF.mk)),SHF.gov,SHF.per!=='all'&&({'today':'اليوم',week:'آخر 7 أيام',month:'هذا الشهر'})[SHF.per]].filter(Boolean);
    $('am-shipping-filters').innerHTML=tags.length?`<div class="am-applied">${tags.map(t=>`<span>${esc(t)}</span>`).join('')}${button('مسح','reset-filters','shipping','am-text-btn')}</div>`:'';
    $('am-ship-summary').innerHTML=`<span><b>${list.length}</b> شحنة</span><span>${state.sort==='recent'?'الأحدث أولًا':state.sort==='oldest'?'الأقدم أولًا':'حسب الأولوية'}</span>`;
    const page=list.slice(0,state.shippingLimit);
    $('shlist').innerHTML=page.map(o=>card(o,true)).join('')||empty('لا توجد شحنات مطابقة','جرّب حالة أخرى أو عدّل الفلاتر.','all-shipments');
    globalThis.AdminWorkspace?.decorateEvents();
    if(list.length>page.length)$('shlist').insertAdjacentHTML('beforeend',button(`عرض شحنات إضافية (${page.length} من ${list.length})`,'load-more','shipping','am-btn am-load-more'));
  }
  const select=(id,label,options,value)=>`<label class="am-filter-field"><span>${label}</span><select id="${id}">${options.map(([k,l])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
  function sheet(title,body){$('modal').innerHTML=`<div class="sheet am-sheet" role="dialog" aria-modal="true" aria-label="${title}"><div class="sh-h"><b>${title}</b>${button(icon('x'),'close','','am-icon-btn','aria-label="إغلاق"')}</div>${body}</div>`;$('modal').style.display='flex';}
  function filters(type){
    const shipping=type==='shipping',f=shipping?SHF:{mk:orderMk,per:orderPer};
    let html=shipping?select('am-f-owner','شركة الشحن',[['','كل الشركات'],...D.carriers.map(c=>[c.id,c.name])],SHF.car):select('am-f-owner','الكابتن',[['','كل الكباتن'],['none','بدون كابتن'],...D.captains.map(c=>[c.id,c.name])],orderCap);
    html+=select('am-f-marketer','المسوّقة',[['','كل المسوّقات'],['none','بدون مسوّقة'],...D.marketers.map(m=>[m.id,m.name])],f.mk);
    if(shipping)html+=select('am-f-gov','المحافظة',[['','كل المحافظات'],...[...new Set(shipments().map(o=>o.governorate).filter(Boolean))].map(g=>[g,g])],SHF.gov);
    html+=select('am-f-period','الفترة',[['all','كل الأوقات'],['today','اليوم'],['week','آخر 7 أيام'],['month','هذا الشهر']],f.per);
    if(!shipping){html+=select('am-f-status','حالات الطلبات',[...primary.slice(0,-1),...['assigned','delivered','returned'],'all'].map(k=>[k,labels[k]||ST[k]]),orderFilter);html+=select('am-f-group','تجميع الطلبات',[['none','بدون تجميع'],['status','حسب الحالة'],['captain','حسب الكابتن'],['marketer','حسب المسوّقة'],['day','حسب اليوم']],orderGrp);}
    html+=select('am-f-sort','ترتيب العرض',[['priority','الأولوية، ثم الأقدم داخل الحالة'],['recent','الأحدث أولًا'],['oldest','الأقدم أولًا']],state.sort);
    sheet('فلترة '+(shipping?'الشحنات':'طلبات التوصيل'),`<div class="am-filter-fields">${html}</div><div class="am-sheet-actions">${button('تطبيق الفلاتر','apply-filters',type,'am-btn am-primary')}${button('إعادة الضبط','reset-filters',type,'am-btn am-secondary')}</div>`);
  }
  function applyFilters(type){
    const value=id=>$(id).value;state.sort=value('am-f-sort');
    if(type==='shipping'){SHF.car=value('am-f-owner');SHF.mk=value('am-f-marketer');SHF.gov=value('am-f-gov');SHF.per=value('am-f-period');}
    else{orderCap=value('am-f-owner');orderMk=value('am-f-marketer');orderPer=value('am-f-period');orderFilter=value('am-f-status');orderGrp=value('am-f-group');}
    closeStatus();resetLimit();type==='shipping'?shippingList():orderList();
  }
  function resetFilters(type){state.sort='priority';if(type==='shipping'){SHF={st:'preparing',q:'',car:'',mk:'',gov:'',per:'all'};}else{orderFilter='new';orderCap='';orderMk='';orderPer='all';orderQuery='';orderGrp='none';}closeStatus();resetLimit();type==='shipping'?shipping():orders();}
  function resetLimit(){state.deliveryLimit=30;state.shippingLimit=30;}
  function deliveryStatus(value){state.deliverySeen=true;orderFilter=value;resetLimit();if(tab==='orders'&&$('am-delivery'))orderList();else go('orders');}
  function shippingFilter(value){state.shippingSeen=true;SHF.st=value;resetLimit();if(tab==='ship'&&$('am-shipping'))shippingList();else go('ship');}
  function options(value){
    const shipping=value.startsWith('s:'),id=value.slice(2),o=(shipping?shipments():D.orders).find(x=>x.id===id);if(!o)return;
    const map=mapUrl(o),closed=['delivered','returned','cancelled'].includes(shipping?shippingStatus(o):o.status);
    sheet('خيارات الطلب #'+esc(o.order_no),`<div class="am-options">${button(icon('box')+'التفاصيل',shipping?'open-shipment':'open-order',id,'am-option')}${!closed&&!shipping?button(icon('tag')+'تعديل بيانات الطلب','edit-order',id,'am-option'):''}<a class="am-option" href="${waUrl(o,waText(o))}" target="_blank" rel="noopener">${icon('phone')}واتساب الزبون</a>${map?`<a class="am-option" href="${map}" target="_blank" rel="noopener">${icon('pin')}فتح الخريطة</a>`:''}</div>`);
  }
  const handlers={
    navigate:key=>key==='more'?openMore():go(key),
    create:type=>{go('new');if(type==='shipping')setNom('shipping');},
    'delivery-status':deliveryStatus,'shipping-status':shippingFilter,
    'retry-shipping':()=>go('ship'),
    'open-order':id=>{if(validId(id))openOrder(id);},'open-shipment':id=>{if(validId(id))openShip(id);},
    'edit-order':id=>{if(validId(id))openEdit(id);},'order-options':options,
    filters, 'apply-filters':applyFilters,'reset-filters':resetFilters,close:()=>closeStatus(),
    logout:()=>{closeStatus();logout();},
    'search-orders':()=>{deliveryStatus('all');$('oq')?.focus();},
    'show-all':()=>{resetFilters('delivery');deliveryStatus('all');},
    'all-shipments':()=>{resetFilters('shipping');shippingFilter('all');},
    'price-requests':()=>sheet('طلبات تعديل الأسعار',prCard()),
    'low-stock':()=>sheet('المخزون المنخفض',`<div class="am-low-stock">${(D.stats?.low_stock||[]).map(x=>`<div><b>${esc(x.product)}</b><span>${esc(x.warehouse)}</span><strong>${Number(x.qty)} قطعة</strong></div>`).join('')}</div>${button('فتح المخزون','stock','','am-btn am-primary')}`),
    stock:()=>{closeStatus();go('stock');},
    'load-more':type=>{if(type==='shipping'){state.shippingLimit+=30;shippingList();}else{state.deliveryLimit+=30;orderList();}}
  };
  document.addEventListener('click',event=>{
    const target=event.target.closest?.('[data-am]');if(!target||!enabled())return;
    const name=target.dataset.am,value=target.dataset.value||'',action=handlers[name];if(action)action(value);
    if(event.detail===0&&['delivery-status','shipping-status'].includes(name))document.querySelector(`[data-am="${name}"][data-value="${CSS.escape(value)}"]`)?.focus({preventScroll:true});
  });
  document.addEventListener('keydown',event=>{
    const dialog=document.querySelector('#modal .am-sheet');if(!dialog||!enabled())return;
    if(event.key==='Escape'){event.preventDefault();closeStatus();return;}
    if(event.key!=='Tab')return;
    const controls=[...dialog.querySelectorAll('button,a[href],input,select,textarea')].filter(el=>!el.disabled&&el.getClientRects().length);
    const first=controls[0],last=controls.at(-1);if(!first)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    else if(!dialog.contains(document.activeElement)){event.preventDefault();(event.shiftKey?last:first).focus();}
  });
  compact.addEventListener('change',()=>{if(typeof ACC==='undefined'||ACC.role!=='full'||$('app')?.style.display==='none')return;renderNav();if(['home','orders','ship'].includes(tab))render();});
  function more(){if(enabled())$('modal').querySelector('.sheet')?.insertAdjacentHTML('beforeend',button(icon('logout')+'تسجيل الخروج','logout','','am-option am-logout'));}
  function viewState(){return {sort:state.sort};}
  function restoreView(view){state.deliverySeen=true;state.shippingSeen=true;if(['priority','recent','oldest'].includes(view?.sort))state.sort=view.sort;}
  globalThis.AdminMobile={enabled,navigation,home,orders,orderList,shipping,shippingList,shippingLoading,shippingError,resetLimit,more,viewState,restoreView};
})();
