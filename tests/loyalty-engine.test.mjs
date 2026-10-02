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
 assert.match(progress,/● ● ● ● ○ ○/);assert.match(progress,/Прогресс: 4 из 6/);assert.match(progress,/До подарка осталось: 2/);
 const reward=formatLoyaltySaleMessage([{programId:'coffee',granted:1,rewards:1}], [{id:'coffee',name:'Каждый 6-й кофе',required_quantity:6,progress:0,rewards:1}]);
 assert.match(reward,/Вам доступен подарок/);assert.match(reward,/Накопление продолжится после использования подарка/);
});
