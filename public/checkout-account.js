(function(root){
  'use strict';
  const autoValues=new Map();let sequence=0,lastPhone=null;
  const field=id=>document.getElementById(id);
  function fill(id,value){const input=field(id);if(!input)return;const current=String(input.value||'');if(!current||current===autoValues.get(id)){input.value=value;autoValues.set(id,value);}}
  function clear(){for(const [id,value] of autoValues){const input=field(id);if(input&&input.value===value)input.value='';}autoValues.clear();}
  async function refresh(){
    const request=++sequence,box=field('checkout-account-gifts'),list=field('checkout-account-gifts-list');
    if(box)box.hidden=true;
    try{
      const response=await fetch('/api/account/session',{credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw new Error('Account unavailable');
      const {user}=await response.json();if(request!==sequence)return;
      if(!user){clear();lastPhone=null;if(list)list.textContent='';return;}
      if(lastPhone!==user.phone){clear();lastPhone=user.phone;}
      fill('name',user.name||'');fill('namePickup',user.name||'');
      if(/^\+375\d{9}$/.test(user.phone||'')){const phone=user.phone.slice(4).replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/,'$1 $2 $3 $4');fill('phone',phone);fill('phonePickup',phone);}
      const gifts=(Array.isArray(user.programs)?user.programs:[]).filter(p=>Number(p.rewards)>0);
      if(box&&list){list.innerHTML=root.GuestLoyaltyCards.render(gifts);box.hidden=!gifts.length;}
    }catch(_error){if(request===sequence&&box)box.hidden=true;}
  }
  root.CheckoutAccount=Object.freeze({refresh});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&field('cartModal')?.style.display==='flex')void refresh();});
})(window);
