/* Zero-dependency repository check: syntax, page wiring, single-source config, RPC coverage. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const exists = file => fs.existsSync(path.join(root, file));
const failures = [];
const fail = message => failures.push(message);

// 1. Every JavaScript source parses.
const sources = [];
for (const name of fs.readdirSync(root)) if (/\.(js|mjs|cjs)$/.test(name)) sources.push(name);
for (const dir of ['scripts', 'tests']) {
  for (const name of fs.readdirSync(path.join(root, dir))) {
    if (/\.(js|mjs|cjs)$/.test(name)) sources.push(dir + '/' + name);
  }
}
for (const file of sources) {
  try { execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }); }
  catch (error) { fail('syntax: ' + file + '\n' + String(error.stderr || error.message).trim()); }
}

// 2. Local links point to source files, Netlify rewrites, or published APKs.
const pages = ['index.html', 'admin.html', 'captain.html','owner.html','account-setup.html'];
const rewrites = new Map([...read('netlify.toml').matchAll(/from = "\/(\w+)"\s+to = "\/([\w.-]+)"\s+status = 200/g)]
  .map(([, route, file]) => [route, file]));
const publishedApks = new Set(['downloads/delivery-admin.apk', 'downloads/delivery-captain.apk']);
for (const page of pages) {
  const source = read(page);
  for (const match of source.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
    const asset = match[1].replace(/^\//, '').split(/[?#]/)[0];
    if (asset && !publishedApks.has(asset) && !exists(rewrites.get(asset) ?? asset)) {
      fail('missing asset: ' + page + ' -> /' + asset);
    }
  }
}

// 3. Deployment endpoints only live in app-config.js.
const projectRef = 'jabapvnmfdflysxfxwwf';
for (const file of ['admin.html', 'captain.html', 'admin-app.js', 'captain-app.js']) {
  if (read(file).includes(projectRef)) fail('hardcoded Supabase project in ' + file + '; use app-config.js');
}

// 4. Every RPC called by the clients is defined in schema.sql or a migration.
// Functions that only exist in the deployed project are listed explicitly in
// supabase/untracked-rpcs.txt; new drift and stale baseline entries both fail.
const sql = read('schema.sql') + '\n' + fs.readdirSync(path.join(root, 'supabase/migrations'))
  .map(name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8')).join('\n');
const defined = new Set([...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)/gi)]
  .map(match => match[1].toLowerCase()));
const called = new Set();
for (const file of ['subscription-access.js','account-setup.js','owner-operations.js','owner-invitations.js','admin-subscription.js','owner-app.js','admin-app.js', 'captain-app.js', 'admin-workspace.js', 'admin-mobile.js', 'push-client.js', 'offline-data.js']) {
  for (const match of read(file).matchAll(/\.rpc\(\s*["']([a-zA-Z0-9_]+)["']/g)) called.add(match[1].toLowerCase());
}
const baselinePath = 'supabase/untracked-rpcs.txt';
const baseline = new Set(read(baselinePath).split('\n').map(line => line.trim())
  .filter(line => line && !line.startsWith('#')));
const missing = [...called].filter(name => !defined.has(name)).sort();
for (const name of missing) if (!baseline.has(name)) fail('RPC without definition: ' + name);
for (const name of [...baseline].sort()) {
  if (defined.has(name)) fail('stale baseline entry (now defined in SQL): ' + name + '; remove it from ' + baselinePath);
  else if (!called.has(name)) fail('stale baseline entry (no client call): ' + name + '; remove it from ' + baselinePath);
}
const untracked = missing.filter(name => baseline.has(name));

// 5. Report superseded SQL definitions without failing: the script is applied top to bottom.
const counts = new Map();
for (const match of sql.matchAll(/create\s+or\s+replace\s+function\s+(?:public\.)?([a-z0-9_]+)/gi)) {
  const name = match[1].toLowerCase();
  counts.set(name, (counts.get(name) || 0) + 1);
}
const superseded = [...counts].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);

if (failures.length) {
  console.error(failures.map(message => '✗ ' + message).join('\n'));
  console.error('\n' + failures.length + ' check(s) failed.');
  process.exit(1);
}
console.log('✓ ' + sources.length + ' JavaScript sources parse');
console.log('✓ ' + pages.length + ' pages reference local assets or deployment routes');
console.log('✓ deployment endpoints are read only from app-config.js');
console.log('✓ all ' + called.size + ' client RPCs are defined in SQL or documented as untracked');
if (untracked.length) console.log('⚠ ' + untracked.length + ' RPC(s) exist only in the deployed database (see ' + baselinePath + '): ' + untracked.join(', '));
console.log('ℹ ' + superseded.length + ' SQL functions are intentionally redefined later (last definition wins): ' +
  superseded.map(([name, count]) => name + '×' + count).join(', '));
