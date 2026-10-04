import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261004152417_telegram_owner_live_reports.sql",import.meta.url),"utf8");

test("Telegram owner ID migration is compatible and idempotent",async()=>{
  const db=new PGlite();
  await db.exec("create table public.devices(id uuid primary key default gen_random_uuid(),device_key text unique,is_active boolean not null default true);");
  await db.exec(migration);await db.exec(migration);
  await db.query("insert into public.devices(device_key,telegram_owner_chat_id) values('one','700000001')");
  const row=(await db.query("select telegram_owner_chat_id from public.devices where device_key='one'")).rows[0];
  assert.deepEqual(row,{telegram_owner_chat_id:"700000001"});
  await assert.rejects(db.query("insert into public.devices(device_key,telegram_owner_chat_id) values('bad','owner')"),/devices_telegram_owner_chat_id_format/);
  await db.close();
});
