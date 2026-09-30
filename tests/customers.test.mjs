import test from "node:test";
import assert from "node:assert/strict";
import { createCheckoutService } from "../checkout-service.js";

function query(result){
  const q={select(){return q},eq(){return q},in(){return q},single:async()=>result,maybeSingle:async()=>result,insert(){return q},update(){return q}};
  return q;
}

test("verified checkout resolves one customer and links order", async()=>{
  const calls={customerInserts:0,customerUpdates:0,orderInsert:null};
  const customer={id:"customer-1",name:"Aleksandr",normalized_phone:"+375291234567",telegram_user_id:"tg-1"};
  const session={id:"session-1",status:"PENDING",phone:"+375291234567",order_payload:{customerName:"Aleksandr",orderType:"Самовывоз",items:[],total:0,fee:0},expires_at:new Date(Date.now()+60000).toISOString()};
  const supabase={from(table){
    if(table==="checkout_sessions") return {select(){return query({data:session,error:null})},update(){return {eq:async()=>({error:null})}}};
    if(table==="customers") return {
      select(){return {eq(){return {maybeSingle:async()=>({data:customer,error:null}),single:async()=>({data:customer,error:null})}}}},
      update(patch){calls.customerUpdates++;assert.equal(patch.telegram_user_id,"tg-1");return {eq(){return {select(){return {single:async()=>({data:{id:customer.id},error:null})}}}}}},
      insert(){calls.customerInserts++;return query({data:{id:customer.id},error:null})}
    };
    if(table==="orders") return {insert(row){calls.orderInsert=row;return {select(){return {single:async()=>({data:{id:"order-1"},error:null})}}}}};
    if(table==="order_items") return {insert:async()=>({error:null})};
    throw new Error("unexpected table "+table);
  }};
  const phoneVerification={
    get:async()=>({status:"VERIFIED",phone:"+375291234567",telegram_user_id:"tg-1",verified_at:new Date().toISOString()}),
    consume:async()=>true
  };
  const service=createCheckoutService({supabase,normalizePhone:x=>x,validateOrderContact:()=>"",phoneVerification});
  const result=await service.finalizeByVerificationToken("token");
  assert.equal(result.ok,true);
  assert.equal(calls.customerInserts,0);
  assert.equal(calls.customerUpdates,1);
  assert.equal(calls.orderInsert.customer_id,"customer-1");
});
