(function(){
  const reduceMotion=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
  const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const productPrice=value=>Number(value||0).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' BYN';
  const randomItem=(items,lastId)=>{
    const candidates=items.length>1?items.filter(item=>String(item.id)!==String(lastId)):items;
    const values=new Uint32Array(1);
    if(globalThis.crypto?.getRandomValues)globalThis.crypto.getRandomValues(values);else values[0]=Math.floor(Math.random()*0xffffffff);
    return candidates[values[0]%candidates.length];
  };

  function mount(options){
    const launch=document.getElementById('rouletteLaunch');
    if(!launch||!options)return;
    const overlay=document.createElement('div');
    overlay.className='roulette-overlay';
    overlay.setAttribute('aria-hidden','true');
    overlay.innerHTML='<div class="roulette-dialog" role="dialog" aria-modal="true" aria-labelledby="rouletteTitle"><button class="roulette-close" type="button" aria-label="Закрыть">×</button><div class="roulette-heading"><div class="roulette-kicker">Помощь с выбором</div><h2 id="rouletteTitle">Рулетка блюд</h2><p>Выберите категорию — мы предложим случайный доступный товар.</p></div><label class="roulette-label" for="rouletteCategory">Категория</label><select id="rouletteCategory" class="roulette-select"></select><div class="roulette-stage" aria-live="polite"><span class="roulette-pointer" aria-hidden="true"></span><div class="roulette-wheel" aria-hidden="true"></div><div class="roulette-readout"><span class="roulette-readout-label">Ваш выбор</span><strong>Готовы?</strong><small>Нажмите «Крутить»</small></div></div><div class="roulette-actions"><button class="roulette-spin" type="button">Крутить</button><button class="roulette-view" type="button" hidden>Открыть товар</button></div></div>';
    document.body.appendChild(overlay);
    const dialog=overlay.querySelector('.roulette-dialog');
    const closeButton=overlay.querySelector('.roulette-close');
    const categorySelect=overlay.querySelector('.roulette-select');
    const wheel=overlay.querySelector('.roulette-wheel');
    const readout=overlay.querySelector('.roulette-readout');
    const spinButton=overlay.querySelector('.roulette-spin');
    const viewButton=overlay.querySelector('.roulette-view');
    const actions=overlay.querySelector('.roulette-actions');
    let result=null,lastProductId=null,cycleTimer=null,finishTimer=null;

    const productsFor=categoryId=>(options.getProducts?.()||[]).filter(product=>String(product.category_id)===String(categoryId)&&options.isAvailable(product));
    const resetResult=()=>{result=null;viewButton.hidden=true;actions.classList.remove('has-result');readout.innerHTML='<span class="roulette-readout-label">Ваш выбор</span><strong>Готовы?</strong><small>Нажмите «Крутить»</small>';};
    const populateCategories=()=>{
      const categories=(options.getCategories?.()||[]).filter(category=>productsFor(category.id).length>0);
      categorySelect.innerHTML=categories.map(category=>'<option value="'+escapeHtml(category.id)+'">'+escapeHtml(category.name)+'</option>').join('');
      const preferred=String(options.getActiveCategoryId?.()??'');
      if(categories.some(category=>String(category.id)===preferred))categorySelect.value=preferred;
      const hasCategories=categories.length>0;
      categorySelect.disabled=!hasCategories;spinButton.disabled=!hasCategories;
      if(!hasCategories)readout.innerHTML='<span class="roulette-readout-label">Ваш выбор</span><strong>Нет доступных товаров</strong><small>Попробуйте позже</small>';
      return hasCategories;
    };
    const open=()=>{
      clearInterval(cycleTimer);clearTimeout(finishTimer);wheel.classList.remove('is-spinning');spinButton.disabled=false;resetResult();populateCategories();
      overlay.classList.add('is-open');overlay.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';
      requestAnimationFrame(()=>closeButton.focus());
    };
    const close=()=>{
      clearInterval(cycleTimer);clearTimeout(finishTimer);wheel.classList.remove('is-spinning');
      overlay.classList.remove('is-open');overlay.setAttribute('aria-hidden','true');document.body.style.overflow='';launch.focus();
    };
    const finish=items=>{
      clearInterval(cycleTimer);wheel.classList.remove('is-spinning');result=randomItem(items,lastProductId);lastProductId=result.id;
      readout.innerHTML='<span class="roulette-readout-label">Попробуйте</span><strong>'+escapeHtml(result.name)+'</strong><small>'+escapeHtml(productPrice(result.price))+'</small>';
      spinButton.disabled=false;spinButton.textContent='Крутить ещё';viewButton.hidden=false;actions.classList.add('has-result');
    };
    const spin=()=>{
      const items=productsFor(categorySelect.value);
      if(!items.length){populateCategories();return}
      result=null;viewButton.hidden=true;spinButton.disabled=true;spinButton.textContent='Выбираем…';wheel.classList.remove('is-spinning');void wheel.offsetWidth;wheel.classList.add('is-spinning');
      if(reduceMotion()){finish(items);return}
      let index=0;
      cycleTimer=setInterval(()=>{const item=items[index++%items.length];readout.innerHTML='<span class="roulette-readout-label">Рулетка крутится</span><strong>'+escapeHtml(item.name)+'</strong><small>Ищем подходящий вариант</small>';},85);
      finishTimer=setTimeout(()=>finish(items),1450);
    };

    launch.addEventListener('click',open);
    closeButton.addEventListener('click',close);
    overlay.addEventListener('click',event=>{if(event.target===overlay)close()});
    categorySelect.addEventListener('change',resetResult);
    spinButton.addEventListener('click',spin);
    viewButton.addEventListener('click',()=>{if(!result)return;const selected=result;close();options.onSelect?.(selected)});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&overlay.classList.contains('is-open'))close()});
  }

  window.GuestRoulette={mount};
})();
