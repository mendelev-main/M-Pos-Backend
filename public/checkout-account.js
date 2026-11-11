(function(root){
  'use strict';
  const autoValues=new Map(),selected=new Set();let sequence=0,user=null,cart=[],products=[];
  const field=id=>document.getElementById(id),esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function fill(id,value){const input=field(id);if(!input)return;const current=String(input.value||'');if(!current||current===autoValues.get(id)){input.value=value;autoValues.set(id,value);}}
  function clear(){for(const [id,value] of autoValues){const input=field(id);if(input&&input.value===value)input.value='';}autoValues.clear();selected.clear();}
  function allocation(){const remaining=new Map(cart.map(x=>[x.id,Number(x.qty)])),chosen=[];
    for(const p of (user?.programs||[]).filter(p=>Number(p.rewards)>0).sort((a,b)=>a.id.localeCompare(b.id))){
      const eligible=products.filter(x=>(remaining.get(x.id)||0)>=1&&(p.reward_product_ids||[]).some(id=>id===x.id||id===x.external_id)).sort((a,b)=>Number(a.price)-Number(b.price)||a.id.localeCompare(b.id));
      if(!eligible.length){selected.delete(p.id);chosen.push({program:p,item:null});continue;}
      const item=eligible[0];chosen.push({program:p,item});if(selected.has(p.id))remaining.set(item.id,remaining.get(item.id)-1);
    }return chosen;
  }
  function render(nextCart=cart,nextProducts=products){cart=nextCart;products=nextProducts;const box=field('checkout-account-gifts'),list=field('checkout-account-gifts-list');if(!box||!list)return;
    const rows=allocation();list.innerHTML=rows.map(({program,item})=>{
      const html=root.GuestLoyaltyCards.render([program]);
      return item?html.replace('<span class="promotion-count">Подарок</span>',`<button type="button" class="gift-use" data-use-gift="${esc(program.id)}" aria-pressed="${selected.has(program.id)}">${selected.has(program.id)?'Убрать подарок':'Использовать подарок'}</button>`):html;
    }).join('');box.hidden=!rows.length;
    list.onclick=event=>{const button=event.target.closest('[data-use-gift]');if(!button)return;const id=button.dataset.useGift;selected.has(id)?selected.delete(id):selected.add(id);render();root.dispatchEvent(new Event('checkout-gifts-changed'));};
  }
  function discount(){return allocation().reduce((sum,x)=>sum+(x.item&&selected.has(x.program.id)?Math.round(Number(x.item.price)*100):0),0)/100;}
  async function refresh(){const request=++sequence;
    try{const response=await fetch('/api/account/session',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error();const result=await response.json();if(request!==sequence)return;
      if(user?.phone!==result.user?.phone)clear();user=result.user||null;
      for(const id of ['phone','phonePickup']){const input=field(id);if(input)input.readOnly=!!user;}
      if(user){fill('name',user.name||'');fill('namePickup',user.name||'');fill('address',user.delivery_address||'');
        if(/^\+375\d{9}$/.test(user.phone||'')){const phone=user.phone.slice(4).replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/,'$1 $2 $3 $4');fill('phone',phone);fill('phonePickup',phone);}}
      render();root.dispatchEvent(new Event('checkout-gifts-changed'));
    }catch(_error){/* Preserve form input and selections on transient network failures. */}
  }
  root.CheckoutAccount=Object.freeze({refresh,render,discount,payload:()=>({giftProgramIds:[...selected].sort()})});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&field('cartModal')?.style.display==='flex')void refresh();});
})(window);
