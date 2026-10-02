import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";

const migration=readFileSync(new URL("../supabase/migrations/20261003003000_category_online_channels.sql",import.meta.url),"utf8");

test("category channel migration preserves current publication and defaults new categories to visible",async()=>{
  const db=new PGlite();
  await db.exec(`
    create table public.categories(
      id uuid primary key default gen_random_uuid(),
      name text not null,
      sort_order integer not null default 0,
      is_active boolean not null default true
    );
    insert into public.categories(name,is_active) values('Видимая',true),('Скрытая',false);
  `);
  await db.exec(migration);
  let rows=(await db.query("select name,is_active,available_online,visible_in_menu from public.categories order by name")).rows;
  assert.deepEqual(rows,[
    {name:"Видимая",is_active:true,available_online:true,visible_in_menu:true},
    {name:"Скрытая",is_active:false,available_online:false,visible_in_menu:false}
  ]);
  await db.query("insert into public.categories(name) values('Новая')");
  rows=(await db.query("select available_online,visible_in_menu from public.categories where name='Новая'")).rows;
  assert.deepEqual(rows,[{available_online:true,visible_in_menu:true}]);
  await db.exec(migration);
  await db.close();
});
