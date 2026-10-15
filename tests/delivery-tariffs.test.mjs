import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createDeliveryTariffs, deliveryAmount } from '../delivery-tariffs.js';
import { createCheckoutService } from '../checkout-service.js';
import { createPhoneVerificationService } from '../phone-verification.js';
import '../public/order-validation.js';

test('tariff publication, checkout snapshots, access and rollback execute as mpos_app', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec('CREATE ROLE mpos_app;');
    const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
    const baseline = readFileSync(new URL('../db/migrations/001_baseline.sql', import.meta.url), 'utf8')
      .replace('GRANT CONNECT ON DATABASE mpos TO mpos_app;', `GRANT CONNECT ON DATABASE "${database}" TO mpos_app;`);
    await db.exec(baseline);
    const migration = readFileSync(new URL('../db/migrations/004_delivery_tariffs.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration); // additive, repeatable deployment
    await db.exec('SET ROLE mpos_app;');
    const query = (sql, params) => db.query(sql, params);
    const withTransaction = fn => db.transaction(fn);
    const tariffs = createDeliveryTariffs({ query, withTransaction, sourceKey: 'trusted-pos' });
    await query("INSERT INTO public.devices(device_key,name) VALUES('trusted-pos','POS'),('stranger','Other')");
    const rate = { id: 'city', name: 'По городу', amount: 5 };
    const publication = { baseVersion: 0, publicationId: 'first', tariffs: [rate, { id: 'free', name: 'Бесплатно', amount: 0 }, { ...rate, id: 'same-price', name: 'Другой район' }] };
    assert.equal((await tariffs.list()).published, false);
    assert.equal((await tariffs.publish('stranger', publication)).status, 403);
    assert.equal((await createDeliveryTariffs({ query, withTransaction }).publish('trusted-pos', publication)).status, 503);
    assert.equal((await tariffs.publish('trusted-pos', { ...publication, tariffs: [rate, rate] })).status, 400);
    assert.equal((await tariffs.publish('trusted-pos', { ...publication, tariffs: [{ ...rate, amount: 1.001 }] })).status, 400);
    assert.equal((await tariffs.publish('trusted-pos', { ...publication, tariffs: [{ ...rate, amount: true }] })).status, 400);
    assert.equal((await tariffs.publish('trusted-pos', publication)).version, 1);
    assert.equal((await tariffs.publish('trusted-pos', publication)).duplicate, true);
    assert.equal((await tariffs.publish('trusted-pos', { ...publication, tariffs: [] })).code, 'DELIVERY_SYNC_CONFLICT');
    assert.equal((await tariffs.publish('trusted-pos', { ...publication, publicationId: 'stale' })).code, 'DELIVERY_SYNC_CONFLICT');
    assert.equal((await tariffs.publish('trusted-pos', { ...publication, baseVersion: 1, publicationId: 'same-list' })).unchanged, true);
    assert.equal((await tariffs.list()).version, 1);
    await query("UPDATE public.devices SET is_active=FALSE WHERE device_key='stranger'");
    const list = await tariffs.list();
    assert.equal(list.tariffs.length, 3);
    assert.equal(list.tariffs[0].amount, '5.00');
    assert.equal(list.tariffs[1].amount, '0.00');

    const product = (await query("INSERT INTO public.products(external_id,name,price,available_online) VALUES('test','Товар',30,TRUE) RETURNING id")).rows[0].id;
    const device = (await query("SELECT id FROM public.devices WHERE device_key='trusted-pos'")).rows[0].id;
    await query('SELECT public.store_availability_snapshot($1,1,now(),$2::jsonb,ARRAY[]::text[])', [device, JSON.stringify([{ externalId: 'test', quantity: 10 }])]);
    const { normalizePhone, validate: validateOrderContact } = globalThis.OrderValidation;
    const verification = createPhoneVerificationService(query, normalizePhone);
    const checkout = createCheckoutService({ query, normalizePhone, validateOrderContact, phoneVerification: verification, deliveryTariffs: tariffs, deliveryFee: 999 });
    const body = { orderType: 'Доставка', customerName: 'Test', phone: '+375290000001', address: 'Тестовая улица, 1', items: [{ productId: product, quantity: 1 }] };
    assert.equal((await checkout.create(body)).code, 'DELIVERY_TARIFF_REQUIRED');
    assert.equal((await checkout.create({ ...body, deliveryTariffId: 'missing' })).code, 'DELIVERY_TARIFF_UNAVAILABLE');
    const selected = { ...body, deliveryTariffId: 'city', deliveryTariffAmount: '5.00', deliveryTariffVersion: 1, total: 0, deliveryFee: 0 };
    assert.equal((await checkout.create({ ...selected, deliveryTariffAmount: 0 })).code, 'DELIVERY_TARIFF_CHANGED');
    assert.equal((await checkout.create({ ...selected, orderType: 'unknown' })).status, 400);
    const session = await checkout.create(selected);
    assert.equal(session.total, 35);
    assert.equal(session.deliveryFee, 5);
    assert.equal(session.deliveryTariff.name, 'По городу');
    const free = await checkout.create({ ...selected, deliveryTariffId: 'free', deliveryTariffAmount: 0 });
    assert.equal(free.total, 30);
    const pickup = await checkout.create({ ...selected, orderType: 'Самовывоз' });
    assert.equal(pickup.total, 30);
    assert.equal(pickup.deliveryTariff, null);

    // Deleting/renaming tariffs affects new checkout only, not the accepted snapshot.
    await tariffs.publish('trusted-pos', { baseVersion: 1, publicationId: 'second', tariffs: [{ ...rate, name: 'Новое название', amount: 10 }] });
    assert.equal((await checkout.create(selected)).code, 'DELIVERY_TARIFF_CHANGED');
    await tariffs.publish('trusted-pos', { baseVersion: 2, publicationId: 'third', tariffs: [] });
    assert.equal((await checkout.create(selected)).code, 'DELIVERY_TARIFF_UNAVAILABLE');
    const token = new URL(session.telegramUrl).searchParams.get('start');
    assert.equal((await verification.confirm(token, body.phone, '123')).ok, true);
    const finalized = await checkout.finalizeByVerificationToken(token);
    assert.equal(finalized.ok, true, JSON.stringify(finalized));
    const order = (await query('SELECT * FROM public.orders WHERE id=$1', [finalized.orderId])).rows[0];
    assert.equal(Number(order.total), 35);
    assert.equal(Number(order.delivery_fee), 5);
    assert.equal(order.delivery_tariff_id, 'city');
    assert.equal(order.delivery_tariff_name, 'По городу');
    assert.equal(Number(order.delivery_tariff_version), 1);
    assert.equal((await checkout.finalizeByVerificationToken(token)).duplicate, true);
    assert.equal((await query('SELECT count(*)::int AS count FROM public.orders')).rows[0].count, 1);

    // Expiry is enforced by the SQL finalizer and rolls back all effects.
    const expiredToken = new URL(free.telegramUrl).searchParams.get('start');
    await verification.confirm(expiredToken, body.phone, '123');
    await query("UPDATE public.checkout_sessions SET expires_at=now()-interval '1 second' WHERE status='PENDING'");
    assert.equal((await checkout.finalizeByVerificationToken(expiredToken)).reason, 'EXPIRED');
    assert.equal((await query('SELECT count(*)::int AS count FROM public.orders')).rows[0].count, 1);
  } finally { await db.close(); }
});

test('delivery amounts require exact nonnegative kopecks', () => {
  assert.equal(deliveryAmount('0').cents, 0);
  assert.equal(deliveryAmount('12.34').cents, 1234);
  for (const value of [-1, NaN, Infinity, null, '', true, '1e3', '1.001']) assert.equal(deliveryAmount(value), null);
});
