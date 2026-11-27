import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.89.0";
import { createFcmSender, parseFcmAccount } from "../_shared/fcm.ts";
import { deliverWebPush } from "../_shared/web-push-delivery.ts";

// تتحقق الدالة من كلمة سرّ مشتركة محفوظة في جدول push_config (لا يصل إليه أي تطبيق).
// مفاتيح VAPID تُولَّد مرة واحدة هنا وتُحفظ في نفس الجدول.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-push-secret, apikey, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const fcmConfig = parseFcmAccount(Deno.env.get("FCM_SERVICE_ACCOUNT_JSON"));
const appOrigin = Deno.env.get("APP_ORIGIN");
const sendFcm = fcmConfig ? createFcmSender(fcmConfig, fetch, appOrigin) : null;

async function readCfg() {
  const { data } = await db.from("push_config").select("key,value");
  return Object.fromEntries((data || []).map((r: any) => [r.key, r.value])) as Record<string, string>;
}
async function cfg() {
  let m = await readCfg();
  if (!m.vapid_public || !m.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    await db.from("push_config").upsert(
      [{ key: "vapid_public", value: k.publicKey }, { key: "vapid_private", value: k.privateKey }],
      { onConflict: "key", ignoreDuplicates: true },
    );
    m = await readCfg();
  }
  return m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method" }, 405);
  const c = await cfg();
  if (req.method === "GET") return json({ key: c.vapid_public });
  if (!c.push_secret || req.headers.get("x-push-secret") !== c.push_secret) return json({ error: "forbidden" }, 403);
  let payload;
  try { payload = await req.json(); } catch (_) { return json({ error: "invalid JSON" }, 400); }
  if (!payload || typeof payload !== "object") return json({ error: "invalid message" }, 400);
  const { captain_id, admins, title, body, tag, url, icon, order_id } = payload;
  if (typeof title !== "string" || typeof body !== "string") return json({ error: "invalid message" }, 400);
  const vapidDetails = { subject: "mailto:admin@example.com", publicKey: c.vapid_public, privateKey: c.vapid_private };
  const { data: subs, error: webTargetError } = await db.rpc("web_push_targets", { p_admins: !!admins, p_captain: captain_id || null });
  if (webTargetError) console.warn("web push targeting unavailable");
  let sent = 0, removed = 0, web_unsupported = 0, web_failed = 0;
  await Promise.all((subs || []).map(async (s: any) => {
    const result = await deliverWebPush(s.endpoint, endpoint => webpush.generateRequestDetails(
      { endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify({ title, body, tag, url: url || "/captain.html", icon: icon || "/icons/captain-192.png" }),
      { TTL: 86400, urgency: "high", vapidDetails },
    ));
    if (result === "sent") sent++;
    else if (result === "unsupported") web_unsupported++;
    else if (result === "expired") {
      // A fresh browser registration may update keys while the request is in flight.
      const { data, error } = await db.from("push_subscriptions").delete().eq("id", s.id)
        .eq("endpoint", s.endpoint).eq("p256dh", s.p256dh).eq("auth", s.auth).select("id");
      if (error) web_failed++;
      else removed += data?.length || 0;
    } else {
      web_failed++;
    }
  }));
  let fcm_sent = 0, fcm_removed = 0, fcm_failed = 0;
  const { data: devices, error: deviceError } = await db.rpc("native_push_targets", { p_admins: !!admins, p_captain: captain_id || null });
  const native_error = deviceError ? "NATIVE_MIGRATION_REQUIRED" : devices?.length && !sendFcm ? "FCM_NOT_CONFIGURED" : null;
  if (sendFcm) await Promise.all((devices || []).map(async (device: any) => {
    try {
      const result = await sendFcm(device, { title, body, tag, url, order_id });
      if (result.ok) fcm_sent++;
      else if (result.unregistered) {
        // Do not delete a device if its token or account changed while sending.
        await db.from("native_push_devices").delete().eq("installation_id", device.installation_id)
          .eq("fcm_token", device.fcm_token).eq("binding_id", device.binding_id);
        fcm_removed++;
      } else fcm_failed++;
    } catch (_) { fcm_failed++; }
  }));
  if (native_error || fcm_failed) console.warn("native push delivery", { native_error, fcm_failed });
  return json({ sent, removed, web_unsupported, web_failed, fcm_sent, fcm_removed, fcm_failed, native_error,
    web_error: webTargetError ? "WEB_TARGETING_UNAVAILABLE" : null });
});
