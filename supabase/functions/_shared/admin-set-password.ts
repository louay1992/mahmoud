// قواعد مشتركة لدالة admin-set-password، خالية من واجهات Deno وحدها
// حتى يستطيع مشغّل اختبارات Node استيرادها وفحصها مباشرة.
import { businessRequestOrigin, LEGACY_APP_ORIGIN, normalizeAppOrigin } from "./app-origins.ts";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const DEFAULT_APP_ORIGIN = LEGACY_APP_ORIGIN;

/** APP_ORIGIN سرّ كامل العنوان، والمتصفح يرسل الأصل وحده؛ التطبيع يمنع الفشل بسبب مسار أو شرطة أخيرة. */
export const normalizeOrigin = normalizeAppOrigin;

export function corsHeaders(allowedOrigin: string) {
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "vary": "Origin",
  };
}

/** Preserve literal LIKE metacharacters while matching a legacy email case-insensitively. */
export function exactEmailPattern(email: string): string {
  return email.replace(/[\\%_]/g, "\\$&");
}

/** رسالة الخطأ العربية أو null إذا كانت كلمة المرور مقبولة. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `كلمة المرور يجب أن تكون ${MAX_PASSWORD_LENGTH} حرفًا على الأكثر`;
  }
  return null;
}

/** A company administrator must never reset the separate subscription owner's credentials. */
export async function protectedSubscriptionOwner(client: any, userId: string) {
  const { data, error } = await client.from("subscription_owners").select("user_id").eq("user_id", userId).maybeSingle();
  return { protected: !!data, error };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const address = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PasswordServices = {
  allowedOrigin?: string;
  admin: any;
  userClient: (token: string) => any;
};

export function adminPasswordHandler({ allowedOrigin: origin, admin, userClient }: PasswordServices) {
  const configuredOrigin = normalizeOrigin(origin);
  return async (req: Request) => {
    const allowedOrigin = businessRequestOrigin(req.headers.get("origin"), configuredOrigin);
    const cors = corsHeaders(allowedOrigin || configuredOrigin);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
    if (!allowedOrigin) return json({ error: "forbidden origin" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "غير مسموح" }, 401);
    const { data: acc, error: ae } = await userClient(token).rpc("my_access");
    if (ae) return json({ error: "تعذّر التحقق من الجلسة. سجّل الخروج ثم الدخول من جديد" }, 401);
    if (!acc || acc.role !== "full") return json({ error: "غير مسموح: هذا الإجراء للإداري الكامل فقط" }, 403);
    let body: any;
    try {
      const raw = await req.text();
      if (raw.length > 4096) return json({ error: "الطلب طويل جدًا" }, 413);
      body = JSON.parse(raw);
    } catch { return json({ error: "طلب غير صالح" }, 400); }
    if (!body || typeof body !== "object" || typeof body.password !== "string") return json({ error: "طلب غير صالح" }, 400);
    const password = body.password;
    const problem = passwordProblem(password);
    if (problem) return json({ error: problem }, 400);
    const captainId = body.captain_id ?? null;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (captainId !== null && (typeof captainId !== "string" || !uuid.test(captainId))) return json({ error: "معرّف الكابتن غير صالح" }, 400);
    if (captainId === null && (email.length > 254 || !address.test(email))) return json({ error: "البريد غير صالح" }, 400);
    let target = captainId
      ? await admin.from("captains").select("email,auth_user_id").eq("id", captainId).maybeSingle()
      : await admin.from("admins").select("email,auth_user_id").eq("email", email).maybeSingle();
    if (!captainId && !target.data && !target.error && !email.includes("*")) {
      target = await admin.from("admins").select("email,auth_user_id").ilike("email", exactEmailPattern(email)).maybeSingle();
    }
    if (target.error) return json({ error: "تعذّر التحقق من الحساب. حاول لاحقًا" }, 503);
    if (!target.data) return json({ error: captainId ? "الكابتن غير موجود" : "الحساب الإداري غير موجود" }, 404);
    const cemail = (target.data.email || "").trim().toLowerCase();
    if (!cemail) return json({ error: "أضف بريد الدخول للكابتن أولاً (تعديل الكابتن)" }, 400);
    if (!captainId && cemail !== email) return json({ error: "الحساب الإداري غير موجود" }, 404);
    let found: any = null;
    if (target.data.auth_user_id) {
      const { data, error } = await admin.auth.admin.getUserById(target.data.auth_user_id);
      if (error || data?.user?.email?.toLowerCase() !== cemail) return json({ error: "بريد الدخول مرتبط بهوية أخرى أو تعذّر التحقق منه" }, 409);
      found = data.user;
    } else {
      for (let page = 1; page <= 20 && !found; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) return json({ error: "تعذّر التحقق من حساب الدخول. حاول لاحقًا" }, 503);
        found = data.users.find((x: any) => x.email?.toLowerCase() === cemail);
        if (data.users.length < 1000) break;
      }
    }
    let userId: string;
    if (found) {
      const protection = await protectedSubscriptionOwner(admin, found.id);
      if (protection.error) return json({ error: "تعذّر التحقق من حماية الحساب. حاول لاحقًا" }, 503);
      if (protection.protected) return json({ error: "لا يمكن تعديل حساب مالك النظام من لوحة الشركة" }, 403);
      const [adminRole, captainRole] = await Promise.all([
        admin.from("admins").select("email").eq("auth_user_id", found.id).maybeSingle(),
        admin.from("captains").select("id").eq("auth_user_id", found.id).maybeSingle(),
      ]);
      if (adminRole.error || captainRole.error) return json({ error: "تعذّر التحقق من ارتباط الحساب. حاول لاحقًا" }, 503);
      if ((adminRole.data && (captainId || adminRole.data.email !== target.data.email))
          || (captainRole.data && captainRole.data.id !== captainId)) {
        return json({ error: "هوية تسجيل الدخول مستخدمة في حساب آخر" }, 409);
      }
      const { error } = await admin.auth.admin.updateUserById(found.id, { password, email_confirm: true });
      if (error) return json({ error: "تعذّر حفظ كلمة المرور. حاول مجددًا" }, 503);
      userId = found.id;
    } else {
      const { data, error } = await admin.auth.admin.createUser({ email: cemail, password, email_confirm: true });
      if (error || !data.user?.id) return json({ error: "تعذّر إنشاء حساب الدخول. حدّث قائمة الحسابات وأعد المحاولة" }, 503);
      userId = data.user.id;
    }
    const { error: bindError } = await admin.rpc("bind_business_identity", { p_auth_user: userId, p_captain: captainId, p_email: captainId ? null : cemail });
    if (bindError) return json({ error: "حُفظت كلمة المرور وتعذّر تفعيل الربط. أعد تعيين كلمة المرور لهذا الحساب من القائمة", code: "IDENTITY_BIND_PENDING" }, 503);
    return json({ ok: true, created: !found });
  };
}
