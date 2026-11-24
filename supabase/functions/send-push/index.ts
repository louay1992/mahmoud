import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

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
  const c = await cfg();
  if (req.method === "GET") return json({ key: c.vapid_public });
  if (!c.push_secret || req.headers.get("x-push-secret") !== c.push_secret) return json({ error: "forbidden" }, 403);
  const { captain_id, admins, title, body, tag, url, icon } = await req.json();
  webpush.setVapidDetails("mailto:admin@example.com", c.vapid_public, c.vapid_private);
  const q = db.from("push_subscriptions").select("*");
  const { data: subs } = admins ? await q.not("admin_email", "is", null) : await q.eq("captain_id", captain_id);
  let sent = 0, removed = 0;
  await Promise.all((subs || []).map(async (s: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, tag, url: url || "/captain.html", icon: icon || "/icons/captain-192.png" }),
        { TTL: 86400, urgency: "high" },
      );
      sent++;
    } catch (e: any) {
      if (e.statusCode === 404 || e.statusCode === 410) { await db.from("push_subscriptions").delete().eq("id", s.id); removed++; }
    }
  }));
  return json({ sent, removed });
});
