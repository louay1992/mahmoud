const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const files = ['index.html', 'admin.html', 'captain.html', 'push-client.js', 'native-push.js', 'mobile-ui.js',
  'mobile.css', 'sw.js', 'manifest-admin.json', 'manifest-captain.json', '.well-known/assetlinks.json'];
for (const name of fs.readdirSync(path.join(root, 'icons'))) if (name.endsWith('.png')) files.push('icons/' + name);
fs.mkdirSync(output, { recursive: true });
for (const file of files) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}
function verify(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) verify(absolute);
    else if (!files.includes(path.relative(output, absolute).split(path.sep).join('/'))) throw new Error('Unexpected file in web output: ' + entry.name);
  }
}
verify(output);
console.log('Prepared ' + files.length + ' public assets in dist/');
