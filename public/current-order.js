(() => {
  const state=window.CurrentOrderState,header=document.querySelector('.site-top');
  if(!state||!header)return;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=value=>Number(value||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' BYN';
  const dock=document.createElement('aside');dock.className='current-order-dock';dock.hidden=true;dock.setAttribute('aria-label','Текущие заказы');header.after(dock);
  const dialog=document.createElement('dialog');dialog.className='current-order-details';dialog.setAttribute('aria-labelledby','current-order-details-title');document.body.append(dialog);
  let orders=[],offset=0,timer,expiryTimer,busy=false,generation=0,signature='',activeId=null,previousOverflow='',returnFocus;
  const now=()=>Date.now()+offset;
  function resize(){document.documentElement.style.setProperty('--current-order-offset',dock.hidden?'0px':dock.getBoundingClientRect().height+'px');}
  function close(){dialog.close();}
  function details(id,open=true){
    const order=orders.find(o=>o.id===id);if(!order)return;
    activeId=id;const view=state.describe(order,now());
    dialog.innerHTML=`<div class="current-order-details-head"><h2 id="current-order-details-title">${escape(order.external_id||'Ваш заказ')}</h2><button type="button" aria-label="Закрыть заказ">×</button></div><p class="order-details-status">${escape(view.title)}</p><p class="current-order-note">${escape(view.note)}</p><p class="order-details-type">${escape(order.order_type||'Самовывоз')}</p>${(order.items||[]).map(item=>`<div class="order-details-row"><span>${escape(item.name)} <small>× ${Number(item.quantity)||0}</small></span><strong>${money(Number(item.price)*Number(item.quantity))}</strong></div>`).join('')}<div class="order-details-total"><span>Итого</span><span>${money(order.total)}</span></div>`;
    dialog.querySelector('button').onclick=close;
    if(open&&!dialog.open){returnFocus=document.activeElement;previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();dialog.querySelector('button').focus();}
  }
  dialog.addEventListener('click',e=>{if(e.target===dialog)close();});
  dialog.addEventListener('close',()=>{document.body.style.overflow=previousOverflow;activeId=null;if(returnFocus?.isConnected)returnFocus.focus();});
  function render(){
    clearTimeout(expiryTimer);
    const visible=orders.filter(o=>!state.describe(o,now()).expired),next=JSON.stringify(visible);
    if(next!==signature){
      const previous=signature;signature=next;dock.hidden=!visible.length;
      dock.innerHTML=visible.map(order=>{
        const view=state.describe(order,now());
        return `<section class="current-order ${view.className}"><div class="current-order-inner"><div class="current-order-top"><button type="button" class="order-summary-button" data-order-id="${escape(order.id)}" aria-label="Открыть ${escape(order.external_id||'заказ')}">${escape(order.external_id||'Ваш заказ')}<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg></button><span class="current-order-type">${escape(order.order_type||'Самовывоз')}</span></div><h2 class="current-order-status" role="status">${escape(view.title)}</h2><p class="current-order-note">${escape(view.note)}</p><ol class="order-steps" aria-label="Этапы заказа" style="--stage-count:3">${view.stages.map((label,i)=>`<li class="order-step ${i<view.step?'done':i===view.step?'active':''}" ${i===view.step?'aria-current="step"':''}><span class="order-step-bar" aria-hidden="true"></span><span>${label}</span></li>`).join('')}</ol></div></section>`;
      }).join('');
      dock.querySelectorAll('[data-order-id]').forEach(button=>button.onclick=()=>details(button.dataset.orderId));
      resize();
      if(dialog.open){if(visible.some(o=>o.id===activeId))details(activeId,false);else close();}
      if(previous)window.dispatchEvent(new Event('current-orders-changed'));
    }
    const deadlines=visible.map(o=>state.describe(o,now()).expiresAt).filter(Number.isFinite);
    if(deadlines.length)expiryTimer=setTimeout(render,Math.max(1,Math.min(...deadlines)-now()+5));
  }
  async function refresh(){
    clearTimeout(timer);if(document.hidden||busy)return;
    busy=true;const expected=generation;
    try{
      const response=await fetch('/api/account/current-orders',{credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw Error('unavailable');
      const result=await response.json();if(expected!==generation)return;
      if(Number.isFinite(Date.parse(result.serverNow)))offset=Date.parse(result.serverNow)-Date.now();
      orders=Array.isArray(result.orders)?result.orders:[];render();
    }catch{if(expected===generation)render();}
    finally{busy=false;if(!document.hidden)timer=setTimeout(refresh,expected!==generation?0:15000);}
  }
  function invalidate(){generation++;orders=[];render();void refresh();}
  new ResizeObserver(resize).observe(dock);
  window.addEventListener('checkout-created',()=>{void refresh();try{localStorage.setItem('project_order_refresh',String(Date.now()));}catch{}});
  window.addEventListener('account-identity-changed',invalidate);
  window.addEventListener('storage',event=>{if(event.key==='project_order_refresh')invalidate();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else{render();void refresh();}});
  window.addEventListener('pageshow',event=>{if(event.persisted)invalidate();});
  void refresh();
})();
