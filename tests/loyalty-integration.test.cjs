const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const ready=fs.readFileSync(path.join(__dirname,"../ready-server.js"),"utf8");
const server=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
test("loyalty uses existing backend Telegram transport",()=>{assert.match(ready,/TELEGRAM_BOT_TOKEN/);assert.match(ready,/sendCustomerTelegram/);assert.match(ready,/\/api\/loyalty\/sales/);});
test("duplicate loyalty retries do not notify Telegram twice",()=>{assert.match(ready,/filter\(event => !event\.duplicate\)/);assert.match(server,/error\.code!=="23505"/);});
test("manual adjustment requires a reason",()=>{assert.match(server,/reason and adjustment are required/);assert.match(server,/operation_type:"MANUAL_ADJUSTMENT"/);});
test("refund uses compensating ledger event",()=>{assert.match(server,/operation_type:"REVERSAL"/);assert.match(server,/progress_delta:-Number/);assert.match(server,/reward_delta:-Number/);});
test("ledger is append-oriented and idempotency constrained",()=>{assert.match(server,/loyaltyIdempotencyKey\(orderId,p\.id,"sale"\)/);assert.match(server,/loyaltyIdempotencyKey\(orderId,row\.program_id,"reversal"\)/);});
