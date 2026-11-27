const exactPushHosts = new Set([
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

// Keep these provider rules in sync with the database registration guard.
const regionalPushHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:push\.apple\.com|notify\.windows\.com)$/i;

export function parseWebPushEndpoint(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 4096 || /[\s\x00-\x1f\x7f\\#]/.test(value)) return null;
  const authority = /^https:\/\/([a-z0-9.-]+)(?::443)?\//i.exec(value);
  if (!authority) return null;
  const host = authority[1].toLowerCase();
  if (host.length > 253 || (!exactPushHosts.has(host) && !regionalPushHost.test(host))) return null;
  try { return new URL(value); } catch { return null; }
}

type PushRequest = { headers: HeadersInit; body: BodyInit | null };

export async function deliverWebPush(
  endpoint: unknown,
  buildRequest: (endpoint: string) => PushRequest,
  http: typeof fetch = fetch,
): Promise<"sent" | "expired" | "unsupported" | "failed"> {
  const target = parseWebPushEndpoint(endpoint);
  if (!target) return "unsupported";
  try {
    const { headers, body } = buildRequest(target.href);
    const response = await http(target.href, {
      method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (response.ok) return "sent";
    return response.status === 404 || response.status === 410 ? "expired" : "failed";
  } catch {
    return "failed";
  }
}
