import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import '../app-updates.js';

const { feed, release } = globalThis.DeliveryAppUpdates;
const roles = ['admin', 'captain'];
const releaseResponse = await fetch(feed, { signal: AbortSignal.timeout(30_000) });
if (!releaseResponse.ok) throw new Error(`Android release manifest returned HTTP ${releaseResponse.status}`);
const manifest = await releaseResponse.json();
const [admin, captain] = roles.map(role => release(manifest, role));
if (!admin || !captain || admin.versionName !== captain.versionName || admin.versionCode !== captain.versionCode) {
  throw new Error('Expected a matched Android release for both apps');
}

const files = await Promise.all([admin, captain].map(async (app, index) => {
  const role = roles[index];
  const response = await fetch(app.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Android ${role} release returned HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== app.size || createHash('sha256').update(bytes).digest('hex') !== app.sha256) {
    throw new Error(`Android ${role} release did not match its published size and SHA-256`);
  }
  return { name: `delivery-${role}.apk`, bytes };
}));

const directory = new URL('../dist/downloads/', import.meta.url);
await mkdir(directory, { recursive: true });
await Promise.all(files.map(({ name, bytes }) => writeFile(new URL(name, directory), bytes)));
console.log(`Staged both verified Android APKs for ${admin.versionName}`);
