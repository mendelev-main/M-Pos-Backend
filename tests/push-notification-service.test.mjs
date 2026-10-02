import test from "node:test";
import assert from "node:assert/strict";
import { createPushNotificationService } from "../push-notification-service.js";

function fixture({ sendResult = { ok: true, status: 200, reason: "" } } = {}) {
  const calls=[];
  const rows={
    device_push_tokens:[{id:"token-row",token:"a".repeat(64),environment:"production",sound_enabled:true,failure_count:0}],
    order_push_outbox:[],
  };
  const supabase={
    async rpc(name,args){calls.push({type:"rpc",name,args});if(name==="claim_order_push_notifications")return {data:[{order_id:"order-1",external_id:"WEB-1",order_type:"Самовывоз",total:10,attempts:1}],error:null};return {data:null,error:null}},
    from(table){
      const state={patch:null};
      const query={
        select(){return query},update(patch){state.patch=patch;calls.push({type:"update",table,patch});return query},eq(){return query},is(){return query},
        then(resolve){resolve({data:state.patch?null:rows[table],error:null})}
      };
      return query;
    }
  };
  const sent=[];
  const provider={configured:true,async send(token,environment,payload){sent.push({token,environment,payload});return sendResult}};
  return {service:createPushNotificationService({supabase,provider}),calls,sent};
}

test("push token registration validates and uses restricted RPC",async()=>{
  const {service,calls}=fixture();
  assert.equal((await service.register("device",{token:"bad",environment:"production"})).status,400);
  assert.deepEqual(await service.register("device",{token:"A".repeat(64),environment:"development",soundEnabled:false}),{ok:true,configured:true});
  const call=calls.find(x=>x.name==="register_device_push_token");
  assert.deepEqual(call.args,{p_device_id:"device",p_token:"a".repeat(64),p_environment:"development",p_sound_enabled:false});
});

test("push drain sends a privacy-safe audible alert and marks outbox delivered",async()=>{
  const {service,calls,sent}=fixture();
  assert.deepEqual(await service.drain(),{disabled:false,processed:1,delivered:1});
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].payload,{aps:{alert:{title:"Новый онлайн-заказ",body:"WEB-1 · Самовывоз"},sound:"default"},kind:"web_order",orderId:"order-1"});
  assert.ok(calls.some(x=>x.type==="update"&&x.table==="order_push_outbox"&&x.patch.delivered_at));
});

test("push drain stays idle without APNs credentials",async()=>{
  const service=createPushNotificationService({supabase:{},provider:{configured:false}});
  assert.deepEqual(await service.drain(),{disabled:true,processed:0});
});
