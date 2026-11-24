const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(){
 const data=new Map(); const storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const context=vm.createContext({localStorage:storage,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync('auth-session.js','utf8'),context);
 return {data,storage,create:key=>new context.DeliverySession(key)};
}
for(const role of ['admin','captain']){
 test(role+': failing native detach and remote sign-out cannot retain the local account',async()=>{
  const f=fixture(),key='sb-'+role+'-auth',gate=f.create(key);f.storage.setItem(key,'old session');
  const other=role==='admin'?'captain':'admin';f.storage.setItem('sb-'+other+'-auth','other app session');
  let locked=false,reloaded=false,scope;
  await gate.logout({auth:{signOut:async options=>{scope=options.scope;return {error:Error('offline')}}},
   detach:async()=>{throw Error('native channel unavailable')},lock:()=>{locked=true},reload:()=>{reloaded=true}});
  assert.ok(locked&&reloaded);assert.equal(scope,'local');assert.equal(f.storage.getItem(key),null);
  assert.equal(f.storage.getItem('sb-'+other+'-auth'),'other app session');assert.ok(f.create(key).blocked);
  f.storage.setItem(key,'late refresh response');const next=f.create(key);assert.ok(next.blocked);next.clearSession();assert.equal(f.storage.getItem(key),null);
  next.beginLogin();assert.ok(next.blocked,'a failed password attempt cannot restore the old account');
  f.storage.setItem(key,'new authenticated session');next.completeLogin();assert.equal(next.blocked,false);
 });
 test(role+': an unresponsive SDK and notification channel cannot hang logout',async()=>{
  const f=fixture(),key='sb-'+role+'-auth',gate=f.create(key);f.storage.setItem(key,'old session');let reloads=0;
  await gate.logout({auth:{signOut:()=>new Promise(()=>{})},detach:()=>new Promise(()=>{}),lock(){},reload(){reloads++},timeout:5});
  assert.equal(reloads,1);assert.equal(f.storage.getItem(key),null);assert.ok(gate.blocked);
 });
}
