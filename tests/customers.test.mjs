import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCheckoutService } from "../checkout-service.js";

test("verified checkout delegates all writes to one atomic RPC", async()=>{
  let call;
  const query=async(sql,args)=>{call={sql,args};return {rows:[{result:{ok:true,orderId:"order-1",customerId:"customer-1",duplicate:false}}]}};
  const service=createCheckoutService({query,normalizePhone:x=>x,validateOrderContact:()=>"",phoneVerification:{}});
  const result=await service.finalizeByVerificationToken("token");
  assert.equal(result.ok,true);
  assert.match(call.sql,/SELECT public\.finalize_verified_checkout/);
  assert.equal(call.args[0],createHash("sha256").update("token").digest("hex"));
  assert.match(call.args[1],/^WEB-/);
  assert.equal(call.args[2].length,32);
});

test("atomic checkout maps safe business errors and permits idempotent result",async()=>{
  for(const [message,reason] of [["CHECKOUT_EXPIRED","EXPIRED"],["VERIFICATION_NOT_READY","NOT_VERIFIED"],["OUT_OF_STOCK:pizza","OUT_OF_STOCK"],["AVAILABILITY_UNAVAILABLE","AVAILABILITY_UNAVAILABLE"]]){
    const service=createCheckoutService({query:async()=>{throw new Error(message)},normalizePhone:x=>x,validateOrderContact:()=>"",phoneVerification:{}});
    assert.deepEqual(await service.finalizeByVerificationToken("token"),{ok:false,reason});
  }
  const duplicate={ok:true,orderId:"existing",customerId:"customer",duplicate:true};
  const service=createCheckoutService({query:async()=>({rows:[{result:duplicate}]}),normalizePhone:x=>x,validateOrderContact:()=>"",phoneVerification:{}});
  assert.deepEqual(await service.finalizeByVerificationToken("token"),duplicate);
});
