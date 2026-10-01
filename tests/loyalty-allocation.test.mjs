import test from "node:test";
import assert from "node:assert/strict";
import { validateLoyaltyAllocation } from "../loyalty-allocation.js";

const programs=[
  {id:"a",loyalty_reward_products:[{product_id:"pizza"}]},
  {id:"b",loyalty_reward_products:[{product_id:"pizza"}]},
];

test("one sold item cannot be redeemed by two programs",()=>{
  assert.throws(()=>validateLoyaltyAllocation({items:[{productId:"pizza",quantity:1}],programs,redemptions:{a:1,b:1},rewardAllocations:{a:[{productId:"pizza",quantity:1}],b:[{productId:"pizza",quantity:1}]}}),/REWARD_ITEM_REUSED/);
});

test("reward units are excluded from paid quantities used for earning",()=>{
  const result=validateLoyaltyAllocation({items:[{productId:"pizza",quantity:2},{productId:"drink",quantity:1}],programs:[programs[0]],redemptions:{a:1},rewardAllocations:{a:[{productId:"pizza",quantity:1}]}});
  assert.equal(result.paidByProduct.get("pizza"),1);
  assert.equal(result.paidByProduct.get("drink"),1);
  assert.equal(result.allocatedByProgram.get("a"),1);
});

test("legacy payload is allocated safely without reusing items",()=>{
  const result=validateLoyaltyAllocation({items:[{productId:"pizza",quantity:2}],programs,redemptions:{a:1,b:1}});
  assert.equal(result.paidByProduct.get("pizza"),0);
  assert.equal(result.allocatedByProgram.get("a"),1);
  assert.equal(result.allocatedByProgram.get("b"),1);
});

test("allocation must use reward products and exactly match redemption",()=>{
  assert.throws(()=>validateLoyaltyAllocation({items:[{productId:"drink",quantity:1}],programs:[programs[0]],redemptions:{a:1},rewardAllocations:{a:[{productId:"drink",quantity:1}]}}),/INVALID_REWARD_ALLOCATION/);
  assert.throws(()=>validateLoyaltyAllocation({items:[{productId:"pizza",quantity:1}],programs:[programs[0]],redemptions:{a:1},rewardAllocations:{a:[]}}),/INVALID_REWARD_ALLOCATION/);
});
