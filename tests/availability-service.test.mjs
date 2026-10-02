import test from "node:test";
import assert from "node:assert/strict";
import {createAvailabilityService} from "../availability-service.js";

function serviceFixture(){
  const calls=[];
  const supabase={
    rpc:async(name,args)=>{calls.push({name,args});if(name==="get_web_availability")return {data:[{external_product_id:"pizza",quantity:"2"},{external_product_id:"water",quantity:null}],error:null};return {data:true,error:null}},
    from(table){assert.equal(table,"devices");const query={select(){return query},eq(){return query},maybeSingle:async()=>({data:{id:"device-1"},error:null})};return query}
  };
  return {service:createAvailabilityService({supabase}),calls};
}

test("availability decorates menu and validates requested quantities",async()=>{
  const {service}=serviceFixture(),products=[{id:"p1",external_id:"pizza",name:"Пицца"},{id:"p2",external_id:"water",name:"Вода"},{id:"p3",external_id:"missing",name:"Соус"}];
  const decorated=await service.attachToProducts(products);assert.equal(decorated[0].available_quantity,2);assert.equal(decorated[1].available_quantity,null);assert.equal(decorated[2].availability_known,false);
  assert.equal(await service.validateOrder(products,[{productId:"p1",quantity:2},{productId:"p2",quantity:99}]),null);
  assert.match(await service.validateOrder(products,[{productId:"p1",quantity:3}]),/осталось: 2/);
  assert.match(await service.validateOrder(products,[{productId:"p3",quantity:1}]),/не подтверждён/);
});

test("availability snapshot validates input and forwards settlements to restricted RPC",async()=>{
  const {service,calls}=serviceFixture();
  assert.deepEqual(await service.store("",{}),{error:"Missing device key",status:401});
  assert.equal((await service.store("key",{version:1,revision:1,sampledAt:new Date().toISOString(),items:[{externalId:"pizza",quantity:-1}]})).status,400);
  const result=await service.store("key",{version:1,revision:7,sampledAt:"2026-10-02T12:00:00.000Z",items:[{externalId:"pizza",quantity:2},{externalId:"water",quantity:null}],settledWebOrderIds:["order-1","order-1"]});
  assert.equal(result.ok,true);const call=calls.find(item=>item.name==="store_availability_snapshot");assert.equal(call.args.p_revision,7);assert.deepEqual(call.args.p_settled_order_ids,["order-1"]);assert.deepEqual(call.args.p_items,[{externalId:"pizza",quantity:2},{externalId:"water",quantity:null}]);
});
