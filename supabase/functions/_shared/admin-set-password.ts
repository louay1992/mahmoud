// قواعد مشتركة لدالة admin-set-password، خالية من واجهات Deno وحدها
// حتى يستطيع مشغّل اختبارات Node استيرادها وفحصها مباشرة.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;
export const DEFAULT_APP_ORIGIN = "https://hhyyw.netlify.app";

/** APP_ORIGIN سرّ كامل العنوان، والمتصفح يرسل الأصل وحده؛ التطبيع يمنع الفشل بسبب مسار أو شرطة أخيرة. */
export function normalizeOrigin(value?: string | null): string {
  try { return new URL(value || DEFAULT_APP_ORIGIN).origin; } catch (_) { return DEFAULT_APP_ORIGIN; }
}

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

/** الطلب من متصفح يحمل Origin: يُقبل من أصل التطبيق فقط. الطلب بلا Origin (curl أو خادم) يبقى تحت تحقق الجلسة. */
export function originRejected(origin: string | null | undefined, allowedOrigin: string): boolean {
  return !!origin && origin !== allowedOrigin;
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
