/* Native Android host; verified TWA ports remain supported for older installations. */
class NativeDeliveryPush {
  constructor({ role, session }) {
    this.role = role;
    this.session = session;
    this.embedded = new URLSearchParams(location.search).get('host') === 'android' || !!globalThis.DeliveryAndroidHost?.postMessage;
    this.expected = new URLSearchParams(location.search).get("native") === "1" ||
      this.embedded || (typeof document !== "undefined" && document.referrer.startsWith("android-app://app.hhyyw." + role));
    this.state = { permission: "default", configured: false, saved: false };
    this.unbindKey = 'delivery-native-unbind-' + role;
    try { this.unbindPending = globalThis.localStorage?.getItem(this.unbindKey) === '1'; } catch (_) { this.unbindPending = false; }
    this.pending = new Map();
    this.candidates = new Map();
    this.serial = 0;
    if (this.embedded && globalThis.DeliveryAndroidHost?.postMessage) {
      const host = globalThis.DeliveryAndroidHost;
      const adapter = { postMessage: raw => host.postMessage(raw), start() {}, close() { host.onmessage = null; } };
      host.onmessage = event => {
        let data; try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch (_) { return; }
        if (data?.type === 'delivery.native.ready') {
          if (this.validHello(data) && data.host === 'android') this.activate(adapter, data);
        } else if (this.port === adapter) this.receive(event.data);
      };
      Promise.resolve().then(() => host.postMessage(JSON.stringify({type:'hello',version:1,role:this.role}))).catch(error => { this.state.error = error.message; });
    }
    globalThis.addEventListener("message", event => {
      if (this.embedded) return;
      if (event.origin !== location.origin || !event.ports?.[0]) return;
      if (event.source && event.source !== globalThis) return;
      let data;
      try { data = typeof event.data === 'string' && event.data ? JSON.parse(event.data) : event.data; } catch (_) { return; }
      const port = event.ports[0];
      // Chromium transfers a port with an empty Window message. The Android hello
      // then arrives ON that port, rather than in the Window bootstrap payload.
      if (data?.type === 'delivery.native.ready') {
        if (this.validHello(data)) this.activate(port, data); else port.close();
        return;
      }
      if (data !== '' && data != null) return;
      if (this.candidates.has(port)) return;
      const timer = setTimeout(() => {
        this.discardCandidate(port);
        if (!this.port) this.state.error = 'وصل منفذ Chrome لكن لم يصل تعريف Android. أعد فتح التطبيق وتحقق من نسخة APK.';
      }, 5000);
      this.candidates.set(port, timer);
      port.onmessage = event => {
        if (!this.candidates.has(port)) return;
        let hello;
        try { hello = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch (_) { return; }
        if (hello?.type !== 'delivery.native.ready') return;
        if (this.validHello(hello)) this.activate(port, hello); else this.discardCandidate(port);
      };
      port.start?.();
    });
  }

  validHello(data) { return data.role === this.role && data.version === 1; }
  discardCandidate(port) {
    clearTimeout(this.candidates.get(port)); this.candidates.delete(port);
    port.onmessage = null; port.close();
  }
  activate(port, data) {
    clearTimeout(this.candidates.get(port)); this.candidates.delete(port);
    for (const candidate of this.candidates.keys()) this.discardCandidate(candidate);
    if (this.port && this.port !== port) {
      this.port.close();
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('أُعيد الاتصال بتطبيق Android؛ أعد المحاولة')); }
      this.pending.clear(); this.unbindPromise = null;
    }
    this.expected = true; this.port = port; this.state.error = ''; this.update(data);
    port.onmessage = event => this.receive(event.data); port.start?.();
    this.readyResolve?.();
    if (this.unbindPending) this.unbind().catch(() => {});
    globalThis.dispatchEvent(new Event('delivery-native-ready'));
  }

  get permission() { return this.state.permission; }
  get enabled() { return this.permission === "granted" && this.state.saved === true; }
  update(data) {
    for (const key of ["permission", "configured", "saved", "account_id", "error", "host", "app_version", "app_name"]) {
      if (Object.hasOwn(data, key)) this.state[key] = data[key];
    }
    if (this.unbindPending) { this.state.saved = false; this.state.account_id = ''; }
  }
  receive(raw) {
    let data;
    try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return; }
    if (!data || typeof data !== "object") return;
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    clearTimeout(pending.timer);
    this.update(data);
    this.state.error = data.ok === false ? String(data.error || "تعذّر تنفيذ إجراء Android") : "";
    if (data.ok === false) pending.reject(new Error(data.error || "تعذّر تنفيذ إجراء Android"));
    else pending.resolve(data);
  }
  async ready() {
    if (this.port) return;
    if (!this.readyPromise) this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.readyPromise = null; reject(new Error(this.channelError())); }, 15000);
      this.readyResolve = () => { clearTimeout(timer); resolve(); };
    });
    await this.readyPromise;
  }
  async request(type, payload = {}, { timeout = 35000, waitForChannel = true } = {}) {
    if (!waitForChannel && !this.port) throw new Error(this.channelError());
    if (waitForChannel) await this.ready();
    if (type === 'bind' && this.unbindPending) throw new Error('جارٍ فصل الحساب السابق؛ أعد المحاولة');
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("انتهت مهلة اتصال Android؛ تحقق من الاتصال وأعد المحاولة"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.port.postMessage(JSON.stringify({ type, id, ...payload })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async requestPermission() {
    const result = await this.request("permission", {}, { waitForChannel: false });
    return result.permission;
  }
  async bind() {
    await this.ready();
    if (this.unbindPending) await this.unbind();
    const { data: { session } } = await this.session();
    if (!session?.access_token || !session.user?.id) throw new Error("سجّل الدخول أولاً");
    // The token crosses the verified port once and is never persisted by Android.
    const result = await this.request("bind", { access_token: session.access_token });
    if (result.account_id !== session.user.id || !result.saved) { this.state.saved = false; throw new Error("لم يُؤكَّد ربط الجهاز بالحساب الحالي"); }
    return result;
  }
  unbind() {
    this.unbindPending = true;
    this.state.saved = false; this.state.account_id = '';
    try { globalThis.localStorage?.setItem(this.unbindKey, '1'); } catch (_) {}
    if (!this.unbindPromise) {
      const operation = this.request('unbind').then(result => {
      if (result.saved) throw new Error('لم يُؤكّد فصل إشعارات الحساب');
      this.unbindPending = false;
      try { globalThis.localStorage?.removeItem(this.unbindKey); } catch (_) {}
      return result;
      }).finally(() => { if (this.unbindPromise === operation) this.unbindPromise = null; });
      this.unbindPromise = operation;
    }
    return this.unbindPromise;
  }
  snapshot() {
    return { ...this.state, transport: "Firebase FCM", requestResult: this.permission,
      push: this.port ? this.state.configured : null, active: !!this.port, scope: "/" + this.role,
      subscription: this.state.saved, userAgent: navigator.userAgent,
      error: this.port ? this.state.error : this.state.error || this.channelError() };
  }
  async inspect() {
    if (!this.port) return this.snapshot();
    try { await this.request('status', {}, { timeout: 2500, waitForChannel: false }); }
    catch (error) { this.state.error = error.message; }
    return this.snapshot();
  }
  async showTest() { return this.request("test", {}, { waitForChannel: false }); }
  channelError() { return this.embedded ? 'الاتصال الداخلي بإشعارات التطبيق غير جاهز. أغلق التطبيق وأعد فتحه، وتحقق من تثبيت إصدار 1.2.0 أو أحدث.' : 'قناة Android غير متصلة. تحقق من تثبيت نسخة APK الداعمة لـ FCM وتحديث Chrome، ثم افتح التطبيق من أيقونته.'; }
  async copyText(text) { return this.request('copy', {text}, {timeout:5000,waitForChannel:false}); }
  async saveCsv(filename, text) {
    if (text.length > 1000000) throw new Error('حجم التصدير كبير جدًّا؛ اختر فترة أقصر');
    return this.request('save-csv', {filename,text}, {timeout:180000,waitForChannel:false});
  }
  async serverTest() {
    const { data: { session } } = await this.session();
    if (!session?.access_token) throw new Error("سجّل الدخول أولاً");
    return this.request("server-test", { access_token: session.access_token }, { waitForChannel: false });
  }
}
globalThis.NativeDeliveryPush = NativeDeliveryPush;
