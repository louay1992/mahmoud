import '../app-updates.js';

export const origin = 'https://applications.nature-care.net';
export const roles = ['admin', 'captain'];
export const latestPath = '/downloads/latest.json';
const repository = 'https://github.com/louay1992/mahmoud/releases/download/';
const { feed, release } = globalThis.DeliveryAppUpdates;

export function apkPath(role, app) {
  return `/downloads/releases/${app.versionName}/${app.sha256}/delivery-${role}.apk`;
}

export function siteManifest(manifest) {
  return {
    ...manifest,
    apps: Object.fromEntries(roles.map(role => [role, {
      ...manifest.apps[role], url: origin + apkPath(role, manifest.apps[role]),
    }])),
  };
}

function releaseAsset(role, version) {
  const name = role === 'admin' ? 'Admin' : 'Captain';
  return `${repository}android-v${version}/Delivery-${name}-${version}.apk`;
}

export async function readRelease() {
  const response = await fetch(feed, { redirect: 'error', signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Android release manifest returned HTTP ${response.status}`);
  const raw = await response.text();
  if (raw.length > 65_536) throw new Error('Android release manifest is too large');
  const manifest = JSON.parse(raw);
  const apps = Object.fromEntries(roles.map(role => [role, release(manifest, role)]));
  if (!apps.admin || !apps.captain || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(apps.admin.versionName)
      || apps.admin.versionName !== apps.captain.versionName
      || apps.admin.versionCode !== apps.captain.versionCode
      || roles.some(role => apps[role].url !== releaseAsset(role, apps[role].versionName))) {
    throw new Error('Expected a matched Android release for both apps');
  }
  return { ...manifest, apps };
}

async function readApk(response, size) {
  if (!response.body) throw new Error('Missing APK body');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      if (offset + part.value.byteLength > size) throw new Error('APK exceeded its declared size');
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
    if (offset !== size) throw new Error('Incomplete APK body');
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function downloadApk(role, app) {
  const signal = AbortSignal.timeout(32_000);
  const asset = releaseAsset(role, app.versionName);
  let response = await fetch(asset, { redirect: 'manual', signal });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Missing APK redirect');
    const target = new URL(location, asset);
    if (target.protocol !== 'https:' || target.username || target.password || target.port
        || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
      throw new Error('Unexpected APK redirect destination');
    }
    response = await fetch(target, { redirect: 'error', signal });
  }
  const size = Number(response.headers.get('content-length'));
  if (!response.ok || !Number.isSafeInteger(size) || size < 1 || size > 100 * 1024 * 1024
      || (app.size !== undefined && size !== app.size)) {
    await response.body?.cancel();
    throw new Error(`Android ${role} release returned an invalid response or size`);
  }
  const bytes = await readApk(response, size);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== app.sha256) throw new Error(`Android ${role} release did not match SHA-256`);
  return bytes;
}
