const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('device order stream includes verified customer identity',async()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');let columns,payload;
 const ctx={console,supabase:{from(table){assert.equal(table,'orders');const q={select(value){columns=value;return q},eq(){return q},order(){return q},limit:async()=>({data:[{id:'web-1',customer_id:'verified-customer'}]})};return q}}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('const eventClients ='),source.indexOf('setInterval(pushNewOrders')),ctx);vm.runInContext('eventClients.add({res:{write(value){capture(value)}}})',Object.assign(ctx,{capture:value=>payload=value}));await ctx.pushNewOrders();assert.ok(columns.split(',').includes('customer_id'));assert.equal(JSON.parse(payload.slice(6)).orders[0].customer_id,'verified-customer');
});
