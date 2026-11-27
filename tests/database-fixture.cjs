/* Build the actual migration chain from an empty database. No substitute business functions or production calls. */
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const userId=email=>createHash('sha256').update(email).digest('hex').slice(0,32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
const claims=(email,uid=userId(email),options={})=>{
 const {aal='aal2',method='password',iat=Math.floor(Date.now()/1000),timestamp=iat,session=uid,role='authenticated'}=options;
 return JSON.stringify({email,sub:uid,role,aal,iat,session_id:session,amr:[{method,timestamp}]});
};
async function seedSession(db,uid,session=uid){
 await db.query('insert into auth.sessions(id,user_id) values($1,$2) on conflict do nothing',[session,uid]);
}
async function seedAccount(db,email,uid=userId(email)){
 await db.query("insert into auth.users(id,email,email_confirmed_at,encrypted_password) values($1,$2,now(),'fixture-password')",[uid,email]);
 await seedSession(db,uid);
}
async function bootstrap(db,{beforeMigration}={}){
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema extensions;create schema net;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,phone text);
 create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,created_at timestamptz not null default now(),not_after timestamptz,aal text not null default 'aal2');
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
 create table net.calls(id bigint generated always as identity,payload jsonb);
 create function net.http_post(url text,body jsonb,headers jsonb) returns bigint language plpgsql as $$begin insert into net.calls(payload) values(body);return 1::bigint;end$$;
 create publication supabase_realtime;`);
 for(const file of fs.readdirSync(path.join(root,'supabase/migrations')).sort()){
  await beforeMigration?.(file);
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8').replace(/create extension if not exists pg_net with schema extensions;/i,''));
 }
}
module.exports={bootstrap,id,claims,userId,seedAccount,seedSession};
