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

function loyaltyCount(value,fallback=0){
 const number=Number(value);
 return Number.isFinite(number)?Math.max(0,Math.trunc(number)):fallback;
}
function loyaltyProgressLine(progress,required){
 const segments=Math.min(10,required),filled=required<=10?progress:Math.floor(progress/required*segments);
 return [...Array(segments)].map((_,index)=>index<filled?'●':'○').join(' ');
}
function remainingItems(count){
 const last=count%10,lastTwo=count%100;
 const word=last===1&&lastTwo!==11?'товар':last>=2&&last<=4&&(lastTwo<12||lastTwo>14)?'товара':'товаров';
 return `Ещё ${count} ${word} по акции — и подарок ваш 🎁`;
}
export function formatLoyaltySaleMessage(events=[],programs=[]){
 const fresh=(events||[]).filter(event=>event&&!event.duplicate);
 if(!fresh.length)return null;
 const byId=new Map((programs||[]).map(program=>[String(program.id),program]));
 const hasGranted=fresh.some(event=>Number(event.granted)>0),hasRedeemed=fresh.some(event=>Number(event.redeemed)>0);
 const hasAvailable=fresh.some(event=>Number(byId.get(String(event.programId))?.rewards??event.rewards)>0);
 const title=hasGranted?'Поздравляем! Вам доступен подарок 🎉':hasRedeemed?'Подарок использован ✅':hasAvailable?'Ваш подарок уже доступен 🎁':'Спасибо за покупку!';
 const sections=fresh.map(event=>{
  const program=byId.get(String(event.programId))||{},name=String(program.name||'Программа лояльности');
  const required=Math.max(1,loyaltyCount(program.required_quantity,1));
  const rewardAvailable=Number(program.rewards??event.rewards)>0;
  if(rewardAvailable)return `Акция «${name}»\n${loyaltyProgressLine(required,required)} — ${required} из ${required}\n\nУсловия акции выполнены — подарок ваш 🎁\nВыберите подарок при оформлении заказа.\n\nНакопление продолжится после использования подарка.`;
  const progress=Math.min(required,loyaltyCount(program.progress??event.progress));
  return `Ваш прогресс по акции «${name}»:\n${loyaltyProgressLine(progress,required)} — ${progress} из ${required}\n\n${remainingItems(required-progress)}`;
 });
 return `${title}\n\n${sections.join('\n\n')}`;
}
