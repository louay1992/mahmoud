export type FcmAccount = { project_id: string; client_email: string; private_key: string };
export type NativeTarget = { installation_id: string; fcm_token: string; binding_id: string; app_scope: string };
export type PushPayload = { title: string; body: string; tag?: string; url?: string; order_id?: string };
export function parseFcmAccount(raw: string | undefined): FcmAccount | null {
  try {
    const value = JSON.parse(raw || "");
    return value.project_id === "health-beauty-e8abc" && typeof value.client_email === "string" &&
      typeof value.private_key === "string" && value.private_key.includes("BEGIN PRIVATE KEY") ? value : null;
  } catch (_) { return null; }
}
const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const encoded = (value: unknown) => b64(enc.encode(JSON.stringify(value)));
export function notificationUrl(scope: string, payload: PushPayload) {
  const fallback = "/" + scope + ".html";
  let url: URL;
  try { url = new URL(payload.url || fallback, "https://hhyyw.netlify.app"); } catch (_) { url = new URL(fallback, "https://hhyyw.netlify.app"); }
  if (url.origin !== "https://hhyyw.netlify.app" || !["/" + scope, fallback].includes(url.pathname)) url = new URL(fallback, "https://hhyyw.netlify.app");
  // Older database triggers identify order events with these tag prefixes.
  const legacy = /^(?:o|n|e|s|c)([0-9a-f]{8}-[0-9a-f-]{27,})$/i.exec(payload.tag || "")?.[1];
  const order = payload.order_id || legacy;
  if (order && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order)) url.searchParams.set("order", order);
  url.searchParams.set("notification", "1");
  return url.pathname + url.search;
}

export function createFcmSender(account: FcmAccount, http: typeof fetch = fetch) {
  let cached: { token: string; until: number } | null = null;
  let refreshing: Promise<string> | null = null;
  async function authorize(): Promise<string> {
    if (cached && cached.until > Date.now() + 60000) return cached.token;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!account?.project_id || !account.client_email || !account.private_key) throw new Error("FCM_NOT_CONFIGURED");
      const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
      const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const now = Math.floor(Date.now() / 1000);
      const content = encoded({ alg: "RS256", typ: "JWT" }) + "." + encoded({
        iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
      });
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(content));
      const response = await http("https://oauth2.googleapis.com/token", { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: content + "." + b64(new Uint8Array(signature)) }),
        signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok || !result.access_token) throw new Error("FCM_AUTH_FAILED");
      cached = { token: result.access_token, until: Date.now() + Number(result.expires_in || 3600) * 1000 };
      return cached.token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  return async (device: NativeTarget, payload: PushPayload) => {
    const token = await authorize();
    const response = await http("https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(account.project_id) + "/messages:send", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: device.fcm_token,
        // Data-only messages let Android reject a queued message after account changes.
        data: { title: payload.title, body: payload.body, tag: payload.tag || "", binding_id: device.binding_id,
          app_scope: device.app_scope, url: notificationUrl(device.app_scope, payload) },
        android: { priority: "HIGH", ttl: "86400s", restricted_package_name: "app.hhyyw." + device.app_scope }
      } }), signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    const unregistered = (result.error?.details || []).some((d: { errorCode?: string }) => d.errorCode === "UNREGISTERED");
    return { ok: response.ok, message_id: result.name || null, unregistered, status: response.status };
  };
}
