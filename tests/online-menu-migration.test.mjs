import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261002230000_product_online_channels.sql",import.meta.url),"utf8");

test("online menu visibility migration preserves existing products and defaults new products to visible",async()=>{
  const db=new PGlite();
  await db.exec(`
    create table public.products(
      id uuid primary key default gen_random_uuid(),
      name text not null,
      category_id uuid,
      sort_order integer not null default 0,
      is_active boolean not null default true,
      available_online boolean not null default true
    );
    insert into public.products(name,available_online) values('Старый товар',false);
  `);
  await db.exec(migration);
  let rows=(await db.query("select name,available_online,visible_in_menu from public.products order by name")).rows;
  assert.deepEqual(rows,[{name:"Старый товар",available_online:false,visible_in_menu:true}]);
  await db.query("insert into public.products(name,available_online) values('Новый товар',false)");
  rows=(await db.query("select name,visible_in_menu from public.products where name='Новый товар'")).rows;
  assert.deepEqual(rows,[{name:"Новый товар",visible_in_menu:true}]);
  await db.exec(migration);
  assert.equal((await db.query("select count(*)::int count from public.products where visible_in_menu")).rows[0].count,2);
  await db.close();
});
