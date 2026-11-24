/* A failed notification channel or remote sign-out must not keep a user signed in. */
class DeliverySession {
  constructor(storageKey, storage = globalThis.localStorage) {
    this.storageKey = storageKey;
    this.storage = storage;
    this.marker = storageKey + '-signed-out';
    this.closed = false;
  }
  get blocked() { return this.closed || this.storage.getItem(this.marker) === '1'; }
  clearSession() {
    for (const suffix of ['', '-user', '-code-verifier']) this.storage.removeItem(this.storageKey + suffix);
  }
  beginLogin() { this.clearSession(); }
  completeLogin() { this.closed = false; this.storage.removeItem(this.marker); }
  async logout({ auth, detach, lock, reload, timeout = 2000 }) {
    if (this.exiting) return this.exiting;
    this.closed = true;
    this.storage.setItem(this.marker, '1');
    lock();
    this.exiting = (async () => {
      let timer;
      try {
        // Start cleanup while the SDK still has its session for server revocation.
        const cleanup = Promise.allSettled([
          Promise.resolve().then(detach),
          Promise.resolve().then(() => auth.signOut({ scope: 'local' })),
          Promise.resolve().then(() => auth.stopAutoRefresh?.())
        ]);
        await Promise.race([cleanup, new Promise(resolve => { timer = setTimeout(resolve, timeout); })]);
      } finally {
        clearTimeout(timer);
        // Older cached SDKs can retain storage when network revocation fails.
        // The marker also rejects a delayed refresh on the next page load.
        this.clearSession();
        reload();
      }
    })();
    return this.exiting;
  }
}
globalThis.DeliverySession = DeliverySession;
