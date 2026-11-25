const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const files = ['index.html', 'admin.html', 'captain.html', 'app-config.js', 'admin.css', 'admin-app.js', 'captain.css', 'captain-app.js', 'auth-session.js', 'push-client.js', 'push-diagnostics.js', 'native-push.js', 'app-updates.js', 'app-updates.css', 'mobile-ui.js',
  'mobile.css', 'admin-mobile.js', 'admin-mobile.css', 'admin-motion.js', 'admin-workspace.js', 'admin-workspace.css', 'app-refresh.js', 'app-refresh.css', 'offline-data.js', 'offline-data.css', 'vendor/supabase.js', 'vendor/SUPABASE-LICENSE.txt', 'vendor/supabase-version.json', 'sw.js', 'manifest-admin.json', 'manifest-captain.json', '.well-known/assetlinks.json'];
for (const name of fs.readdirSync(path.join(root, 'icons'))) if (name.endsWith('.png')) files.push('icons/' + name);
// Netlify can restore files added to a previous publish directory. Rebuild our generated output.
if (path.relative(root, output) !== 'dist' || (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())) throw new Error('Unsafe web output path');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of files) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if(/\.(html|js|css|json|txt)$/.test(file))fs.writeFileSync(destination,fs.readFileSync(path.join(root,file),'utf8').replaceAll('\r\n','\n'));
  else fs.copyFileSync(path.join(root, file), destination);
}
// Deterministic per-app build IDs cover HTML, scripts and styles, including CSS-only updates.
const versions={schema:1};
for(const role of ['admin','captain']){
  const inputs=[role+'.html','app-config.js',role+'.css',role+'-app.js','auth-session.js','native-push.js','app-updates.js','app-updates.css','push-client.js','mobile-ui.js','mobile.css','app-refresh.js','app-refresh.css','offline-data.js','offline-data.css','vendor/supabase.js','sw.js','manifest-'+role+'.json',...(role==='admin'?['admin-mobile.js','admin-mobile.css','admin-motion.js','admin-workspace.js','admin-workspace.css']:['push-diagnostics.js'])];
  const hash=createHash('sha256');
  for(const name of inputs)hash.update(name+'\n'+fs.readFileSync(path.join(output,name),'utf8').replaceAll('\r\n','\n'));
  versions[role]=hash.digest('hex');
  const file=path.join(output,role+'.html');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('content="__APP_BUILD__"','content="'+versions[role]+'"'));
}
fs.writeFileSync(path.join(output,'app-version.json'),JSON.stringify(versions)+'\n');files.push('app-version.json');
// A complete public shell is verified before replacing the last offline package.
const shell={schema:1};
for(const role of ['admin','captain']){
  const names=files.filter(name=>!['index.html','app-version.json','.well-known/assetlinks.json'].includes(name)&&!(role==='admin'?/^(captain\.html|manifest-captain|icons\/captain|captain[-.]|push-diagnostics)/:/^(admin\.html|manifest-admin|icons\/admin|admin[-.])/).test(name));
  shell[role]={version:versions[role],files:names.map(name=>({url:'/'+name,sha256:createHash('sha256').update(fs.readFileSync(path.join(output,name))).digest('hex')}))};
}
fs.writeFileSync(path.join(output,'offline-shell-manifest.json'),JSON.stringify(shell)+'\n');files.push('offline-shell-manifest.json');
function verify(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) verify(absolute);
    else if (!files.includes(path.relative(output, absolute).split(path.sep).join('/'))) throw new Error('Unexpected file in web output: ' + entry.name);
  }
}
verify(output);
console.log('Prepared ' + files.length + ' public assets in dist/');
