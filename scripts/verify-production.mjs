import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createFcmSender, parseFcmAccount} from '../supabase/functions/_shared/fcm.ts';
const base='https://jabapvnmfdflysxfxwwf.supabase.co/functions/v1/';
const summary={};
const vapid=await fetch(base+'send-push');
assert.equal(vapid.status,200); assert.equal(typeof (await vapid.json()).key,'string');
summary.webPushPublicEndpoint='passed';
const invalid=await fetch(base+'native-device',{method:'POST',body:'{}'});
assert.equal(invalid.status,400);
const unauthed=await fetch(base+'native-device',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
 action:'bind',installation_id:'00000000-0000-0000-0000-000000000001',app_scope:'captain',secret:'0'.repeat(64),fcm_token:'validation-only-token-no-device'
})});
assert.equal(unauthed.status,403); summary.nativeConfiguredAndRejectsUnauthorized='passed';
const blocked=await fetch(base+'native-device',{method:'OPTIONS',headers:{origin:'https://example.com'}});
assert.equal(blocked.status,403); summary.foreignOriginRejected='passed';
// Business app preflight allows both exact production origins.
const passwordForeign=await fetch(base+'admin-set-password',{method:'OPTIONS',headers:{origin:'https://example.com'}});
assert.equal(passwordForeign.status,403);
for(const fn of ['admin-set-password','native-device','webpage-text']){
 for(const origin of ['https://hhyyw.netlify.app','https://applications.nature-care.net']){
  const allowed=await fetch(base+fn,{method:'OPTIONS',headers:{origin}});
  assert.equal(allowed.status,200);
  assert.equal(allowed.headers.get('access-control-allow-origin'),origin);
  assert.match(allowed.headers.get('vary')||'',/\bOrigin\b/i);
 }
}
summary.businessAppOrigins='passed';
if(process.argv[2]){
 const account=parseFcmAccount(fs.readFileSync(process.argv[2],'utf8')); assert.ok(account);
 let oauthOk=false,validation;
 const send=createFcmSender(account,async(url,options)=>{
  if(url.includes('fcm.googleapis.com')){
   options={...options,body:JSON.stringify({...JSON.parse(options.body),validate_only:true})};
  }
  const response=await fetch(url,options);
  if(url.includes('oauth2.googleapis.com')) oauthOk=response.ok;
  else {const result=await response.clone().json();validation={status:response.status,code:result.error?.status||'OK'};}
  return response;
 });
 await send({installation_id:'validation',app_scope:'captain',binding_id:'validation',fcm_token:'validation-only-token-no-device'},{title:'Validation only',body:'No device is contacted'});
 assert.ok(oauthOk); assert.equal(validation.status,400); assert.equal(validation.code,'INVALID_ARGUMENT');
 summary.firebaseOAuth='passed';summary.firebaseHttpV1Permissions='passed (validate_only; invalid dummy token rejected)';
}
console.log(JSON.stringify(summary,null,2));
