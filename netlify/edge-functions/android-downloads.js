import { downloadApk, latestPath, readRelease, siteManifest } from '../../scripts/android-downloads.mjs';

const latestAlias = /^\/downloads\/delivery-(admin|captain)\.apk$/;
const versioned = /^\/downloads\/releases\/(\d{1,9}\.\d{1,9}\.\d{1,9})\/([a-f0-9]{64})\/delivery-(admin|captain)\.apk$/;
const latestCache = 'public, max-age=0, s-maxage=60, must-revalidate';

export default async function androidDownloads(request) {
  const { pathname } = new URL(request.url);
  const alias = pathname.match(latestAlias);
  const pinned = pathname.match(versioned);
  const manifestRequested = pathname === latestPath;
  if (!manifestRequested && !alias && !pinned) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const head = request.method === 'HEAD';
  try {
    if (manifestRequested) {
      const payload = JSON.stringify(siteManifest(await readRelease())) + '\n';
      return new Response(head ? null : payload, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': latestCache, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const role = pinned ? pinned[3] : alias[1];
    const app = pinned ? { versionName: pinned[1], sha256: pinned[2] } : (await readRelease()).apps[role];
    const bytes = await downloadApk(role, app);
    return new Response(head ? null : bytes, {
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Disposition': `attachment; filename="delivery-${role}.apk"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': pinned ? 'public, max-age=86400, immutable' : latestCache,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    // Let Netlify serve the verified snapshot from the last successful build.
    return;
  }
}
