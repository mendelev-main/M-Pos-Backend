(function(root){
  const LIFETIME=30*60*1000;
  function describe(order,now=Date.now()) {
    const cancelled=['cancelled','canceled'].includes(order.status),ready=order.status==='ready';
    const step=ready?2:['accepted','preparing','in_work'].includes(order.status)?1:0;
    const terminal=cancelled||ready,changed=Date.parse(order.status_changed_at);
    const expiresAt=terminal&&Number.isFinite(changed)?changed+LIFETIME:null;
    const delivery=order.order_type==='Доставка';
    const stages=['Создан','Принят',delivery?'Готов и передан в доставку':'Готов'];
    let note='Ожидаем подтверждение от заведения.';
    if(cancelled)note='Статус сохранится в истории заказов.';
    else if(ready)note=delivery?'Ожидайте доставку.':'Можно забирать в заведении.';
    else if(step===1){
      const estimate=String(order.ready_estimate||'');
      if(/^at:([01]\d|2[0-3]):[0-5]\d$/.test(estimate))note='Будет готов к '+estimate.slice(3)+'.';
      else if(estimate==='60plus')note='Время приготовления — больше часа.';
      else {
        const minutes={'5m':5,'15m':15,'30m':30,'40m':40}[estimate],accepted=Date.parse(order.accepted_at);
        note=minutes&&Number.isFinite(accepted)?'Будет готов примерно к '+new Date(accepted+minutes*60000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Minsk'})+'.':'Ожидаем время готовности от заведения.';
      }
    }
    return {step,stages,note,terminal,expiresAt,expired:expiresAt!==null&&now>=expiresAt,
      title:cancelled?'Заказ отменён':ready?(delivery?'Готов и передан в доставку':'Заказ готов'):step===1?'Заказ принят':'Заказ создан',
      className:cancelled?'cancelled':ready?'complete':step===1?'accepted':''};
  }
  root.CurrentOrderState={describe,LIFETIME};
})(globalThis);
