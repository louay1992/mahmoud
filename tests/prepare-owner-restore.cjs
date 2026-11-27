/* Create two empty, isolated local databases. Never accept a remote destination. */
const {Client}=require('pg'),{bootstrap,id}=require('./database-fixture.cjs');
(async()=>{const url=new URL(process.env.OWNER_TEST_URL||'');if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Local isolated PostgreSQL required');const admin=new Client({connectionString:url.href});await admin.connect();try{
 for(const name of ['owner_restore_test','owner_stage_test']){if((await admin.query('select 1 from pg_database where datname=$1',[name])).rowCount)throw Error('Test database already exists; refuse to overwrite');await admin.query('create database '+name);}
 url.pathname='/owner_restore_test';const db=new Client({connectionString:url.href});await db.connect();try{
 const roles=new Set((await db.query("select rolname from pg_roles")).rows.map(x=>x.rolname));
 await bootstrap({exec:sql=>db.query(sql.replace(/create role (anon|authenticated|service_role)( bypassrls)?;/g,(m,r)=>roles.has(r)?'':m)),query:(s,a)=>db.query(s,a)});
 await db.query('create table auth.identities(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,provider text);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id) on delete cascade)');
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id(901),email:'owner@example.test',role:'authenticated'})]);
 await db.query(`insert into auth.users values('${id(901)}','owner@example.test',now(),'owner-current'),('${id(902)}','company@example.test',now(),'old-password');insert into subscription_owners(user_id)values('${id(901)}');insert into admins(email,name,perms)values('owner@example.test','Owner',null),('company@example.test','Company',null);insert into auth.identities values('${id(911)}','${id(901)}','email'),('${id(912)}','${id(902)}','email');insert into auth.sessions values('${id(921)}','${id(901)}'),('${id(922)}','${id(902)}');insert into products(id,name,price)values('${id(1)}','Snapshot product',100);select save_subscription('2026-01-01','2027-12-31',1000,'USD',0);`);
 }finally{await db.end();}
 }finally{await admin.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
