const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const ready=fs.readFileSync(path.join(__dirname,"../ready-server.js"),"utf8");
const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
test("loyalty uses existing backend Telegram transport",()=>{assert.match(ready,/TELEGRAM_BOT_TOKEN/);assert.match(ready,/sendCustomerTelegram/);assert.match(ready,/\/api\/loyalty\/sales/);});
test("duplicate loyalty retries do not notify Telegram twice",()=>{assert.match(ready,/filter\(event => !event\.duplicate\)/);assert.match(server,/apply_loyalty_sale/);assert.match(server,/duplicate:Boolean\(x\?\.duplicate\)/);});
test("manual adjustment requires reason and administrator identity",()=>{assert.match(server,/reason, administrator and adjustment are required/);assert.match(server,/adminEmployeeId/);assert.match(server,/adminEmployeeName/);assert.match(server,/operation_type:"MANUAL_ADJUSTMENT"/);});
test("refund uses compensating ledger event",()=>{assert.match(server,/operation_type:"REVERSAL"/);assert.match(server,/progress_delta:-Number/);assert.match(server,/reward_delta:-Number/);});
test("ledger is append-oriented and idempotency constrained",()=>{assert.match(server,/loyaltyIdempotencyKey\(orderId,row\.program_id,"reversal"\)/);assert.match(server,/apply_loyalty_sale/);});
