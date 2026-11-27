const {test}=require('node:test'),assert=require('node:assert/strict');
const {bootstrap,id}=require('./database-fixture.cjs');
test('owner operations protect owners, transfer exact roles on verified email, revoke deleted accounts and restrict resource/backup controls',async()=>{
 const {PGlite}=await import('@electric-sql/pglite'),db=new PGlite();
 const scalar=async(s,a)=>Object.values((await db.query(s,a)).rows[0])[0];
 const as=async(email,uid=id(901),iat=Math.floor(Date.now()/1000))=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:uid,email,role:'authenticated',iat})]);};
 try{
  await bootstrap(db);await db.query(`insert into auth.users(id,email,email_confirmed_at,encrypted_password)values($1,'owner@example.test',now(),'owner-password'),($2,'company@example.test',now(),'pass'),($3,'new@example.test',now(),'pass'),($4,'staff@example.test',now(),'pass')`,[id(901),id(902),id(903),id(904)]);await db.query('insert into subscription_owners(user_id)values($1)',[id(901)]);await db.exec(`insert into admins(email,name,perms)values('owner@example.test','Owner',null),('company@example.test','Company',null),('staff@example.test','Staff',array['view_orders']);`);
  for(const email of ['company@example.test','staff@example.test','stranger@example.test']){
   await as(email,id(902));for(const s of ['select owner_admin_invites()','select owner_project_resources()',"select owner_request_backup('create')",'select owner_backup_console()'])await assert.rejects(db.query(s),/غير مسموح/);
   await assert.rejects(db.query("select owner_update_admin_profile('company@example.test','X')"),/مالك النظام/);
   await assert.rejects(db.query('select * from owner_private.backup_jobs'),/permission denied/);
  }
  await as('owner@example.test');await assert.rejects(db.query("select owner_prepare_admin_delete('owner@example.test','owner@example.test')"),/محمي/);
  await db.query("select owner_update_admin_profile('company@example.test','Renamed')");assert.equal((await scalar('select owner_admin_invites()')).find(x=>x.email==='company@example.test').name,'Renamed');
  await db.query("select owner_begin_admin_email_change('staff@example.test','new@example.test','New staff')");
  assert.ok((await scalar('select owner_admin_invites()')).find(x=>x.email==='staff@example.test').pending_email);
  await as('new@example.test',id(903));await assert.rejects(db.query('select complete_admin_setup()'),/الدعوة/);
  await db.exec('reset role');await db.query("update subscription_admin_invites set email_sent_at=now(),auth_user_id=$1 where email='new@example.test'",[id(903)]);
  await as('new@example.test',id(903));await db.query('select complete_admin_setup()');assert.equal(await scalar("select has_perm('view_orders')"),true);assert.equal(await scalar('select is_admin()'),false,'staff email replacement never upgrades to full admin');
  await as('staff@example.test',id(904));assert.equal(await scalar("select has_perm('view_orders')"),false,'old JWT loses its business role');
  await as('owner@example.test');await assert.rejects(db.query("select owner_prepare_admin_delete('company@example.test','wrong@example.test')"),/تأكيد/);
  const deletion=await scalar("select owner_prepare_admin_delete('company@example.test','company@example.test')");assert.ok(deletion.operation_id);
  await as('company@example.test',id(902));assert.equal(await scalar('select is_admin()'),false);await assert.rejects(db.query('select complete_admin_setup()'),/الدعوة/);
  await as('owner@example.test');assert.equal((await scalar('select owner_admin_invites()')).find(x=>x.email==='company@example.test').status,'deleting');
  await assert.rejects(db.query('select owner_admin_delete_target($1,$2)',[id(901),deletion.operation_id]),/permission denied/);
  await db.exec('reset role;set role service_role');assert.equal((await scalar('select owner_admin_delete_target($1,$2)',[id(901),deletion.operation_id])).auth_user_id,id(902));
  await db.exec('reset role');await assert.rejects(db.query('delete from auth.users where id=$1',[id(901)]),/محمي/);await assert.rejects(db.query('delete from auth.users where id=$1',[id(903)]),/صلاحيات/);
  await db.query('delete from auth.users where id=$1',[id(902)]);await db.exec('set role service_role');assert.equal(await scalar('select owner_finish_admin_delete($1,$2)',[id(901),deletion.operation_id]),true);
  await as('owner@example.test');assert.ok(!(await scalar('select owner_admin_invites()')).some(x=>x.email==='company@example.test'));
  const resources=await scalar('select owner_project_resources()');assert.ok(resources.database_bytes>0);assert.equal(resources.cpu_percent,null);assert.equal(resources.safe_cleanup.files,0);
  await db.exec('reset role');await db.query("insert into owner_private.backup_catalog(object_key,created_at,size_bytes,sha256,verified)values('a','2026-11-27T05:00:00Z',1,repeat('a',64),true),('b','2026-11-27T05:00:00Z',1,repeat('b',64),true)");await as('owner@example.test');
  const firstPage=await scalar('select owner_backup_console(1)');assert.equal(firstPage.files[0].object_key,'b');const secondPage=await scalar("select owner_backup_console(1,'2026-11-27T05:00:00Z','b')");assert.equal(secondPage.files[0].object_key,'a','equal timestamps paginate without dropping backups');
  const job=await scalar("select owner_request_backup('create')");const again=await scalar("select owner_request_backup('create')");assert.equal(job.id,again.id);assert.equal(again.existing,true);
  await assert.rejects(db.query("select owner_request_backup('restore','missing')"),/نسخة موثقة/);await assert.rejects(db.query("select owner_request_backup('cleanup')"),/تأكيد/);await assert.rejects(db.query("select owner_request_backup('catalog','unused')"),/ملفًا/);
  await db.exec('reset role');await db.query("update owner_private.runtime_state set maintenance=true");
  await as('new@example.test',id(903));assert.equal((await scalar('select subscription_access()')).reason,'maintenance');assert.equal(await scalar("select has_perm('view_orders')"),false);await assert.rejects(db.query('select complete_admin_setup()'),/انتظر/);
  await db.query("select set_config('request.path','/rpc/working_orders',false)");await assert.rejects(db.query('select enforce_subscription_request()'),e=>e.code==='PT503');
  await as('owner@example.test');await db.query("select set_config('request.path','/rpc/owner_project_resources',false)");await db.query('select enforce_subscription_request()');await db.query('select owner_project_resources()');
  await db.exec('reset role');await db.query("update owner_private.runtime_state set maintenance=false,session_cutoff=now()+interval '5 seconds'");await as('new@example.test',id(903));assert.equal((await scalar('select subscription_access()')).reason,'session_refresh');
 }finally{await db.close();}
});
test('account endpoint authenticates owner, handles partial Auth deletion without claiming success and rejects foreign origins',async()=>{
 const {createOwnerAccountHandler}=await import('../supabase/functions/_shared/owner-manage-admin.ts');let owner=true,deleted=false,prepared=false,fail=true;
 const handler=createOwnerAccountHandler({allowedOrigin:'https://applications.nature-care.net',service:{auth:{getUser:async()=>({data:{user:{id:'owner'}}}),admin:{deleteUser:async()=>{deleted=true;return {error:fail?{status:500}:null};}}},rpc:async name=>({data:name==='owner_admin_delete_target'?{complete:false,auth_user_id:'company'}:true})},userClient:()=>({rpc:async name=>{if(name==='owner_prepare_admin_delete')prepared=true;return {data:name==='is_subscription_owner'?owner:{operation_id:'op'},error:null};}}),invite:async()=>new Response('{}')});
 const request=(origin='https://applications.nature-care.net')=>new Request('https://fixture.test',{method:'POST',headers:{origin,authorization:'Bearer fixture'},body:JSON.stringify({action:'delete',email:'company@example.test',confirmation:'company@example.test'})});
 assert.equal((await handler(request('https://evil.example'))).status,403);assert.equal(deleted,false);owner=false;assert.equal((await handler(request())).status,403);assert.equal(prepared,false);owner=true;
 let response=await handler(request());assert.equal(response.status,202);assert.equal((await response.json()).access_revoked,true);fail=false;response=await handler(request());assert.equal((await response.json()).ok,true);
});
