import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { createCustomerAccount, mountCustomerAccount } from '../customer-account.js';
import '../public/order-validation.js';

test('dashboard uses the verified phone, real memberships/balances, isolated profile and order history', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec('CREATE ROLE mpos_app;');
    const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
    const directory = new URL('../db/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(n => /^\d{3}_.+\.sql$/.test(n)).sort()) {
      await db.exec((await readFile(new URL(name, directory), 'utf8')).replace('GRANT CONNECT ON DATABASE mpos TO mpos_app;', `GRANT CONNECT ON DATABASE "${database}" TO mpos_app;`));
    }
    const query = db.query.bind(db);
    const phone = '+375290000001', otherPhone = '+375290000002';
    const customer = (await query('INSERT INTO public.customers(name,normalized_phone) VALUES($1,$2) RETURNING id', ['Тестовый участник', phone])).rows[0].id;
    const otherCustomer = (await query('INSERT INTO public.customers(name,normalized_phone) VALUES($1,$2) RETURNING id', ['Другой участник', otherPhone])).rows[0].id;
    await query(`INSERT INTO public.loyalty_memberships(customer_id,status,consented_at,expires_at,document_version)
      VALUES($1,'active',now(),now()+interval '1 year','test')`, [customer]);
    const pizza = (await query("INSERT INTO public.loyalty_programs(name,required_quantity) VALUES('Пицца в подарок',10) RETURNING id")).rows[0].id;
    const coffee = (await query("INSERT INTO public.loyalty_programs(name,required_quantity) VALUES('Кофе в подарок',5) RETURNING id")).rows[0].id;
    await query("INSERT INTO public.loyalty_programs(name,required_quantity,is_active) VALUES('Архивная акция',3,FALSE)");
    await query(`INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key)
      VALUES($1,$2,'EARN',7,0,'account-pizza'),($1,$3,'EARN',4,0,'account-coffee'),($4,$2,'EARN',2,0,'other-pizza')`, [customer,pizza,coffee,otherCustomer]);
    const order = (await query("INSERT INTO public.orders(customer_id,phone,external_id,total) VALUES($1,$2,'my-order',15) RETURNING id", [customer,phone])).rows[0].id;
    await query("INSERT INTO public.order_items(order_id,product_name,price,quantity) VALUES($1,'Мой кофе',5,3)", [order]);
    await query("INSERT INTO public.orders(customer_id,phone,external_id,total) VALUES($1,$2,'private-other-order',999)", [otherCustomer,otherPhone]);
    const session = 'a'.repeat(43), otherSession = 'b'.repeat(43);
    const hash = s => createHash('sha256').update(s).digest('hex');
    for (const [token, number] of [[session,phone],[otherSession,otherPhone]]) await query(`INSERT INTO public.customer_account_sessions(token_hash,phone,telegram_user_id,expires_at)
      VALUES($1,$2,'123456',now()+interval '90 days')`, [hash(token),number]);
    await db.exec('SET ROLE mpos_app;');
    const dependencies = { query, withTransaction: fn => fn({query}), normalizePhone: globalThis.OrderValidation.normalizePhone };
    const account = createCustomerAccount(dependencies);
    assert.equal(await account.current('x'.repeat(43)), null);
    const user = await account.current(session);
    assert.equal(user.name, 'Тестовый участник');
    assert.equal(user.membership_active, true);
    assert.deepEqual(user.programs.map(p => [p.name,p.progress,p.required_quantity]).sort(), [['Кофе в подарок',4,5],['Пицца в подарок',7,10]]);
    assert.equal((await account.orders(session)).length, 1);
    assert.equal((await account.orders(session))[0].items[0].name, 'Мой кофе');
    assert.equal((await account.orders(otherSession))[0].external_id, 'private-other-order');
    assert.equal((await account.updateProfile(session, { name:'Новое имя',birthDate:'1998-05-12',deliveryAddress:'ул. Тестовая, 12' })).user.birth_date, '1998-05-12');
    assert.equal((await account.current(session)).delivery_address, 'ул. Тестовая, 12');
    assert.equal((await account.current(otherSession)).name, 'Другой участник');
    assert.equal((await account.current(otherSession)).delivery_address, null);
    for (const payload of [{phone:otherPhone},{birthDate:'2099-01-01'},{birthDate:'2025-02-30'},{name:'<script>'},{deliveryAddress:'a'.repeat(301)}]) assert.equal((await account.updateProfile(session,payload)).status,400);
    assert.equal((await account.updateProfile('x'.repeat(43),{name:'No'})).status,401);
    await account.updateProfile(session,{birthDate:null});
    assert.equal((await account.current(session)).birth_date,null);
    assert.equal((await account.current(session)).name,'Новое имя');
    await query('UPDATE public.loyalty_ledger SET progress_delta=0,reward_delta=1 WHERE program_id=$1 AND customer_id=$2', [coffee,customer]);
    assert.equal((await account.current(session)).programs.find(p => p.id===coffee).rewards,1);

    const routes = {};
    mountCustomerAccount({use(){},get(p,fn){routes[p]=fn;},post(){},patch(){}},dependencies);
    const response = () => ({status(n){this.code=n;return this;},json(v){this.body=v;return this;},set(){},type(v){this.mime=v;return this;},send(v){this.body=v;return this;}});
    let res = response(); await routes['/api/account/qr']({headers:{cookie:''}},res); assert.equal(res.code,401);
    res=response(); await routes['/api/account/qr']({headers:{cookie:`mpos_account=${session}`}},res);
    assert.equal(res.mime,'image/svg+xml'); assert.match(res.body,/<svg/); assert.equal(res.body.includes(session),false);
    await query("UPDATE public.loyalty_memberships SET status='withdrawn' WHERE customer_id=$1",[customer]);
    assert.deepEqual((await account.current(session)).programs,[]);
    await query("UPDATE public.loyalty_memberships SET status='active',expires_at=now()-interval '1 day' WHERE customer_id=$1",[customer]);
    assert.deepEqual((await account.current(session)).programs,[]);
  } finally { await db.close(); }
});
