const {test}=require('node:test'),assert=require('node:assert/strict');
const {bootstrap,id}=require('./database-fixture.cjs');
test('subscriber invitation roles require a recorded send, authoritative email confirmation, a password and active owner approval',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 const root=()=>db.exec('reset role');
 const as=async(uid,role='authenticated')=>{await root();await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:uid,email:'forged-claim@example.test',role})]);};
 const scalar=async(sql,args)=>Object.values((await db.query(sql,args)).rows[0])[0];
 const reserve=email=>scalar('select reserve_subscription_admin_invite($1,$2,$3)',[id(901),email,'Subscriber admin']);
 const finish=(r,success,uid=id(902))=>scalar('select finish_subscription_admin_invite($1,$2,$3,$4)',[r.email,r.send_token,success,uid]);
 try{
  await bootstrap(db);await db.query("insert into auth.users(id,email,email_confirmed_at,encrypted_password)values($1,'owner@example.test',now(),'fixture-hash'),($2,'company@example.test',now(),'fixture-hash'),($3,'new@example.test',null,null),($4,'other@example.test',now(),'fixture-hash')",[id(901),id(900),id(902),id(903)]);
  await db.query('insert into subscription_owners(user_id)values($1)',[id(901)]);await db.exec("insert into admins(email,perms)values('company@example.test',null)");
  await as(id(900));await assert.rejects(reserve('new@example.test'),/permission denied/);await assert.rejects(scalar('select owner_admin_invites()'),/غير مسموح/);await assert.rejects(db.query('select * from subscription_admin_invites'),/permission denied/);
  assert.equal((await scalar('select admin_setup_access()')).allowed,true,'existing company admins can reset their own passwords');
  await as(id(903));assert.equal((await scalar('select admin_setup_access()')).allowed,false);await assert.rejects(scalar('select complete_admin_setup()'),/الدعوة/);
  await as(id(901),'service_role');let r=await reserve(' NEW@example.test ');assert.equal(r.email,'new@example.test');assert.equal(r.existing_user,true);
  await assert.rejects(reserve('new@example.test'),/انتظر دقيقة/);await assert.rejects(reserve('owner@example.test'),/حساب المالك/);await assert.rejects(reserve('not-an-email'),/بريدًا/);
  assert.equal(await finish(r,false),true);await as(id(902));assert.equal((await scalar('select admin_setup_access()')).allowed,false);await assert.rejects(scalar('select complete_admin_setup()'),/تأكيد البريد/);
  await root();await db.query('update auth.users set email_confirmed_at=now(),encrypted_password=$1 where id=$2',['fixture-hash',id(902)]);await as(id(902));assert.equal((await scalar('select admin_setup_access()')).allowed,false);await assert.rejects(scalar('select complete_admin_setup()'),/الدعوة/,'a failed email cannot activate a new business role');
  await root();await db.exec("update subscription_admin_invites set send_requested_at=now()-interval '2 minutes'");await as(id(901),'service_role');const old=r;r=await reserve('new@example.test');assert.equal(await finish(old,true),false,'stale send completion is rejected');assert.equal(await finish(r,true),true);
  await root();await db.query('update auth.users set encrypted_password=null where id=$1',[id(902)]);await as(id(902));assert.equal((await scalar('select admin_setup_access()')).allowed,true);await assert.rejects(scalar('select complete_admin_setup()'),/كلمة المرور/);
  await root();await db.query('update auth.users set encrypted_password=$1 where id=$2',['fixture-hash',id(902)]);await as(id(902));assert.equal((await scalar('select complete_admin_setup()')).active,true);assert.equal((await scalar('select complete_admin_setup()')).active,true);
  await root();assert.equal(await scalar("select count(*)::int from admins where email='new@example.test' and perms is null"),1);await db.exec("update admins set perms=array['create_orders'] where email='new@example.test'");await as(id(902));await scalar('select complete_admin_setup()');await root();assert.deepEqual(await scalar("select perms from admins where email='new@example.test'"),['create_orders'],'password reset must not restore a demoted role');
  await db.exec("delete from admins where email='new@example.test'");await as(id(902));await assert.rejects(scalar('select complete_admin_setup()'),/الدعوة/,'old activated invitations cannot resurrect a removed account');
  await root();await db.exec("update subscription_admin_invites set send_requested_at=now()-interval '2 minutes'");await as(id(901),'service_role');r=await reserve('new@example.test');assert.equal(await finish(r,false),true);await as(id(902));assert.equal((await scalar('select admin_setup_access()')).allowed,false);await assert.rejects(scalar('select complete_admin_setup()'),/الدعوة/,'a failed re-invitation cannot reuse an old successful send');
  await as(id(901),'service_role');r=await reserve('other@example.test');assert.equal(await finish(r,true,id(903)),true);await root();await db.query('update subscription_owners set active=false where user_id=$1',[id(901)]);await as(id(903));assert.equal((await scalar('select admin_setup_access()')).allowed,false);await assert.rejects(scalar('select complete_admin_setup()'),/الدعوة/);
  await as(id(901));await assert.rejects(scalar('select owner_admin_invites()'),/غير مسموح/);assert.equal((await scalar('select admin_setup_access()')).allowed,false,'owners never enter the subscriber password flow');
  await as(id(902),'anon');await assert.rejects(scalar('select admin_setup_access()'),/permission denied/);
 }finally{await db.close();}
});

test('owner invitation endpoint validates identity and owner role, pins redirect, and records email failures without granting a role',async()=>{
 const {createOwnerInviteHandler}=await import('../supabase/functions/_shared/owner-invite-admin.ts');
 async function run(options={}){
  const calls=[];const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:options.denied?null:{active:true},error:options.ownerError?{}:null})};
  const service={from:()=>q,auth:{getUser:async()=>({data:{user:{id:'owner-fixture'}},error:options.badToken?{}:null}),admin:{inviteUserByEmail:async(email,opt)=>{calls.push({method:'invite',email,opt});return {data:{user:{id:'new-user'}},error:options.sendError?{code:'smtp_failed'}:null}}}},rpc:async(name,args)=>{calls.push({method:name,args});return name==='reserve_subscription_admin_invite'?{data:{email:args.p_email,send_token:'reservation',existing_user:options.existing,auth_user_id:options.existing?'existing-user':null},error:options.limited?{message:'انتظر دقيقة'}:null}:{data:!options.recordError,error:options.recordError?{}:null}}};
  const publicAuth={resetPasswordForEmail:async(email,opt)=>{calls.push({method:'recovery',email,opt});return {error:options.sendError?{}:null}}};
  const handler=createOwnerInviteHandler({allowedOrigin:'https://app.example.test',service,publicAuth});
  const response=await handler(new Request('https://function.example.test',{method:'POST',headers:{authorization:'Bearer fixture-session',origin:options.foreign?'https://foreign.example.test':'https://app.example.test'},body:JSON.stringify({email:options.invalid?'bad':' NEW@example.test ',name:'Name'})}));
  return {calls,status:response.status,body:await response.json()};
 }
 for(const options of [{denied:true},{badToken:true},{ownerError:true},{foreign:true},{invalid:true}]){const r=await run(options);assert.ok(r.status>=400);assert.equal(r.calls.some(c=>c.method==='invite'||c.method==='recovery'),false);}
 let r=await run();assert.equal(r.status,200);assert.equal(r.calls.find(c=>c.method==='invite').opt.redirectTo,'https://app.example.test/account-setup.html');assert.equal(r.calls.find(c=>c.method==='finish_subscription_admin_invite').args.p_success,true);assert.deepEqual(r.body,{ok:true,email:'new@example.test'});assert.doesNotMatch(JSON.stringify(r.body),/token|reservation|new-user/);
 r=await run({existing:true});assert.equal(r.status,200);assert.ok(r.calls.some(c=>c.method==='recovery'));assert.equal(r.calls.some(c=>c.method==='invite'),false);
 r=await run({sendError:true});assert.equal(r.status,502);assert.equal(r.calls.find(c=>c.method==='finish_subscription_admin_invite').args.p_success,false);
 r=await run({recordError:true});assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.body),/fixture-session/);
 r=await run({limited:true});assert.equal(r.status,429);assert.equal(r.calls.some(c=>c.method==='invite'),false);
});
