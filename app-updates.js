/* Bootstrap for installed Android hosts that predate the native APK updater. */
(function(root){
  const feed='https://raw.githubusercontent.com/louay1992/mahmoud/android-releases/latest.json';
  function version(value){return /^\d+\.\d+\.\d+$/.test(value)?value.split('.').map(Number):null;}
  function newer(next,current){const a=version(next),b=version(current);if(!a||!b)return false;for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
  function release(manifest,role){
    if(!['admin','captain'].includes(role)||manifest?.schema!==1||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit||''))return null;
    const item=manifest.apps?.[role];if(!item||item.packageName!=='app.hhyyw.'+role||!version(item.versionName)||!Number.isSafeInteger(item.versionCode)||item.versionCode<=0||item.versionCode>2147483647||!Number.isSafeInteger(item.size)||item.size<=0||item.size>100*1024*1024||!/^[a-f0-9]{64}$/.test(item.sha256||'')||typeof item.notes!=='string'||item.notes.length>2000)return null;
    let url;try{url=new URL(item.url);}catch(_){return null;}
    const filename='Delivery-'+(role==='admin'?'Admin':'Captain')+'-'+item.versionName+'.apk';
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.port||url.search||url.hash||!url.pathname.startsWith('/louay1992/mahmoud/releases/download/'))return null;
    const parts=url.pathname.split('/');if(parts.length!==7||!/^[A-Za-z0-9._-]+$/.test(parts[5])||parts[6]!==filename)return null;
    return {...item,url:url.href};
  }
  const sessions=new WeakMap();let currentNative;
  function show(item,native){
    if(!document.body||document.getElementById('delivery-apk-update'))return;
    const dialog=document.createElement('dialog');dialog.id='delivery-apk-update';dialog.className='delivery-apk-update '+native.role;dialog.dir='rtl';dialog.setAttribute('aria-labelledby','delivery-apk-title');
    dialog.innerHTML='<div class="apk-update-icon" aria-hidden="true">↑</div><p class="apk-update-eyebrow">'+(native.role==='admin'?'تطبيق الإدارة':'تطبيق الكابتن')+'</p><h2 id="delivery-apk-title">تحديث جديد متاح</h2><p class="apk-update-version"></p><p class="apk-update-notes"></p><p class="apk-update-help">نزّل النسخة الجديدة، ثم افتح الملف لتثبيت التحديث مع الحفاظ على حسابك وبياناتك.</p><div class="apk-update-actions"><a class="apk-update-download">تنزيل التحديث</a><button type="button">لاحقًا</button></div>';
    dialog.querySelector('.apk-update-version').textContent='الإصدار '+item.versionName+' · '+(item.size/1048576).toFixed(1)+' MB';
    dialog.querySelector('.apk-update-notes').textContent=item.notes;
    const link=dialog.querySelector('a');link.href=item.url;link.rel='noopener';
    const previous=document.activeElement;
    dialog.querySelector('button').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{dialog.remove();previous?.focus?.();},{once:true});
    document.body.appendChild(dialog);dialog.showModal();
  }
  async function check(native,manual=false){
    if(!native?.embedded||!native.state?.app_version||!['admin','captain'].includes(native.role))return;
    if(native.state.app_update_supported){if(manual)await native.request('check-app-update');return;}
    let state=sessions.get(native);if(!state){state={last:0,shown:null,flight:null};sessions.set(native,state);}
    if(state.flight)return state.flight;if(!manual&&Date.now()-state.last<300000)return;
    state.last=Date.now();
    state.flight=(async()=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),8000);
      try{
        const response=await fetch(feed+'?t='+Date.now(),{cache:'no-store',signal:abort.signal});if(!response.ok)return;
        const raw=await response.text();if(raw.length>65536)return;
        const item=release(JSON.parse(raw),native.role);
        if(!item||!newer(item.versionName,native.state.app_version)||(!manual&&state.shown===item.versionCode))return;
        if(document.hidden)return;
        state.shown=item.versionCode;show(item,native);
      }catch(_){/* Offline release checks never interrupt login or the current task. */}
      finally{clearTimeout(timer);state.flight=null;}
    })();return state.flight;
  }
  const api={release,newer,feed,connected(native){currentNative=native;void check(native);},check(){return check(currentNative,true);}};
  root.DeliveryAppUpdates=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document!=='undefined')document.addEventListener('visibilitychange',()=>{if(!document.hidden&&currentNative)void check(currentNative);});
})(globalThis);
