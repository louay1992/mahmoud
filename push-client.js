/* Shared notification subscription flow for the captain and admin applications. */
class DeliveryPush {
  constructor({ scope, keyUrl, apiKey, save, remove, session }) {
    this.scope = scope;
    this.keyUrl = keyUrl;
    this.apiKey = apiKey;
    this.save = save;
    this.remove = remove;
    this.native = globalThis.NativeDeliveryPush && session ?
      new NativeDeliveryPush({ role: scope.slice(1), session }) : null;
    this.saved = false;
    this.lastError = null;
    this.lastWarning = null;
    this.requestResult = null;
    this.registrationPromise = null;
    this.subscriptionPromise = null;
  }

  get permission() {
    if (this.native?.expected) return this.native.permission;
    return "Notification" in globalThis ? Notification.permission : "na";
  }

  get enabled() {
    if (this.native?.expected) return this.native.enabled;
    return this.permission === "granted" && this.saved;
  }

  async requestPermission() {
    if (this.native?.expected) {
      this.requestResult = await this.native.requestPermission();
      return this.requestResult;
    }
    if (this.permission === "na") throw new Error("المتصفح لا يدعم الإشعارات");
    this.requestResult = await Notification.requestPermission();
    // A delegated Android permission can take a moment to reach the page.
    if (this.requestResult === "granted") {
      for (let i = 0; i < 10 && this.permission === "default"; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (this.permission !== "granted") {
        throw new Error("وافق طلب الإذن لكن إذن الموقع بقي " + this.permission +
          ". تعذّر ربط الإذن بالتطبيق؛ حدّث التطبيق والمتصفح ثم أعد فتحه.");
      }
    }
    return this.requestResult;
  }

  async bounded(promise, message) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async registration() {
    if (!("serviceWorker" in navigator)) throw new Error("خدمة الخلفية غير مدعومة");
    if (!this.registrationPromise) {
      this.registrationPromise = this.openRegistration().catch(error => {
        this.registrationPromise = null;
        throw error;
      });
    }
    return this.registrationPromise;
  }

  async openRegistration() {
    // These scopes match the Android intent filters and keep the two owners apart.
    const reg = await this.bounded(navigator.serviceWorker.register("/sw.js", {
      scope: this.scope, updateViaCache: "none"
    }), "انتهت مهلة تسجيل خدمة الخلفية. تحقق من الاتصال وأعد المحاولة.");
    if (reg.scope !== new URL(this.scope, location.origin).href) {
      throw new Error("نطاق خدمة الإشعارات لا يطابق التطبيق");
    }
    if (reg.active) return reg;
    const worker = reg.installing || reg.waiting;
    if (!worker) throw new Error("خدمة الخلفية لم تبدأ");
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        worker.removeEventListener("statechange", check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (reg.active || worker.state === "activated") finish();
        else if (worker.state === "redundant") finish(new Error("تعذّر تشغيل خدمة الخلفية"));
      };
      const timer = setTimeout(() => finish(new Error("انتهت مهلة تشغيل خدمة الخلفية")), 15000);
      worker.addEventListener("statechange", check);
      check();
    });
    return reg;
  }

  async subscribe() {
    if (this.subscriptionPromise) return this.subscriptionPromise;
    this.subscriptionPromise = this.subscribeAndSave().finally(() => {
      this.subscriptionPromise = null;
    });
    return this.subscriptionPromise;
  }

  async subscribeAndSave() {
    this.saved = false;
    this.lastError = null;
    this.lastWarning = null;
    try {
      if (this.native?.expected) {
        const result = await this.native.bind();
        // Retire Web Push on this browser profile only after FCM binding succeeds.
        try {
          const reg = await navigator.serviceWorker?.getRegistration(this.scope);
          const sub = await reg?.pushManager.getSubscription();
          if (sub) {
            const removed = await this.remove({ p_endpoint: sub.endpoint });
            if (removed?.error) throw new Error(removed.error.message);
          }
          await this.retireLegacyEndpoint(null);
        } catch (error) { this.lastWarning = error; }
        return result;
      }
      if (this.permission !== "granted") {
        throw new Error("إذن الموقع ليس granted (" + this.permission + ")");
      }
      if (!("PushManager" in globalThis)) throw new Error("المتصفح لا يدعم Push");
      const reg = await this.registration();
      let sub = await this.bounded(reg.pushManager.getSubscription(), "انتهت مهلة قراءة اشتراك الجهاز");
      if (!sub) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let key;
        try {
          const response = await fetch(this.keyUrl, {
            headers: { apikey: this.apiKey }, signal: controller.signal
          });
          if (!response.ok) throw new Error("تعذّر تحميل مفتاح الإشعارات (HTTP " + response.status + ")");
          ({ key } = await response.json());
          if (typeof key !== "string" || !/^[A-Za-z0-9_-]+$/.test(key)) {
            throw new Error("مفتاح الإشعارات غير صالح");
          }
        } finally {
          clearTimeout(timer);
        }
        const raw = atob((key + "=".repeat((4 - key.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
        const applicationServerKey = Uint8Array.from(raw, c => c.charCodeAt(0));
        sub = await this.bounded(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }),
          "انتهت مهلة إنشاء اشتراك الإشعارات. أعد المحاولة.");
      }
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("بيانات اشتراك الجهاز غير مكتملة");
      }
      const result = await this.bounded(this.save({
        p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth
      }), "انتهت مهلة حفظ اشتراك الإشعارات");
      if (result?.error) throw new Error("تعذّر حفظ الاشتراك: " + result.error.message);
      this.saved = true;
      await this.retireLegacyEndpoint(json.endpoint);
      return sub;
    } catch (error) {
      this.lastError = error;
      throw error;
    }
  }

  async retireLegacyEndpoint(currentEndpoint) {
    try {
      const reg = await this.bounded(navigator.serviceWorker.getRegistration("/"), "تعذّر قراءة الاشتراك السابق");
      if (!reg || reg.scope !== new URL("/", location.origin).href) return;
      const sub = await this.bounded(reg.pushManager.getSubscription(), "تعذّر قراءة الاشتراك السابق");
      if (!sub || sub.endpoint === currentEndpoint) return;
      // The RPC only removes records owned by the current account. Keep the browser
      // subscription and root worker intact: the other app may still use them.
      const result = await this.bounded(this.remove({ p_endpoint: sub.endpoint }), "تعذّر إزالة سجل الاشتراك السابق");
      if (result?.error) throw new Error(result.error.message);
    } catch (error) {
      this.lastWarning = error;
      console.warn("legacy push registration", error);
    }
  }

  async unsubscribe() {
    this.saved = false;
    if (this.native?.expected) {
      await this.native.unbind();
      return;
    }
    const reg = await navigator.serviceWorker?.getRegistration(this.scope);
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      // Disable browser delivery even when the account's RPC is offline or fails.
      await sub.unsubscribe();
      const result = await this.remove({ p_endpoint: sub.endpoint });
      if (result?.error) throw new Error(result.error.message);
    }
    this.saved = false;
    await this.retireLegacyEndpoint(null);
  }

  snapshot() {
    if (this.native?.expected) return this.native.snapshot();
    return {
      transport: 'Web Push',
      permission: this.permission, requestResult: this.requestResult, saved: this.saved,
      push: "PushManager" in globalThis, scope: this.scope, active: false, subscription: false,
      userAgent: navigator.userAgent, error: this.lastError?.message || ""
    };
  }

  async inspect() {
    if (this.native?.expected) return this.native.inspect();
    const result = this.snapshot();
    try {
      const reg = await this.registration();
      result.scope = new URL(reg.scope).pathname;
      result.active = !!reg.active;
      result.subscription = !!await this.bounded(reg.pushManager.getSubscription(), "تعذّر قراءة اشتراك الجهاز");
    } catch (error) {
      result.error = error.message;
    }
    return result;
  }

  async showTest(title, options) {
    if (this.native?.expected) return this.native.showTest();
    const reg = await this.registration();
    await reg.showNotification(title, options);
  }
}
globalThis.DeliveryPush = DeliveryPush;
