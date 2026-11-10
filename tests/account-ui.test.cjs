const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('account enters Telegram directly without reading or sending a phone field', async () => {
  const elements = new Map(), requests = [], navigations = [];
  const get = id => {
    assert.notEqual(id, 'account-phone');
    if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', addEventListener(event, handler) { this[event] = handler; }, focus() {}, hasAttribute(name) { return !!this[name]; } });
    return elements.get(id);
  };
  const context = {
    document: { getElementById: get, hidden: false, addEventListener() {} },
    window: { addEventListener() {}, location: { assign(url) { navigations.push(url); } } },
    Date, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      const result = url.endsWith('/session') ? { user: null } : url.endsWith('/complete') ? { status: 'MISSING' } : { telegramUrl: 'https://t.me/test_bot?start=token', expiresAt: new Date(Date.now() + 300000).toISOString() };
      return { ok: true, json: async () => result };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/account/account.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  await get('login-form').submit({ preventDefault() {} });
  const start = requests.find(request => request.url.endsWith('/start'));
  assert.deepEqual(JSON.parse(start.options.body), {});
  assert.deepEqual(navigations, ['https://t.me/test_bot?start=token']);
  assert.equal(get('telegram-step').hidden, false);
  assert.equal(get('login-button').disabled, false);
});
