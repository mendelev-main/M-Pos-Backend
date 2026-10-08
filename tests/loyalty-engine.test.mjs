import test from "node:test";import assert from "node:assert/strict";
import {calculateLoyaltyTransition,formatLoyaltySaleMessage,loyaltyIdempotencyKey} from "../loyalty-engine.js";
test("5th coffee grants reward and resets progress",()=>assert.deepEqual(calculateLoyaltyTransition({progress:4,rewards:0,requiredQuantity:5,earnedQuantity:1}),{progress:0,rewards:1,progressDelta:-4,rewardDelta:1,granted:1,redeemed:0,earned:1}));
test("active reward freezes progress and never exceeds one",()=>{const x=calculateLoyaltyTransition({progress:0,rewards:1,requiredQuantity:5,earnedQuantity:6});assert.equal(x.progress,0);assert.equal(x.rewards,1);assert.equal(x.granted,0)});
test("redeem cannot exceed balance",()=>assert.throws(()=>calculateLoyaltyTransition({progress:1,rewards:0,requiredQuantity:5,redeemQuantity:1})));
test("idempotency key is stable per order program operation",()=>assert.equal(loyaltyIdempotencyKey("o1","p1","earn"),loyaltyIdempotencyKey("o1","p1","earn")));

test("paid items start the next cycle when reward is redeemed",()=>{const x=calculateLoyaltyTransition({progress:0,rewards:1,requiredQuantity:5,earnedQuantity:2,redeemQuantity:1});assert.equal(x.progress,2);assert.equal(x.rewards,0);assert.equal(x.progressDelta,2);assert.equal(x.rewardDelta,-1);assert.equal(x.granted,0);assert.equal(x.redeemed,1);});
test("excess items are discarded when one reward is granted",()=>{const x=calculateLoyaltyTransition({progress:4,rewards:0,requiredQuantity:5,earnedQuantity:3});assert.equal(x.progress,0);assert.equal(x.rewards,1);assert.equal(x.granted,1)});
test("loyalty messages show progress and frozen reward state",()=>{
 const progress=formatLoyaltySaleMessage([{programId:'coffee',earned:2,progress:4,rewards:0}], [{id:'coffee',name:'Каждый 6-й кофе',required_quantity:6,progress:4,rewards:0}]);
 assert.match(progress,/● ● ● ● ○ ○/);assert.match(progress,/— 4 из 6/);assert.match(progress,/Ещё 2 товара по акции/);
 const reward=formatLoyaltySaleMessage([{programId:'coffee',granted:1,rewards:1}], [{id:'coffee',name:'Каждый 6-й кофе',required_quantity:6,progress:0,rewards:1}]);
 assert.match(reward,/Поздравляем! Вам доступен подарок 🎉/);assert.match(reward,/● ● ● ● ● ● — 6 из 6/);assert.match(reward,/Накопление продолжится после использования подарка/);
});


test("variant two reports purchased units rather than number of orders",()=>{
 const text=formatLoyaltySaleMessage([{programId:'coffee',earned:1}], [{id:'coffee',name:'6-й кофе в подарок',required_quantity:5,progress:3,rewards:0}]);
 assert.equal(text,'Спасибо за покупку!\n\nВаш прогресс по акции «6-й кофе в подарок»:\n● ● ● ○ ○ — 3 из 5\n\nЕщё 2 товара по акции — и подарок ваш 🎁');
});
test("duplicate sale produces no message and cannot announce an earned gift again",()=>{
 assert.equal(formatLoyaltySaleMessage([{programId:'coffee',duplicate:true,granted:1}],[{id:'coffee',name:'Кофе',required_quantity:5,rewards:1}]),null);
 const text=formatLoyaltySaleMessage([{programId:'coffee',granted:0,rewards:1}],[{id:'coffee',name:'Кофе',required_quantity:5,rewards:1}]);
 assert.match(text,/Ваш подарок уже доступен/);assert.doesNotMatch(text,/Поздравляем/);
});
test("large thresholds have a bounded indicator and retain the exact quantities",()=>{
 const text=formatLoyaltySaleMessage([{programId:'p'}],[{id:'p',name:'Большая акция',required_quantity:100,progress:30,rewards:0}]);
 assert.match(text,/● ● ● ○ ○ ○ ○ ○ ○ ○ — 30 из 100/);assert.match(text,/Ещё 70 товаров/);
});
test("multiple programs report their own progress and a redeemed gift starts the next cycle",()=>{
 const text=formatLoyaltySaleMessage([{programId:'coffee',redeemed:1},{programId:'pizza',earned:1}],[{id:'coffee',name:'Кофе',required_quantity:5,progress:2,rewards:0},{id:'pizza',name:'Пицца',required_quantity:3,progress:1,rewards:0}]);
 assert.match(text,/Подарок использован/);assert.match(text,/● ● ○ ○ ○ — 2 из 5/);assert.match(text,/● ○ ○ — 1 из 3/);assert.match(text,/Ещё 3 товара/);
});
