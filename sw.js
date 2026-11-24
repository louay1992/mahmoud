/* Only public static assets enter CacheStorage. Private data lives in account-scoped IndexedDB. */
const APP = new URL(self.registration.scope).pathname.startsWith("/admin") ? "admin" :
  new URL(self.registration.scope).pathname.startsWith("/captain") ? "captain" : "legacy";
const CACHE_PREFIX = "shell-" + APP + "-";
const CACHE = CACHE_PREFIX + "v15";
const BUNDLE_PREFIX='offline-bundle-'+APP+'-';
const META='offline-package-pointer-'+APP;
let preparing;
async function active(){const cache=await caches.open(META),response=await cache.match('/__offline_active');return response?response.text():null;}
async function prepare(){
  if(preparing)return preparing;
  preparing=(async()=>{
    const response=await fetch('/offline-shell-manifest.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('shell manifest');const manifest=await response.json(),pack=manifest[APP];
    if(manifest.schema!==1||!pack||!/^[a-f0-9]{64}$/.test(pack.version)||!Array.isArray(pack.files)||!pack.files.length)throw Error('invalid shell');
    const name=BUNDLE_PREFIX+pack.version,previous=await active();if(name===previous)return name;
    const cache=await caches.open(name);
    try{
      const results=await Promise.allSettled(pack.files.map(async file=>{
        if(!/^\/[a-zA-Z0-9/_.-]+$/.test(file.url)||file.url.includes('..')||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('invalid asset');
        const result=await fetch(file.url,{cache:'reload',signal:AbortSignal.timeout(15000)});if(!result.ok)throw Error('missing asset');
        const data=await result.clone().arrayBuffer(),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('');
        if(hash!==file.sha256)throw Error('mixed release');await cache.put(file.url,result);
      }));
      if(results.some(result=>result.status==='rejected'))throw Error('incomplete shell');
      const meta=await caches.open(META);await meta.put('/__offline_active',new Response(name));
      // Keep the previous complete release until a later successful installation.
      for(const key of await caches.keys())if(key.startsWith(BUNDLE_PREFIX)&&key!==name&&key!==previous)await caches.delete(key);
      return name;
    }catch(error){await caches.delete(name);throw error;}
  })().finally(()=>{preparing=null;});return preparing;
}
self.addEventListener('install',event=>{event.waitUntil(prepare().catch(()=>{}).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(CACHE_PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('message',event=>{if(event.data==='SKIP_WAITING')self.skipWaiting();if(event.data==='PREPARE_OFFLINE')event.waitUntil(prepare().then(()=>event.ports[0]?.postMessage({ok:true})).catch(()=>event.ports[0]?.postMessage({ok:false})));});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==location.origin)return;
  if(['/app-version.json','/offline-shell-manifest.json'].includes(url.pathname))return;
  const navigation=request.mode==='navigate'&&new RegExp('^/'+APP+'(?:\\.html)?/?$').test(url.pathname);
  event.respondWith((async()=>{
    let name=await active(),offline=false;
    if(navigation){try{name=await prepare();}catch(_){offline=true;}}
    const cache=name?await caches.open(name):null,response=cache?await cache.match(navigation?'/'+APP+'.html':url.pathname):null;
    if(response){
      if(navigation&&offline){const html=(await response.text()).replace('<head>','<head><meta name="delivery-offline-shell" content="1">');return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}});}
      return response;
    }
    return fetch(request);
  })());
});
// استلام إشعار Push من الخادم (يعمل والتطبيق مغلق)
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: "كابتن التوصيل", body: e.data ? e.data.text() : "" }; }
  const app = APP === "admin" ? "admin" : "captain";
  e.waitUntil(self.registration.showNotification(d.title || (app === "admin" ? "الإدارة" : "كابتن التوصيل"), {
    body: d.body || "", tag: d.tag || undefined, icon: d.icon || "/icons/" + app + "-192.png", badge: d.icon || "/icons/" + app + "-192.png",
    dir: "rtl", lang: "ar", renotify: !!d.tag, vibrate: [200, 100, 200], data: { url: d.url || "/" + app + ".html" }
  }));
});
// الضغط على الإشعار يفتح التطبيق
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const fallback = "/" + (APP === "admin" ? "admin" : "captain") + ".html";
  let target;
  try { target = new URL(e.notification.data?.url || fallback, location.origin); }
  catch (_) { target = new URL(fallback, location.origin); }
  if (target.origin !== location.origin) target = new URL(fallback, location.origin);
  const appScope = target.pathname.startsWith("/admin") ? "/admin" : "/captain";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async list => {
    for (const c of list) {
      if (new URL(c.url).pathname.startsWith(appScope) && "focus" in c) {
        if (c.url !== target.href && "navigate" in c) await c.navigate(target.href);
        return c.focus();
      }
    }
    return self.clients.openWindow(target.href);
  }));
});
