import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {createCustomerAccount} from '../customer-account.js';

test('current order stages, tablet estimates and the exact 30-minute boundary',async()=>{
 const c={};vm.runInNewContext(await readFile(new URL('../public/current-order-state.js',import.meta.url),'utf8'),c);
 const {describe,LIFETIME}=c.CurrentOrderState,changed='2026-11-13T15:00:00Z',base={status:'new',status_changed_at:changed,order_type:'Самовывоз'};
 assert.equal(describe(base).note,'Ожидаем подтверждение от заведения.');
 const accepted={...base,status:'accepted',ready_estimate:'at:18:45'};
 assert.equal(describe(accepted).note,'Будет готов к 18:45.');
 assert.equal(describe({...accepted,ready_estimate:'15m',accepted_at:changed}).note,'Будет готов примерно к 18:15.');
 assert.equal(describe({...accepted,ready_estimate:null}).note,'Ожидаем время готовности от заведения.');
 for(const status of ['ready','cancelled']){
  const order={...base,status};assert.equal(describe(order,Date.parse(changed)+LIFETIME-1).expired,false);assert.equal(describe(order,Date.parse(changed)+LIFETIME).expired,true);
 }
 assert.equal(describe({...base,status:'ready',order_type:'Доставка'}).stages[2],'Готов и передан в доставку');
 assert.equal(describe({...base,status:'preparing'}).step,1);
});

test('current orders are private, bounded and move into history without resetting their terminal clock',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec('CREATE ROLE mpos_app');const database=(await db.query('select current_database() as name')).rows[0].name;
  const dir=new URL('../db/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(n=>/^\d{3}_.+\.sql$/.test(n)).sort())await db.exec((await readFile(new URL(file,dir),'utf8')).replace('GRANT CONNECT ON DATABASE mpos TO mpos_app;',`GRANT CONNECT ON DATABASE "${database}" TO mpos_app;`));
  const q=db.query.bind(db),session='a'.repeat(43),guest='g'.repeat(43),phone='+375290000091',hash=s=>createHash('sha256').update(s).digest('hex');
  await q("INSERT INTO customer_account_sessions(token_hash,phone,telegram_user_id,expires_at) VALUES($1,$2,'123',now()+interval '1 day')",[hash(session),phone]);
  const own=(await q("INSERT INTO orders(phone,external_id) VALUES($1,'own') RETURNING id",[phone])).rows[0].id;
  const other=(await q("INSERT INTO orders(phone,external_id) VALUES('+375290000092','other') RETURNING id")).rows[0].id;
  await q("INSERT INTO checkout_sessions(token_hash,phone,status,order_payload,expires_at,order_id) VALUES($1,'+375290000092','ORDER_CREATED','{}',now()+interval '5 minutes',$2)",[hash(guest),other]);
  const account=createCustomerAccount({query:q});
  assert.deepEqual((await account.currentOrders('', '')).orders,[]);
  assert.equal((await account.currentOrders(session,guest)).orders[0].id,own);
  assert.equal((await account.currentOrders('',guest)).orders[0].id,other);
  assert.equal((await account.orders(session)).orders.length,0);
  let accept;
  const server=await readFile(new URL('../server.js',import.meta.url),'utf8');
  vm.runInNewContext(server.slice(server.indexOf('app.post("/api/orders/:id/accept"'),server.indexOf('app.patch("/api/orders/:id/status"')),{app:{post(path,fn){accept=fn}},requireDevice:async()=>true,query:q,console});
  const response=()=>({status(code){this.code=code;return this},json(body){this.body=body;return this}});
  const result=response();await accept({params:{id:own},body:{readyEstimate:'at:18:45'}},result);assert.equal(result.body.ok,true);
  const retry=response();await accept({params:{id:own},body:{readyEstimate:'15m'}},retry);assert.equal(retry.body.alreadyAccepted,true);
  let row=(await account.currentOrders(session)).orders[0];assert.equal(row.ready_estimate,'at:18:45');assert.ok(row.accepted_at);
  await q("UPDATE orders SET status='ready' WHERE id=$1",[own]);
  row=(await account.currentOrders(session)).orders[0];const finished=String(row.status_changed_at);
  await q("UPDATE orders SET status='ready',updated_at=now()+interval '2 hours' WHERE id=$1",[own]);
  assert.equal(String((await account.currentOrders(session)).orders[0].status_changed_at),finished);
  assert.equal((await account.orders(session)).orders.length,0);
  // Simulate elapsed server time without relying on the browser clock.
  await db.exec('ALTER TABLE orders DISABLE TRIGGER track_order_stage');
  await q("UPDATE orders SET status_changed_at=now()-interval '30 minutes' WHERE id=$1",[own]);
  await db.exec('ALTER TABLE orders ENABLE TRIGGER track_order_stage');
  assert.equal((await account.currentOrders(session)).orders.length,0);
  assert.equal((await account.orders(session)).orders[0].id,own);
  await q("UPDATE orders SET status='cancelled' WHERE id=$1",[other]);
  assert.equal((await account.currentOrders('',guest)).orders[0].status,'cancelled');
  for(let i=0;i<7;i++)await q("INSERT INTO orders(phone,external_id) VALUES($1,$2)",[phone,'new-'+i]);
  assert.equal((await account.currentOrders(session)).orders.length,5);
  await db.exec('SET ROLE mpos_app');assert.equal((await account.currentOrders(session)).orders.length,5);
 }finally{await db.close()}
});
