import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {createCheckoutService} from '../checkout-service.js';
import {createCustomerAccount} from '../customer-account.js';
import {createPhoneVerificationService} from '../phone-verification.js';
import {validateLegalAcknowledgement} from '../privacy-service.js';
import {LEGAL_VERSION} from '../legal-documents.js';
import '../public/order-validation.js';
import {applyLoyaltyReceipt} from '../loyalty-sales.js';
import {validateLoyaltyAllocation} from '../loyalty-allocation.js';

test('receipt earns once across both Android messages, excludes free gifts, and restores cancellation',async()=>{
 const db=new PGlite({extensions:{pgcrypto}});
 try{
  await db.exec('CREATE ROLE mpos_app');const name=(await db.query('SELECT current_database() AS n')).rows[0].n;
  for(const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(x=>/^\d{3}_.*sql$/.test(x)).sort())await db.exec((await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8')).replace('GRANT CONNECT ON DATABASE mpos TO mpos_app;',`GRANT CONNECT ON DATABASE "${name}" TO mpos_app;`));
  await db.exec('SET ROLE mpos_app');const query=db.query.bind(db),withTransaction=async fn=>{await query('BEGIN');try{const result=await fn({query});await query('COMMIT');return result;}catch(e){await query('ROLLBACK');throw e;}};
  const device=(await query("INSERT INTO devices(name,device_key) VALUES('Test','web-gift-test') RETURNING id")).rows[0].id;
  const product=async(name,price)=>(await query('INSERT INTO products(name,external_id,price,available_online) VALUES($1,$1,$2,true) RETURNING *',[name,price])).rows[0];
  const cheap=await product('cheap',3),expensive=await product('expensive',7);
  const p=(await query("INSERT INTO loyalty_programs(name,required_quantity) VALUES('Test gift',5) RETURNING id")).rows[0].id;
  for(const t of ['loyalty_earning_products','loyalty_reward_products'])for(const x of [cheap,expensive])await query(`INSERT INTO ${t}(program_id,product_id) VALUES($1,$2)`,[p,x.external_id]);
  let revision=0;const snapshot=ids=>query('SELECT public.store_availability_snapshot($1,$2,now(),$3::jsonb,$4::text[]) AS applied',[device,++revision,JSON.stringify([{externalId:cheap.external_id,quantity:100},{externalId:expensive.external_id,quantity:100}]),ids]);await snapshot([]);
  const phone='+375290000001',session='a'.repeat(43);await query("INSERT INTO customer_account_sessions(token_hash,phone,telegram_user_id,expires_at) VALUES($1,$2,'123456',now()+interval '90 days')",[createHash('sha256').update(session).digest('hex'),phone]);
  const {normalizePhone,validate:validateOrderContact}=globalThis.OrderValidation,account=createCustomerAccount({query,withTransaction,normalizePhone}),verification=createPhoneVerificationService(query,normalizePhone);
  const checkout=createCheckoutService({query,withTransaction,normalizePhone,validateOrderContact,phoneVerification:verification,resolveAccount:account.identity,validateLegal:validateLegalAcknowledgement,manualDelivery:true,autoEnroll:true});
  const payload=()=>({customerName:'Test',phone,legal:{version:LEGAL_VERSION,acknowledged:true},requestId:randomUUID(),items:[{productId:cheap.id,quantity:1},{productId:expensive.id,quantity:1}]});
  const receipt=async(oid,items)=>{
    const order=(await query('SELECT customer_id FROM orders WHERE id=$1',[oid])).rows[0];
    const membership=(await query('SELECT version FROM loyalty_memberships WHERE customer_id=$1',[order.customer_id])).rows[0];
    const programs=[{id:p,required_quantity:5,reward_quantity:1,loyalty_earning_products:[{product_id:'cheap'},{product_id:'expensive'}]}];
    const allocation=validateLoyaltyAllocation({items,programs});
    return withTransaction(client=>applyLoyaltyReceipt({query:client.query,customerId:order.customer_id,orderId:'receipt-'+oid,programs,allocation,membership,occurredAt:new Date().toISOString()}));
  };
  const first=await checkout.create(payload(),session);assert.equal(first.status,'ORDER_CREATED');assert.equal((await account.current(session)).membership_active,true);
  assert.equal((await account.current(session)).programs[0].progress,0);await snapshot([first.orderId]);assert.equal((await account.current(session)).programs[0].progress,0);const firstItems=[{productId:'cheap',quantity:1,unitPrice:3}];await receipt(first.orderId,firstItems);assert.equal((await account.current(session)).programs[0].progress,1);await snapshot([first.orderId]);assert.equal((await receipt(first.orderId,firstItems))[0].duplicate,true);assert.equal((await account.current(session)).programs[0].progress,1);
  await query("INSERT INTO loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key) VALUES($1,$2,'MANUAL_ADJUSTMENT',-1,1,'seed-reward')",[(await account.current(session)).customer_id,p]);
  const data={...payload(),items:[{productId:cheap.id,quantity:2},{productId:expensive.id,quantity:1}],orderType:'Доставка',address:'ул. Тестовая, 1',giftProgramIds:[p]};const order=await checkout.create(data,session);assert.equal(order.status,'ORDER_CREATED');assert.equal((await checkout.create(data,session)).duplicate,true);
  const stored=(await query('SELECT * FROM orders WHERE id=$1',[order.orderId])).rows[0];assert.equal(Number(stored.total),10);assert.equal(Number(stored.discount_total),3);assert.equal(stored.delivery_fee_pending,true);
  const free=(await query('SELECT * FROM order_items WHERE order_id=$1 AND is_loyalty_reward',[order.orderId])).rows[0];assert.equal(free.product_id,cheap.id);assert.equal(Number(free.price),0);
  assert.equal((await account.current(session)).programs[0].rewards,0);const competing=await checkout.create({...payload(),giftProgramIds:[p]},session);assert.equal(competing.status,409);assert.equal((await query('SELECT count(*)::int AS n FROM orders')).rows[0].n,2);const paidItems=[{productId:'cheap',quantity:1,unitPrice:3},{productId:'cheap',quantity:1,unitPrice:0},{productId:'expensive',quantity:1,unitPrice:7}];await receipt(order.orderId,paidItems);await snapshot([order.orderId]);assert.equal((await receipt(order.orderId,paidItems))[0].duplicate,true);assert.equal((await account.current(session)).programs[0].progress,2);
  await query('SELECT public.apply_single_reward_reversal($1,$2)',[(await account.current(session)).customer_id,'receipt-'+order.orderId]);
  await query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.orderId]);const restored=(await account.current(session)).programs[0];assert.equal(restored.rewards,1);assert.equal(restored.progress,0);
  const count=(await query('SELECT count(*)::int AS n FROM loyalty_ledger')).rows[0].n;await query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.orderId]);await snapshot([order.orderId]);assert.equal((await query('SELECT count(*)::int AS n FROM loyalty_ledger')).rows[0].n,count);
  const rejected=await checkout.create({...payload(),giftProgramIds:[p],items:[{productId:cheap.id,quantity:0.5}]},session);assert.equal(rejected.status,409);
  const sessionExpired=await checkout.create(payload(),'z'.repeat(43));assert.equal(sessionExpired.status,401);
  const mismatch=await checkout.create({...payload(),phone:'+375290000002'},session);assert.equal(mismatch.status,400);
  // Withdrawn customers rejoin on every genuinely new order; duplicate requests do not re-enroll.
  const cid=(await account.current(session)).customer_id;await query("UPDATE loyalty_memberships SET status='withdrawn',revoked_at=now()-interval '1 second' WHERE customer_id=$1",[cid]);
  const rejoined=await checkout.create(payload(),session);assert.equal(rejoined.status,'ORDER_CREATED');assert.equal((await account.current(session)).membership_active,true);
  // Guests are also enrolled, even when an outdated browser sends false.
  const guestData={...payload(),phone:'+375290000002',loyaltyOptIn:false};const guest=await checkout.create(guestData);
  assert.equal(guest.status,'PENDING');const vt=new URL(guest.telegramUrl).searchParams.get('start');await verification.confirm(vt,guestData.phone,'123457');const guestOrder=await checkout.finalizeByVerificationToken(vt);assert.equal(guestOrder.ok,true);
  assert.equal((await query('SELECT public.loyalty_membership_active($1) AS active',[guestOrder.customerId])).rows[0].active,true);
  assert.equal(Number((await query('SELECT progress FROM public.loyalty_balance($1,$2)',[guestOrder.customerId,p])).rows[0].progress),0);await snapshot([guestOrder.orderId]);await receipt(guestOrder.orderId,[{productId:'cheap',quantity:1,unitPrice:3},{productId:'expensive',quantity:1,unitPrice:7}]);assert.equal(Number((await query('SELECT progress FROM public.loyalty_balance($1,$2)',[guestOrder.customerId,p])).rows[0].progress),2);
  // Cursor history is bounded, stable on equal timestamps, and isolated by verified phone.
  for(let i=0;i<9;i++)await query('INSERT INTO orders(phone,external_id) VALUES($1,$2)',[phone,'page-'+i]);
  let cursor=null,ids=[];do{const page=await account.orders(session,cursor);assert.ok(page.orders.length<=5);ids.push(...page.orders.map(x=>x.id));cursor=page.nextCursor;}while(cursor);assert.equal(new Set(ids).size,ids.length);assert.equal(ids.length,12);
 }finally{await db.close();}
});
