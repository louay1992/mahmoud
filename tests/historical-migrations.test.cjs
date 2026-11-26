const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
test('restored historical migrations retain the original production journal text',()=>{
 const root=path.resolve(__dirname,'..'),history=JSON.parse(fs.readFileSync(path.join(root,'supabase/historical-migrations.json')));
 const versions=new Set();
 for(const entry of history.migrations){
  assert.equal(versions.has(entry.version),false,'historical versions must be unique');versions.add(entry.version);
  const name=entry.version+'_'+entry.name+'.sql',bytes=fs.readFileSync(path.join(root,'supabase/migrations',name));
  assert.equal(createHash('md5').update(bytes).digest('hex'),entry.md5,name+' differs from the recorded production statements; add a new migration rather than rewriting history');
 }
 assert.ok(history.migrations.some(x=>x.name==='delivery_captains_schema'),'fresh migrations must include the original base tables');
});
