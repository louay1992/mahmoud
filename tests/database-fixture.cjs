/* Build the actual migration chain from an empty database. No substitute business functions or production calls. */
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const claims=(email)=>JSON.stringify({email,sub:id(900),role:'authenticated'});
async function bootstrap(db){
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema extensions;create schema net;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text);
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
 create table net.calls(id bigint generated always as identity,payload jsonb);
 create function net.http_post(url text,body jsonb,headers jsonb) returns bigint language plpgsql as $$begin insert into net.calls(payload) values(body);return 1::bigint;end$$;
 create publication supabase_realtime;`);
 for(const file of fs.readdirSync(path.join(root,'supabase/migrations')).sort())await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',file),'utf8').replace(/create extension if not exists pg_net with schema extensions;/i,''));
}
module.exports={bootstrap,id,claims};
