(() => {
  const el = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let timer, expiresAt = 0, checking = false, currentUser = null, historyLoaded = false, historyCursor = null, historyBusy = false;
  const message = text => { el('account-message').textContent = text; };
  async function api(path, body, method = 'POST') {
    const options = { cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) Object.assign(options, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const response = await fetch(`/api/account/${path}`, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
    return result;
  }
  function stop() { clearTimeout(timer); }
  function reset() {
    stop(); expiresAt = 0;
    el('login-form').hidden = false; el('telegram-step').hidden = true;
  }
  const phoneLabel = phone => String(phone || '').replace(/^(\+375)(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3-$4-$5');
  function renderPrograms(user) {
    const programs = Array.isArray(user.programs) ? user.programs : [];
    if (!programs.length) {
      el('member-programs').innerHTML = `<p class="member-empty">${user.membership_active ? 'Новые акции появятся здесь, когда станут доступны.' : 'Сейчас у вас нет активного участия в акциях. Уточните условия в заведении.'}</p>`;
      return;
    }
    el('member-programs').innerHTML = window.GuestLoyaltyCards.render(programs);
  }

  function renderUser(user) {
    currentUser = user;
    if(el('account-loading'))el('account-loading').hidden=true;
    el('guest-view').hidden = !!user;
    el('member-view').hidden = !user;
    el('account-tagline').hidden = !!user;
    if (!user) {
      el('member-qr').removeAttribute('src');
      el('member-programs').textContent = '';
      el('member-orders').textContent = '';
      el('member-history').open = false;
      historyLoaded = false;historyCursor=null;if(el('orders-more'))el('orders-more').hidden=true;
      return;
    }
    stop(); message('');
    el('member-name').textContent = user.name || 'Указать имя';
    el('member-phone').textContent = phoneLabel(user.phone);
    el('member-address').textContent = user.delivery_address || 'Указать адрес';
    el('qr-error').hidden = true;
    if (!el('member-qr').getAttribute('src')) el('member-qr').src = '/api/account/qr';
    renderPrograms(user);
  }
  async function loadProfile() {
    const { user } = await api('session');
    renderUser(user);
    return !!user;
  }
  async function complete(manual = false) {
    if (checking || document.hidden && !manual) return;
    checking = true; stop();
    try {
      const { status } = await api('complete', {});
      if (status === 'AUTHENTICATED') { await loadProfile(); return; }
      if (status === 'EXPIRED' || expiresAt && Date.now() >= expiresAt) { reset(); message('Время подтверждения истекло. Войдите ещё раз.'); return; }
      if (status === 'PENDING') {
        el('login-form').hidden = true; el('telegram-step').hidden = false;
        el('telegram-link').hidden = !el('telegram-link').hasAttribute('href');
        if (manual) message('Поделитесь номером в Telegram, затем вернитесь сюда.');
        timer = setTimeout(() => complete(), 3000);
      }
    } catch (error) { message(error.message); }
    finally { checking = false; }
  }
  el('login-form').addEventListener('submit', async event => {
    event.preventDefault(); message(''); el('login-button').disabled = true;
    try {
      const result = await api('start', {});
      expiresAt = Date.parse(result.expiresAt);
      el('telegram-link').href = result.telegramUrl; el('telegram-link').hidden = false;
      el('login-form').hidden = true; el('telegram-step').hidden = false;
      el('telegram-link').focus();
      window.location.assign(result.telegramUrl);
      timer = setTimeout(() => complete(), 3000);
    } catch (error) { message(error.message); }
    finally { el('login-button').disabled = false; }
  });
  el('check-login').addEventListener('click', () => complete(true));
  el('restart-login').addEventListener('click', () => { reset(); message(''); el('login-button').focus(); });
  el('member-qr').addEventListener('error', () => { el('qr-error').hidden = false; });
  function openProfile(focus) {
    if (!currentUser) return;
    el('profile-name').value = currentUser.name || '';
    el('profile-message').textContent = '';
    el('profile-dialog').showModal(); el(focus).focus();
  }
  el('edit-profile').addEventListener('click', () => openProfile('profile-name'));
  el('close-profile').addEventListener('click', () => el('profile-dialog').close());
  el('edit-address').addEventListener('click', () => {
    if (!currentUser) return;
    el('profile-address').value = currentUser.delivery_address || '';
    el('address-message').textContent = '';
    el('address-dialog').showModal(); el('profile-address').focus();
  });
  el('close-address').addEventListener('click', () => el('address-dialog').close());
  async function saveProfile(buttonId, messageId, dialogId, payload) {
    el(buttonId).disabled = true; el(messageId).textContent = '';
    try { const { user } = await api('profile', payload, 'PATCH'); renderUser(user); el(dialogId).close(); }
    catch (error) { el(messageId).textContent = error.message; }
    finally { el(buttonId).disabled = false; }
  }
  el('profile-form').addEventListener('submit', event => {
    event.preventDefault(); saveProfile('save-profile', 'profile-message', 'profile-dialog', {name:el('profile-name').value});
  });
  el('address-form').addEventListener('submit', event => {
    event.preventDefault(); saveProfile('save-address', 'address-message', 'address-dialog', { deliveryAddress: el('profile-address').value });
  });
  async function loadOrders(append=false) {
    if(historyBusy||!currentUser)return;
    historyBusy=true;const expectedPhone=currentUser.phone,more=el('orders-more');
    if(more)more.disabled=true;
    if(!append)el('member-orders').textContent='Загружаем заказы…';
    try{
      const {orders,nextCursor}=await api('orders'+(append&&historyCursor?'?cursor='+encodeURIComponent(historyCursor):''));
      if(currentUser?.phone!==expectedPhone)return;
      const statuses={new:'Создан',accepted:'Принят',in_work:'Готовится',preparing:'Готовится',ready:'Готов',delivering:'В пути',completed:'Завершён',paid:'Оплачен',cancelled:'Отменён',canceled:'Отменён'};
      const html=orders.map(order=>`<article class="account-order"><header class="account-order-heading"><div><small>${escape(order.external_id||'Онлайн-заказ')}</small><time>${escape(new Date(order.created_at).toLocaleString('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}))}</time></div><span class="account-order-status">${escape(statuses[order.status]||'Статус уточняется')}</span></header><p class="account-order-type">${escape(order.order_type||'Самовывоз')}</p><ul class="account-order-items">${(order.items||[]).map(item=>`<li><span>${escape(item.name)} <small>× ${Number(item.quantity)}</small></span><strong>${(Number(item.price)*Number(item.quantity)).toFixed(2)} BYN</strong></li>`).join('')}</ul><footer><span>Итого</span><strong>${Number(order.total||0).toFixed(2)} BYN</strong></footer></article>`).join('');
      if(append)el('member-orders').insertAdjacentHTML('beforeend',html);else el('member-orders').innerHTML=html||'<p>У вас пока нет онлайн-заказов.</p>';
      historyLoaded=true;historyCursor=nextCursor;if(more)more.hidden=!nextCursor;
    }catch(error){if(currentUser?.phone===expectedPhone){if(!append)el('member-orders').textContent=error.message;else message(error.message);}}
    finally{historyBusy=false;if(more)more.disabled=false;}
  }
  el('member-history').addEventListener('toggle',()=>{if(el('member-history').open&&!historyLoaded)void loadOrders();});
  el('orders-more')?.addEventListener('click',()=>loadOrders(true));
  el('logout-button').addEventListener('click', async () => {
    el('logout-button').disabled = true;
    try { await api('logout', {}); reset(); await loadProfile(); }
    catch (error) { message(error.message); }
    finally { el('logout-button').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (!el('telegram-step').hidden) complete(); else if (currentUser) loadProfile().catch(error => {if(el('account-loading'))el('account-loading').textContent='Не удалось загрузить кабинет. Обновите страницу.';message(error.message);}); });
  window.addEventListener('pageshow', event => { if (event.persisted) loadProfile().then(signedIn => { if (!signedIn) complete(); }).catch(error => {if(el('account-loading'))el('account-loading').textContent='Не удалось загрузить кабинет. Обновите страницу.';message(error.message);}); });
  loadProfile().then(signedIn => { if (!signedIn) complete(); }).catch(error => {if(el('account-loading'))el('account-loading').textContent='Не удалось загрузить кабинет. Обновите страницу.';message(error.message);});
})();
