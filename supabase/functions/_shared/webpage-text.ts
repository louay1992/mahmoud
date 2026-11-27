// ApyHub "Extract visible text from a webpage": server-only proxy.
// The token lives in the Edge Function environment and never reaches a page.
import { businessRequestOrigin, normalizeAppOrigin } from "./app-origins.ts";

export const APYHUB_TEXT_ENDPOINT = "https://api.eu.apyhub.com/apyhub/extract-visible-text-from-a-webpage";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type VisibleText = { url: string; text: string; characters: number; truncated: boolean };
type Failure = { ok: false; status: number; error: string };
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
function privateV4(host: string) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some(part => part > 255)) return true;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(host: string) {
  const value = host.toLowerCase();
  if (!value.includes(":")) return false;
  if (value === "::" || value === "::1") return true;
  if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value)) return true; // unique-local and link-local
  if (/^::ffff:/.test(value)) return true; // IPv4-mapped (dotted or hex, e.g. [::ffff:7f00:1])
  return /^(64:ff9b|100:|2001:db8|2002:)/.test(value); // NAT64, discard-only, documentation, 6to4
}
/** Only absolute public http(s) URLs are allowed; internal and literal-IP targets are refused. */
export function parsePublicHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let target: URL;
  try { target = new URL(value); } catch { return null; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (target.username || target.password) return null;
  // Browsers keep a trailing dot in the host; strip it before every check.
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host || host === "localhost" || INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))) return null;
  if (privateV4(host) || privateV6(host)) return null;
  if (!host.includes(".") && !host.includes(":")) return null; // single-label intranet names
  return target;
}
/**
 * Calls the documented ApyHub endpoint and returns the page's visible text, navigation included.
 * The text is untrusted: control characters are stripped here, and callers must render it as text only.
 */
export async function extractVisibleText(target: URL, options: {
  token?: string; fetch?: FetchLike; endpoint?: string; maxCharacters?: number;
}): Promise<{ ok: true; value: VisibleText } | Failure> {
  const token = (options.token || "").trim();
  if (!token) return { ok: false, status: 503, error: "خدمة استخراج النص غير مهيّأة على الخادم (APY_TOKEN مفقود)" };
  const request = new URL(options.endpoint || APYHUB_TEXT_ENDPOINT);
  request.searchParams.set("url", target.href);
  let response: Response;
  try {
    response = await (options.fetch || fetch)(request.href, {
      method: "GET", headers: { "apy-token": token, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10000)
    });
  } catch { return { ok: false, status: 503, error: "تعذّر الوصول إلى خدمة ApyHub" }; }
  if (!response.ok) {
    if (response.status === 429) return { ok: false, status: 429, error: "تجاوزت خدمة ApyHub حدّ الطلبات، أعد المحاولة لاحقًا" };
    if (response.status === 401 || response.status === 403) return { ok: false, status: 503, error: "رمز ApyHub غير صالح أو لا يملك صلاحية هذه الخدمة" };
    if (response.status === 400) return { ok: false, status: 400, error: "رابط الصفحة غير صالح أو غير قابل للقراءة" };
    return { ok: false, status: 502, error: "لم تُرجع خدمة ApyHub نصًا لهذه الصفحة" };
  }
  let payload: any;
  try { payload = await response.json(); } catch { return { ok: false, status: 502, error: "استجابة ApyHub غير مفهومة" }; }
  if (typeof payload?.data !== "string") return { ok: false, status: 502, error: "استجابة ApyHub غير مفهومة" };
  const text = payload.data.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+$/gm, "").trim();
  if (!text) return { ok: false, status: 422, error: "لا يوجد نص ظاهر في هذه الصفحة" };
  const maxCharacters = options.maxCharacters ?? 20000;
  return { ok: true, value: {
    url: target.href, text: text.slice(0, maxCharacters),
    characters: Math.min(text.length, maxCharacters), truncated: text.length > maxCharacters
  } };
}
export function webpageTextHandler(services: {
  allowedOrigin?: string;
  token?: string;
  authenticate: (jwt: string) => Promise<boolean>;
  fetch?: FetchLike;
  endpoint?: string;
  maxCharacters?: number;
}) {
  return async (request: Request) => {
    const allowedOrigin = businessRequestOrigin(request.headers.get("origin"), services.allowedOrigin);
    const headers = {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "access-control-allow-origin": allowedOrigin || normalizeAppOrigin(services.allowedOrigin),
      "access-control-allow-headers": "authorization,apikey,content-type",
      "access-control-allow-methods": "GET, OPTIONS", "vary": "Origin"
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (!allowedOrigin) return json({ error: "forbidden origin" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { headers });
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const jwt = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "غير مسموح" }, 401);
    const allowed = await Promise.resolve().then(() => services.authenticate(jwt)).catch(() => false);
    if (!allowed) return json({ error: "غير مسموح: هذا الإجراء للإداري الكامل فقط" }, 403);
    const target = parsePublicHttpUrl(new URL(request.url).searchParams.get("url"));
    if (!target) return json({ error: "أدخل رابطًا عامًا يبدأ بـ http أو https؛ العناوين الداخلية مرفوضة" }, 400);
    const result = await extractVisibleText(target, services);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json(result.value);
  };
}
