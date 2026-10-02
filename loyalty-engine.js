export function calculateLoyaltyTransition({progress=0,rewards=0,requiredQuantity,rewardQuantity=1,earnedQuantity=0,redeemQuantity=0}){
 const required=Math.max(1,Math.trunc(Number(requiredQuantity)||0));
 const earned=Math.max(0,Math.trunc(Number(earnedQuantity)||0));
 const redeem=Math.max(0,Math.trunc(Number(redeemQuantity)||0));
 const beforeProgress=Math.max(0,Math.trunc(Number(progress)||0));
 const beforeRewards=Math.max(0,Math.trunc(Number(rewards)||0));
 if(redeem>beforeRewards||redeem>1) throw new Error("Insufficient loyalty rewards");
 const remainingReward=beforeRewards-redeem;
 const combined=beforeProgress+earned;
 const granted=remainingReward===0&&combined>=required?1:0;
 const nextProgress=remainingReward>0||granted>0?0:combined;
 return {progress:nextProgress,rewards:Math.min(1,remainingReward+granted),
   progressDelta:nextProgress-beforeProgress,rewardDelta:granted-redeem,
   granted,redeemed:redeem,earned};
}
export function loyaltyIdempotencyKey(orderId,programId,kind){return `order:${orderId}:program:${programId}:${kind}`;}

function loyaltyProgressLine(progress,required){
 const safeRequired=Math.max(1,Math.trunc(Number(required)||0)),safeProgress=Math.max(0,Math.min(safeRequired,Math.trunc(Number(progress)||0)));
 return safeRequired<=10?`${'● '.repeat(safeProgress)}${'○ '.repeat(safeRequired-safeProgress)}`.trim():'';
}
export function formatLoyaltySaleMessage(events=[],programs=[]){
 const fresh=(events||[]).filter(event=>!event?.duplicate);
 if(!fresh.length)return null;
 const byId=new Map((programs||[]).map(program=>[String(program.id),program]));
 const hasGranted=fresh.some(event=>Number(event.granted)>0),hasRedeemed=fresh.some(event=>Number(event.redeemed)>0);
 const hasAvailable=fresh.some(event=>Number(byId.get(String(event.programId))?.rewards??event.rewards)>0);
 const title=hasGranted?'🎁 Вам доступен подарок!':hasRedeemed?'✅ Подарок использован':hasAvailable?'🎁 Ваш подарок уже доступен':'⭐ Покупка учтена';
 const sections=fresh.map(event=>{
  const program=byId.get(String(event.programId))||{},name=String(program.name||'Программа лояльности');
  const required=Math.max(1,Math.trunc(Number(program.required_quantity)||1));
  const rewardAvailable=Number(program.rewards??event.rewards)>0;
  if(rewardAvailable)return `Программа «${name}»\nПодарок доступен\n\nНакопление продолжится после использования подарка.`;
  const progress=Math.max(0,Math.min(required,Math.trunc(Number(program.progress??event.progress)||0)));
  const visual=loyaltyProgressLine(progress,required);
  return `Программа «${name}»\n${visual?visual+'\n':''}Прогресс: ${progress} из ${required}\n\nДо подарка осталось: ${required-progress}`;
 });
 return `${title}\n\n${sections.join('\n\n')}`;
}
