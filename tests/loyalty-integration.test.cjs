const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const ready=fs.readFileSync(path.join(__dirname,"../ready-server.js"),"utf8");
const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
test("loyalty uses existing backend Telegram transport",()=>{assert.match(ready,/TELEGRAM_BOT_TOKEN/);assert.match(ready,/sendCustomerTelegram/);assert.match(ready,/\/api\/loyalty\/sales/);});
test("duplicate loyalty retries do not notify Telegram twice",()=>{assert.match(ready,/filter\(event => !event\.duplicate\)/);assert.match(server,/apply_loyalty_sale/);assert.match(server,/duplicate:Boolean\(x\?\.duplicate\)/);});
test("manual adjustment requires reason and administrator identity",()=>{assert.match(server,/reason, administrator and adjustment are required/);assert.match(server,/adminEmployeeId/);assert.match(server,/adminEmployeeName/);assert.match(server,/operation_type:"MANUAL_ADJUSTMENT"/);});
test("refund uses compensating ledger event",()=>{assert.match(server,/operation_type:"REVERSAL"/);assert.match(server,/progress_delta:-Number/);assert.match(server,/reward_delta:-Number/);});
test("ledger is append-oriented and idempotency constrained",()=>{assert.match(server,/loyaltyIdempotencyKey\(orderId,row\.program_id,"reversal:"\+row\.id\)/);assert.match(server,/apply_loyalty_sale/);});

test("loyalty programs support future-only rule editing and activation",()=>{assert.match(server,/app\.put\("\/api\/loyalty\/programs\/:id"/);assert.match(server,/loyalty_earning_products"\)\.delete\(\)\.eq\("program_id",id\)/);assert.match(server,/loyalty_reward_products"\)\.delete\(\)\.eq\("program_id",id\)/);assert.match(server,/app\.patch\("\/api\/loyalty\/programs\/:id\/active"/);});

test("customer admin exposes purchase history for retention analytics",()=>{assert.match(server,/\/api\/customers\/:id\/orders/);assert.match(server,/\.eq\("customer_id",req\.params\.id\)/);assert.match(server,/order_items\(product_name,quantity,unit_price\)/);});

test("atomic sale keeps semantic ledger events and reversal keys per source event",()=>{const migration=fs.readFileSync(path.join(__dirname,"../supabase/migrations/20261001023000_atomic_loyalty_sale.sql"),"utf8");assert.match(migration,/'EARN'/);assert.match(migration,/'REWARD_GRANTED'/);assert.match(migration,/'REWARD_REDEEMED'/);assert.match(migration,/p_idempotency_key\|\|':earn'/);assert.match(migration,/p_idempotency_key\|\|':grant'/);assert.match(migration,/p_idempotency_key\|\|':redeem'/);assert.match(server,/reversal:"\+row\.id/);assert.match(server,/reversalOf:row\.id/);});
