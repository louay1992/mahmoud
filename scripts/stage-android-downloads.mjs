import { mkdir, writeFile } from 'node:fs/promises';
import { apkPath, downloadApk, latestPath, readRelease, roles, siteManifest } from './android-downloads.mjs';

const manifest = await readRelease();
const output = new URL('../dist/', import.meta.url);
await Promise.all(roles.map(async role => {
  const app = manifest.apps[role];
  const bytes = await downloadApk(role, app);
  const pinned = new URL(`.${apkPath(role, app)}`, output);
  await mkdir(new URL('./', pinned), { recursive: true });
  await Promise.all([
    writeFile(pinned, bytes),
    writeFile(new URL(`downloads/delivery-${role}.apk`, output), bytes),
  ]);
}));
await writeFile(new URL(`.${latestPath}`, output), JSON.stringify(siteManifest(manifest)) + '\n');
console.log(`Staged both verified Android APKs for ${manifest.apps.admin.versionName}`);
