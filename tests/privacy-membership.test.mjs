import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {createCheckoutService} from '../checkout-service.js';
import {createPhoneVerificationService} from '../phone-verification.js';
import {createPrivacyService,validateLegalAcknowledgement} from '../privacy-service.js';
import {LEGAL_VERSION} from '../legal-documents.js';
import '../public/order-validation.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(){
 const db=new PGlite({extensions:{pgcrypto}});await db.exec('CREATE ROLE mpos_app;');const name=(await db.query('select current_database() as name')).rows[0].name;
 for(const file of ['001_baseline','002_owner_auth','003_runtime_defaults','004_delivery_tariffs','005_privacy_membership']){let sql=readFileSync(new URL('../db/migrations/'+file+'.sql',import.meta.url),'utf8');sql=sql.replace('GRANT CONNECT ON DATABASE mpos TO mpos_app;',`GRANT CONNECT ON DATABASE "${name}" TO mpos_app;`);await db.exec(sql);}
 await db.exec('SET ROLE mpos_app;');const query=(s,p)=>db.query(s,p);const phoneVerification=createPhoneVerificationService(query,globalThis.OrderValidation.normalizePhone);const checkout=createCheckoutService({query,normalizePhone:globalThis.OrderValidation.normalizePhone,validateOrderContact:globalThis.OrderValidation.validate,phoneVerification,validateLegal:validateLegalAcknowledgement});
 const device=(await query("insert into devices(device_key,name) values('privacy-test','Test') returning id")).rows[0].id;const product=(await query("insert into products(name,external_id,available_online,price) values('Test','test',true,3) returning id")).rows[0].id;await query('select public.store_availability_snapshot($1,1,now(),$2::jsonb,ARRAY[]::text[])',[device,JSON.stringify([{externalId:'test',quantity:100}])]);
 async function order(optIn,phone='+375290000001'){const x=await checkout.create({legal:{version:LEGAL_VERSION,acknowledged:true},loyaltyOptIn:optIn,customerName:'Test',phone,items:[{productId:product,quantity:1}]});assert.equal(x.status,'PENDING');const token=new URL(x.telegramUrl).searchParams.get('start');return {x,token,async confirm(){await phoneVerification.confirm(token,phone,'123');return checkout.finalizeByVerificationToken(token);}};}
 return {db,query,checkout,phoneVerification,privacy:createPrivacyService({query,phoneVerification,normalizePhone:globalThis.OrderValidation.normalizePhone}),order,product};
}
test('legal validation precedes all contact storage and requires an explicit boolean choice',async()=>{
 let reads=0;const checkout=createCheckoutService({query:async()=>{reads++;throw Error('unexpected')},validateLegal:validateLegalAcknowledgement});assert.equal((await checkout.create({phone:'+375290000001'})).code,'LEGAL_VERSION_REQUIRED');assert.equal(reads,0);assert.ok(validateLegalAcknowledgement({legal:{version:LEGAL_VERSION,acknowledged:true},loyaltyOptIn:'true'}));
});
test('actual PostgreSQL migration verifies consent, withdrawal, stale checkout, expiry and bounded retention under app role',async()=>{
 const f=await fixture();try{
  const unchecked=await f.order(false);const a=await unchecked.confirm();assert.equal(a.ok,true);assert.equal((await f.query('select public.loyalty_membership_active($1) as active',[a.customerId])).rows[0].active,false);
  const opted=await f.order(true);assert.equal((await f.query('select count(*)::int as n from loyalty_memberships')).rows[0].n,0);const b=await opted.confirm();const m=(await f.query('select * from loyalty_memberships')).rows[0];assert.equal(m.status,'active');
  const duplicate=await f.checkout.finalizeByVerificationToken(opted.token);assert.equal(duplicate.duplicate,true);assert.equal((await f.query("select count(*)::int as n from privacy_events where event_type='loyalty_consented'")).rows[0].n,1);
  const program=(await f.query("insert into loyalty_programs(name,required_quantity) values('Gift test',5) returning id")).rows[0].id;
  const seed=async(key)=>f.query("insert into loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key) values($1,$2,'MANUAL_ADJUSTMENT',2,1,$3)",[a.customerId,program,key]);
  const balance=async()=> (await f.query('select * from loyalty_balance($1,$2)',[a.customerId,program])).rows[0];
  await seed('before-withdraw');
  const pending=await f.order(true);const access=await f.privacy.access('+375290000001');assert.equal((await f.privacy.status(access.token)).verified,false);assert.equal((await f.privacy.withdraw(access.token)).status,403);const vt=new URL(access.telegramUrl).searchParams.get('start');await f.phoneVerification.confirm(vt,'+375290000001','123');assert.equal((await f.privacy.status(access.token)).active,true);assert.equal((await f.privacy.withdraw(access.token)).ok,true);assert.equal((await f.privacy.withdraw(access.token)).ok,true);assert.equal((await f.query("select count(*)::int as n from privacy_events where event_type='loyalty_withdrawn'")).rows[0].n,1);
  assert.deepEqual(await balance(),{progress:0,rewards:0});
  assert.equal((await f.query("select count(*)::int as n from loyalty_ledger where metadata->>'reason'='membership_terminated'")).rows[0].n,1);
  await pending.confirm();assert.equal((await f.query('select public.loyalty_membership_active($1) as active',[a.customerId])).rows[0].active,false);
  const fresh=await f.order(true);await fresh.confirm();assert.equal((await f.query('select public.loyalty_membership_active($1) as active',[a.customerId])).rows[0].active,true);
  await seed('before-expiry');
  await f.query("update loyalty_memberships set expires_at=now()-interval '1 day'");await f.privacy.maintain({apply:false});assert.equal((await f.query('select status from loyalty_memberships')).rows[0].status,'active');await f.privacy.maintain({apply:true});assert.equal((await f.query('select status from loyalty_memberships')).rows[0].status,'expired');
  assert.deepEqual(await balance(),{progress:0,rewards:0});
  assert.equal((await f.query('select count(*)::int as n from loyalty_ledger')).rows[0].n,4);
  await f.query("update checkout_sessions set expires_at=now()-interval '2 days'");const report=await f.privacy.maintain({apply:true});assert.equal(report.applied,true);assert.equal((await f.query('select count(*)::int as n from checkout_sessions')).rows[0].n,0);assert.equal((await f.query('select count(*)::int as n from orders')).rows[0].n,4);assert.equal((await f.query('select count(*)::int as n from legal_document_archive')).rows[0].n,4);
 }finally{await f.db.close();}
});

test('sale consent version, actual purchase time, refund after withdrawal and contact retirement preserve financial rows',async()=>{
 const f=await fixture();try{
  const pending=await f.order(true);const order=await pending.confirm();const customerId=order.customerId;
  const program=(await f.query("insert into loyalty_programs(name,required_quantity) values('Coffee',2) returning id")).rows[0].id;
  const version=(await f.query('select version from loyalty_memberships where customer_id=$1',[customerId])).rows[0].version;
  const purchaseTime=new Date(Date.now()+1000).toISOString();
  const sale=(key,earned,redeem,consent=version)=>f.query('select * from apply_loyalty_sale($1,$2,$3,$4,$5,$6,2,1,$7,$8::timestamptz)',[customerId,program,key,key,earned,redeem,consent,purchaseTime]);
  await assert.rejects(sale('wrong-version',1,0,Number(version)+1),/LOYALTY_CONSENT_REQUIRED/);
  const earned=(await sale('paid',2,0)).rows[0];assert.equal(earned.rewards,1);
  const expiry=(await f.query('select expires_at from loyalty_memberships')).rows[0].expires_at;
  assert.equal((await sale('paid',2,0)).rows[0].duplicate,true);
  assert.equal(String((await f.query('select expires_at from loyalty_memberships')).rows[0].expires_at),String(expiry));
  assert.equal((await sale('redeemed',0,1)).rows[0].rewards,0);
  const access=await f.privacy.access('+375290000001');await f.phoneVerification.confirm(new URL(access.telegramUrl).searchParams.get('start'),'+375290000001','123');await f.privacy.withdraw(access.token);
  await assert.rejects(sale('after-withdrawal',1,0),/LOYALTY_CONSENT_REQUIRED/);
  await assert.rejects(f.query('select * from apply_loyalty_sale($1,$2,$3,$4,1,0,2,1)',[customerId,program,'legacy','legacy']),/LOYALTY_CONSENT_REQUIRED/);
  await assert.rejects(f.query('select * from apply_loyalty_sale_internal($1,$2,$3,$4,1,0,2,1)',[customerId,program,'private','private']),/permission denied/);
  await f.query('select apply_single_reward_reversal($1,$2)',[customerId,'redeemed']);
  assert.deepEqual((await f.query('select * from loyalty_balance($1,$2)',[customerId,program])).rows[0],{progress:0,rewards:0});
  await f.query('select apply_single_reward_reversal($1,$2)',[customerId,'redeemed']);
  assert.deepEqual((await f.query('select * from loyalty_balance($1,$2)',[customerId,program])).rows[0],{progress:0,rewards:0});
  await assert.rejects(f.query("select * from apply_single_reward_adjustment($1,$2,1,0,'manual','{}'::jsonb)",[customerId,program]),/LOYALTY_CONSENT_REQUIRED/);
  const before=(await f.query('select total from orders where id=$1',[order.orderId])).rows[0].total;
  await f.query("update loyalty_memberships set revoked_at=now()-interval '15 days'");
  await f.privacy.maintain({apply:true});
  const customer=(await f.query('select * from customers where id=$1',[customerId])).rows[0];assert.equal(customer.normalized_phone,'retired:'+customerId);assert.equal(customer.telegram_user_id,null);
  await f.query("update orders set status='accepted',privacy_closed_at=now()-interval '31 days' where id=$1",[order.orderId]);
  await f.query("update checkout_sessions set expires_at=now()-interval '2 days'");
  await f.query('update privacy_retention_state set apply_order_contacts=true');
  await f.privacy.maintain({apply:true});
  const row=(await f.query('select * from orders where id=$1',[order.orderId])).rows[0];assert.equal(row.phone,null);assert.equal(row.customer_id,null);assert.equal(row.total,before);
  assert.ok((await f.query("select * from privacy_pos_tasks where task_type='redact_order' and order_id=$1",[order.orderId])).rows.length);
  assert.equal((await f.query('select count(*)::int as n from order_items where order_id=$1',[order.orderId])).rows[0].n,1);
 }finally{await f.db.close();}
});
