import test from "node:test";
import assert from "node:assert/strict";
import { createLivePosReports, sanitizeLivePosReport } from "../live-pos-reports.js";

function database(ownerId="700000001") {
  return { from(table) { assert.equal(table,"devices"); const query={select(){return query},eq(key,value){if(key==="telegram_owner_chat_id")query.owner=value;return query},limit(){return query},maybeSingle:async()=>({data:query.owner===ownerId?{id:"device-1"}:null,error:null})};return query; } };
}

test("only the configured owner can request a live POS report",async()=>{
  const service=createLivePosReports({supabase:database(),createId:()=>"request_12345678901234567890",timeoutMs:50});
  assert.deepEqual(await service.access("700000001"),{ok:true});
  await assert.rejects(service.access("700000002"),error=>error.status===403&&error.code==="OWNER_FORBIDDEN");
});

test("online POS resolves the owner request with a bounded report",async()=>{
  const service=createLivePosReports({supabase:database(),createId:()=>"request_12345678901234567890",timeoutMs:100});
  const pending=service.request("700000001",(deviceId,payload)=>{assert.equal(deviceId,"device-1");queueMicrotask(()=>service.submit(deviceId,payload.requestId,{shiftOpen:true,revenue:30,cash:10,card:20,orders:2,currency:"BYN",categories:[{name:"Пицца",quantity:2,revenue:30}],products:[{name:"Маргарита",quantity:2,revenue:30}]}));return true});
  const result=await pending;assert.equal(result.report.revenue,30);assert.equal(result.report.cash,10);assert.equal(result.report.card,20);assert.deepEqual(result.report.categories,[{name:"Пицца",quantity:2,revenue:30}]);
});

test("closed or unresponsive POS is reported as offline",async()=>{
  const closed=createLivePosReports({supabase:database(),createId:()=>"request_12345678901234567890",timeoutMs:20});
  await assert.rejects(closed.request("700000001",()=>false),error=>error.status===409&&error.code==="POS_OFFLINE");
  const stalled=createLivePosReports({supabase:database(),createId:()=>"request_12345678901234567891",timeoutMs:5});
  await assert.rejects(stalled.request("700000001",()=>true),error=>error.status===409&&error.code==="POS_OFFLINE");
});

test("live report sanitizer rejects unbounded and invalid values",()=>{
  const report=sanitizeLivePosReport({shiftOpen:true,revenue:"bad",cash:-1,card:4,orders:2.9,categories:Array.from({length:120},(_,i)=>({name:"x".repeat(200)+i,quantity:i,revenue:i}))});
  assert.equal(report.revenue,0);assert.equal(report.cash,0);assert.equal(report.orders,2);assert.equal(report.categories.length,100);assert.equal(report.categories[0].name.length,120);
});
