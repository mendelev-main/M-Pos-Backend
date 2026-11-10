(function(root){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(programs){return (programs||[]).map(program=>{
    const goal=Math.max(1,Math.floor(Number(program.required_quantity)||1)),gift=Number(program.rewards)>0;
    const filled=gift?goal:Math.max(0,Math.min(goal,Math.floor(Number(program.progress)||0))),name=escape(program.name);
    const progress=goal<=12?`<div class="loyalty-stamps" role="progressbar" aria-label="${name}" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${filled}">${Array.from({length:goal},(_,i)=>`<span class="${i<filled?'is-filled':''}" aria-hidden="true">✦</span>`).join('')}<span class="stamp-gift ${gift?'is-ready':''}" aria-hidden="true">♡</span></div>`:`<progress class="account-progress" max="${goal}" value="${filled}" aria-label="${name}">${filled} из ${goal}</progress>`;
    return `<article class="member-promotion ${gift?'has-reward':''}"><div class="promotion-top"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 10h16v11H4ZM2 6h20v4H2Zm10 0v15M12 6C2 6 7-3 12 6Zm0 0c10 0 5-9 0 0Z"/></svg><h3>${name}</h3><span class="promotion-count">${gift?'Подарок':`${filled} из ${goal}`}</span></div>${progress}</article>`;
  }).join('');}
  root.GuestLoyaltyCards=Object.freeze({render});
})(typeof window!=='undefined'?window:globalThis);
