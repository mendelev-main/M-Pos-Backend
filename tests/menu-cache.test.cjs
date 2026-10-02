const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'public/guest-menu-cache.js'),'utf8');

function fixture(now=1_000_000){
  const values=new Map();
  const localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const context={localStorage,Date:{now:()=>now}};context.window=context;vm.createContext(context);vm.runInContext(source,context);
  return {cache:context.GuestMenuCache,values};
}

test('menu cache keeps surfaces separate and reports freshness',()=>{
  const {cache}=fixture();const menu={categories:[{id:'c'}],products:[{id:'p'}]};
  assert.equal(cache.write('order',menu),true);
  assert.equal(cache.read('menu',120_000),null);
  const stored=cache.read('order',120_000);assert.equal(stored.fresh,true);assert.equal(stored.menu.products[0].id,'p');
});

test('menu cache rejects malformed and expired values without breaking the page',()=>{
  const {cache,values}=fixture(100_000_000);values.set('project_guest_menu_cache_v1:menu',JSON.stringify({version:1,savedAt:0,menu:{categories:[],products:[]}}));
  assert.equal(cache.read('menu',1_000,86_400_000),null);
  values.set('project_guest_menu_cache_v1:menu','not-json');assert.equal(cache.read('menu',1_000),null);
  assert.equal(cache.write('menu',{products:[]}),false);
});
