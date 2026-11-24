/* Render before probing Android/network services; closing never waits for a probe. */
function openDeliveryPushDiagnostics({ client, role, initialLog = '', enable, refreshUI, escape: esc, probeTimeout = 3000, actionTimeout = 40000 }) {
  const previous = document.getElementById('pdg');
  if (previous?.closeDiagnostics) previous.closeDiagnostics(); else previous?.remove();
  const box = document.createElement('div'); box.id = 'pdg';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'pdg-title');
  box.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:99999;display:flex;align-items:flex-end;justify-content:center';
  const lifetime = new AbortController(), log = initialLog ? [initialLog] : [];
  let state = client.snapshot(), checking = false, working = false, revision = 0, closed = false;
  function close() {
    closed = true; lifetime.abort(); document.removeEventListener('keydown', onKey); box.remove();
  }
  function onKey(event) { if (event.key === 'Escape') close(); }
  box.closeDiagnostics = close;
  box.addEventListener('click', event => { if (event.target === box) close(); });
  document.addEventListener('keydown', onKey);
  function bounded(task, timeout) {
    return new Promise((resolve, reject) => {
      const aborted = () => finish(new Error('أُغلق الفحص'));
      const timer = setTimeout(() => finish(new Error('انتهت مهلة الفحص؛ يمكنك إعادة المحاولة أو إغلاق النافذة.')), timeout);
      const finish = (error, value) => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(value); };
      if (lifetime.signal.aborted) { aborted(); return; }
      lifetime.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(task).then(value => finish(null, value), error => finish(error));
    });
  }
  function draw() {
    if (closed) return;
    const native = !!client.native?.expected;
    const mode = native || matchMedia('(display-mode: standalone)').matches || document.referrer.startsWith('android-app://') ? 'تطبيق' : 'متصفح';
    box.innerHTML = `<div style="background:#fff;width:100%;max-width:560px;border-radius:18px 18px 0 0;padding:16px;max-height:85dvh;overflow:auto;direction:rtl;font-size:14px;color:#0f172a">
      <b id="pdg-title" style="font-size:16px">🔧 فحص الإشعارات · ${esc(state.transport || 'Web Push')}</b>
      <div role="status" id="pdg-status" style="margin-top:8px">${working ? 'جارٍ تنفيذ الاختبار — يمكنك إغلاق النافذة' : checking ? 'جارٍ قراءة الحالة — يمكنك إغلاق النافذة' : 'اكتمل الفحص'}</div>
      <div style="margin:10px 0;line-height:1.9">${native ? 'إذن إشعارات Android' : 'إذن الموقع الفعلي'}: <b>${native && !state.active ? 'غير معروف — لم يصل رد Android' : esc(state.permission)}</b><br>نتيجة آخر طلب إذن: <b>${esc(state.requestResult || 'لم يُطلب')}</b><br>طريقة التشغيل: <b>${mode}</b><br>دعم Push: <b>${state.push == null ? 'غير معروف' : state.push ? 'نعم' : 'لا'}</b><br>${native ? 'اتصال التطبيق بـ Android' : 'خدمة الخلفية'}: <b>${state.active ? 'يعمل' : 'غير جاهزة'}</b><br>نطاق الخدمة: <b dir="ltr">${esc(state.scope)}</b><br>اشتراك الجهاز: <b>${state.subscription ? 'موجود ✓' : 'غير موجود'}</b><br>حفظ الاشتراك بالخادم: <b>${state.saved ? 'تم ✓' : 'غير مؤكّد'}</b></div>
      ${state.error ? `<div style="color:#b91c1c;margin-bottom:10px">${esc(state.error)}</div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><button class="b btn" id="pdg-ask">1) طلب الإذن</button><button class="b btn" id="pdg-sub">2) تفعيل الاشتراك</button><button class="b btn" id="pdg-local">3) إشعار تجريبي</button>${native ? '<button class="b btn" id="pdg-server">4) اختبار FCM من الخادم</button>' : ''}<button class="b btn" id="pdg-refresh">تحديث الفحص</button><button class="b btn" id="pdg-close">إغلاق</button></div>
      <div style="background:#f1f5f9;border-radius:10px;padding:8px 10px;white-space:pre-wrap;direction:ltr;text-align:left;font-size:12px;min-height:40px">${esc(log.join('\n') || '...')}</div>
      <div style="margin-top:8px;font-size:11px;direction:ltr;text-align:left;overflow-wrap:anywhere">${esc(state.userAgent)}</div></div>`;
    box.querySelector('#pdg-close').onclick = close;
    box.querySelector('#pdg-refresh').onclick = refresh;
    box.querySelector('#pdg-ask').onclick = () => act(async () => {
      try { await client.requestPermission(); }
      finally { log.push('requestPermission → ' + client.requestResult + '; ' + (client.native?.expected ? 'Android.permission' : 'Notification.permission') + ' → ' + client.permission); }
    });
    box.querySelector('#pdg-sub').onclick = () => act(async () => { await enable(); log.push('OK: اشتراك الجهاز وحفظ الخادم نجحا'); });
    box.querySelector('#pdg-local').onclick = () => act(async () => { await client.showTest('إشعار تجريبي', { body: 'إذا ظهر هذا الإشعار فالعرض يعمل', dir: 'rtl', icon: '/icons/' + role + '-192.png', data: { url: '/' + role + '.html' } }); log.push('showNotification OK — فحص عرض محلي'); });
    if (native) box.querySelector('#pdg-server').onclick = () => act(async () => { await client.native.serverTest(); log.push('FCM accepted — أُرسل للاختبار؛ تحقّق من وصوله على الجهاز'); });
    box.querySelectorAll('button:not(#pdg-close)').forEach(button => { button.disabled = working; });
    box.querySelector('#pdg-refresh').disabled = working || checking;
  }
  async function refresh() {
    if (closed || checking) return;
    const current = ++revision; checking = true; draw();
    try { const result = await bounded(() => client.inspect(), probeTimeout); if (current === revision) state = result; }
    catch (error) { if (current === revision) state = { ...client.snapshot(), error: error.message }; }
    finally { if (!closed && current === revision) { checking = false; draw(); } }
  }
  async function act(task) {
    if (working || closed) return;
    ++revision; checking = false; working = true; draw();
    try { await bounded(task, actionTimeout); } catch (error) { if (!closed) log.push('ERR: ' + error.name + ' ' + error.message); }
    finally { if (!closed) { working = false; state = client.snapshot(); refreshUI(); refresh(); } }
  }
  draw(); document.body.appendChild(box); refresh();
  return box;
}
globalThis.openDeliveryPushDiagnostics = openDeliveryPushDiagnostics;
