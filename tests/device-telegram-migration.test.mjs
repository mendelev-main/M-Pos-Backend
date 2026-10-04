import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261004144957_device_telegram_order_alerts.sql",import.meta.url),"utf8");

test("device Telegram alert migration is compatible and idempotent",async()=>{
  const db=new PGlite();
  await db.exec("create table public.devices(id uuid primary key default gen_random_uuid(),device_key text unique,is_active boolean not null default true);");
  await db.exec(migration);await db.exec(migration);
  await db.query("insert into public.devices(device_key,telegram_order_chat_id,notify_online_orders) values('one','745965268',true)");
  const row=(await db.query("select telegram_order_chat_id,notify_online_orders from public.devices where device_key='one'")).rows[0];
  assert.deepEqual(row,{telegram_order_chat_id:"745965268",notify_online_orders:true});
  await assert.rejects(db.query("insert into public.devices(device_key,telegram_order_chat_id) values('bad','group')"),/devices_telegram_order_chat_id_format/);
  await db.close();
});
