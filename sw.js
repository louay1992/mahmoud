// الشبكة أولاً (حتى لا تبقى نسخة قديمة)، وإن لم يتوفر الإنترنت تُعرض آخر نسخة محفوظة.
// مكتبة Supabase من CDN تُحفظ أيضاً ليعمل التطبيق عند ضعف الشبكة.
const CACHE = "shell-v3";
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
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
// الضغط على الإشعار يفتح التطبيق
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/captain.html";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
