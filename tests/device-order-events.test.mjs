import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createDeviceOrderEvents, mountDeviceOrderEvents, decodeOrderCursor } from '../device-order-events.js';

async function database() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE public.orders(id uuid PRIMARY KEY,external_id text,status text,order_type text,customer_id uuid,
    customer_name text,phone text,address text,comment text,total numeric,delivery_fee numeric,delivery_tariff_id uuid,
    delivery_tariff_name text,delivery_tariff_version int,created_at timestamptz,updated_at timestamptz,web_paid_at timestamptz);
    CREATE TABLE public.order_items(id uuid,order_id uuid,external_product_id text,product_name text,price numeric,quantity numeric,comment text,created_at timestamptz);`);
  for (let i=1;i<=13;i++) await db.query(`INSERT INTO public.orders(id,external_id,status,total,delivery_fee,created_at,updated_at)
    VALUES($1,$2,$3,10,0,$4,$4)`, [id(i),String(i),i===13?'new':i===12?'cancelled':'accepted',i<12?'2026-11-13T09:00:00.123456Z':'2026-11-13T09:00:00.123457Z']);
  return db;
}
function id(i) { return `00000000-0000-0000-0000-${String(i).padStart(12,'0')}`; }

test('history reads 5 at a time with exact microseconds/ties, while new rows arrive',async()=>{
  const db=await database();
  try {
    const calls=[];const service=createDeviceOrderEvents({query:(sql,args)=>{calls.push([sql,args]);return db.query(sql,args)}});
    const first=await service.history();assert.equal(first.orders.length,5);assert.ok(first.nextCursor);
    assert.equal(decodeOrderCursor(first.nextCursor).at,'2026-11-13T09:00:00.123456Z');
    await db.query(`INSERT INTO public.orders(id,status,created_at,updated_at) VALUES($1,'new','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z')`,[id(99)]);
    const second=await service.history({cursor:first.nextCursor,limit:'5'});assert.equal(second.orders.length,5);
    const third=await service.history({cursor:second.nextCursor});assert.equal(third.orders.length,3);assert.equal(third.nextCursor,null);
    const all=[...first.orders,...second.orders,...third.orders].map(x=>x.id);
    assert.equal(new Set(all).size,13);assert.deepEqual(all,Array.from({length:13},(_,n)=>id(13-n)));
    assert.ok(calls.every(([sql])=>!sql.includes('OFFSET') && sql.trim().startsWith('SELECT')));
    assert.ok(calls.every(([,args])=>args.at(-1)===6));
  } finally {await db.close()}
});

test('both devices see shared status changes; directory reads never change orders',async()=>{
  const db=await database();
  try {
    const a=createDeviceOrderEvents({query:(...args)=>db.query(...args)}),b=createDeviceOrderEvents({query:(...args)=>db.query(...args)});
    assert.deepEqual((await a.current()).orders.map(x=>x.id),[id(13)]);
    assert.deepEqual((await b.current()).orders.map(x=>x.id),[id(13)]);
    await db.query(`UPDATE public.orders SET status='accepted' WHERE id=$1`,[id(13)]);
    const before=(await db.query('SELECT * FROM public.orders ORDER BY id')).rows;
    assert.equal((await b.current()).orders.length,0);
    const page=await b.history();assert.equal(page.orders.find(x=>x.id===id(13)).status,'accepted');
    assert.ok(page.orders.some(x=>x.status==='cancelled'));
    assert.deepEqual((await db.query('SELECT * FROM public.orders ORDER BY id')).rows,before);
  } finally {await db.close()}
});

test('invalid cursors/limits never execute SQL and overlarge queues are never declared complete',async()=>{
  let calls=0;const service=createDeviceOrderEvents({query:async()=>{calls++;return {rows:[]}}});
  for(const input of [{limit:'0'},{limit:'51'},{limit:'1.5'},{limit:['5','6']},{cursor:'bad'},{cursor:'a'.repeat(513)},{cursor:Buffer.from(JSON.stringify({v:1,at:'2026-11-13T09:00:00.000001Z',id:"';DROP TABLE orders;--"})).toString('base64url')}])
    await assert.rejects(service.history(input),e=>e.status===400);
  assert.equal(calls,0);
  const huge=createDeviceOrderEvents({query:async()=>({rows:Array(1001).fill({})})});
  await assert.rejects(huge.current(),e=>e.status===409 && e.code==='CURRENT_QUEUE_TOO_LARGE');
});

test('both routes require an active device, hide database errors, and bypass no writes',async()=>{
  const routes=new Map();let queries=0;
  mountDeviceOrderEvents({get:(path,fn)=>routes.set(path,fn)},{query:async()=>{queries++;throw Error('private SQL password')},requireDevice:async(req,res)=>{if(!req.allowed){res.status(401).json({error:'Unauthorized'});return null}return {id:'device'}}});
  const response=()=>({code:200,headers:{},status(n){this.code=n;return this},json(v){this.value=v},setHeader(k,v){this.headers[k]=v}});
  for(const fn of routes.values()) {const res=response();await fn({query:{}},res);assert.equal(res.code,401)}
  assert.equal(queries,0);
  const res=response();await routes.get('/api/orders/history')({allowed:true,query:{}},res);
  assert.equal(res.code,503);assert.ok(!JSON.stringify(res.value).includes('private'));assert.equal(res.headers['Cache-Control'],'no-store');
});


test('history indexes migrate idempotently without changing order facts',async()=>{
  const db=await database();
  try {
    const before=(await db.query('SELECT * FROM public.orders ORDER BY id')).rows;
    const sql=readFileSync(new URL('../db/migrations/016_device_order_history.sql',import.meta.url),'utf8');
    await db.exec(sql);await db.exec(sql);
    const indexes=(await db.query("SELECT indexname FROM pg_indexes WHERE tablename='orders'")).rows.map(x=>x.indexname);
    assert.ok(indexes.includes('orders_device_history_page'));assert.ok(indexes.includes('orders_device_pending_page'));
    assert.deepEqual((await db.query('SELECT * FROM public.orders ORDER BY id')).rows,before);
  } finally {await db.close()}
});
