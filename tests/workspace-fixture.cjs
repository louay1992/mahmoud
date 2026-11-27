/* Synthetic data only. Every external request is blocked by the browser test. */
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),{execFileSync}=require('node:child_process');
const baseline=execFileSync('git',['show','21c4fb8176febdf26e69cd88321ab12457c62854:admin.html'],{encoding:'utf8'});
async function serve(){const root=process.cwd(),server=http.createServer(async(req,res)=>{try{const name=new URL(req.url,'http://localhost').pathname;if(name==='/before.html'){res.setHeader('content-type','text/html');return res.end(baseline);}const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep))throw Error();res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(file));}catch(_){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,origin:'http://127.0.0.1:'+server.address().port};}
async function route(context,origin){await context.route('**/*',r=>r.request().url().match(/cdn\.jsdelivr\.net|\/vendor\/supabase\.js/)?r.fulfill({contentType:'application/javascript',body:'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};'}):r.request().url().startsWith(origin+'/')?r.continue():r.abort());}
async function populate(page,screen='stock'){
 await page.waitForFunction(()=>document.getElementById("splash")?.classList.contains("off"));
 await page.evaluate(screen=>{
  const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'),today=dayK(new Date())+'T09:00:00Z';
if(typeof TABS!=='undefined'&&!TABS.some(t=>t[0]==='subscription'))TABS.splice(TABS.length-1,0,['subscription','إدارة الاشتراك','wallet']);
  D.settings={business_name:'الصحة والجمال',currency:'ل.س',low_stock:'3',price_mode:'actual'};CUR='ل.س';
  D.products=Array.from({length:65},(_,i)=>({id:id(i+1),name:i===0?'مجموعة العناية اليومية للبشرة الحساسة — إصدار خاص طويل الاسم':i===1?'سيروم فيتامين سي':'منتج العناية '+(i+1),price:25000+i*1000,cost:15000+i*700,active:i%9!==8}));
  D.warehouses=[{id:id(101),name:'المستودع الرئيسي',is_main:true,governorates:['دمشق','ريف دمشق']},{id:id(102),name:'مستودع حلب',is_main:false,governorates:['حلب']}];
  D.stock=D.products.flatMap((p,i)=>[{warehouse_id:id(101),product_id:p.id,qty:i%7===0?0:i%7===1?2:20+i},{warehouse_id:id(102),product_id:p.id,qty:i%5===0?0:8}]);
  D.captains=Array.from({length:35},(_,i)=>({id:id(201+i),name:i===0?'أحمد محمد عبد الرحمن خالد — الكابتن الرئيسي':'كابتن '+(i+1),phone:'09440000'+String(i).padStart(2,'0'),active:i%6!==5,warehouse_id:i%2?id(102):id(101),delivery_fee:5000}));
  D.marketers=Array.from({length:36},(_,i)=>({id:id(301+i),name:i===0?'نور الهدى محمود — مسوّقة المنتجات والعناية بالبشرة':'مسوّقة '+(i+1),phone:i%3?'09441100'+String(i).padStart(2,'0'):null,governorate:i%2?'حلب':'دمشق',active:i%7!==6}));
  D.balances=D.captains.map((c,i)=>({captain_id:c.id,delivered_count:i+4,delivered_total:100000+i*15000,paid_total:50000,balance:50000+i*15000}));
  D.mbal=D.marketers.map((m,i)=>({marketer_id:m.id,name:m.name,earned:150000+i*10000,paid:50000,balance:100000+i*10000,pending:i%2?15000:0,delivered_count:i+2}));
  const base={fulfillment:'delivery',customer_name:'سارة أحمد الرفاعي',customer_phone:'0944123456',customer_address:'المزة، شارع الفيلات، بجانب الصيدلية',governorate:'دمشق',captain_id:id(201),marketer_id:id(301),total:55000,items_total:50000,list_total:50000,delivery_fee:5000,created_at:today,status_at:today,order_items:[{id:id(999),qty:2,unit_price:25000,list_price:25000,products:{name:D.products[0].name}}]};
  D.orders=Array.from({length:80},(_,i)=>({...base,id:id(401+i),order_no:1041+i,status:['new','in_delivery','no_answer','delivered','returned','cancelled'][i%6],delivered_at:i%6===3?today:null}));
  D.mpay=[{id:id(501),marketer_id:id(301),amount:50000,note:'دفعة أرباح',created_at:today}];D.payments=[{id:id(502),captain_id:id(201),amount:50000,note:'تحصيل',created_at:today}];
  D.prof={};D.ev={};D.prs=[];D.pr={};D.notifs=[];D.admins=[];D.carriers=[{id:id(601),name:'قدموس',active:true,phone:'0944333333'}];D.stats={delivered_today:12,sales_today:600000,owed_total:1500000,low_stock:[{product:D.products[1].name,warehouse:'المستودع الرئيسي',qty:2}]};
  window.fixtures={calls:[],fail:false,hold:false,writeError:null,created:id(900),delay:0};
  const invoices=Array.from({length:68},(_,i)=>({id:id(700+i),warehouse_id:id(101),created_at:today,note:'فاتورة المورّد '+(i+1),deducted_from_main:i%2===0,stock_invoice_items:[{qty:10,products:{name:D.products[i%65].name}}]}));
  const movements=Array.from({length:68},(_,i)=>({id:id(800+i),warehouse_id:id(101),product_id:D.products[i%65].id,qty:i%2?-2:10,kind:['invoice','sale','return','adjust','transfer_in','transfer_out'][i%6],created_at:today,created_by:'admin@example.test',note:'حركة تجريبية '+(i+1),products:{name:D.products[i%65].name},order_id:i%2?id(401):null}));
  const profitItems=D.orders.map((o,i)=>({order_id:o.id,order_no:o.order_no,status:o.status,created_at:today,delivered_at:o.delivered_at,first_item:true,fulfillment:i===4?'shipping':'delivery',shipping_cost:i===4?7000:0,product_id:D.products[i%65].id,product_name:D.products[i%65].name,captain_id:o.captain_id,marketer_id:o.marketer_id,governorate:o.governorate,qty:2,unit_price:25000,capital:22000,cost:15000,delivery_fee:5000}));
  fixtures.tables={stock_invoices:invoices,stock_movements:movements,orders:D.orders,stock:D.stock.map(s=>({...s,products:{name:pname(s.product_id)}})),order_profits:D.orders.map(o=>({order_id:o.id,capital:44000,profit:6000})),captains:D.captains,warehouses:D.warehouses,marketers:D.marketers,marketer_balances:D.mbal,captain_balances:D.balances,marketer_payments:D.mpay,captain_payments:D.payments,settings:Object.entries(D.settings).map(([key,value])=>({key,value})),carriers:D.carriers,notifications:[],price_requests:[],order_events:[],admins:[]};
  fixtures.profit=profitItems;
  sb.from=table=>{
   const filters=[],call={table,filters,range:null};let single=false,signal,limit=Infinity;const query={select:()=>query,eq:(k,v)=>{filters.push(['eq',k,v]);return query;},ilike:(k,v)=>{filters.push(['ilike',k,v]);return query;},gte:(k,v)=>{filters.push(['gte',k,v]);return query;},lt:(k,v)=>{filters.push(['lt',k,v]);return query;},order:()=>query,limit:n=>{limit=n;return query;},range:(a,b)=>{call.range=[a,b];return query;},abortSignal:s=>{signal=s;return query;},maybeSingle:()=>{single=true;return query;},insert:()=>query,update:()=>query,delete:()=>query,
    then:(resolve,reject)=>{fixtures.calls.push(call);return new Promise(done=>setTimeout(done,fixtures.delay)).then(()=>{if(signal?.aborted)return {data:null,error:{message:'aborted'}};if(fixtures.fail||(fixtures.paymentFail&&table==='carrier_payments'))return {data:null,error:{message:'fixture offline'}};let rows=[...(fixtures.tables[table]||[])];for(const [op,k,v]of filters)rows=rows.filter(r=>op==='eq'?r[k]===v:op==='ilike'?String(r[k]||'').includes(v.replaceAll('%','')):op==='gte'?r[k]>=v:r[k]<v);if(call.range)rows=rows.slice(call.range[0],call.range[1]+1);rows=rows.slice(0,limit);return {data:single?rows[0]||null:rows,error:null};}).then(resolve,reject);}
   };return query;
  };
  sb.rpc=(name,args)=>{
   fixtures.calls.push({rpc:name,args});let signal, range;const query={order:()=>query,range:(from,to)=>{range=[from,to];return query;},abortSignal:s=>{signal=s;return query;},then:(resolve,reject)=>{
    const isWrite=name==='submit_order';if(isWrite&&fixtures.hold)return new Promise(done=>{fixtures.complete=done;signal?.addEventListener('abort',()=>done({data:null,error:{message:'aborted'}}),{once:true});}).then(resolve,reject);
    return Promise.resolve({data:name==='working_orders'?fixtures.tables.orders:name==='carrier_balances'?[]:name==='admin_profit_items'?(range?profitItems.slice(range[0],range[1]+1):profitItems):name==='admin_products'?D.products:name==='dashboard_stats'?D.stats:isWrite?fixtures.created:[],error:isWrite?fixtures.writeError:null}).then(resolve,reject);
   }};return query;
  };
  sb.auth.getSession=async()=>({data:{session:{user:{email:'admin@example.test'},access_token:'fixture-only'}}});
  ACC={role:'full'};ME='admin@example.test';$('hn').textContent='الصحة والجمال';$('login').style.display='none';$('app').style.display='block';hideSplash();renderNav();go(screen);
 },screen);
 await page.locator('#splash').waitFor({state:'hidden'});
}
module.exports={serve,route,populate};
