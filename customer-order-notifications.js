// Delivery acknowledgement is not idempotent in Telegram. Never retry an ambiguous send.
export async function deliverCreatedOrder({botToken,chatId,externalId,fetchImpl=fetch}) {
  const text=`<b>Заказ №${String(externalId||'').slice(0,8).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</b>\n⚪️ Статус: <b>Создан</b>\n\nОтправили ваш заказ в заведение. Сообщим, когда его статус изменится.`;
  try {
    const response=await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true}),signal:AbortSignal.timeout(10_000)});
    const body=await response.json().catch(()=>null);
    if(response.ok&&body?.ok===true&&Number.isInteger(body.result?.message_id))return {state:'sent',messageId:body.result.message_id};
    if(body?.ok===false&&Number.isInteger(body.error_code)) {
      if(body.error_code===429||body.error_code>=500)return {state:'retry',retrySeconds:Math.min(86400,Math.max(30,Math.ceil(Number(body.parameters?.retry_after))||30))};
      return {state:'rejected'};
    }
    return {state:'uncertain'};
  } catch {return {state:'uncertain'};}
}

export function createCustomerOrderNotificationWorker({query,botToken,isSleeping=()=>false,fetchImpl=fetch,logger=console}) {
  let busy=false;
  async function claim() {
    const {rows}=await query('SELECT * FROM public.claim_customer_order_notification()');
    return rows||[];
  }
  async function finish(job,outcome) {
    const {rows}=await query(
      'SELECT public.finish_customer_order_notification($1::uuid,$2::uuid,$3,$4::bigint,$5::integer) AS saved',
      [job.order_id,job.claim_token,outcome.state,outcome.messageId??null,outcome.retrySeconds??30]
    );
    return rows?.[0]?.saved===true;
  }
  return async function poll() {
    if(busy||!botToken||isSleeping())return;
    busy=true;
    try {
      // Claim one at a time so waiting rows cannot lose their lease during a slow batch.
      for(let i=0;i<10;i++) {
        const rows=await claim(),job=rows?.[0];
        if(!job)break;
        const outcome=await deliverCreatedOrder({botToken,chatId:job.chat_id,externalId:job.external_id,fetchImpl});
        const saved=await finish(job,outcome);
        if(saved!==true)throw Error('notification_state_not_saved');
        if(outcome.state!=='sent')logger.warn('Customer order notification outcome',{state:outcome.state});
      }
    } catch {logger.error('Customer order notification worker failed; claimed deliveries are not automatically resent');}
    finally {busy=false;}
  };
}
