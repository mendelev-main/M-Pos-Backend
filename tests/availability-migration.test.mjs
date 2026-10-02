import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261002153000_event_driven_availability.sql",import.meta.url),"utf8");

test("confirmed WEB orders reserve availability atomically and POS settlement removes double counting",async()=>{
  const db=new PGlite();
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create table public.devices(id uuid primary key default gen_random_uuid(),device_key text unique,is_active boolean not null default true);
    create table public.customers(id uuid primary key default gen_random_uuid(),name text not null,normalized_phone text not null unique,telegram_user_id text,updated_at timestamptz default now());
    create table public.orders(id uuid primary key default gen_random_uuid(),external_id text,tracking_token text,status text,order_type text,customer_name text,phone text,customer_id uuid references public.customers(id),address text,comment text,total numeric,delivery_fee numeric);
    create table public.products(id uuid primary key default gen_random_uuid(),external_id text unique);
    create table public.order_items(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),product_id uuid,external_product_id text,product_name text,price numeric,quantity numeric,comment text);
    create table public.phone_verifications(id uuid primary key default gen_random_uuid(),token_hash text unique,phone text,status text,expires_at timestamptz,verified_at timestamptz,consumed_at timestamptz,telegram_user_id text);
    create table public.checkout_sessions(id uuid primary key default gen_random_uuid(),verification_token_hash text,phone text,status text,order_payload jsonb,expires_at timestamptz,order_id uuid,tracking_token text,telegram_user_id text,verified_at timestamptz,updated_at timestamptz default now());
    grant all on all tables in schema public to service_role;
  `);
  await db.exec(migration);
  const device=(await db.query("insert into public.devices(device_key) values('key') returning id")).rows[0].id;
  const product=(await db.query("insert into public.products(external_id) values('pizza') returning id")).rows[0].id;
  await db.exec("set role service_role");
  await assert.rejects(db.query("select public.store_availability_snapshot($1,1,now(),$2::jsonb,array[]::text[])",[device,[{externalId:"pizza"}]]),/INVALID_AVAILABILITY_ITEM/);
  assert.equal((await db.query("select public.store_availability_snapshot($1,1,now(),$2::jsonb,array[]::text[]) applied",[device,[{externalId:"pizza",quantity:2}]])).rows[0].applied,true);

  async function checkout(token,phone,quantity,external){
    await db.query("insert into public.phone_verifications(token_hash,phone,status,expires_at,verified_at) values($1,$2,'VERIFIED',now()+interval '5 minutes',now())",[token,phone]);
    await db.query("insert into public.checkout_sessions(verification_token_hash,phone,status,order_payload,expires_at) values($1,$2,'PENDING',$3,now()+interval '5 minutes')",[token,phone,{customerName:"Test",orderType:"Самовывоз",items:[{product_id:product,external_product_id:"pizza",product_name:"Pizza",price:10,quantity}],total:10*quantity,fee:0}]);
    return (await db.query("select public.finalize_verified_checkout($1,$2,$3) result",[token,external,"track-"+external])).rows[0].result;
  }

  const first=await checkout("a".repeat(64),"+375290000001",1,"WEB-1");assert.equal(first.ok,true);
  assert.equal(Number((await db.query("select quantity from public.get_web_availability() where external_product_id='pizza'")).rows[0].quantity),1);
  await assert.rejects(checkout("b".repeat(64),"+375290000002",2,"WEB-2"),/OUT_OF_STOCK/);
  assert.equal((await db.query("select count(*)::int count from public.orders")).rows[0].count,1);

  assert.equal((await db.query("select public.store_availability_snapshot($1,2,now(),$2::jsonb,$3::text[]) applied",[device,[{externalId:"pizza",quantity:1}],[first.orderId]])).rows[0].applied,true);
  assert.equal(Number((await db.query("select quantity from public.get_web_availability() where external_product_id='pizza'")).rows[0].quantity),1);
  const second=await checkout("c".repeat(64),"+375290000003",1,"WEB-3");assert.equal(second.ok,true);
  assert.equal(Number((await db.query("select quantity from public.get_web_availability() where external_product_id='pizza'")).rows[0].quantity),0);
  assert.equal((await db.query("select count(*)::int count from public.web_order_reservations where settled_at is null")).rows[0].count,1);
  await db.exec("reset role");await db.close();
});
