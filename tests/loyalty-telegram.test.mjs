import test from 'node:test';
import assert from 'node:assert/strict';
import {LOYALTY_PARTY_EFFECT_ID,loyaltySaleEffectId,sendLoyaltyTelegram} from '../loyalty-telegram.js';
const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>body});
function fixture(responses=[response(200,{ok:true})]){
 const requests=[],logs=[];
 return {requests,logs,options:{botToken:'synthetic-token',chatId:'900000001',text:'synthetic notification',events:[{granted:1}],logger:{error:message=>logs.push(message)},fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));assert.ok(options.signal);const result=responses.shift();if(result instanceof Error)throw result;return result}}};
}
test('party effect is a string and only new gifts in private chats receive it',()=>{
 assert.equal(typeof LOYALTY_PARTY_EFFECT_ID,'string');assert.equal(loyaltySaleEffectId([{granted:1}],'900000001'),LOYALTY_PARTY_EFFECT_ID);
 for(const events of [[{earned:1}],[{granted:1,duplicate:true}],[{rewards:1}],[]])assert.equal(loyaltySaleEffectId(events,'900000001'),undefined);
 for(const chat of ['-100123','@group','0'])assert.equal(loyaltySaleEffectId([{granted:1}],chat),undefined);
});
test('successful gift notification is sent once with the party effect',async()=>{
 const f=fixture();assert.equal(await sendLoyaltyTelegram(f.options),true);assert.equal(f.requests.length,1);assert.equal(f.requests[0].message_effect_id,LOYALTY_PARTY_EFFECT_ID);assert.equal(f.logs.length,0);
});
test('explicit invalid effect rejection retries the same message without animation',async()=>{
 const f=fixture([response(400,{ok:false,error_code:400,description:'Bad Request: EFFECT_ID_INVALID'}),response(200,{ok:true})]);
 assert.equal(await sendLoyaltyTelegram(f.options),true);assert.equal(f.requests.length,2);assert.ok(f.requests[0].message_effect_id);assert.equal(f.requests[1].message_effect_id,undefined);assert.equal(f.requests[0].text,f.requests[1].text);assert.equal(f.requests[0].chat_id,f.requests[1].chat_id);
});
test('ordinary purchase omits the effect and is not retried after an unrelated rejection',async()=>{
 const f=fixture([response(400,{ok:false,error_code:400,description:'Bad Request: chat not found'})]);f.options.events=[{earned:1}];
 assert.equal(await sendLoyaltyTelegram(f.options),false);assert.equal(f.requests.length,1);assert.equal(f.requests[0].message_effect_id,undefined);
});
test('ambiguous network failures do not duplicate delivery or leak sensitive values',async()=>{
 const f=fixture([Error('https://api.telegram.org/botsynthetic-token/sendMessage')]);assert.equal(await sendLoyaltyTelegram(f.options),false);assert.equal(f.requests.length,1);assert.doesNotMatch(f.logs.join(' '),/synthetic-token|900000001|synthetic notification/);
});
test('a blocked recipient is not retried and API body failure is not mistaken for delivery',async()=>{
 const f=fixture([response(403,{ok:false,error_code:403,description:'Forbidden: bot was blocked by the user'})]);assert.equal(await sendLoyaltyTelegram(f.options),false);assert.equal(f.requests.length,1);
 const g=fixture([response(200,{ok:false,error_code:400,description:'invalid request'})]);assert.equal(await sendLoyaltyTelegram(g.options),false);
});
