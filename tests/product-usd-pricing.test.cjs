const {test} = require('node:test');
const assert = require('node:assert/strict');
const {bootstrap, id, claims} = require('./database-fixture.cjs');

test('USD pricing reprices the catalogue and preserves existing order amounts', async () => {
  const {PGlite} = await import('@electric-sql/pglite');
  const db = new PGlite();
  const as = async email => {
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claims',$1,false)", [claims(email)]);
  };
  const rows = async (sql, args) => (await db.query(sql,args)).rows;
  const createOrder = async name => (await rows(
    "select create_order($2,'0900000000',null,null,$1::jsonb,null,null,null,'دمشق') as id",
    [JSON.stringify([{product_id:id(1), qty:2}]), name]
  ))[0].id;
  const amounts = order => rows(
    'select o.total, i.unit_price, i.list_price, c.capital from orders o join order_items i on i.order_id=o.id join order_item_capital c on c.item_id=i.id where o.id=$1',
    [order]
  );
  try {
    await bootstrap(db);
    await db.exec(`insert into admins(email,perms) values ('admin@test',null), ('staff@test',array['create_orders']);
      insert into products(id,name,price,cost) values ('${id(1)}','منتج',200,100), ('${id(2)}','منتج ثابت',500,300)`);
    await as('admin@test');
    await assert.rejects(db.query("select save_catalog_product($1,'منتج',null,100,2.35)",[id(1)]), /حدّد سعر صرف/);
    await db.query('select set_usd_exchange_rate(1000)');
    await db.query("select save_catalog_product($1,'منتج',null,100,2.35)",[id(1)]);
    const previous = await createOrder('طلب سابق');
    await db.query('select set_usd_exchange_rate(1250.5)');
    const next = await createOrder('طلب جديد');
    const prices = await rows('select id, price, price_usd, cost from admin_products() order by id');
    assert.deepEqual(prices.map(p => [Number(p.price), p.price_usd === null ? null : Number(p.price_usd), Number(p.cost)]),
      [[2938.68,2.35,100],[500,null,300]]);
    assert.deepEqual((await amounts(previous)).map(r => Object.values(r).map(Number)), [[4700,2350,2350,2350]]);
    assert.deepEqual((await amounts(next)).map(r => Object.values(r).map(Number)), [[5877.36,2938.68,2938.68,2938.68]]);
    await assert.rejects(db.query("select set_usd_exchange_rate('NaN')"), /أكبر من الصفر/);
    await assert.rejects(db.query("select set_usd_exchange_rate(100000000000)"), /overflow/);
    assert.deepEqual(await rows("select value from settings where key='usd_exchange_rate'"), [{value:'1250.5'}]);
    await as('staff@test');
    assert.deepEqual(await rows("select value from settings where key='usd_exchange_rate'"), []);
    assert.deepEqual(await rows('select price_usd from admin_products()'), []);
    await assert.rejects(db.query('select price_usd from products'), /permission denied/);
    await assert.rejects(db.query('select set_usd_exchange_rate(2000)'), /غير مسموح/);
    await assert.rejects(db.query("select save_catalog_product($1,'منتج',500,100,2)",[id(1)]), /غير مسموح/);
  } finally {
    await db.close();
  }
});
