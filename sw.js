// الشبكة أولاً (حتى لا تبقى نسخة قديمة)، وإن لم يتوفر الإنترنت تُعرض آخر نسخة محفوظة.
// مكتبة Supabase من CDN تُحفظ أيضاً ليعمل التطبيق عند ضعف الشبكة.
const APP = new URL(self.registration.scope).pathname.startsWith("/admin") ? "admin" :
  new URL(self.registration.scope).pathname.startsWith("/captain") ? "captain" : "legacy";
const CACHE_PREFIX = "shell-" + APP + "-";
const CACHE = CACHE_PREFIX + "v12";
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  const own = url.origin === location.origin, cdn = url.hostname === "cdn.jsdelivr.net";
  if (!own && !cdn) return; // لا نتدخل في طلبات Supabase
  e.respondWith(fetch(req).then(res => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
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
