const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),c={normalizePhone:()=>''};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function customerSearchFilter('),source.indexOf('app.get("/api/customers/search"')),c);
test('phone prefix uses phone column without requiring full contact validation',()=>{for(const q of ['+3752912','+375 (29) 123-45-67']){const r=c.customerSearchFilter(q);assert.equal(r.column,'normalized_phone');assert.equal(r.pattern,q.replace(/[\s()-]/g,'')+'%')}assert.equal(c.customerSearchFilter('Иван').column,'name')});
test('GET customer search routes partial phone to phone prefix filter and retains device auth',async()=>{
 const routes={},filters=[];let allowed=true;
 const query=async(sql,args)=>{
   if(sql.includes('FROM public.devices'))return {rows:allowed?[{id:'device'}]:[]};
   assert.match(sql,/FROM public.customers/);const column=sql.includes('normalized_phone ILIKE')?'normalized_phone':'name';filters.push({column,pattern:args[0]});return {rows:[{id:'customer',normalized_phone:'+375291234567'}]};
 };
 const app={set(){},use(){},get(p,h){routes[p]=h},post(){},put(){},patch(){},delete(){},listen(){}};
 const express=()=>app;express.json=()=>{};express.static=()=>{};
 const ctx={validateLegalAcknowledgement:()=>null,createPrivacyService:()=>({maintain:async()=>({})}),publicLegalConfiguration:()=>({}),legalHtml:()=>null,withTransaction:async()=>{throw Error("Unexpected transaction")},express,cors:()=>{},console,process:{env:{SUPABASE_URL:'test',SUPABASE_SERVICE_ROLE_KEY:'test'}},query,mountOwnerRoutes(){},createPhoneVerificationService:()=>({}),createTelegramOrderAlerts:()=>({notifyNewOrder:async()=>({}),configure:async()=>({ok:true})}),createLivePosReports:()=>({access:async()=>({ok:true}),request:async()=>({ok:true,report:{}}),submit:()=>true}),createDeliveryTariffs:()=>({}),createAvailabilityService:()=>({}),createCheckoutService:()=>({}),setTimeout(){},setInterval(){}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/order-validation.js'),'utf8'),ctx);vm.runInContext(source.replace(/^import .*;\n/gm,''),ctx);
 const response=()=>({status(n){this.code=n;return this},json(body){this.body=body;return this}});
 let res=response();await routes['/api/customers/search']({header:()=> 'test-device',query:{q:'+3752912'}},res);assert.equal(res.body.customers.length,1);assert.deepEqual(filters,[{column:'normalized_phone',pattern:'+3752912%'}]);res=response();await routes['/api/customers/search']({header:()=> 'test-device',query:{q:'4567'}},res);assert.deepEqual(filters[1],{column:'normalized_phone',pattern:'%4567'});allowed=false;res=response();await routes['/api/customers/search']({header:()=> 'bad-device',query:{q:'+3752912'}},res);assert.equal(res.code,401);assert.equal(filters.length,2);
});

test('four digits match only phone suffix and preserve full phone prefix queries',()=>{const r=c.customerSearchFilter('4567');assert.equal(r.column,'normalized_phone');assert.equal(r.pattern,'%4567');assert.equal(c.customerSearchFilter('+3754567').pattern,'+3754567%')});
