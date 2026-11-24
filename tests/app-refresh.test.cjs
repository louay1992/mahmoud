const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(overrides={}){
 const storage=new Map(),notices=[],deleted=[];let active=true,safe=true,reloads=0,calls=0;
 const context=vm.createContext({setTimeout,clearTimeout,AbortController,Date,Promise,Map,Set,
  navigator:{onLine:true},document:{hidden:false,querySelector:()=>null,getElementById:()=>null},
  sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  caches:{keys:async()=>['shell-admin-v12','shell-captain-v12','unrelated'],delete:async key=>deleted.push(key)},
  fetch:async()=>({ok:true,json:async()=>({schema:1,admin:'b'.repeat(64),captain:'a'.repeat(64)})})});
 vm.runInContext(fs.readFileSync('app-refresh.js','utf8'),context);
 const controller=new context.DeliveryRefresh({role:'admin',mount:false,buildVersion:'a'.repeat(64),active:()=>active,safe:()=>safe,
  fetchData:async()=>{calls++;return true},toast:(...args)=>notices.push(args),reload:()=>reloads++,captureView:()=>({owner:'fixture',tab:'orders'}),...overrides});
 return {controller,context,storage,notices,deleted,get calls(){return calls},get reloads(){return reloads},set active(v){active=v},set safe(v){safe=v}};
}
test('manual and automatic requests share a fetch; live changes queue a bounded fresh pass',async()=>{
 let release,calls=0;const f=fixture({fetchData:async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return true}});
 const a=f.controller.refresh();await Promise.resolve();const b=f.controller.refresh({manual:true});
 assert.equal(calls,1);const c=f.controller.refresh({reason:'live'});release();await Promise.all([a,b,c]);assert.equal(calls,2);assert.equal(f.controller.flight,null);
});
test('hidden/offline/dirty work skips reads and deferred work resumes when safe',async()=>{
 const f=fixture();f.context.document.hidden=true;await f.controller.refresh();assert.equal(f.calls,0);
 f.context.document.hidden=false;f.context.navigator.onLine=false;await f.controller.manual();assert.equal(f.calls,0);
 f.context.navigator.onLine=true;const field={isConnected:true,value:'unsaved note',defaultValue:''};f.controller.dirty.add(field);
 await f.controller.refresh();assert.equal(f.calls,0);assert.equal(f.controller.pending,true);
 field.isConnected=false;f.controller.tick();await f.controller.flight;assert.equal(f.calls,1);
});
test('a stuck refresh aborts, clears its busy state, and can be retried',async()=>{
 let signal;const f=fixture({timeout:5,fetchData:async options=>{signal=options.signal;await new Promise(()=>{})}});
 assert.equal((await f.controller.manual()).ok,false);assert.equal(signal.aborted,true);assert.equal(f.controller.flight,null);assert.match(f.notices.at(-1)[0],/تعذّر التحديث/);
 f.controller.options.fetchData=async()=>true;assert.equal((await f.controller.refresh({manual:true})).ok,true);
});
test('a new interface waits for drafts and deletes only its own shell cache',async()=>{
 const f=fixture();f.safe=false;await f.controller.checkUpdate();assert.equal(f.reloads,0);assert.equal(f.controller.pendingVersion,'b'.repeat(64));
 f.safe=true;await f.controller.applyUpdate(false);assert.equal(f.reloads,1);assert.deepEqual(f.deleted,['shell-admin-v12']);
 assert.equal(JSON.parse(f.storage.get('delivery-refresh-view-admin')).tab,'orders');
});
test('editing that begins during cache cleanup cancels automatic reload',async()=>{
 const f=fixture();let release;f.context.caches.keys=()=>new Promise(resolve=>release=resolve);f.controller.pendingVersion='b'.repeat(64);
 const pending=f.controller.applyUpdate(false);await new Promise(resolve=>setTimeout(resolve,0));f.safe=false;release([]);await pending;
 assert.equal(f.reloads,0);assert.equal(f.controller.applying,false);assert.equal(f.storage.has(f.controller.attemptKey),false);
});
test('a stale deployment cannot create an automatic reload loop',async()=>{
 const f=fixture();f.storage.set(f.controller.attemptKey,JSON.stringify({version:'b'.repeat(64),at:Date.now()}));
 await f.controller.checkUpdate();assert.equal(f.reloads,0);
});
test('a pending release never clears offline caches or reloads while disconnected',async()=>{
 const f=fixture();f.controller.pendingVersion='b'.repeat(64);f.context.navigator.onLine=false;
 await f.controller.applyUpdate(false);assert.equal(f.reloads,0);assert.deepEqual(f.deleted,[]);
 f.context.navigator.onLine=true;f.context.fetch=async()=>{throw Error('network down')};
 await f.controller.applyUpdate(false);assert.equal(f.reloads,0);assert.deepEqual(f.deleted,[]);
});
