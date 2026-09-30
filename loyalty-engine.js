export function calculateLoyaltyTransition({progress=0,rewards=0,requiredQuantity,rewardQuantity=1,earnedQuantity=0,redeemQuantity=0}){
 const required=Math.max(1,Math.trunc(Number(requiredQuantity)||0));
 const rewardEach=Math.max(1,Math.trunc(Number(rewardQuantity)||1));
 const earned=Math.max(0,Math.trunc(Number(earnedQuantity)||0));
 const redeem=Math.max(0,Math.trunc(Number(redeemQuantity)||0));
 const beforeProgress=Math.max(0,Math.trunc(Number(progress)||0));
 const beforeRewards=Math.max(0,Math.trunc(Number(rewards)||0));
 if(redeem>beforeRewards) throw new Error("Insufficient loyalty rewards");
 const combined=beforeProgress+earned;
 const cycles=Math.floor(combined/required);
 return {progress:combined%required,rewards:beforeRewards+(cycles*rewardEach)-redeem,
   progressDelta:(combined%required)-beforeProgress,rewardDelta:(cycles*rewardEach)-redeem,
   granted:cycles*rewardEach,redeemed:redeem,earned};
}
export function loyaltyIdempotencyKey(orderId,programId,kind){return `order:${orderId}:program:${programId}:${kind}`;}
