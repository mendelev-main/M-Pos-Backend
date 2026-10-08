// Telegram's free party effect; kept as a string because it exceeds JS safe integer range.
// https://core.telegram.org/bots/api#sendmessage
// https://github.com/Romashkaa/telekit/blob/main/docs/tutorial2/5_senders.md#effects
export const LOYALTY_PARTY_EFFECT_ID = '5046509860389126442';

export function loyaltySaleEffectId(events,chatId){
  const privateChat=/^[1-9]\d*$/.test(String(chatId));
  return privateChat&&(events||[]).some(event=>event&&!event.duplicate&&Number(event.granted)>0)
    ? LOYALTY_PARTY_EFFECT_ID : undefined;
}

export async function sendLoyaltyTelegram({botToken,chatId,text,events=[],fetchImpl=fetch,logger=console}){
  if(!botToken||!chatId||!text)return false;
  const payload={chat_id:String(chatId),text,disable_web_page_preview:true};
  const effect=loyaltySaleEffectId(events,chatId);
  if(effect)payload.message_effect_id=effect;
  async function send(body){
    const response=await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000),
    });
    const result=await response.json().catch(()=>null);
    return {ok:response.ok&&result?.ok===true,status:response.status,result};
  }
  try{
    let response=await send(payload);
    // Retry only an explicit effect rejection: an ambiguous timeout may have delivered
    // the first message, and a general retry would send the notification twice.
    if(effect&&!response.ok&&(response.status===400||response.result?.error_code===400)&&/effect/i.test(String(response.result?.description||''))){
      delete payload.message_effect_id;
      response=await send(payload);
    }
    if(response.ok)return true;
    logger.error(`Telegram loyalty notification failed (HTTP ${response.status})`);
    return false;
  }catch{
    // Do not log the request URL, bot token, recipient or customer message.
    logger.error('Telegram loyalty notification failed (network or timeout)');
    return false;
  }
}
