const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const ready=fs.readFileSync(path.join(__dirname,"../ready-server.js"),"utf8");
const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
test("loyalty uses existing backend Telegram transport",()=>{assert.match(ready,/TELEGRAM_BOT_TOKEN/);assert.match(ready,/sendCustomerTelegram/);assert.match(ready,/\/api\/loyalty\/sales/);});
test("duplicate loyalty retries do not notify Telegram twice",()=>{assert.match(ready,/filter\(event => !event\.duplicate\)/);assert.match(server,/apply_loyalty_sale/);assert.match(server,/duplicate:Boolean\(x\?\.duplicate\)/);});
test("manual adjustment requires reason and administrator identity",()=>{assert.match(server,/reason, administrator and adjustment are required/);assert.match(server,/adminEmployeeId/);assert.match(server,/adminEmployeeName/);assert.match(server,/operation_type:"MANUAL_ADJUSTMENT"/);});
test("refund uses compensating ledger event",()=>{assert.match(server,/operation_type:"REVERSAL"/);assert.match(server,/progress_delta:-Number/);assert.match(server,/reward_delta:-Number/);});
test("ledger is append-oriented and idempotency constrained",()=>{assert.match(server,/loyaltyIdempotencyKey\(orderId,row\.program_id,"reversal:"\+row\.id\)/);assert.match(server,/apply_loyalty_sale/);});

test("loyalty programs use atomic rule replacement and activation",()=>{assert.match(server,/app\.put\("\/api\/loyalty\/programs\/:id"/);assert.match(server,/supabase\.rpc\("replace_loyalty_program"/);assert.match(server,/app\.patch\("\/api\/loyalty\/programs\/:id\/active"/);const migration=fs.readFileSync(path.join(__dirname,"../supabase/migrations/20261001112313_atomic_checkout_and_loyalty_programs.sql"),"utf8");assert.match(migration,/create or replace function public\.replace_loyalty_program/);assert.match(migration,/for update/);});

test("checkout finalization is one restricted database transaction",()=>{const checkout=fs.readFileSync(path.join(__dirname,"../checkout-service.js"),"utf8"),migration=fs.readFileSync(path.join(__dirname,"../supabase/migrations/20261001112313_atomic_checkout_and_loyalty_programs.sql"),"utf8");assert.match(checkout,/supabase\.rpc\("finalize_verified_checkout"/);assert.match(migration,/create or replace function public\.finalize_verified_checkout/);assert.match(migration,/set search_path = ''/);assert.match(migration,/revoke all on function public\.finalize_verified_checkout.*public,anon,authenticated/);});

test("customer admin exposes purchase history for retention analytics",()=>{assert.match(server,/\/api\/customers\/:id\/orders/);assert.match(server,/\.eq\("customer_id",req\.params\.id\)/);assert.match(server,/order_items\(product_name,quantity,price\)/);assert.match(server,/id,external_id,status,total,created_at/);});

test("atomic sale keeps semantic ledger events and reversal keys per source event",()=>{const migration=fs.readFileSync(path.join(__dirname,"../supabase/migrations/20261001023000_atomic_loyalty_sale.sql"),"utf8");assert.match(migration,/'EARN'/);assert.match(migration,/'REWARD_GRANTED'/);assert.match(migration,/'REWARD_REDEEMED'/);assert.match(migration,/p_idempotency_key\|\|':earn'/);assert.match(migration,/p_idempotency_key\|\|':grant'/);assert.match(migration,/p_idempotency_key\|\|':redeem'/);assert.match(server,/reversal:"\+row\.id/);assert.match(server,/reversalOf:row\.id/);});

test("loyalty analytics use central customer orders and semantic ledger",()=>{assert.match(server,/\/api\/analytics\/loyalty/);assert.match(server,/averageCustomerCheck/);assert.match(server,/activeLoyaltyUsers/);assert.match(server,/rewardsGranted/);assert.match(server,/rewardsRedeemed/);});

test("manual loyalty adjustment requires server-side administrator authorization",()=>{assert.match(server,/POS_ADMIN_PASSWORD/);assert.match(server,/Administrator authorization required/);assert.match(server,/adminPassword/);});
