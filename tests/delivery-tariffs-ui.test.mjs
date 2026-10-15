import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/delivery-tariffs-ui.js';

test('guest chooses by ID, confirms price changes and fails closed on offline delivery', async () => {
  let data = { published: true, version: 1, tariffs: [{ id: 'a', name: 'Город', amount: '5.00' }, { id: 'b', name: 'Район', amount: '5.00' }, { id: 'free', name: 'Бесплатно', amount: '0.00' }] };
  let offline = false;
  const ui = globalThis.DeliveryTariffsUI.create({ fetchList: async () => { if (offline) throw new Error('offline'); return data; } });
  await ui.refresh();
  assert.equal(ui.ready(), false);
  ui.select('b');
  assert.equal(ui.payload().deliveryTariffId, 'b');
  await ui.refresh();
  assert.equal(ui.ready(), true);
  data = { ...data, version: 2, tariffs: [{ id: 'b', name: 'Район', amount: '10.00' }] };
  await ui.refresh();
  assert.equal(ui.ready(), false);
  assert.equal(ui.snapshot().selected, null);
  ui.select('b');
  assert.equal(ui.payload().deliveryTariffAmount, '10.00');
  offline = true;
  await ui.refresh();
  assert.equal(ui.ready(), false);
  assert.equal(ui.snapshot().selected, null);
  offline = false;
  data = { published: true, version: 3, tariffs: [{ id: 'free', name: 'Бесплатно', amount: '0.00' }] };
  await ui.refresh(); ui.select('free');
  assert.equal(ui.ready(), true);
  assert.equal(ui.payload().deliveryTariffAmount, '0.00');
  ui.clear();
  assert.deepEqual(ui.payload(), {});
  data = { published: true, version: 4, tariffs: [] };
  await ui.refresh();
  assert.equal(ui.ready(), false);
});

test('slow obsolete fetch cannot replace a newer tariff response', async () => {
  const resolvers = [];
  const ui = globalThis.DeliveryTariffsUI.create({ fetchList: () => new Promise(resolve => resolvers.push(resolve)) });
  const older = ui.refresh(), newer = ui.refresh();
  resolvers[1]({ published: true, version: 2, tariffs: [] }); await newer;
  resolvers[0]({ published: true, version: 1, tariffs: [] }); await older;
  assert.equal(ui.snapshot().version, 2);
});
