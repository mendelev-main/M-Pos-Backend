import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramOrderAlerts, ONLINE_ORDER_ALERT_TEXT } from "../telegram-order-alerts.js";

test("device notification configuration validates and persists the work-device Telegram ID",async()=>{
  let update;
  const supabase={from(table){assert.equal(table,"devices");return{update(value){update=value;return{eq:async(key,id)=>{assert.equal(key,"id");assert.equal(id,"device-1");return{error:null}}}}}}};
  const service=createTelegramOrderAlerts({supabase,botToken:"token",fetchImpl:async()=>({ok:true})});
  assert.deepEqual(await service.configure("device-1",{chatId:"bad",enabled:true}),{error:"Укажите корректный Telegram ID рабочего устройства",status:400});
  assert.equal(update,undefined);
  assert.deepEqual(await service.configure("device-1",{chatId:" 900000001 ",enabled:true}),{ok:true,enabled:true,chatId:"900000001",ownerChatId:""});
  assert.deepEqual(update,{telegram_order_chat_id:"900000001",notify_online_orders:true});
  assert.deepEqual(await service.configure("device-1",{chatId:"invalid",enabled:false}),{ok:true,enabled:false,chatId:"",ownerChatId:""});
  assert.deepEqual(update,{telegram_order_chat_id:null,notify_online_orders:false});
  assert.deepEqual(await service.configure("device-1",{chatId:"",ownerChatId:"700000001",enabled:false}),{ok:true,enabled:false,chatId:"",ownerChatId:"700000001"});
  assert.deepEqual(update,{telegram_order_chat_id:null,notify_online_orders:false,telegram_owner_chat_id:"700000001"});
  assert.deepEqual(await service.configure("device-1",{chatId:"",ownerChatId:"owner",enabled:false}),{error:"Укажите корректный Telegram ID владельца",status:400});
});

test("new order alert sends the fixed message once to each enabled work device",async()=>{
  const requests=[];
  const supabase={from(table){assert.equal(table,"devices");const query={select(){return query},eq(){return query},not:async()=>({data:[{telegram_order_chat_id:"900000001"},{telegram_order_chat_id:"900000001"},{telegram_order_chat_id:null}],error:null})};return query}};
  const service=createTelegramOrderAlerts({supabase,botToken:"secret",fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:true}}});
  assert.deepEqual(await service.notifyNewOrder(),{sent:1,failed:0});
  assert.equal(requests.length,1);assert.match(requests[0].url,/\/botsecret\/sendMessage$/);assert.deepEqual(requests[0].body,{chat_id:"900000001",text:ONLINE_ORDER_ALERT_TEXT});
});

test("missing bot token skips notification without querying devices",async()=>{
  const service=createTelegramOrderAlerts({supabase:{from(){throw Error("database must not be queried")}},botToken:"",fetchImpl:async()=>{throw Error("network must not be called")}});
  assert.deepEqual(await service.notifyNewOrder(),{sent:0,skipped:"missing_bot_token"});
});
