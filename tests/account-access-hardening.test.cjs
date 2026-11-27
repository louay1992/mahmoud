const {test}=require('node:test');
const assert=require('node:assert/strict');
const {bootstrap,claims,id,seedAccount,seedSession,userId}=require('./database-fixture.cjs');

test('business permissions follow Auth identity and a live session, and browser registrations cannot be reassigned',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const db=new PGlite();
 const captainId=id(202);
 const alice='alice@example.test', bob='bob@example.test', outsider='outside@example.test', owner='owner@example.test';
 const endpoint='https://fcm.googleapis.com/fcm/send/synthetic-test';
 const as=async(email,settings={},uid=userId(email))=>{
  await db.exec('reset role;set role authenticated');
  await db.query("select set_config('request.jwt.claims',$1,false)",[claims(email,uid,settings)]);
 };
 const value=async(sql,params)=>Object.values((await db.query(sql,params)).rows[0])[0];
 try{
  await bootstrap(db);
  for(const email of [alice,bob,outsider,owner])await seedAccount(db,email);
  await db.query('insert into subscription_owners(user_id) values($1)',[userId(owner)]);
  await db.query('insert into admins(email,auth_user_id) values($1,$2)',[alice,userId(alice)]);
  await db.query('insert into captains(id,name,email) values($1,$2,$3)',[captainId,'Test captain',bob]);
  await db.exec("insert into products(name,price) values('Fixture',100);insert into settings(key,value) values('fixture_nonsecret','1');");
  await as(alice,{},userId(outsider));
  assert.equal(await value('select is_admin()'),false);
  assert.equal(await value('select count(*)::int from settings'),0);
  assert.equal(await value('select count(*)::int from products'),0);
  await as(alice);
  assert.equal(await value('select is_admin()'),true);
  await assert.rejects(db.query('update admins set auth_user_id=$1 where email=$2',[userId(outsider),alice]),/permission denied/);
  await db.query("select save_admin_push_subscription($1,'synthetic-public-key','synthetic-auth-key')",[endpoint]);
  await as(bob);
  assert.equal(await value('select my_captain_id()'),null,'a provisional business record grants no access');
  await assert.rejects(db.query('select bind_business_identity($1,$2)',[userId(bob),captainId]),/permission denied/);
  await db.exec('reset role;set role service_role');
  assert.equal(await value('select bind_business_identity($1,$2)',[userId(bob),captainId]),true);
  await assert.rejects(db.query('select bind_business_identity($1,$2)',[userId(owner),captainId]),/مالك النظام/);
  await as(bob);
  assert.equal(await value('select my_captain_id()'),captainId);
  await assert.rejects(db.query("select save_push_subscription($1,'other-key','other-auth')",[endpoint]),/مرتبط بحساب/);
  await assert.rejects(db.query("select save_push_subscription('https://unsupported.example.test/push','key','auth')"),/غير صالحة/);
  await db.query('select remove_push_subscription($1)',[endpoint]);
  await db.exec('reset role;set role service_role');
  assert.equal(await value('select count(*)::int from web_push_targets(true)'),1);
  await db.exec('reset role');
  await db.query("insert into owner_private.backup_jobs(actor_id,action,status,result)values($1,'download','succeeded',jsonb_build_object('url','https://example.test/synthetic','expires_at',now()+interval '10 minutes'))",[userId(owner)]);
  await as(owner,{aal:'aal1'});
  assert.equal(await value('select owner_has_strong_session()'),false);
  assert.equal((await value('select owner_backup_console()')).jobs[0].result.url,undefined);
  await assert.rejects(db.query("select owner_request_backup('create')"),/OWNER_MFA_REQUIRED/);
  await assert.rejects(db.query('select save_subscription(current_date,current_date+1,1,$1,0)',['USD']),/OWNER_MFA_REQUIRED/);
  await as(owner);
  assert.equal(await value('select owner_has_strong_session()'),true);
  assert.equal((await value('select owner_backup_console()')).jobs[0].result.url,'https://example.test/synthetic');
  await db.query("select save_subscription((now() at time zone 'Asia/Damascus')::date+1,(now() at time zone 'Asia/Damascus')::date+30,1,'USD',0)");
  await as(alice);
  assert.equal((await value('select subscription_access()')).reason,'upcoming');
  await db.query("select set_config('request.path','/rpc/working_orders',false)");
  await assert.rejects(db.query('select enforce_subscription_request()'),/SUBSCRIPTION_NOT_STARTED/);
  await db.exec('reset role');
  await db.query('delete from project_subscription');
  await db.query('delete from auth.sessions where user_id=$1',[userId(alice)]);
  await as(alice);
  assert.equal(await value('select is_admin()'),false,'a token from a revoked session cannot use a mapped role');
  await db.exec('reset role');
  await seedSession(db,userId(alice),id(203));
  await as(alice,{session:id(203)});
  assert.equal(await value('select is_admin()'),true);
 }finally{await db.close();}
});


test('legacy non-finite rows do not stop the Auth identity backfill, and new amounts are checked',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const db=new PGlite();
 const captainId=id(204), orderId=id(205);
 const administrator='historical-admin@example.test', captain='historical-captain@example.test';
 try{
  await bootstrap(db,{beforeMigration:async file=>{
   if(!file.startsWith('20261127223010_'))return;
   await seedAccount(db,administrator);
   await seedAccount(db,captain);
   await db.query('insert into admins(email) values($1)',[administrator]);
   await db.query("insert into captains(id,name,email,delivery_fee)values($1,'Historical captain',$2,'NaN')",[captainId,captain]);
   await db.query("insert into orders(id,customer_name,customer_phone,created_by,items_total)values($1,'Historical order','555123',$2,'NaN')",[orderId,administrator]);
  }});
  assert.deepEqual((await db.query('select auth_user_id,delivery_fee::text from captains where id=$1',[captainId])).rows,[{auth_user_id:userId(captain),delivery_fee:'NaN'}]);
  assert.deepEqual((await db.query('select created_by_auth_user_id,items_total::text from orders where id=$1',[orderId])).rows,[{created_by_auth_user_id:userId(administrator),items_total:'NaN'}]);
  await assert.rejects(db.query("insert into captains(name,delivery_fee)values('New captain','NaN')"),/captains_finite_delivery_fee/);
  await assert.rejects(db.query("insert into orders(customer_name,customer_phone,items_total)values('New order','555999','NaN')"),/orders_finite_amounts/);
 }finally{await db.close();}
});
