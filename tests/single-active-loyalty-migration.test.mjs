import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261002231817_single_active_loyalty_reward.sql",import.meta.url),"utf8");
const boundaryMigration=readFileSync(new URL("../supabase/migrations/20261002232845_atomic_single_reward_adjustment_and_reversal.sql",import.meta.url),"utf8");

test("migration removes extra rewards and freezes progress until redemption",async()=>{
 const db=new PGlite();
 await db.exec(`
  create role anon;create role authenticated;create role service_role bypassrls;
  create table public.customers(id uuid primary key default gen_random_uuid());
  create table public.loyalty_programs(id uuid primary key default gen_random_uuid(),name text not null,required_quantity integer not null,reward_quantity integer not null,is_active boolean not null,updated_at timestamptz default now());
  create table public.loyalty_ledger(id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.customers(id),program_id uuid not null references public.loyalty_programs(id),operation_type text not null,progress_delta integer not null default 0,reward_delta integer not null default 0,idempotency_key text not null unique,metadata jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());
 `);
 const customer=(await db.query("insert into public.customers default values returning id")).rows[0].id;
 const program=(await db.query("insert into public.loyalty_programs(name,required_quantity,reward_quantity,is_active) values('Coffee',6,3,true) returning id")).rows[0].id;
 await db.query("insert into public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key) values($1,$2,'EARN',4,0,'old:earn'),($1,$2,'REWARD_GRANTED',0,2,'old:grant')",[customer,program]);
 await db.exec(migration);await db.exec(boundaryMigration);
 assert.equal((await db.query("select reward_quantity from public.loyalty_programs where id=$1",[program])).rows[0].reward_quantity,1);
 assert.deepEqual((await db.query("select sum(progress_delta)::int progress,sum(reward_delta)::int rewards from public.loyalty_ledger where customer_id=$1 and program_id=$2",[customer,program])).rows[0],{progress:0,rewards:1});

 let result=(await db.query("select * from public.apply_loyalty_sale($1,$2,'frozen','o1',3,0,6,1)",[customer,program])).rows[0];
 assert.equal(Number(result.progress),0);assert.equal(Number(result.rewards),1);assert.equal(result.granted,0);
 result=(await db.query("select * from public.apply_loyalty_sale($1,$2,'redeem','o2',2,1,6,1)",[customer,program])).rows[0];
 assert.equal(Number(result.progress),2);assert.equal(Number(result.rewards),0);assert.equal(result.redeemed,1);
 result=(await db.query("select * from public.apply_loyalty_sale($1,$2,'grant','o3',5,0,6,1)",[customer,program])).rows[0];
 assert.equal(Number(result.progress),0);assert.equal(Number(result.rewards),1);assert.equal(result.granted,1);
 const duplicate=(await db.query("select * from public.apply_loyalty_sale($1,$2,'grant','o3',5,0,6,1)",[customer,program])).rows[0];
 assert.equal(duplicate.duplicate,true);assert.equal(Number(duplicate.rewards),1);
 await assert.rejects(db.query("select * from public.apply_single_reward_adjustment($1,$2,0,1,'manual:overflow','{}'::jsonb)",[customer,program]),/INVALID_SINGLE_REWARD_BALANCE/);
 const reversed=(await db.query("select public.apply_single_reward_reversal($1,'o2') reversed",[customer])).rows[0].reversed;
 assert.equal(reversed,2);
 assert.deepEqual((await db.query("select sum(progress_delta)::int progress,sum(reward_delta)::int rewards from public.loyalty_ledger where customer_id=$1 and program_id=$2",[customer,program])).rows[0],{progress:0,rewards:1});
 await db.close();
});
