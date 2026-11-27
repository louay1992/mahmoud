(function(global){
 'use strict';
 const $=id=>document.getElementById(id),esc=DeliverySubscription.esc;
 const bytes=n=>{if(n==null)return 'غير متاح';n=Number(n);const units=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++;}return new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(n)+' '+units[i];};
 const date=n=>n?new Date(n).toLocaleString('ar-SY',{timeZone:'Asia/Damascus'}):'—';
 const actionNames={catalog:'تحديث قائمة النسخ',create:'نسخة احتياطية جديدة',download:'تجهيز التنزيل',restore:'استعادة نسخة',cleanup:'تنظيف الملفات المؤقتة'};
 const states={queued:'بانتظار التنفيذ',running:'قيد التنفيذ',succeeded:'نجحت العملية',failed:'تعذّرت العملية',recovery_required:'الاستعادة تحتاج متابعة · التطبيق مقفل للحماية'};
 const stages={validating:'فحص النسخة والمفتاح',maintenance:'إيقاف مؤقت للتطبيق',safety_backup:'حفظ نسخة أمان قبل الاستعادة',restoring_database:'استعادة البيانات',restoring_storage:'استعادة الملفات والتحقق منها',recovery_queued:'بانتظار الرجوع إلى نسخة الأمان',recovering_storage:'الرجوع إلى ملفات نسخة الأمان',exporting:'نسخ البيانات والملفات',cleaning:'تنظيف الملفات المؤقتة',starting:'بدء التنفيذ'};
 const reasons={SCHEMA_INCOMPATIBLE:'بنية النسخة لا تتوافق مع الإصدار الحالي. لم يبدأ استبدال البيانات.',RECOVERY_KEY_INVALID:'مفتاح الاستعادة غير صحيح أو تغيّر مفتاح النقل. أعد اختيار الملف.',BACKUP_CHECKSUM:'فشل التحقق من سلامة النسخة.',OWNER_REVOKED:'لم يعد حساب طالب العملية مالكًا فعالًا.',WORKER_INTERRUPTED:'توقّف منفّذ العملية. راجع الحالة قبل إعادة الطلب.',RECOVERY_REQUIRED:'توقفت الاستعادة أثناء معالجة الملفات. يبقى التطبيق في الصيانة إلى حين التحقق من ملفات نسخة الأمان.',RESTORE_ROLLED_BACK:'استُعيدت ملفات نسخة الأمان وأُعيد فتح التطبيق. لم تُطبّق الاستعادة المطلوبة.',OPERATION_FAILED:'لم تكتمل العملية. راجع الحالة قبل إعادة المحاولة.'};
 let client=null,valid=()=>false,generation=0,timer=null,busy=false,consoleData=null,resources=null,loading=false,allFiles=[];
 const message=(text,error=false)=>{$('owner-operations-message').textContent=text;$('owner-operations-message').classList.toggle('error',error);};
 async function rpc(name,args){let timeout;try{return await Promise.race([client.rpc(name,args),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('انتهت مهلة الاتصال')),20000);})]);}finally{clearTimeout(timeout);}}
 async function load(){
  if(!client||!valid()||loading)return;loading=true;const gen=generation,start=performance.now();
  const result=await Promise.allSettled([rpc('owner_backup_console',{p_limit:100}),rpc('owner_project_resources')]);
  if(gen!==generation||!valid())return;loading=false;
  if(result[0].status==='fulfilled'&&!result[0].value.error&&result[0].value.data){consoleData=result[0].value.data;const merged=new Map(allFiles.map(f=>[f.object_key,f]));for(const file of consoleData.files||[])merged.set(file.object_key,file);allFiles=[...merged.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.object_key.localeCompare(a.object_key));consoleData.files=allFiles;renderBackups();}else $('owner-backup-status').textContent='تعذّر تحميل النسخ. تحقق من الاتصال ثم حدّث الحالة.';
  if(result[1].status==='fulfilled'&&!result[1].value.error&&result[1].value.data){resources=result[1].value.data;renderResources(performance.now()-start);}else $('owner-resource-content').textContent='تعذّر تحميل الموارد. حدّث القياسات للمحاولة مجددًا.';
  clearTimeout(timer);timer=setTimeout(()=>void load(),30000);
 }
 function renderBackups(){
  const data=consoleData,jobs=data.jobs||[],worker=data.worker||{};
  const newest=worker.latest_backup_at||data.latest_backup_at,success=worker.last_success_at||data.last_success_at;
  const stale=Date.now()-Date.parse(newest)>26*60*60*1000;
  $('owner-backup-status').textContent=(worker.maintenance?'التطبيق في وضع الصيانة. ':'')+'آخر اتصال بالمنفّذ '+date(worker.last_seen_at)+(success?' · آخر تشغيل ناجح '+date(success):'')+(newest?' · أحدث نسخة مشفرة '+date(newest):'')+(stale?' · مرّ أكثر من 26 ساعة على أحدث نسخة.':'')+(worker.error_code?' · يوجد خطأ في آخر تشغيل.':'');
  $('owner-backup-total').textContent=allFiles.length+' نسخة معروضة من '+(data.total_files||0);
  $('owner-backup-more').hidden=allFiles.length>=(data.total_files||0);
  $('owner-backup-files').innerHTML=(data.files||[]).map(file=>`<article class="owner-backup-row"><div><b>${esc(date(file.created_at))}</b><span dir="ltr">${esc(bytes(file.size_bytes))}</span><small>${file.verified?'مشفّرة · موثقة SHA-256':'غير موثقة أو لم تعد موجودة'}</small><details><summary>تفاصيل الملف</summary><code dir="ltr">${esc(file.object_key)}</code><small dir="ltr">${esc(file.sha256||'')}</small></details></div><div class="owner-account-actions"><button class="b secondary" data-backup-action="download" data-key="${esc(file.object_key)}" ${!file.verified||busy?'disabled':''}>تنزيل محلي</button><button class="b danger" data-backup-action="restore" data-key="${esc(file.object_key)}" ${!file.verified||!data.transport_key||busy?'disabled':''}>استعادة</button></div></article>`).join('')||'<p class="owner-empty">لم تُفهرس نسخ بعد. اضغط تحديث قائمة Backblaze.</p>';
  $('owner-backup-jobs').innerHTML=jobs.map(job=>{const link=job.action==='download'&&job.status==='succeeded'&&job.result?.url&&Date.parse(job.result.expires_at)>Date.now()?job.result.url:null;
   let url=null;try{const value=new URL(link);if(value.protocol==='https:'&&/^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(value.hostname))url=value.href;}catch{}
   const resume=job.recoverable&&job.status==='recovery_required'&&job.stage!=='recovery_queued'&&data.transport_key;
   return `<article class="owner-job ${esc(job.status)}"><div><b>${esc(actionNames[job.action]||job.action)}</b><small>${esc(date(job.created_at))}</small></div><div><span>${esc(states[job.status]||job.status)}</span>${stages[job.stage]?`<small>${esc(stages[job.stage])}</small>`:''}${job.error_code?`<p>${esc(reasons[job.error_code]||'تعذّر تنفيذ العملية؛ تحقق من الحالة قبل المحاولة مجددًا.')}</p>`:''}${url?`<a class="b" rel="noreferrer" href="${esc(url)}" download>تنزيل النسخة المشفرة · صالح 10 دقائق</a>`:''}${job.action==='cleanup'&&job.status==='succeeded'?`<small>حُذف ${Number(job.result?.deleted)||0} ملف · تُرك ${Number(job.result?.skipped_changed)||0} ملف تغيّر منذ تسجيله</small>`:''}${job.action==='restore'&&job.status==='succeeded'?'<small>اكتملت الاستعادة. يلزم دخول جديد لحسابات الشركة.</small>':''}${resume?`<button class="b danger" type="button" data-resume-id="${esc(job.id)}" ${busy?'disabled':''}>الرجوع إلى نسخة الأمان</button>`:''}</div></article>`;}).join('')||'<p class="owner-empty">لا توجد عمليات مسجلة.</p>';
 }
 function renderResources(latency){
  const r=resources,stats=r.database_stats||{},connections=r.connections||{},storage=r.storage||{},perf=r.query_performance;
  $('owner-resource-stamp').textContent='القياسات: '+date(r.checked_at)+' · زمن استجابة طلبي اللوحة: '+Math.round(latency)+' ms';
  const metric=(label,value,note)=>`<article><span>${label}</span><strong dir="ltr">${esc(value)}</strong><small>${note}</small></article>`;
  $('owner-resource-content').innerHTML=`<div class="owner-metrics">${metric('حجم قاعدة البيانات',bytes(r.database_bytes),'يشمل الجداول والفهارس والبيانات الداخلية')}${metric('ملفات Storage',bytes(storage.bytes),(Number(storage.objects)||0)+' ملف'+(storage.size_unknown?' · بعض الأحجام غير معروفة':''))}${metric('اتصالات قاعدة البيانات',(connections.total??'—')+' / '+(connections.maximum??'—'),(connections.active??'—')+' اتصال نشط')}${metric('إصابات كاش قاعدة البيانات',stats.cache_hit_percent==null?'غير متاح':stats.cache_hit_percent+'%','مؤشر تراكمي منذ إعادة ضبط الإحصاءات')}</div><div class="owner-resource-notes"><p>المعاملات الناجحة: <b>${esc(stats.transactions_committed??'—')}</b> · المتراجعة: <b>${esc(stats.transactions_rolled_back??'—')}</b> · التعارضات: <b>${esc(stats.deadlocks??'—')}</b></p><p>بداية الإحصاءات: ${esc(date(stats.stats_since))}. متوسط تنفيذ الاستعلامات: ${perf?.mean_exec_ms!=null?esc(Number(perf.mean_exec_ms).toFixed(2))+' ms':'غير متاح'}.</p><p>CPU والذاكرة وحدود خطة الاستضافة غير متاحة من هذا الاتصال. حجم قاعدة البيانات قد لا ينخفض مباشرة بعد الحذف لأن PostgreSQL يعيد استخدام المساحة.</p></div><details><summary>أحجام الجداول والفهارس</summary><div class="owner-table-wrap"><table><thead><tr><th>الجدول</th><th>الحجم</th><th>الفهارس</th><th>صفوف تقديرية</th></tr></thead><tbody>${(r.tables||[]).map(t=>`<tr><td dir="ltr">${esc(t.schemaname+'.'+t.relname)}</td><td dir="ltr">${bytes(t.total_bytes)}</td><td dir="ltr">${bytes(t.index_bytes)}</td><td>${Number(t.estimated_rows)||0}</td></tr>`).join('')}</tbody></table></div></details><details><summary>حاويات Storage</summary>${(storage.buckets||[]).map(b=>`<p><b dir="ltr">${esc(b.id)}</b> · ${b.public?'عامة':'خاصة'} · ${Number(b.object_count)||0} ملف · <span dir="ltr">${bytes(b.size_bytes)}</span></p>`).join('')||'<p>لا توجد حاويات.</p>'}</details>`;
  const safe=r.safe_cleanup||{};$('owner-cleanup-preview').innerHTML=`<p>الملفات المؤقتة المنتهية المسجلة: <b>${Number(safe.files)||0}</b>. تُحذف فقط ملفات <code dir="ltr">owner-temp/</code> المسجلة كملفات مؤقتة، وبعد مطابقة بصمتها. تبقى الملفات الأخرى محفوظة.</p>${(safe.candidates||[]).map(x=>`<p class="owner-muted"><code dir="ltr">${esc(x.bucket+'/'+x.name)}</code> · انتهت ${esc(date(x.expired_at))}</p>`).join('')}`;
  $('owner-safe-cleanup').disabled=busy||!(safe.files>0);
 }
 async function queue(action,key=null,extra={}){
  if(busy||!client||!valid())return false;busy=true;const gen=generation;message('جارٍ تسجيل الطلب…');$('owner-operations').querySelectorAll('button').forEach(b=>b.disabled=true);
  try{
   if(action!=='catalog'&&!await OwnerMfa.ensure()){message('');return false;}
   if(gen!==generation||!valid())return false;
   const {data,error}=action==='resume'?await rpc('owner_resume_backup_restore',{p_job_id:key,...extra}):await rpc('owner_request_backup',{p_action:action,p_object_key:key,...extra});
   if(gen!==generation||!valid())return false;if(error||!data?.id){message(error?.message||'تعذّر تأكيد تسجيل الطلب. حدّث الحالة قبل المحاولة مجددًا.',true);return false;}message('سُجّل الطلب. يمكنك إغلاق اللوحة ومتابعة النتيجة من سجل العمليات.');return true;
  }
  catch{if(gen===generation&&valid())message('تعذّر تأكيد تسجيل الطلب. حدّث الحالة قبل إعادة المحاولة.',true);return false;}
  finally{if(gen===generation&&valid()){busy=false;$('owner-operations').querySelectorAll('button').forEach(b=>b.disabled=false);await load();}}
 }
 const dialog=$('owner-restore-dialog');
 function showRestore(key,resume=false){
  const entry=resume?consoleData?.jobs?.find(job=>job.id===key&&job.recoverable):consoleData?.files?.find(f=>f.object_key===key);
  if(!entry||!consoleData.transport_key)return;
  const transport=consoleData.transport_key,gen=generation;
  $('owner-restore-form').reset();$('owner-restore-title').textContent=resume?'الرجوع إلى نسخة الأمان':'مراجعة الاستعادة';
  $('owner-restore-selected').textContent=resume?entry.safety_backup_key||'':date(entry.created_at)+' · '+bytes(entry.size_bytes);
  $('owner-restore-description').textContent=resume?'سيعيد المنفّذ ملفات نسخة الأمان ويتحقق منها قبل إعادة فتح التطبيق.':'تُستبدل بيانات التشغيل والملفات بالنسخة المحددة. تُحفظ نسخة أمان أولًا، ويتوقف التطبيق مؤقتًا أثناء التنفيذ. يحتفظ الفريق بحساباته وصلاحياته الحالية ويلزم تسجيل دخول جديد بعد النجاح.';
  $('owner-restore-error').textContent='';dialog.showModal();
  $('owner-restore-form').onsubmit=async event=>{
   event.preventDefault();if(gen!==generation||!valid())return;const button=$('owner-restore-confirm');button.disabled=true;
   try{if(!await OwnerMfa.ensure()||gen!==generation||!valid())return;
    const selected=$('owner-recovery-key').files[0];if(!selected||selected.size>65536)throw Error('اختر ملف مفتاح استعادة بحجم أقل من 64 KB.');let text=await selected.text();const matches=text.match(/AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}/g);text='';if(matches?.length!==1)throw Error('لم يُعثر على مفتاح age واحد صحيح داخل الملف.');
    const publicKey=await crypto.subtle.importKey('jwk',transport.jwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);const clear=new TextEncoder().encode(matches[0]);matches[0]='';let encrypted;try{encrypted=await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,clear);}finally{clear.fill(0);$('owner-recovery-key').value='';}const envelope=btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    if(gen!==generation||!valid())return;if(await queue(resume?'resume':'restore',key,{p_encrypted_identity:envelope,p_transport_key:transport.id,p_confirmation:$('owner-restore-word').value.trim()}))dialog.close();
   }catch(error){if(gen===generation&&valid())$('owner-restore-error').textContent=error.message||'تعذّر تجهيز المفتاح.';}finally{button.disabled=false;}
  };
 }
 async function cacheCandidates(){return (await import('/owner-cache.js')).cacheCandidates();}
 const cacheButton=$('owner-cache-clear');
 if(location.hostname==='owner.nature-care.net'){
  const link=document.createElement('a');link.className=cacheButton.className;
  link.href='https://applications.nature-care.net/owner-cache.html';link.target='_blank';link.rel='noopener';
  link.textContent='فتح فحص الكاش على نطاق التطبيقات';cacheButton.replaceWith(link);
  $('owner-cache-preview').textContent='تفتح صفحة الفحص في تبويب جديد على نطاق التطبيقات لتصل إلى حزمها المحفوظة في هذا المتصفح.';
 }else{
  cacheButton.onclick=async()=>{
   const gen=generation;if(!valid())return;cacheButton.disabled=true;
   try{const {clearOldAppBundles}=await import('/owner-cache.js');await clearOldAppBundles($('owner-cache-preview'),()=>gen===generation&&valid());}
   catch{if(gen===generation&&valid())$('owner-cache-preview').textContent='تعذّر تحميل صفحة فحص الكاش. حاول مجددًا.';}
   finally{cacheButton.disabled=false;}
  };
 }
 $('owner-backup-more').onclick=async()=>{if(busy||loading||!valid()||!allFiles.length)return;const gen=generation,last=allFiles.at(-1);$('owner-backup-more').disabled=true;try{const {data,error}=await rpc('owner_backup_console',{p_limit:100,p_before:last.created_at,p_before_key:last.object_key});if(gen!==generation||!valid())return;if(error)throw error;const merged=new Map(allFiles.map(f=>[f.object_key,f]));for(const file of data.files||[])merged.set(file.object_key,file);allFiles=[...merged.values()];consoleData={...data,files:allFiles};renderBackups();}catch{if(gen===generation&&valid())message('تعذّر تحميل النسخ الأقدم. حاول مجددًا.',true);}finally{if(gen===generation)$('owner-backup-more').disabled=false;}};
 $('owner-backup-create').onclick=()=>void queue('create');$('owner-backup-scan').onclick=()=>void queue('catalog');$('owner-operations-refresh').onclick=()=>void load();
 $('owner-safe-cleanup').onclick=()=>{if(!resources?.safe_cleanup?.files)return;if(confirm('حذف '+resources.safe_cleanup.files+' ملف مؤقت منتهٍ من القائمة المسجلة، بعد مطابقة بصمتها؟'))void queue('cleanup',null,{p_confirmation:'تنظيف'});};
 $('owner-backup-files').onclick=event=>{const button=event.target.closest('button[data-backup-action]');if(!button||busy)return;if(button.dataset.backupAction==='restore')showRestore(button.dataset.key);else void queue('download',button.dataset.key);};
 $('owner-backup-jobs').onclick=event=>{const button=event.target.closest('button[data-resume-id]');if(button&&!busy)showRestore(button.dataset.resumeId,true);};
 $('owner-restore-cancel').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{$('owner-restore-form').reset();});
 global.OwnerOperations={activate(nextClient,key,current){if(client!==nextClient||!valid()){++generation;client=nextClient;}valid=current;void load();},reset(){++generation;clearTimeout(timer);client=null;valid=()=>false;loading=false;busy=false;consoleData=null;resources=null;allFiles=[];dialog.close();$('owner-backup-files').replaceChildren();$('owner-backup-jobs').replaceChildren();$('owner-resource-content').replaceChildren();$('owner-cleanup-preview').replaceChildren();message('');},cacheCandidates};
})(globalThis);
