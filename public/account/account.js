(() => {
  const el = id => document.getElementById(id);
  let timer, expiresAt = 0, checking = false;
  const message = text => { el('account-message').textContent = text; };
  async function api(path, body) {
    const options = { cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  async function loadProfile() {
    const { user } = await api('session');
    el('guest-profile').hidden = !!user; el('member-profile').hidden = !user;
    if (user) {
      stop(); message('');
      el('member-name').textContent = user.name || 'Рады вас видеть';
      el('member-phone').textContent = user.phone;
    }
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
        // After returning from Telegram, the original link may no longer be in memory.
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
  el('logout-button').addEventListener('click', async () => {
    el('logout-button').disabled = true;
    try { await api('logout', {}); reset(); await loadProfile(); }
    catch (error) { message(error.message); }
    finally { el('logout-button').disabled = false; }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (!el('telegram-step').hidden) complete(); });
  window.addEventListener('pageshow', event => { if (event.persisted) loadProfile().then(signedIn => { if (!signedIn) complete(); }).catch(error => message(error.message)); });
  loadProfile().then(signedIn => { if (!signedIn) complete(); }).catch(error => message(error.message));
})();
