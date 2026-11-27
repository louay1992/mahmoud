import { corsHeaders } from "./admin-set-password.ts";

/** Hosted Auth owns email delivery and passwords. This endpoint never returns a verification link or a token. */
export function createOwnerInviteHandler({ allowedOrigin, service, publicAuth, userClient }: { allowedOrigin: string; service: any; publicAuth: any; userClient: (jwt: string) => any }) {
  const productionOrigins = ["https://hhyyw.netlify.app", "https://applications.nature-care.net", "https://owner.nature-care.net"];
  const origins = new Set(productionOrigins.includes(allowedOrigin) ? productionOrigins : [allowedOrigin]);
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const headers = { ...corsHeaders(origin && origins.has(origin) ? origin : allowedOrigin), "Content-Type": "application/json" };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return json({ error: "forbidden origin" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { headers });
    if (req.method !== "POST") return json({ error: "method" }, 405);
    try {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!token) return json({ error: "سجّل دخولك إلى لوحة المالك" }, 401);
      const { data: identity, error: authError } = await service.auth.getUser(token);
      if (authError || !identity?.user?.id) return json({ error: "تعذّر التحقق من الجلسة" }, 401);
      const { data: owner, error: ownerError } = await service.from("subscription_owners").select("active").eq("user_id", identity.user.id).eq("active", true).maybeSingle();
      if (ownerError) return json({ error: "تعذّر التحقق من صلاحية المالك" }, 503);
      if (!owner) return json({ error: "إضافة المشتركين لمالك النظام فقط" }, 403);
      const { data: strong, error: strongError } = await userClient(token).rpc("owner_has_strong_session");
      if (strongError) return json({ error: "تعذّر التحقق من أمان جلسة المالك" }, 503);
      if (strong !== true) return json({ error: "أكمل التحقق بخطوتين من حساب المالك", code: "OWNER_MFA_REQUIRED" }, 403);
      const raw = await req.text();
      if (raw.length > 4096) return json({ error: "الطلب طويل جدًا" }, 400);
      let body: any;
      try { body = JSON.parse(raw); } catch { return json({ error: "طلب غير صالح" }, 400); }
      const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length > 100) return json({ error: "أدخل بريدًا صحيحًا واسمًا لا يتجاوز 100 حرف" }, 400);
      const { data: reservation, error: reservationError } = await service.rpc("reserve_subscription_admin_invite", { p_owner: identity.user.id, p_email: email, p_name: name || null });
      if (reservationError) {
        if (/انتظر دقيقة/.test(reservationError.message || "")) return json({ error: "انتظر دقيقة قبل إعادة إرسال الدعوة" }, 429);
        if (/حساب المالك|حساب كابتن|بريدًا إلكترونيًا|الاسم طويل/.test(reservationError.message || "")) return json({ error: reservationError.message }, 400);
        return json({ error: "تعذّر تجهيز الدعوة. حدّث الصفحة وحاول مجددًا" }, 503);
      }
      const options = { redirectTo: allowedOrigin + "/account-setup.html" };
      let sent: any;
      try {
        sent = reservation.existing_user
          ? await publicAuth.resetPasswordForEmail(email, options)
          : await service.auth.admin.inviteUserByEmail(email, options);
        // Another request could have registered this email between the reservation and Auth call.
        if (sent.error && ["email_exists", "user_already_exists"].includes(sent.error.code)) sent = await publicAuth.resetPasswordForEmail(email, options);
      } catch { sent = { error: true }; }
      const { data: recorded, error: recordError } = await service.rpc("finish_subscription_admin_invite", {
        p_email: email, p_token: reservation.send_token, p_success: !sent.error,
        p_auth_user_id: sent.data?.user?.id || reservation.auth_user_id || null,
      });
      if (sent.error) return json({ error: "تعذّر إرسال رسالة التفعيل. تحقق من إعدادات بريد الإرسال ثم أعد المحاولة" }, 502);
      if (recordError || recorded !== true) return json({ error: "أُرسل طلب البريد لكن تعذّر تأكيد تسجيل الدعوة. حدّث البيانات قبل المحاولة مجددًا" }, 503);
      return json({ ok: true, email });
    } catch {
      return json({ error: "تعذّر إكمال طلب الدعوة. حدّث البيانات وحاول مجددًا" }, 503);
    }
  };
}
