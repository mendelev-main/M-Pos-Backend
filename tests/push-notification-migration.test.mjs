import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261002190000_order_push_notifications.sql",import.meta.url),"utf8");
const expiryMigration=readFileSync(new URL("../supabase/migrations/20261002190500_expire_stale_order_push_notifications.sql",import.meta.url),"utf8");

test("order insert atomically enqueues one push and token registration replaces stale token",async()=>{
  const db=new PGlite();
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create table public.devices(id uuid primary key default gen_random_uuid(),is_active boolean not null default true);
    create table public.orders(id uuid primary key default gen_random_uuid(),external_id text,order_type text,total numeric);
    grant all on all tables in schema public to service_role;
  `);
  await db.exec(migration);
  await db.exec(expiryMigration);
  await db.exec("set role service_role");
  const device=(await db.query("insert into public.devices default values returning id")).rows[0].id;
  await db.query("select public.register_device_push_token($1,$2,'development',true)",[device,"a".repeat(64)]);
  await db.query("select public.register_device_push_token($1,$2,'development',false)",[device,"b".repeat(64)]);
  const tokens=(await db.query("select token,is_active,sound_enabled from public.device_push_tokens order by token")).rows;
  assert.deepEqual(tokens,[{token:"a".repeat(64),is_active:false,sound_enabled:true},{token:"b".repeat(64),is_active:true,sound_enabled:false}]);
  const expiredOrder=(await db.query("insert into public.orders(external_id,order_type,total) values('WEB-OLD','Самовывоз',10) returning id")).rows[0];
  await db.query("update public.order_push_outbox set created_at=now()-interval '16 minutes' where order_id=$1",[expiredOrder.id]);
  assert.equal((await db.query("select count(*)::int count from public.claim_order_push_notifications(10)")).rows[0].count,0);
  const expired=(await db.query("select delivered_at,last_error from public.order_push_outbox where order_id=$1",[expiredOrder.id])).rows[0];
  assert.ok(expired.delivered_at);assert.equal(expired.last_error,"Push delivery window expired");
  const order=(await db.query("insert into public.orders(external_id,order_type,total) values('WEB-1','Самовывоз',10) returning id")).rows[0];
  assert.equal((await db.query("select count(*)::int count from public.order_push_outbox where order_id=$1",[order.id])).rows[0].count,1);
  const claimed=(await db.query("select * from public.claim_order_push_notifications(10)")).rows;
  assert.equal(claimed.length,1);assert.equal(claimed[0].external_id,"WEB-1");assert.equal(claimed[0].attempts,1);
  assert.equal((await db.query("select count(*)::int count from public.claim_order_push_notifications(10)")).rows[0].count,0);
  await db.exec("reset role");await db.close();
});
