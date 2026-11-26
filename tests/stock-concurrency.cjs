/* Run only against a disposable, empty PostgreSQL database supplied in PG_TEST_URL. */
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {bootstrap,id,claims}=require('./database-fixture.cjs');
(async()=>{
 if(!process.env.PG_TEST_URL)throw Error('PG_TEST_URL must identify a disposable, empty test database');
 const main=new Client({connectionString:process.env.PG_TEST_URL}),a=new Client({connectionString:process.env.PG_TEST_URL}),b=new Client({connectionString:process.env.PG_TEST_URL});
 try{
  await main.connect();
  assert.equal((await main.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n,0,'refuse to change a nonempty database');
  await bootstrap({exec:sql=>main.query(sql),query:(sql,args)=>main.query(sql,args)});
  await main.query("select set_config('request.jwt.claims',$1,false)",[claims('boss@test')]);
  await main.query(`insert into admins values('boss@test',null,null);update warehouses set is_main=false;
   insert into products(id,name,price,cost) values('${id(1)}','concurrency',100,50);
   insert into warehouses(id,name,is_main) values('${id(3)}','source',true),('${id(4)}','target',false);
   insert into captains(id,name,email,warehouse_id)values('${id(2)}','captain','captain@test','${id(3)}');
   insert into stock values('${id(3)}','${id(1)}',10),('${id(4)}','${id(1)}',10);`);
  const create=async(name)=>(await main.query('select create_order($1,$2,null,$3,$4::jsonb,null,null,null,null) id',[name,name,id(2),JSON.stringify([{product_id:id(1),qty:7}])])).rows[0].id;
  const orders=[await create('race-one'),await create('race-two')];
  await Promise.all([a.connect(),b.connect()]);
  for(const client of [a,b]){await client.query('set role authenticated');await client.query("select set_config('request.jwt.claims',$1,false)",[claims('captain@test')]);}
  const transaction=async(client,sql,args)=>{await client.query('begin');try{const result=await client.query(sql,args);await client.query('commit');return result;}catch(error){await client.query('rollback');throw error;}};
  const results=await Promise.allSettled([transaction(a,'select deliver_order($1,null)',[orders[0]]),transaction(b,'select deliver_order($1,null)',[orders[1]])]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1,'only one order can spend the shared stock');
  assert.match(results.find(x=>x.status==='rejected').reason.message,/غير متوفر/,'loser must recheck stock after acquiring the shared lock');
  assert.equal((await main.query('select qty from stock where warehouse_id=$1',[id(3)])).rows[0].qty,3);
  for(const client of [a,b])await client.query("select set_config('request.jwt.claims',$1,false)",[claims('boss@test')]);
  await main.query('update stock set qty=10');
  await Promise.all([transaction(a,'select transfer_stock($1,$2,$3,7,null)',[id(3),id(4),id(1)]),transaction(b,'select transfer_stock($1,$2,$3,7,null)',[id(4),id(3),id(1)])]);
  assert.deepEqual((await main.query('select qty from stock order by warehouse_id')).rows.map(x=>x.qty),[10,10]);
  console.log('Real PostgreSQL: competing deliveries spend stock once; opposing transfers finish without a deadlock; totals are conserved.');
 }finally{await Promise.allSettled([a.end(),b.end(),main.end()]);}
})().catch(error=>{console.error(error);process.exitCode=1;});
