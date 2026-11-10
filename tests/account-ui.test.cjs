const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('account enters Telegram directly without reading or sending a phone field', async () => {
  const elements = new Map(), requests = [], navigations = [];
  const get = id => {
    assert.notEqual(id, 'account-phone');
    if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', addEventListener(event, handler) { this[event] = handler; }, focus() {}, removeAttribute(name) { delete this[name]; }, getAttribute(name) { return this[name] || null; }, hasAttribute(name) { return !!this[name]; } });
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/loyalty-cards.js'),'utf8'),context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/account/account.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  await get('login-form').submit({ preventDefault() {} });
  const start = requests.find(request => request.url.endsWith('/start'));
  assert.deepEqual(JSON.parse(start.options.body), {});
  assert.deepEqual(navigations, ['https://t.me/test_bot?start=token']);
  assert.equal(get('telegram-step').hidden, false);
  assert.equal(get('login-button').disabled, false);
});

test('signed-in dashboard hides guest promotions and renders the returned loyalty balances', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {hidden:false,innerHTML:'',textContent:'',addEventListener(event,fn){this[event]=fn;},getAttribute(name){return this[name]||null;},removeAttribute(name){delete this[name];},focus(){}});
    return elements.get(id);
  };
  const user = {phone:'+375291234567',name:'Тестовый участник',delivery_address:'Тестовая, 12',membership_active:true,programs:[{name:'Кофе <script>',required_quantity:5,progress:4,rewards:0}]};
  const context = {document:{getElementById:get,hidden:false,addEventListener(){}},window:{addEventListener(){}},Date,setTimeout(){},clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({user})})};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/loyalty-cards.js'),'utf8'),context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/account/account.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(get('guest-view').hidden,true);
  assert.equal(get('member-view').hidden,false);
  assert.equal(get('member-qr').src,'/api/account/qr');
  assert.match(get('member-programs').innerHTML,/4 из 5/);
  assert.match(get('member-programs').innerHTML,/Кофе &lt;script&gt;/);
  assert.equal((get('member-programs').innerHTML.match(/class="is-filled"/g)||[]).length,4);
});
