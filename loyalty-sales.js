import { loyaltyIdempotencyKey } from './loyalty-engine.js';

// The caller owns the transaction. Inventory acknowledgements never call this.
export async function applyLoyaltyReceipt({query,customerId,orderId,programs,allocation,membership,occurredAt}) {
  await query("SELECT pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0))",[customerId]);
  const events=[];
  for(const p of programs){
    const earningIds=new Set((p.loyalty_earning_products||[]).map(x=>String(x.product_id)));
    const earned=[...allocation.paidByProduct].filter(([id])=>earningIds.has(id)).reduce((sum,[,quantity])=>sum+quantity,0);
    const redeem=allocation.allocatedByProgram.get(String(p.id))||0;
    if(!earned&&!redeem)continue;
    const key=loyaltyIdempotencyKey(orderId,p.id,'sale');
    const {rows}=await query('SELECT * FROM public.apply_loyalty_sale($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::bigint,$10::timestamptz)',[customerId,p.id,key,orderId,earned,redeem,p.required_quantity,p.reward_quantity,membership.version,occurredAt||null]);
    const x=rows?.[0];
    events.push({programId:p.id,earned,redeemed:Number(x?.redeemed||0),granted:Number(x?.granted||0),progress:Number(x?.progress||0),rewards:Number(x?.rewards||0),duplicate:Boolean(x?.duplicate)});
  }
  return events;
}
