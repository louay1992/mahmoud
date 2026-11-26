const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('build IDs are deterministic, embedded in HTML, and detect a stylesheet-only admin release',()=>{
 const base=path.resolve('.tools');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'refresh-build-'));
 try{
  for(const name of fs.readdirSync('.'))if(/\.(html|js|css)$/.test(name))fs.copyFileSync(name,path.join(root,name));
  for(const name of ['manifest-admin.json','manifest-captain.json'])fs.copyFileSync(name,path.join(root,name));
  for(const name of ['icons','.well-known','vendor'])fs.cpSync(name,path.join(root,name),{recursive:true});
  fs.mkdirSync(path.join(root,'scripts'));fs.copyFileSync('scripts/build-web.cjs',path.join(root,'scripts/build-web.cjs'));
  const build=()=>{execFileSync(process.execPath,[path.join(root,'scripts/build-web.cjs')],{stdio:'pipe'});return JSON.parse(fs.readFileSync(path.join(root,'dist/app-version.json'),'utf8'))};
  const first=build();const shell=JSON.parse(fs.readFileSync(path.join(root,'dist/offline-shell-manifest.json'),'utf8'));for(const role of ['admin','captain'])assert.equal(shell[role].files.some(x=>/^\/owner(?:[-.]|$)/.test(x.url)),false,'owner console must not enter an app offline shell');assert.ok(shell.admin.files.some(x=>x.url==='/admin-subscription.js'));assert.equal(shell.captain.files.some(x=>x.url==='/admin-subscription.js'),false);assert.deepEqual(build(),first);assert.match(first.admin,/^[a-f0-9]{64}$/);
  assert.ok(fs.readFileSync(path.join(root,'dist/admin.html'),'utf8').includes('content="'+first.admin+'"'));
  fs.appendFileSync(path.join(root,'admin-mobile.css'),'\n/* fixture stylesheet update */');const changed=build();
  assert.notEqual(changed.admin,first.admin);assert.equal(changed.captain,first.captain);
 }finally{
  const target=fs.realpathSync(root);assert.ok(target.startsWith(fs.realpathSync(base)+path.sep));fs.rmSync(target,{recursive:true,force:true});
 }
});
