const {test}=require('node:test'),assert=require('node:assert/strict');
const {bootstrap,id,claims,userId,seedAccount}=require('./database-fixture.cjs');
test('expiry stops admin, staff and captain business access; owner renewal immediately restores it',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 const scalar=async(sql,args)=>Object.values((await db.query(sql,args)).rows[0])[0];
 const as=async(email,uid)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[claims(email,uid)]);};
 try{
  await db.exec('create role authenticator');await bootstrap(db);
  await seedAccount(db,'owner@test',id(901));for(const email of ['company@test','staff@test','captain@test'])await seedAccount(db,email);
  await db.exec(`insert into subscription_owners(user_id)values('${id(901)}');insert into admins(email,perms,auth_user_id)values('company@test',null,'${userId('company@test')}'),('staff@test',array['create_orders','view_orders'],'${userId('staff@test')}');
   insert into captains(id,name,email,auth_user_id)values('${id(2)}','Captain','captain@test','${userId('captain@test')}');insert into products(id,name,price)values('${id(1)}','Product',100);`);
  await as('company@test');assert.equal((await scalar('select subscription_access()')).allowed,true,'unconfigured subscriptions preserve existing operation until owner sets terms');
  await as('owner@test',id(901));await db.query("select save_subscription((now() at time zone 'Asia/Damascus')::date-30,(now() at time zone 'Asia/Damascus')::date,1000,'USD',0)");
  await as('company@test');let access=await scalar('select subscription_access()');assert.equal(access.allowed,true,'last contract day remains valid');assert.equal(access.renewal_amount,1000);
  const today=(await scalar('select get_subscription()')).checked_on;assert.equal(new Date(access.expires_at).getTime(),Date.parse(today+'T00:00:00+03:00')+864e5);
  await as('owner@test',id(901));await db.query("select save_subscription((now() at time zone 'Asia/Damascus')::date-30,(now() at time zone 'Asia/Damascus')::date-1,1000,'USD',1)");
  for(const email of ['company@test','staff@test','captain@test']){
   await as(email);access=await scalar('select subscription_access()');assert.equal(access.allowed,false);assert.equal(await scalar('select is_admin()'),false);assert.equal(await scalar("select has_perm('create_orders')"),false);assert.equal(await scalar('select my_captain_id()'),null);
   assert.equal(Number(await scalar('select count(*) from products')),0,'restrictive RLS also stops direct table and realtime reads');
   await assert.rejects(db.query("select create_order('blocked','0900000000',null,null,'[]'::jsonb,null,null,null,null)"),/غير مسموح/);
   await db.query("select set_config('request.path','/rpc/working_orders',false)");await assert.rejects(db.query('select enforce_subscription_request()'),e=>e.code==='PT402');
   await db.query("select set_config('request.path','/products',false)");await assert.rejects(db.query('select enforce_subscription_request()'),/SUBSCRIPTION_EXPIRED/);
   await db.query("select set_config('request.path','/rpc/subscription_access',false)");await db.query('select enforce_subscription_request()');
   if(email!=='company@test')assert.equal(access.renewal_amount,null,'captains and staff never see the commercial amount');
  }
  await as('company@test');assert.equal((await scalar('select get_subscription()')).status,'expired');await assert.rejects(db.query('select owner_subscription()'),/غير مسموح/);
  await as('owner@test',id(901));await db.query("select set_config('request.path','/rpc/save_subscription',false)");await db.query('select enforce_subscription_request()');assert.equal((await scalar('select owner_subscription()')).subscription.status,'expired');
  await db.query("select save_subscription((now() at time zone 'Asia/Damascus')::date,(now() at time zone 'Asia/Damascus')::date+365,1000,'USD',2)");
  await as('company@test');assert.equal((await scalar('select subscription_access()')).allowed,true);assert.equal(Number(await scalar('select count(*) from products')),1);assert.equal(await scalar('select is_admin()'),true);
  await as('captain@test');assert.equal(await scalar('select my_captain_id()'),id(2));
  await db.exec('reset role');assert.equal((await scalar("select rolconfig from pg_roles where rolname='authenticator'")).includes('pgrst.db_pre_request=public.enforce_subscription_request'),true);
  assert.equal(Number(await scalar("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relname not like 'subscription_%' and c.relname<>'project_subscription' and not exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='subscription_required' and not p.polpermissive)")),0);
 }finally{await db.close();}
});
