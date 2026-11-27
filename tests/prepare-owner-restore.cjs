/* Create two empty, isolated local databases. Never accept a remote destination. */
const {Client}=require('pg'),{bootstrap,id}=require('./database-fixture.cjs');
(async()=>{const url=new URL(process.env.OWNER_TEST_URL||'');if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Local isolated PostgreSQL required');const admin=new Client({connectionString:url.href});await admin.connect();try{
 for(const name of ['owner_restore_test','owner_stage_test']){if((await admin.query('select 1 from pg_database where datname=$1',[name])).rowCount)throw Error('Test database already exists; refuse to overwrite');await admin.query('create database '+name);}
 url.pathname='/owner_restore_test';const db=new Client({connectionString:url.href});await db.connect();try{
 const roles=new Set((await db.query("select rolname from pg_roles")).rows.map(x=>x.rolname));
 await bootstrap({exec:sql=>db.query(sql.replace(/create role (anon|authenticated|service_role)( bypassrls)?;/g,(m,r)=>roles.has(r)?'':m)),query:(s,a)=>db.query(s,a)});
 await db.query(`create table auth.identities(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,provider text);
  create table if not exists auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,created_at timestamptz default now());
  insert into auth.users(id,email,email_confirmed_at,encrypted_password) values
   ('${id(901)}','owner@example.test',now(),'owner-current'),
   ('${id(902)}','company@example.test',now(),'old-password'),
   ('${id(903)}','removed@example.test',now(),'removed-password');
  insert into subscription_owners(user_id)values('${id(901)}');
  insert into auth.identities values('${id(911)}','${id(901)}','email'),('${id(912)}','${id(902)}','email');
  insert into auth.sessions(id,user_id) values('${id(921)}','${id(901)}'),('${id(922)}','${id(902)}');
  insert into admins(email,name,perms)values('owner@example.test','Owner',null),('company@example.test','Company',null),('removed@example.test','Removed',null);
  insert into products(id,name,price)values('${id(1)}','Snapshot product',100);
  insert into captains(id,name,phone,email,active) values
   ('${id(11)}','Archive captain','555111','archive@example.test',true),
   ('${id(12)}','Snapshot current captain','555222','old-captain@example.test',true);
  insert into orders(id,customer_name,customer_phone,captain_id) values('${id(21)}','Snapshot customer','555333','${id(11)}');
  insert into captain_payments(id,captain_id,amount) values('${id(31)}','${id(11)}',10);`);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id(901),session_id:id(921),email:'owner@example.test',role:'authenticated',aal:'aal2'})]);
 await db.query("select save_subscription('2026-01-01','2027-12-31',1000,'USD',0)");
 if((await db.query("select to_regclass('public.order_submissions') as ledger")).rows[0].ledger) {
  await db.query(`insert into order_submissions(actor_id,request_id,fingerprint,order_id)
   values('${id(902)}','${id(931)}',decode('01','hex'),'${id(21)}')`);
 }
 }finally{await db.end();}
 }finally{await admin.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
