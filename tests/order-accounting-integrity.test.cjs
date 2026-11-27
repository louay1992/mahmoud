const {test}=require('node:test');
const assert=require('node:assert/strict');
const {bootstrap,id,claims,seedAccount,userId}=require('./database-fixture.cjs');

test('order accounting migration keeps edits, dispatch, warehouse assignments and statements consistent',async t=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const db=new PGlite();
  const admin='workflow-admin@example.test', captain='workflow-captain@example.test';
  const as=async email=>{
    await db.exec('reset role; set role authenticated');
    await db.query("select set_config('request.jwt.claims',$1,false)",[claims(email)]);
  };
  const rows=async(sql,params)=>(await db.query(sql,params)).rows;
  const one=async(sql,params)=>Object.values((await rows(sql,params))[0])[0];
  const items=(qty,unit_price)=>[{product_id:id(1),qty,unit_price}];
  const snapshot=order=>rows(`select o.items_total::text,o.list_total::text,o.total::text,o.price_adjust::text,
    i.id,i.unit_price::text,i.list_price::text,i.product_id
    from orders o join order_items i on i.order_id=o.id where o.id=$1`,[order]);
  try{
    await bootstrap(db);
    await seedAccount(db,admin);
    await seedAccount(db,captain);
    await db.exec(`
      insert into admins(email,auth_user_id) values('${admin}','${userId(admin)}');
      insert into products(id,name,price,cost) values('${id(1)}','Same name',75,60),('${id(9)}','Same name',90,30);
      update warehouses set is_main=false;
      insert into warehouses(id,name,is_main) values('${id(3)}','Main',true),('${id(4)}','Other',false);
      insert into stock(warehouse_id,product_id,qty) values('${id(3)}','${id(1)}',50);
      insert into captains(id,name,email,warehouse_id,delivery_fee,auth_user_id) values('${id(2)}','Captain','${captain}','${id(3)}',5,'${userId(captain)}');
      insert into carriers(id,name) values('${id(6)}','Company A'),('${id(7)}','Company B');`);
    await as(admin);
    const order=await one("select create_order('Synthetic order','0900000001',null,$1,$2::jsonb,null,null,null,null)",[id(2),JSON.stringify(items(3,100))]);
    await t.test('contact corrections preserve line identity, agreed prices and pending approval',async()=>{
      await as(captain);
      const first=await one("select request_price_change($1,300,'Agreed discount')",[order]);
      await as(admin);
      await db.query('select decide_price_request($1,true,null)',[first]);
      await as(captain);
      const second=await one("select request_price_change($1,295,'Further adjustment')",[order]);
      await as(admin);
      const original=await snapshot(order);
      await db.query('select edit_order($1,$2::jsonb,$3::jsonb)',[
        order,JSON.stringify({address:'Unit 2'}),JSON.stringify(items(3,original[0].unit_price))]);
      assert.deepEqual(await snapshot(order),original);
      assert.equal(await one('select customer_address from orders where id=$1',[order]),'Unit 2');
      assert.equal(await one('select status from price_requests where id=$1',[second]),'pending');
      await db.query('select edit_order($1,null,$2::jsonb)',[
        order,JSON.stringify([{...items(4,original[0].unit_price)[0],item_id:original[0].id}])]);
      const changed=(await snapshot(order))[0];
      assert.equal(changed.id,original[0].id);
      assert.equal(changed.product_id,id(1));
      assert.equal(changed.list_price,original[0].list_price);
      assert.equal(await one('select status from price_requests where id=$1',[second]),'rejected');
      assert.equal(await one("select jsonb_array_length(order_history($1))>1",[order]),true);
    });

    await t.test('the exact same form retry yields one ID, while a separate request yields another',async()=>{
      const payload=JSON.stringify({p_name:'Repeat customer',p_phone:'0900000004',p_items:items(1,80)});
      const create=key=>one("select submit_order($1,'delivery',$2::jsonb)",[key,payload]);
      const first=await create(id(21));
      assert.equal(await create(id(21)),first);
      assert.notEqual(await create(id(22)),first);
      assert.equal(Number(await one("select count(*) from orders where customer_name='Repeat customer'")),2);
    });

    await t.test('legacy and idempotent orders total the unit amounts actually stored',async()=>{
      const fractional=items(3,100.005);
      const legacy=await one(`select create_order('Legacy form','0900000005',null,null,$1::jsonb,null,null,null,null)`,
        [JSON.stringify(fractional)]);
      const current=await one(`select submit_order($1,'delivery',$2::jsonb)`,[id(23),JSON.stringify({
        p_name:'Current form',p_phone:'0900000006',p_items:fractional,
      })]);
      for(const orderId of [legacy,current]){
        const result=(await snapshot(orderId))[0];
        assert.equal(result.unit_price,'100.01');
        assert.equal(result.items_total,'300.03');
        assert.equal(result.total,'300.03');
      }
    });

    await t.test('closed carrier ledger stays stable and stale shipment transitions cannot restock',async()=>{
      const shipment=await one(`select create_shipment('Synthetic shipment','0900000002',null,$1::jsonb,'Address',
        null,null,'Damascus',$2,'A123',10,15,$3)`,[JSON.stringify(items(2,100)),id(6),id(3)]);
      await db.query("select set_shipment_status_checked($1,'handed',null,false,'preparing',false)",[shipment]);
      await assert.rejects(db.query("select set_shipment_status_checked($1,'cancelled',null,false,'preparing',false)",[shipment]),/تغيّرت حالة الشحنة/);
      assert.equal(await one('select stock_out from orders where id=$1',[shipment]),true);
      await db.query("select set_shipment_status_checked($1,'in_transit',null,false,'handed',true)",[shipment]);
      await db.query("select set_shipment_status_checked($1,'delivered',null,false,'in_transit',true)",[shipment]);
      await db.query("select add_carrier_payment($1,100,'Part payment')",[id(6)]);
      const before=await one('select carrier_balances()');
      await assert.rejects(db.query("select update_shipment($1,$2,'B123',null,null,null)",[shipment,id(7)]),/لا يمكن تغيير شركة/);
      await assert.rejects(db.query("select update_shipment($1,null,'A123',20,null,null)",[shipment]),/لا يمكن تعديل تكلفة/);
      await db.query("select update_shipment($1,null,'A124',null,null,null)",[shipment]);
      assert.deepEqual(await one('select carrier_balances()'),before);
      assert.equal(await one('select waybill from orders where id=$1',[shipment]),'A124');
    });

    await t.test('warehouse moves verify locations before touching warehouse or captain data',async()=>{
      const expected=JSON.stringify([{id:id(2),warehouse_id:id(3)}]);
      await db.query('select save_warehouse($1,$2,$3,$4,$5)',[id(4),'Central depot',['Damascus'],[id(2)],expected]);
      assert.equal(await one('select warehouse_id from captains where id=$1',[id(2)]),id(4));
      await assert.rejects(db.query('select save_warehouse($1,$2,$3,$4,$5)',[
        id(3),'Old screen rename',[],[id(2)],expected]),/تغيّر ربط الكباتن/);
      assert.equal(await one('select name from warehouses where id=$1',[id(3)]),'Main');
      assert.equal(await one('select warehouse_id from captains where id=$1',[id(2)]),id(4));
    });

    await t.test('captain statement details use stored owed amount and reconcile with the balance',async()=>{
      const delivered=await one(`select create_order('Second order','0900000003',null,$1,$2::jsonb,null,null,null,null)`,[id(2),JSON.stringify(items(1,140))]);
      await db.query('select transfer_stock($1,$2,$3,1,null)',[id(3),id(4),id(1)]);
      await db.query("update settings set value='list' where key='price_mode'");
      await db.query('select deliver_order($1,null)',[delivered]);
      await db.query('insert into captain_payments(captain_id,amount) values($1,20)',[id(2)]);
      await as(captain);
      const statement=await one('select captain_statement($1)',[id(2)]);
      assert.equal(statement.balance.balance,120);
      assert.equal(statement.orders[0].owed_amount,140);
      assert.equal(statement.payments[0].amount,20);
    });

    await t.test('every changed money table rejects nonfinite writes using a database constraint',async()=>{
      await as(admin);
      await assert.rejects(db.query('insert into captain_payments(captain_id,amount) values($1,$2)',[id(2),'NaN']),/captain_payments_finite_amount/);
      await assert.rejects(db.query('select update_shipment($1,null,null,$2,null,null)',[null,'Infinity']),/ليست شحنة/);
      assert.equal(Number(await one("select count(*) from pg_constraint where conname like '%finite_amount%' or conname='captains_finite_delivery_fee'")),9);
    });
  }finally{
    await db.close();
  }
});
