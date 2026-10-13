const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('device order stream includes verified customer identity',async()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');let columns,payload;
 const ctx={console,query:async(sql)=>{columns=sql;return {rows:[{id:'web-1',customer_id:'verified-customer'}]}}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('const eventClients ='),source.indexOf('setInterval(pushNewOrders')),ctx);vm.runInContext('eventClients.add({res:{write(value){capture(value)}}})',Object.assign(ctx,{capture:value=>payload=value}));await ctx.pushNewOrders();assert.match(columns,/o\.customer_id/);assert.equal(JSON.parse(payload.slice(6)).orders[0].customer_id,'verified-customer');
});
