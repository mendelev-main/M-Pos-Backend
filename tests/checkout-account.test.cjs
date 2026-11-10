const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('checkout fills both contact forms, preserves manual edits and displays only available gifts',async()=>{
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:true,style:{},textContent:'',innerHTML:''});return elements.get(id);};
 let user={name:'Александр',phone:'+375291234567',programs:[{name:'Кофе',required_quantity:5,progress:0,rewards:1},{name:'Пицца',required_quantity:10,progress:7,rewards:0}]};
 const context={window:{},document:{getElementById:get,addEventListener(){}},fetch:async()=>({ok:true,json:async()=>({user})})};
 for(const file of ['loyalty-cards.js','checkout-account.js'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),context);
 await context.window.CheckoutAccount.refresh();
 assert.equal(get('name').value,'Александр');assert.equal(get('namePickup').value,'Александр');assert.equal(get('phone').value,'29 123 45 67');assert.equal(get('phonePickup').value,'29 123 45 67');
 assert.equal(get('checkout-account-gifts').hidden,false);assert.match(get('checkout-account-gifts-list').innerHTML,/has-reward/);assert.match(get('checkout-account-gifts-list').innerHTML,/Кофе/);assert.doesNotMatch(get('checkout-account-gifts-list').innerHTML,/Пицца|Покажите карту/);
 get('namePickup').value='Другое имя';user={...user,name:'Новое имя',programs:[]};await context.window.CheckoutAccount.refresh();
 assert.equal(get('namePickup').value,'Другое имя');assert.equal(get('name').value,'Новое имя');assert.equal(get('checkout-account-gifts').hidden,true);
 user=null;await context.window.CheckoutAccount.refresh();assert.equal(get('phone').value,'');assert.equal(get('name').value,'');assert.equal(get('namePickup').value,'Другое имя');assert.equal(get('checkout-account-gifts-list').textContent,'');
});
test('older account responses cannot restore a gift after a newer signed-out response',async()=>{
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:true,style:{},textContent:'',innerHTML:''});return elements.get(id);};
 let resolveOld,calls=0;const context={window:{},document:{getElementById:get,addEventListener(){}},fetch:()=>++calls===1?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve({ok:true,json:async()=>({user:null})})};
 for(const file of ['loyalty-cards.js','checkout-account.js'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'),context);
 const old=context.window.CheckoutAccount.refresh();await context.window.CheckoutAccount.refresh();resolveOld({ok:true,json:async()=>({user:{name:'Old',phone:'+375291234567',programs:[{rewards:1}]}})});await old;
 assert.equal(get('name').value,'');assert.equal(get('checkout-account-gifts').hidden,true);
});
