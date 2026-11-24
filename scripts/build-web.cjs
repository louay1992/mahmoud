const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const files = ['index.html', 'admin.html', 'captain.html', 'auth-session.js', 'push-client.js', 'push-diagnostics.js', 'native-push.js', 'mobile-ui.js',
  'mobile.css', 'admin-mobile.js', 'admin-mobile.css', 'admin-motion.js', 'admin-workspace.js', 'admin-workspace.css', 'app-refresh.js', 'app-refresh.css', 'sw.js', 'manifest-admin.json', 'manifest-captain.json', '.well-known/assetlinks.json'];
for (const name of fs.readdirSync(path.join(root, 'icons'))) if (name.endsWith('.png')) files.push('icons/' + name);
// Netlify can restore files added to a previous publish directory. Rebuild our generated output.
if (path.relative(root, output) !== 'dist' || (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())) throw new Error('Unsafe web output path');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of files) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}
// Deterministic per-app build IDs cover HTML, scripts and styles, including CSS-only updates.
const versions={schema:1};
for(const role of ['admin','captain']){
  const inputs=[role+'.html','auth-session.js','native-push.js','push-client.js','mobile-ui.js','mobile.css','app-refresh.js','app-refresh.css','sw.js','manifest-'+role+'.json',...(role==='admin'?['admin-mobile.js','admin-mobile.css','admin-motion.js','admin-workspace.js','admin-workspace.css']:['push-diagnostics.js'])];
  const hash=createHash('sha256');
  for(const name of inputs)hash.update(name+'\n'+fs.readFileSync(path.join(output,name),'utf8').replaceAll('\r\n','\n'));
  versions[role]=hash.digest('hex');
  const file=path.join(output,role+'.html');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('content="__APP_BUILD__"','content="'+versions[role]+'"'));
}
fs.writeFileSync(path.join(output,'app-version.json'),JSON.stringify(versions)+'\n');files.push('app-version.json');
function verify(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) verify(absolute);
    else if (!files.includes(path.relative(output, absolute).split(path.sep).join('/'))) throw new Error('Unexpected file in web output: ' + entry.name);
  }
}
verify(output);
console.log('Prepared ' + files.length + ' public assets in dist/');
