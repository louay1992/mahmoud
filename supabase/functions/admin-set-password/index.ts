import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // يوفّره Supabase داخل الدالة تلقائياً ولا يظهر لأي تطبيق
  const admin = createClient(url, svc, { auth: { persistSession: false } });
  // التحقق من أن المستدعي إداري
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "غير مسموح" }, 401);
  const { data: u } = await admin.auth.getUser(token);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return json({ error: "غير مسموح" }, 401);
  const { data: a } = await admin.from("admins").select("email").ilike("email", email).maybeSingle();
  if (!a) return json({ error: "غير مسموح" }, 403);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "طلب غير صالح" }, 400); }
  const password = String(body.password || "");
  if (password.length < 6) return json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" }, 400);
  const { data: cap } = await admin.from("captains").select("id,name,email").eq("id", body.captain_id).maybeSingle();
  if (!cap) return json({ error: "الكابتن غير موجود" }, 404);
  const cemail = (cap.email || "").trim().toLowerCase();
  if (!cemail) return json({ error: "أضف بريد الدخول للكابتن أولاً (تعديل الكابتن)" }, 400);
  let found: any = null;
  for (let page = 1; page <= 20 && !found; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return json({ error: error.message }, 500);
    found = data.users.find((x: any) => (x.email || "").toLowerCase() === cemail);
    if (data.users.length < 1000) break;
  }
  if (found) {
    const { error } = await admin.auth.admin.updateUserById(found.id, { password, email_confirm: true });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, created: false });
  }
  const { error } = await admin.auth.admin.createUser({ email: cemail, password, email_confirm: true });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, created: true });
});
