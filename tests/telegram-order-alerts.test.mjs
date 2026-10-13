import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramOrderAlerts, ONLINE_ORDER_ALERT_TEXT } from "../telegram-order-alerts.js";

test("device notification configuration validates and persists the work-device Telegram ID",async()=>{
  let update;
  const query=async(sql,args)=>{assert.match(sql,/UPDATE public.devices/);assert.equal(args.at(-1),"device-1");assert.match(sql,new RegExp("WHERE id = \\$"+args.length+"::uuid"));update=args.slice(0,-1);return {rowCount:1};};
  const service=createTelegramOrderAlerts({query,botToken:"token",fetchImpl:async()=>({ok:true})});
  assert.deepEqual(await service.configure("device-1",{chatId:"bad",enabled:true}),{error:"Укажите корректный Telegram ID рабочего устройства",status:400});
  assert.equal(update,undefined);
  assert.deepEqual(await service.configure("device-1",{chatId:" 900000001 ",enabled:true}),{ok:true,enabled:true,chatId:"900000001",ownerChatId:""});
  assert.deepEqual(update,["900000001",true]);
  assert.deepEqual(await service.configure("device-1",{chatId:"invalid",enabled:false}),{ok:true,enabled:false,chatId:"",ownerChatId:""});
  assert.deepEqual(update,[null,false]);
  assert.deepEqual(await service.configure("device-1",{chatId:"",ownerChatId:"700000001",enabled:false}),{ok:true,enabled:false,chatId:"",ownerChatId:"700000001"});
  assert.deepEqual(update,[null,false,"700000001"]);
  assert.deepEqual(await service.configure("device-1",{chatId:"",ownerChatId:"owner",enabled:false}),{error:"Укажите корректный Telegram ID владельца",status:400});
});

test("new order alert sends the fixed message once to each enabled work device",async()=>{
  const requests=[];
  const query=async(sql)=>{assert.match(sql,/notify_online_orders = TRUE/);assert.match(sql,/is_active = TRUE/);return {rows:[{telegram_order_chat_id:'900000001'},{telegram_order_chat_id:'900000001'},{telegram_order_chat_id:null}]};};
  const service=createTelegramOrderAlerts({query,botToken:"secret",fetchImpl:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:true}}});
  assert.deepEqual(await service.notifyNewOrder(),{sent:1,failed:0});
  assert.equal(requests.length,1);assert.match(requests[0].url,/\/botsecret\/sendMessage$/);assert.deepEqual(requests[0].body,{chat_id:"900000001",text:ONLINE_ORDER_ALERT_TEXT});
});

test("missing bot token skips notification without querying devices",async()=>{
  const service=createTelegramOrderAlerts({query:async()=>{throw Error("database must not be queried")},botToken:"",fetchImpl:async()=>{throw Error("network must not be called")}});
  assert.deepEqual(await service.notifyNewOrder(),{sent:0,skipped:"missing_bot_token"});
});
