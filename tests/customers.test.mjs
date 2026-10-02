import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCheckoutService } from "../checkout-service.js";

test("verified checkout delegates all writes to one atomic RPC", async()=>{
  let call;
  const supabase={rpc:async(name,args)=>{call={name,args};return {data:{ok:true,orderId:"order-1",customerId:"customer-1",duplicate:false},error:null}}};
  const service=createCheckoutService({supabase,normalizePhone:x=>x,validateOrderContact:()=>"",phoneVerification:{}});
  const result=await service.finalizeByVerificationToken("token");
  assert.equal(result.ok,true);
  assert.equal(call.name,"finalize_verified_checkout");
  assert.equal(call.args.p_verification_token_hash,createHash("sha256").update("token").digest("hex"));
  assert.match(call.args.p_external_id,/^WEB-/);
  assert.equal(call.args.p_tracking_token.length,32);
});

test("atomic checkout maps safe business errors and permits idempotent result",async()=>{
  for(const [message,reason] of [["CHECKOUT_EXPIRED","EXPIRED"],["VERIFICATION_NOT_READY","NOT_VERIFIED"],["OUT_OF_STOCK:pizza","OUT_OF_STOCK"],["AVAILABILITY_UNAVAILABLE","AVAILABILITY_UNAVAILABLE"]]){
    const service=createCheckoutService({supabase:{rpc:async()=>({data:null,error:{message}})},normalizePhone:x=>x,validateOrderContact:()=>"",phoneVerification:{}});
    assert.deepEqual(await service.finalizeByVerificationToken("token"),{ok:false,reason});
  }
  const duplicate={ok:true,orderId:"existing",customerId:"customer",duplicate:true};
  const service=createCheckoutService({supabase:{rpc:async()=>({data:duplicate,error:null})},normalizePhone:x=>x,validateOrderContact:()=>"",phoneVerification:{}});
  assert.deepEqual(await service.finalizeByVerificationToken("token"),duplicate);
});
