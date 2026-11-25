const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const {prepare}=require('../scripts/prepare-android-release.cjs');
const context=vm.createContext({URL,module:{exports:{}}});vm.runInContext(fs.readFileSync('app-updates.js','utf8'),context);const updates=context.module.exports;
function generated(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-release-'));try{
 for(const role of ['Admin','Captain'])fs.writeFileSync(path.join(directory,'Delivery-'+role+'-1.4.0.apk'),'signed fixture '+role);
 return prepare({directory,sourceCommit:'a'.repeat(40),notes:'تحسين التحديثات',gradle:'versionName "1.4.0"\nversionCode 7'});
}finally{fs.rmSync(directory,{recursive:true,force:true});}}
test('published metadata identifies both APKs, their exact hashes and the reviewed source',()=>{
 const manifest=generated();for(const role of ['admin','captain']){const item=updates.release(manifest,role);assert.ok(item);assert.equal(item.packageName,'app.hhyyw.'+role);assert.match(item.sha256,/^[a-f0-9]{64}$/);assert.equal(item.versionCode,7);}
 assert.equal(manifest.sourceCommit,'a'.repeat(40));assert.notEqual(manifest.apps.admin.sha256,manifest.apps.captain.sha256);
 assert.equal(updates.newer('1.4.0','1.3.0'),true);assert.equal(updates.newer('1.4.0','1.4.0'),false);assert.equal(updates.newer('1.4.0','1.5.0'),false);assert.equal(updates.newer('1.10.0','1.9.0'),true);
});
test('the legacy offer rejects another application, untrusted URLs and invalid release data',()=>{
 const manifest=generated();for(const url of ['javascript:alert(1)','https://github.com.evil.example/update.apk','https://github.com/another/repo/releases/download/v1/Delivery-Admin-1.4.0.apk',manifest.apps.captain.url,manifest.apps.admin.url+'?redirect=evil']){
  const input=structuredClone(manifest);input.apps.admin.url=url;assert.equal(updates.release(input,'admin'),null);
 }
 for(const [key,value] of [['sha256','bad'],['versionCode',-1],['size',101*1024*1024],['versionName','1.4'],['packageName','app.hhyyw.captain']]){const input=structuredClone(manifest);input.apps.admin[key]=value;assert.equal(updates.release(input,'admin'),null);}
 assert.equal(updates.release({...manifest,schema:2},'admin'),null);
});
