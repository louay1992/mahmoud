/* CacheStorage is limited to this browser and origin. Only old public app bundles are eligible. */
export async function cacheCandidates(){
  const storage=globalThis.caches;
  if(!storage)throw Error('CacheStorage is unavailable');
  const names=await storage.keys(), candidates=[];
  for(const role of ['admin','captain']){
    const pointerName='offline-package-pointer-'+role, prefix='offline-bundle-'+role+'-';
    if(!names.includes(pointerName))continue;
    const pointer=await (await storage.open(pointerName)).match('/__offline_active');
    const active=pointer&&await pointer.text();
    if(!active?.startsWith(prefix)||!names.includes(active))continue;
    const previous=names.filter(name=>name.startsWith(prefix)&&name!==active);
    candidates.push(...previous.slice(0,-1));
  }
  return candidates;
}

export async function clearOldAppBundles(status,isCurrent=()=>true){
  try{
    const candidates=await cacheCandidates();
    if(!isCurrent())return;
    status.textContent=candidates.length?'يمكن حذف '+candidates.length+' حزمة قديمة والاحتفاظ بالحزمة الحالية ونسخة بديلة.':'لا توجد حزم كاش قديمة آمنة للحذف في هذا المتصفح.';
    if(!candidates.length||!confirm('حذف '+candidates.length+' حزمة قديمة من هذا المتصفح؟'))return;
    let deleted=0;
    for(const name of candidates){
      const current=await cacheCandidates();
      if(!isCurrent())return;
      if(current.includes(name)&&await caches.delete(name))deleted++;
    }
    if(isCurrent())status.textContent='حُذفت '+deleted+' حزمة قديمة. حُفظت حزم التطبيقات الحالية وبيانات الدخول والبيانات المحلية.';
  }catch{
    if(isCurrent())status.textContent='تعذّر الوصول إلى كاش التطبيقات. تحقق من إعدادات المتصفح ثم حاول مجددًا.';
  }
}

const button=document.getElementById('cache-maintenance-clear');
if(button)button.onclick=async()=>{
  button.disabled=true;
  try{ await clearOldAppBundles(document.getElementById('cache-maintenance-result')); }
  finally{ button.disabled=false; }
};
