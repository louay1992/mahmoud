/* The port is supplied by Chrome only after Digital Asset Links validation. */
class NativeDeliveryPush {
  constructor({ role, session }) {
    this.role = role;
    this.session = session;
    this.expected = new URLSearchParams(location.search).get("native") === "1" ||
      (typeof document !== "undefined" && document.referrer.startsWith("android-app://app.hhyyw." + role));
    this.state = { permission: "default", configured: false, saved: false };
    this.unbindKey = 'delivery-native-unbind-' + role;
    try { this.unbindPending = globalThis.localStorage?.getItem(this.unbindKey) === '1'; } catch (_) { this.unbindPending = false; }
    this.pending = new Map();
    this.serial = 0;
    globalThis.addEventListener("message", event => {
      if (event.origin !== location.origin || !event.ports?.[0]) return;
      let data;
      try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch (_) { return; }
      if (data?.type !== "delivery.native.ready" || data.role !== this.role || data.version !== 1) return;
      if (this.port) {
        this.port.close();
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("أُعيد الاتصال بتطبيق Android؛ أعد المحاولة")); }
        this.pending.clear();
      }
      this.expected = true;
      this.port = event.ports[0];
      this.update(data);
      this.port.onmessage = event => this.receive(event.data);
      this.port.start?.();
      this.readyResolve?.();
      if (this.unbindPending) this.unbind().catch(() => {});
      globalThis.dispatchEvent(new Event("delivery-native-ready"));
    });
  }

  get permission() { return this.state.permission; }
  get enabled() { return this.permission === "granted" && this.state.saved === true; }
  update(data) {
    for (const key of ["permission", "configured", "saved", "account_id", "error"]) {
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
      const timer = setTimeout(() => { this.readyPromise = null; reject(new Error("تعذّر الاتصال بتطبيق Android. أعد فتح التطبيق وتحقق من ربط الموقع بشهادة التطبيق.")); }, 15000);
      this.readyResolve = () => { clearTimeout(timer); resolve(); };
    });
    await this.readyPromise;
  }
  async request(type, payload = {}) {
    await this.ready();
    if (type === 'bind' && this.unbindPending) throw new Error('جارٍ فصل الحساب السابق؛ أعد المحاولة');
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("انتهت مهلة اتصال Android؛ تحقق من الاتصال وأعد المحاولة"));
      }, 35000);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage(JSON.stringify({ type, id, ...payload }));
    });
  }
  async requestPermission() {
    const result = await this.request("permission");
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
    if (!this.unbindPromise) this.unbindPromise = this.request('unbind').then(result => {
      if (result.saved) throw new Error('لم يُؤكّد فصل إشعارات الحساب');
      this.unbindPending = false;
      try { globalThis.localStorage?.removeItem(this.unbindKey); } catch (_) {}
      return result;
    }).finally(() => { this.unbindPromise = null; });
    return this.unbindPromise;
  }
  async inspect() {
    try { await this.request("status"); } catch (error) { this.state.error = error.message; }
    return { ...this.state, transport: "Firebase FCM", requestResult: this.permission,
      push: this.state.configured, active: !!this.port, scope: "/" + this.role,
      subscription: this.state.saved, userAgent: navigator.userAgent };
  }
  async showTest() { return this.request("test"); }
  async serverTest() {
    const { data: { session } } = await this.session();
    if (!session?.access_token) throw new Error("سجّل الدخول أولاً");
    return this.request("server-test", { access_token: session.access_token });
  }
}
globalThis.NativeDeliveryPush = NativeDeliveryPush;
