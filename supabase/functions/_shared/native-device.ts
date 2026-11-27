import type { NativeTarget, PushPayload } from "./fcm.ts";
import { businessRequestOrigin, normalizeAppOrigin } from "./app-origins.ts";
type Account = { userId: string; captainId: string | null; email: string | null };
type Services = {
  configured?: boolean;
  allowedOrigin?: string;
  authenticate: (jwt: string, scope: string) => Promise<Account | null>;
  action: (params: Record<string, unknown>) => Promise<{ data: any; error: any }>;
  send: (device: NativeTarget, payload: PushPayload) => Promise<{ ok: boolean; message_id: string | null }>;
};
export function nativeDeviceHandler(services: Services) {
  return async (request: Request) => {
    const allowedOrigin = businessRequestOrigin(request.headers.get("origin"), services.allowedOrigin);
    const headers = { "content-type": "application/json", "access-control-allow-origin": allowedOrigin || normalizeAppOrigin(services.allowedOrigin),
      "access-control-allow-headers": "authorization,apikey,content-type", "access-control-allow-methods": "POST, OPTIONS",
      "cache-control": "no-store", "vary": "Origin" };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (!allowedOrigin) return json({ error: "forbidden origin" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "POST") return json({ error: "method" }, 405);
    try {
      const text = await request.text();
      if (text.length > 16000) return json({ error: "request too large" }, 413);
      const body = JSON.parse(text);
      if (!body || typeof body !== "object" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.installation_id || "") ||
        !/^[0-9a-f]{64}$/.test(body.secret || "") || !["admin", "captain"].includes(body.app_scope) ||
        !["bind", "sync", "unbind", "test"].includes(body.action)) return json({ error: "invalid device" }, 400);
      if (["bind", "sync"].includes(body.action) && (typeof body.fcm_token !== "string" || body.fcm_token.length < 20 || body.fcm_token.length > 4096)) return json({ error: "invalid token" }, 400);
      if (["bind", "test"].includes(body.action) && services.configured === false) return json({ error: "إعداد حساب خدمة Firebase بالخادم غير مكتمل" }, 503);
      let account: Account | null = null;
      if (["bind", "test"].includes(body.action)) {
        const jwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        account = jwt ? await services.authenticate(jwt, body.app_scope) : null;
        if (!account) return json({ error: "غير مسموح لهذا الحساب" }, 403);
      }
      const secretHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.secret)))].map(n => n.toString(16).padStart(2, "0")).join("");
      const { data, error } = await services.action({ p_id: body.installation_id, p_scope: body.app_scope,
        p_secret_hash: secretHash, p_action: body.action, p_token: body.fcm_token || null,
        p_user: account?.userId || null, p_captain: account?.captainId || null, p_email: account?.email || null });
      if (error) return json({ error: "تعذّر ربط الجهاز أو بيانات الجهاز غير صالحة" }, 409);
      if (body.action === "test") {
        const result = await services.send({ ...data, installation_id: body.installation_id }, {
          title: "اختبار إشعارات التطبيق", body: "وصل إشعار Firebase FCM من الخادم إلى هذا الجهاز", tag: "fcm-test"
        });
        if (!result.ok) return json({ error: "رفض Firebase إرسال الإشعار التجريبي" }, 502);
        return json({ ok: true, message_id: result.message_id });
      }
      // Never expose device tokens, secret hashes, or other accounts to the page.
      return json({ ok: true, saved: data.saved, binding_id: data.binding_id, account_id: data.account_id });
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "invalid JSON" }, 400);
      return json({ error: "تعذّر الاتصال بخدمة الإشعارات" }, 503);
    }
  };
}
