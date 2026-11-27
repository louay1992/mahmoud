export const LEGACY_APP_ORIGIN = "https://hhyyw.netlify.app";
export const APPLICATIONS_APP_ORIGIN = "https://applications.nature-care.net";

const businessOrigins = new Set([LEGACY_APP_ORIGIN, APPLICATIONS_APP_ORIGIN]);

export function normalizeAppOrigin(value?: string | null): string {
  try {
    const url = new URL(value || LEGACY_APP_ORIGIN);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // Use the deployment default when APP_ORIGIN is absent or malformed.
  }
  return LEGACY_APP_ORIGIN;
}

/** Production supports both app hosts. An explicitly configured preview stays isolated. */
export function businessRequestOrigin(requestOrigin?: string | null, configuredOrigin?: string | null): string | null {
  const configured = normalizeAppOrigin(configuredOrigin);
  if (!requestOrigin || requestOrigin === configured) return configured;
  return businessOrigins.has(configured) && businessOrigins.has(requestOrigin) ? requestOrigin : null;
}
