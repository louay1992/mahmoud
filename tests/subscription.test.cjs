const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {bootstrap,id,claims,userId,seedAccount}=require('./database-fixture.cjs');
test('single-company subscription: customer reads, independent owner writes, audit and concurrency are protected',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 const as=async(email,uid)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[claims(email,uid)]);};
 const scalar=async(sql,args)=>Object.values((await db.query(sql,args)).rows[0])[0];
 const save=(revision,start='2026-11-26',end='2027-11-25',amount='750.50',currency='USD')=>db.query('select save_subscription($1::date,$2::date,$3::numeric,$4,$5)',[start,end,amount,currency,revision]);
 try{
  await bootstrap(db);await seedAccount(db,'owner@test',id(901));for(const email of ['company@test','staff@test','captain@test'])await seedAccount(db,email);
  await db.exec(`insert into admins(email,perms,auth_user_id)values('company@test',null,'${userId('company@test')}'),('staff@test',array['view_orders'],'${userId('staff@test')}');insert into subscription_owners(user_id)values('${id(901)}');`);
  await as('company@test');assert.equal(await scalar('select is_subscription_owner()'),false);
  assert.equal((await scalar('select get_subscription()')).configured,false);
  await assert.rejects(save(0),/مالك النظام/);await assert.rejects(db.query('select owner_subscription()'),/غير مسموح/);
  for(const table of ['subscription_owners','project_subscription','subscription_changes']){
   await assert.rejects(db.query('select * from '+table),/permission denied/);
   await assert.rejects(db.query('delete from '+table),/permission denied/);
  }
  await assert.rejects(db.query('insert into subscription_owners(user_id)values($1)',[id(900)]),/permission denied/);
  await as('staff@test');await assert.rejects(db.query('select get_subscription()'),/غير مسموح/);
  await as('captain@test');await assert.rejects(db.query('select get_subscription()'),/غير مسموح/);
  await db.exec('reset role;set role anon');await assert.rejects(db.query('select get_subscription()'),/permission denied/);
  await as('owner@test',id(901));assert.equal(await scalar('select is_subscription_owner()'),true);assert.equal(await scalar('select is_admin()'),false);
  await save(0);let s=await scalar('select get_subscription()');assert.equal(Number(s.renewal_amount),750.5);assert.equal(s.currency,'USD');assert.equal(s.duration_days,365);assert.equal(s.revision,1);
  assert.equal((await scalar('select owner_subscription()')).changes.length,1);
  await assert.rejects(save(0),/جلسة أخرى/);
  for(const args of [[1,'2027-01-01','2026-01-01'],[1,'2026-01-01','2027-01-01','-1'],[1,'2026-01-01','2027-01-01','NaN'],[1,'2026-01-01','2027-01-01','4.123'],[1,'2026-01-01','2027-01-01','2','<script>']])await assert.rejects(save(...args),/غير صالح|رمز عملة/);
  const today=s.checked_on,old=new Date(Date.parse(today+'T00:00:00Z')-864e5).toISOString().slice(0,10),future=new Date(Date.parse(today+'T00:00:00Z')+864e5).toISOString().slice(0,10);
  await save(1,old,today);s=await scalar('select get_subscription()');assert.equal(s.status,'active');assert.equal(s.days_remaining,0);
  await save(2,old,old);assert.equal((await scalar('select get_subscription()')).status,'expired');
  await save(3,future,future);assert.equal((await scalar('select get_subscription()')).status,'upcoming');
  await as('company@test');assert.equal((await scalar('select get_subscription()')).configured,true);
  await db.exec('reset role');await db.query('update subscription_owners set active=false where user_id=$1',[id(901)]);
  await as('owner@test',id(901));await assert.rejects(save(4),/مالك النظام/);
 }finally{await db.close();}
});
test('subscription UI distinguishes blank, current and expired terms and never mixes company cash currency',()=>{
 const context={Intl,Date};vm.runInNewContext(fs.readFileSync('subscription-utils.js','utf8'),context);const ui=context.DeliverySubscription;
 assert.match(ui.card({configured:false}),/غير محددة/);assert.doesNotMatch(ui.card({configured:false}),/0 USD/);
 const s={configured:true,status:'active',starts_on:'2026-11-26',valid_until:'2027-11-25',days_remaining:90,renewal_amount:750.5,currency:'USD'};
 const html=ui.card(s,'<img src=x onerror=x>');assert.match(html,/750.5 USD/);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
 assert.match(ui.card({...s,status:'expired',days_remaining:-2}),/انتهى منذ 2/);assert.match(ui.card({...s,days_remaining:0}),/نهاية اليوم/);
 assert.equal(ui.validate({...s,renewal_amount:'750.50'}),null);assert.match(ui.validate({...s,starts_on:'2026-02-31',renewal_amount:'2'}),/تاريخ/);
 assert.match(ui.validate({...s,renewal_amount:'1e4'}),/قيمة/);
});
test('company password reset protects registered subscription owners, including inactive ones',async()=>{
 const {protectedSubscriptionOwner}=await import('../supabase/functions/_shared/admin-set-password.ts');
 let target;const mock=result=>({from:table=>{assert.equal(table,'subscription_owners');const q={select:()=>q,eq:(key,id)=>{assert.equal(key,'user_id');target=id;return q;},maybeSingle:async()=>result};return q;}});
 assert.equal((await protectedSubscriptionOwner(mock({data:{user_id:'owner'},error:null}),'owner')).protected,true);assert.equal(target,'owner');
 assert.equal((await protectedSubscriptionOwner(mock({data:null,error:null}),'company')).protected,false);
 assert.ok((await protectedSubscriptionOwner(mock({data:null,error:{message:'unavailable'}}),'owner')).error);
 const source=fs.readFileSync('supabase/functions/_shared/admin-set-password.ts','utf8');assert.ok(source.includes('protection.protected')&&source.indexOf('protection.protected')<source.indexOf('updateUserById'));
});
