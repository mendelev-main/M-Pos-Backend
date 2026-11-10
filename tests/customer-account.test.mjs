import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createCustomerAccount, mountCustomerAccount, ACCOUNT_SESSION_SECONDS } from '../customer-account.js';
import { createPhoneVerificationService } from '../phone-verification.js';
import { seedDemoCatalog } from '../scripts/demo-catalog.mjs';
import '../public/order-validation.js';

test('account login binds browser proof to verified contact, expires/revokes sessions and consumes once', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec('CREATE ROLE mpos_app;');
    const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
    const sql = (await readFile(new URL('../db/migrations/001_baseline.sql', import.meta.url), 'utf8'))
      .replace('GRANT CONNECT ON DATABASE mpos TO mpos_app;', `GRANT CONNECT ON DATABASE "${database}" TO mpos_app;`);
    await db.exec(sql);
    await db.exec(await readFile(new URL('../db/migrations/009_customer_account.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../db/migrations/010_account_phone_from_telegram.sql', import.meta.url), 'utf8'));
    await db.exec('SET ROLE mpos_app;');
    const query = db.query.bind(db);
    const withTransaction = async fn => {
      await query('BEGIN');
      try { const result = await fn({ query }); await query('COMMIT'); return result; }
      catch (error) { await query('ROLLBACK'); throw error; }
    };
    const normalizePhone = globalThis.OrderValidation.normalizePhone;
    const account = createCustomerAccount({ query, withTransaction, normalizePhone });
    const verification = createPhoneVerificationService(query, normalizePhone);
    const login = await account.start('https://example.test/account/');
    const verificationToken = new URL(login.telegramUrl).searchParams.get('start');
    assert.equal((await account.complete('x'.repeat(43))).status, 'EXPIRED');
    assert.equal((await account.complete(login.proof)).status, 'PENDING');
    assert.equal((await verification.get(verificationToken)).phone, null);
    for (const phone of ['+79123456789', '+380501234567', '+375123', '+3752912345678']) {
      assert.equal((await verification.confirm(verificationToken, phone, '900001')).reason, 'INVALID');
      assert.equal((await verification.get(verificationToken)).phone, null);
      assert.equal((await account.complete(login.proof)).status, 'PENDING');
    }
    assert.equal((await verification.confirm(verificationToken, '+375291234567', '900001', 'test_user')).ok, true);
    const result = await account.complete(login.proof);
    assert.equal((await verification.get(verificationToken)).phone, '+375291234567');
    assert.equal(result.status, 'AUTHENTICATED');
    assert.equal((await account.complete(login.proof)).status, 'EXPIRED');
    assert.equal((await verification.get(verificationToken)).status, 'CONSUMED');
    assert.equal((await account.current(result.session)).phone, '+375291234567');
    assert.equal(await account.current('x'.repeat(43)), null);
    const stored = (await query('SELECT token_hash,expires_at,created_at FROM public.customer_account_sessions')).rows[0];
    assert.equal(stored.token_hash, createHash('sha256').update(result.session).digest('hex'));
    assert.equal((new Date(stored.expires_at) - new Date(stored.created_at)) / 1000, ACCOUNT_SESSION_SECONDS);
    await account.logout(result.session);
    assert.equal(await account.current(result.session), null);
    const expired = await account.start('https://example.test/account/');
    await query("UPDATE public.customer_account_challenges SET expires_at=now()-interval '1 second'");
    assert.equal((await account.complete(expired.proof)).status, 'EXPIRED');
    const again = await account.start('https://example.test/account/');
    await verification.confirm(new URL(again.telegramUrl).searchParams.get('start'), '+375291234567', '900001');
    const newSession = await account.complete(again.proof);
    await query("UPDATE public.customer_account_sessions SET expires_at=now()-interval '1 second'");
    assert.equal(await account.current(newSession.session), null);

    const seeded = await seedDemoCatalog({ query });
    assert.deepEqual(seeded, { categories: 6, products: 24 });
    await seedDemoCatalog({ query });
    assert.equal((await query('SELECT count(*)::int AS n FROM public.products')).rows[0].n, 24);
    const stock = (await query('SELECT * FROM public.get_web_availability()')).rows;
    assert.equal(stock.length, 24);
    assert.equal(stock.filter(row => Number(row.quantity) === 0 && row.quantity !== null).length, 2);
    assert.equal(stock.filter(row => row.quantity === null).length, 4);
    await query("INSERT INTO public.devices(name,device_key) VALUES('Other POS','other-device')");
    await assert.rejects(seedDemoCatalog({ query }), /another active POS/);
    assert.equal((await query('SELECT count(*)::int AS n FROM public.products')).rows[0].n, 24);
  } finally { await db.close(); }
});

test('account routes enforce same origin and set HttpOnly 90-day cookie without exposing token in JSON', async () => {
  const routes = {}, middlewares = [];
  const app = { use(path, fn) { middlewares.push(fn); }, get(path, fn) { routes[path] = fn; }, post(path, fn) { routes[path] = fn; } };
  // Full SQL lifecycle is covered above; here only exercise the HTTP boundary.
  const verified = { expires_at: new Date(Date.now() + 300_000), status: 'VERIFIED', phone: '+375291234567', telegram_user_id: '900001' };
  const query = async sql => ({ rows: sql.includes('FOR UPDATE') ? [verified] : [] });
  mountCustomerAccount(app, { query, withTransaction: fn => fn({ query }), normalizePhone: value => value });
  const response = () => ({ headers: {}, set(k, v) { this.headers[k] = v; }, append(k, v) { (this.headers[k] ||= []).push(v); }, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
  const req = { method: 'POST', protocol: 'https', secure: true, headers: { cookie: `mpos_account_challenge=${'a'.repeat(43)}` }, get: name => name === 'origin' ? 'https://evil.test' : 'example.test', is: () => true };
  let res = response(), passed = false;
  middlewares[0](req, res, () => { passed = true; });
  assert.equal(res.code, 403); assert.equal(passed, false);
  res = response();
  req.get = name => name === 'origin' ? 'https://example.test' : 'example.test';
  middlewares[0](req, res, () => { passed = true; });
  assert.equal(passed, true); assert.equal(res.headers['Cache-Control'], 'no-store');
  await routes['/api/account/complete'](req, res);
  assert.deepEqual(res.body, { status: 'AUTHENTICATED' });
  const sessionCookie = res.headers['Set-Cookie'][0];
  assert.match(sessionCookie, /HttpOnly; SameSite=Lax; Max-Age=7776000; Secure$/);
  assert.match(res.headers['Set-Cookie'][1], /mpos_account_challenge=;.*Max-Age=0/);
});
