/* Read-only verification using the existing production DB secret. Never print connection details or business data. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Client}=require('pg');
const {bootstrap}=require('../tests/database-fixture.cjs');
const names=['subscription_is_current','subscription_access','enforce_subscription_request','get_subscription','is_admin','has_perm','my_captain_id','native_push_targets','web_push_targets'];
const metadata=`select p.proname as name,pg_get_function_identity_arguments(p.oid) as args,md5(p.prosrc) as body_md5,p.prosecdef as security_definer,p.proconfig as config from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1::text[]) order by p.proname`;
async function main(){
 const uri=(process.env.SUPABASE_DB_URL||'').trim(),match=uri.match(/^(?:postgresql|postgres):\/\/([^:]+):(.+)@([a-z0-9.-]+)(?::5432)?\/postgres(?:[?]sslmode=(?:require|verify-ca|verify-full))?$/);
 if(!match)throw Error('Missing or invalid production connection setting');
 const [,encodedUser,encodedPassword,host]=match,user=decodeURIComponent(encodedUser),password=decodeURIComponent(encodedPassword),project='jabapvnmfdflysxfxwwf';
 assert.ok(host===`db.${project}.supabase.co`&&user==='postgres'||host.endsWith('.pooler.supabase.com')&&user===`postgres.${project}`,'Unexpected database destination');
 const connectionOptions={host,port:5432,database:'postgres',user,password,ssl:{ca:fs.readFileSync(path.join(__dirname,'backup/supabase-prod-ca.crt'),'utf8'),rejectUnauthorized:true},connectionTimeoutMillis:15000,statement_timeout:15000};
 let client=new Client(connectionOptions);
 const {PGlite}=await import('@electric-sql/pglite'),expected=new PGlite();
 try{
  await bootstrap(expected);
  try{await client.connect();}catch(error){
   if(error.code!=='28P01'||!encodedPassword.startsWith('[')||!encodedPassword.endsWith(']'))throw error;
   await client.end();client=new Client({...connectionOptions,password:password.slice(1,-1)});await client.connect();
  }
  await client.query('set default_transaction_read_only=on');
  const file='20261127164402_enforce_subscription_expiry.sql',version=file.split('_')[0],source=fs.readFileSync(path.join(__dirname,'../supabase/migrations',file),'utf8');
  let record;
  for(let attempt=0;attempt<36;attempt++){
   const result=await client.query('select name,statements from supabase_migrations.schema_migrations where version=$1',[version]);record=result.rows[0];if(record)break;
   if(attempt<35)await new Promise(resolve=>setTimeout(resolve,5000));
  }
  assert.ok(record,'The Supabase deployment has not recorded the subscription migration');assert.equal(record.name,'enforce_subscription_expiry');
  const canonical=text=>text.replace(/--[^\n]*/g,'').replace(/[\s;]/g,'');
  assert.equal(canonical(record.statements.join('\n')),canonical(source),'Live migration statements differ from source');
  const liveFunctions=(await client.query(metadata,[names])).rows,expectedFunctions=(await expected.query(metadata,[names])).rows;
  assert.deepEqual(liveFunctions,expectedFunctions,'Deployed function bodies/security settings differ from source');
  const missing=(await client.query("select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and c.relrowsecurity and ((n.nspname='public' and c.relname not in ('subscription_owners','project_subscription','subscription_changes','subscription_admin_invites')) or (n.nspname='storage' and c.relname='objects')) and not exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='subscription_required' and not p.polpermissive)")).rows;
  assert.deepEqual(missing,[],'Some business tables lack the restrictive expiry policy');
  const settings=(await client.query("select rolconfig from pg_roles where rolname='authenticator'")).rows[0].rolconfig;assert.ok(settings.includes('pgrst.db_pre_request=public.enforce_subscription_request'));
  const journal=(await client.query("select version,name,md5(array_to_string(statements,'')) as statements_md5 from supabase_migrations.schema_migrations order by version")).rows;
  const report={sourceCommit:process.env.GITHUB_SHA,migration:version,migrationSourceSHA256:require('node:crypto').createHash('sha256').update(source).digest('hex'),migrationStatementsMatch:true,functions:liveFunctions,missingRestrictivePolicies:missing,preRequestHookMatches:true,migrationJournal:journal};
  fs.mkdirSync('artifacts/verification',{recursive:true});fs.writeFileSync('artifacts/verification/subscription-production.json',JSON.stringify(report,null,2)+'\n');
  console.log('Verified production migration text, nine function bodies/security settings, restrictive policies and the API request hook. No production business data was changed.');
 }finally{await client.end();await expected.close();}
}
main().catch(error=>{console.error('Production subscription verification failed:',String(error.code||error.message).slice(0,180));process.exitCode=1;});
