const assert=require('node:assert/strict'),{chromium}=require('playwright');
const {serve}=require('./workspace-fixture.cjs');
// Fixture sessions and passwords below exist only in this isolated browser test. No hosted Auth calls.
const sdk=`window.fixture={...window.authCase,calls:[],session:authCase.session};
window.supabase={createClient:()=>{
 fixture.oldStorageAtCreation=localStorage.getItem('sb-subscription-owner-auth');
 const hadCallback=!!location.hash;if(hadCallback)history.replaceState(null,'',location.pathname);
 return {auth:{
  getSession:async()=>({data:{session:fixture.session},error:fixture.sessionError?{message:'unavailable'}:null}),
  onAuthStateChange:cb=>{if(fixture.event&&hadCallback)setTimeout(()=>cb(fixture.event,fixture.session),0);return {data:{subscription:{unsubscribe(){}}}}},
  resetPasswordForEmail:async(email,options)=>{fixture.calls.push({method:'reset',email,options});return {error:fixture.resetError?{message:'limited'}:null}},
  updateUser:async({password})=>{fixture.calls.push({method:'update',length:password.length});await window.recordAuthCall('update');if(fixture.hold)return new Promise(resolve=>fixture.finishUpdate=resolve);return {data:{user:fixture.session.user},error:fixture.updateError?{message:'expired'}:null}},
  signOut:async()=>{fixture.session=null;await window.recordAuthCall('signOut');return {error:null}},stopAutoRefresh(){}
 },rpc:async name=>name==='is_subscription_owner'?{data:fixture.owner,error:null}:{data:{subscription:{configured:false},changes:[]},error:null}};
}};`;
(async()=>{
 const {server,origin}=await serve();let browser;const errors=[];
 try{
  browser=await chromium.launch({headless:true});
  async function pageFor(options={},hash=''){
   const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:'block',reducedMotion:'reduce'}),calls=[];
   await context.exposeFunction('recordAuthCall',name=>calls.push(name));
   await context.addInitScript(value=>{window.authCase=value;if(value.signedOut&&!sessionStorage.getItem('fixture-first-load')){sessionStorage.setItem('fixture-first-load','1');localStorage.setItem('sb-subscription-owner-auth-signed-out','1');localStorage.setItem('sb-subscription-owner-auth','old-session');}},{owner:true,session:null,...options});
   await context.route('**/*',r=>r.request().url().endsWith('/vendor/supabase.js')?r.fulfill({contentType:'application/javascript',body:sdk}):r.request().url().startsWith(origin+'/')?r.continue():r.abort());
   const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/owner.html'+hash);return {p,context,calls};
  }
  let t=await pageFor();await t.p.locator('#owner-email').fill('owner@example.test');await t.p.locator('#owner-reset-request').click();await t.p.getByText(/ستصلك رسالة/).waitFor();
  const reset=await t.p.evaluate(()=>fixture.calls.find(x=>x.method==='reset'));assert.equal(reset.email,'owner@example.test');assert.equal(reset.options.redirectTo,origin+'/owner.html');assert.equal(await t.p.locator('#owner-recovery').isVisible(),false);await t.context.close();
  t=await pageFor({resetError:true});await t.p.locator('#owner-email').fill('owner@example.test');await t.p.locator('#owner-reset-request').click();await t.p.getByText(/تعذّر إرسال الرابط/).waitFor();await t.context.close();
  const session={user:{id:'owner-fixture',email:'owner@example.test'}};
  t=await pageFor({session,signedOut:true,event:'PASSWORD_RECOVERY'},'#type=recovery&access_token=fixture-token&refresh_token=fixture-refresh');
  await t.p.locator('#owner-recovery').waitFor();assert.equal(await t.p.evaluate(()=>fixture.oldStorageAtCreation),null,'recovery must discard pre-logout credentials before initializing the SDK');assert.equal(await t.p.locator('#owner-dashboard').isVisible(),false);
  assert.ok(await t.p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await t.p.reload();await t.p.locator('#owner-recovery').waitFor();
  await t.p.locator('#owner-new-password').fill('isolated-fixture-password');await t.p.locator('#owner-confirm-password').fill('different-fixture-password');await t.p.locator('#owner-password-save').click();await t.p.getByText(/متطابقتان/).waitFor();assert.deepEqual(t.calls,[]);
  await t.p.locator('#owner-confirm-password').fill('isolated-fixture-password');await t.p.locator('#owner-password-save').click();await t.p.getByText(/حُفظت كلمة المرور/).waitFor();assert.deepEqual(t.calls,['update','signOut']);assert.equal(await t.p.locator('#owner-new-password').inputValue(),'');assert.equal(await t.p.locator('#owner-login').isVisible(),true);await t.context.close();
  t=await pageFor({session,owner:false},'#type=recovery&access_token=fixture-token');await t.p.getByText(/لا يملك صلاحية/).waitFor();assert.equal(await t.p.locator('#owner-recovery').isVisible(),false);assert.deepEqual(t.calls,[]);await t.context.close();
  t=await pageFor({signedOut:true},'#type=recovery&error=access_denied&error_code=otp_expired');await t.p.getByText(/انتهت صلاحيته/).waitFor();assert.equal(await t.p.locator('#owner-recovery').isVisible(),false);await t.context.close();
  t=await pageFor({session,updateError:true},'#type=recovery&access_token=fixture-token');await t.p.locator('#owner-recovery').waitFor();await t.p.locator('#owner-new-password').fill('isolated-fixture-password');await t.p.locator('#owner-confirm-password').fill('isolated-fixture-password');await t.p.locator('#owner-password-save').click();await t.p.getByText(/تعذّر حفظ كلمة المرور/).waitFor();assert.equal(await t.p.locator('#owner-password-save').isEnabled(),true);await t.context.close();
  t=await pageFor({session,hold:true},'#type=recovery&access_token=fixture-token');await t.p.locator('#owner-recovery').waitFor();await t.p.locator('#owner-new-password').fill('isolated-fixture-password');await t.p.locator('#owner-confirm-password').fill('isolated-fixture-password');await t.p.locator('#owner-password-save').click();await t.p.locator('#owner-recovery-exit').click();await t.p.locator('#owner-login').waitFor();assert.equal(await t.p.locator('#owner-recovery').isVisible(),false);await t.context.close();
  assert.deepEqual(errors,[]);console.log('Owner email setup: exact redirect, owner-only callback, recovery after logout/refresh, expiry, mismatched passwords, update failure, sign-out and cancellation verified.');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
