import test from "node:test";import assert from "node:assert/strict";
import {calculateLoyaltyTransition,loyaltyIdempotencyKey} from "../loyalty-engine.js";
test("5th coffee grants reward and resets progress",()=>assert.deepEqual(calculateLoyaltyTransition({progress:4,rewards:0,requiredQuantity:5,earnedQuantity:1}),{progress:0,rewards:1,progressDelta:-4,rewardDelta:1,granted:1,redeemed:0,earned:1}));
test("multiple rewards accumulate",()=>{const x=calculateLoyaltyTransition({progress:4,rewards:2,requiredQuantity:5,earnedQuantity:6});assert.equal(x.progress,0);assert.equal(x.rewards,4);assert.equal(x.granted,2)});
test("redeem cannot exceed balance",()=>assert.throws(()=>calculateLoyaltyTransition({progress:1,rewards:0,requiredQuantity:5,redeemQuantity:1})));
test("idempotency key is stable per order program operation",()=>assert.equal(loyaltyIdempotencyKey("o1","p1","earn"),loyaltyIdempotencyKey("o1","p1","earn")));

test("earn and redeem in same sale preserve exact reversible deltas",()=>{const x=calculateLoyaltyTransition({progress:4,rewards:2,requiredQuantity:5,rewardQuantity:1,earnedQuantity:1,redeemQuantity:1});assert.equal(x.progress,0);assert.equal(x.rewards,2);assert.equal(x.progressDelta,-4);assert.equal(x.rewardDelta,0);assert.equal(x.granted,1);assert.equal(x.redeemed,1);});
