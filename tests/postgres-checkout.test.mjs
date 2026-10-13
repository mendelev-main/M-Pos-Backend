import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createPhoneVerificationService } from '../phone-verification.js';
import { createCheckoutService } from '../checkout-service.js';
import '../public/order-validation.js';

test('native baseline supports confirmation and atomic checkout under mpos_app', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec('CREATE ROLE mpos_app;');
    const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
    const baseline = readFileSync(new URL('../db/migrations/001_baseline.sql', import.meta.url), 'utf8')
      .replace('GRANT CONNECT ON DATABASE mpos TO mpos_app;', `GRANT CONNECT ON DATABASE "${database}" TO mpos_app;`);
    await db.exec(baseline);
    await db.exec(readFileSync(new URL('../db/migrations/002_owner_auth.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../db/migrations/003_runtime_defaults.sql', import.meta.url), 'utf8'));
    await db.exec('SET ROLE mpos_app;');
    const query = (sql, params) => db.query(sql, params);
    const device = (await query("INSERT INTO public.devices(device_key,name) VALUES ('integration-device','Test') RETURNING id")).rows[0].id;
    const product = (await query("INSERT INTO public.products(external_id,name,price,available_online) VALUES ('integration-product','Test',12.34,true) RETURNING id")).rows[0].id;
    await query('SELECT public.store_availability_snapshot($1,1,now(),$2::jsonb,ARRAY[]::text[])', [device, JSON.stringify([{ externalId: 'integration-product', quantity: 7 }])]);
    const { normalizePhone, validate: validateOrderContact } = globalThis.OrderValidation;
    const verification = createPhoneVerificationService(query, normalizePhone);
    const checkout = createCheckoutService({ query, normalizePhone, validateOrderContact, phoneVerification: verification });
    const session = await checkout.create({ customerName: 'Test', phone: '+375290000001', items: [{ productId: product, quantity: 2 }] });
    assert.equal(session.status, 'PENDING');
    const token = new URL(session.telegramUrl).searchParams.get('start');
    assert.equal((await verification.confirm(token, '+375290000002', '123')).reason, 'PHONE_MISMATCH');
    assert.equal((await verification.get(token)).status, 'PENDING');
    assert.equal((await verification.confirm(token, '+375290000001', '123', 'test_user')).ok, true);
    const result = await checkout.finalizeByVerificationToken(token);
    assert.equal(result.ok, true);
    assert.equal((await verification.get(token)).status, 'CONSUMED');
    assert.equal((await checkout.get(session.checkoutToken)).status, 'ORDER_CREATED');
    assert.equal(Number((await query('SELECT quantity FROM public.get_web_availability()')).rows[0].quantity), 5);
    const repeated = await checkout.finalizeByVerificationToken(token);
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.orderId, result.orderId);
    assert.equal((await query('SELECT count(*)::int AS count FROM public.orders')).rows[0].count, 1);
    assert.equal((await query('SELECT count(*)::int AS count FROM public.order_items')).rows[0].count, 1);
  } finally {
    await db.close();
  }
});
