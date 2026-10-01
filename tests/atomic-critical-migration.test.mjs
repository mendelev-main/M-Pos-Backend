import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261001112313_atomic_checkout_and_loyalty_programs.sql",import.meta.url),"utf8");

test("critical migration atomically finalizes checkout and replaces loyalty rules",async()=>{
  const db=new PGlite();
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create table public.customers(id uuid primary key default gen_random_uuid(),name text not null,normalized_phone text not null unique,telegram_user_id text,updated_at timestamptz default now());
    create table public.orders(id uuid primary key default gen_random_uuid(),external_id text,tracking_token text,status text,order_type text,customer_name text,phone text,customer_id uuid references public.customers(id),address text,comment text,total numeric,delivery_fee numeric);
    create table public.products(id uuid primary key default gen_random_uuid());
    create table public.order_items(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),product_id uuid,external_product_id text,product_name text,price numeric,quantity numeric,comment text);
    create table public.phone_verifications(id uuid primary key default gen_random_uuid(),token_hash text unique,phone text,status text,expires_at timestamptz,verified_at timestamptz,consumed_at timestamptz,telegram_user_id text);
    create table public.checkout_sessions(id uuid primary key default gen_random_uuid(),verification_token_hash text,phone text,status text,order_payload jsonb,expires_at timestamptz,order_id uuid,tracking_token text,telegram_user_id text,verified_at timestamptz,updated_at timestamptz default now());
    create table public.loyalty_programs(id uuid primary key default gen_random_uuid(),name text not null,required_quantity integer not null,reward_quantity integer not null,is_active boolean not null,updated_at timestamptz default now());
    create table public.loyalty_earning_products(program_id uuid not null references public.loyalty_programs(id),product_id text not null,primary key(program_id,product_id));
    create table public.loyalty_reward_products(program_id uuid not null references public.loyalty_programs(id),product_id text not null,primary key(program_id,product_id));
    grant all on all tables in schema public to service_role;
  `);
  await db.exec(migration);
  for(const role of ["anon","authenticated"]){await db.exec("set role "+role);await assert.rejects(db.query("select public.finalize_verified_checkout('x','e','t')"),/permission denied/);await db.exec("reset role")}
  const product=(await db.query("insert into public.products default values returning id")).rows[0].id;
  const tokenHash="a".repeat(64),phone="+375290000000";
  await db.query("insert into public.phone_verifications(token_hash,phone,status,expires_at,verified_at,telegram_user_id) values($1,$2,'VERIFIED',now()+interval '5 minutes',now(),'tg')",[tokenHash,phone]);
  await db.query("insert into public.checkout_sessions(verification_token_hash,phone,status,order_payload,expires_at) values($1,$2,'PENDING',$3,now()+interval '5 minutes')",[tokenHash,phone,{customerName:"Test",orderType:"Самовывоз",items:[{product_id:product,external_product_id:"local",product_name:"Pizza",price:10,quantity:1}],total:10,fee:0}]);
  await db.exec("set role service_role");
  const first=(await db.query("select public.finalize_verified_checkout($1,$2,$3) result",[tokenHash,"WEB-1","track-1"])).rows[0].result;
  const second=(await db.query("select public.finalize_verified_checkout($1,$2,$3) result",[tokenHash,"WEB-2","track-2"])).rows[0].result;
  assert.equal(first.ok,true);assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);
  assert.equal((await db.query("select count(*)::int count from public.orders")).rows[0].count,1);
  assert.equal((await db.query("select count(*)::int count from public.order_items")).rows[0].count,1);
  assert.equal((await db.query("select status from public.phone_verifications")).rows[0].status,"CONSUMED");
  assert.equal((await db.query("select status from public.checkout_sessions")).rows[0].status,"ORDER_CREATED");

  const program=(await db.query("insert into public.loyalty_programs(name,required_quantity,reward_quantity,is_active) values('Old',5,1,true) returning id")).rows[0].id;
  await db.query("insert into public.loyalty_earning_products values($1,'old')",[program]);
  await assert.rejects(db.query("select public.replace_loyalty_program($1,'Broken',2,1,true,array[null]::text[],array['gift']::text[])",[program]));
  assert.equal((await db.query("select name from public.loyalty_programs where id=$1",[program])).rows[0].name,"Old");
  assert.equal((await db.query("select product_id from public.loyalty_earning_products where program_id=$1",[program])).rows[0].product_id,"old");
  await db.exec("reset role");await db.close();
});
