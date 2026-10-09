import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {normalizeTelegramUsername,createPhoneVerificationService} from '../phone-verification.js';
test('Telegram usernames normalize without accepting URLs or injected handles',()=>{
 for(const v of [null,undefined,'','https://t.me/valid_user','user?text=hi','<script>','@','12345'])assert.equal(normalizeTelegramUsername(v),null);
 assert.equal(normalizeTelegramUsername(' @Valid_user '),'Valid_user');
});
test('verified phone stores observed username and distinguishes old bot from username removal',async()=>{
 for(const username of ['valid_user',null,undefined]){
  let patch;const initial={id:'verification',phone:'synthetic',status:'PENDING'};
  const builder={select(){return this},eq(){return this},update(value){patch=value;return this},async maybeSingle(){return {data:patch?{...initial,...patch}:initial,error:null}}};
  const api=createPhoneVerificationService({from:()=>builder},x=>x);assert.equal((await api.confirm('synthetic-token','synthetic',123,username)).ok,true);
  if(username===undefined)assert.equal(Object.hasOwn(patch,'telegram_username_observed'),false);else {assert.equal(patch.telegram_username_observed,true);assert.equal(patch.telegram_username,username);}
 }
});
test('customer trigger synchronizes observed handle, clears removal and preserves legacy updates',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;
 create table public.customers(id int primary key,normalized_phone text,telegram_user_id text);
 create table public.phone_verifications(id int primary key,phone text,telegram_user_id text,status text,verified_at timestamptz,created_at timestamptz default now());`);
 await db.exec(readFileSync(new URL('../supabase/verified_customer_telegram_username.sql',import.meta.url),'utf8'));
 await db.exec(`insert into public.phone_verifications(id,phone,telegram_user_id,status,verified_at,telegram_username,telegram_username_observed) values(1,'synthetic','123','VERIFIED',now(),'valid_user',true);
 insert into public.customers(id,normalized_phone,telegram_user_id) values(1,'synthetic','123');`);
 const username=async()=> (await db.query('select telegram_username from public.customers where id=1')).rows[0].telegram_username;
 assert.equal(await username(),'valid_user');
 await db.exec(`update public.phone_verifications set telegram_username='changed_user';update public.customers set telegram_user_id='123' where id=1;`);assert.equal(await username(),'changed_user');
 await db.exec(`update public.phone_verifications set telegram_username_observed=false;update public.customers set telegram_user_id='123' where id=1;`);assert.equal(await username(),'changed_user');
 await db.exec(`update public.phone_verifications set telegram_username_observed=true,telegram_username=null;update public.customers set telegram_user_id='123' where id=1;`);assert.equal(await username(),null);
 await db.exec(`update public.customers set telegram_username='old_user';update public.customers set telegram_user_id='999' where id=1;`);assert.equal(await username(),null);
 }finally{await db.close()}
});
