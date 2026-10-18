/* The displayed legal edition is pinned before contacts leave the page. */
(function(root){
 let displayed=null;
 async function configuration(){const r=await fetch('/api/legal',{cache:'no-store'});if(!r.ok)throw Error('Не удалось загрузить условия оформления. Повторите попытку.');return r.json();}
 const ready=configuration().then(x=>{displayed=x;return x;}).catch(()=>null);
 root.CheckoutPrivacy={async acknowledge(){await ready;const current=await configuration();if(!displayed){displayed=current;throw Error('Условия загружены. Ознакомьтесь с документами и нажмите «Оформить заказ» ещё раз.');}if(displayed.version!==current.version){displayed=current;const checkbox=document.getElementById('loyaltyOptIn');if(checkbox)checkbox.checked=false;throw Error('Условия обновились. Ознакомьтесь с документами и повторите оформление.');}return {version:displayed.version,acknowledged:true};}};
})(window);
