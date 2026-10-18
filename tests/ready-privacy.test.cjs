const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../ready-server.js'),'utf8');
test('the promoted startup root handler enforces closing hours before reading the order form',async()=>{
 const {isOrderingOpen,closedPageHtml}=await import('../business-hours.js');let handler,reads=0;
 const c={URL,console,runningApp:{get(p,h){handler=h}},isSiteSleepWindow:()=>false,isOrderingOpen:()=>isOrderingOpen(new Date('2026-10-18T19:00:00Z'),'Europe/Minsk'),closedPageHtml,readFile:async()=>{reads++;return '<main>Fixture checkout</main>'}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('runningApp.get("/",'),source.indexOf('const stack =')).replaceAll('import.meta.url',"'file:///fixture/ready-server.js'"),c);
 const res={headers:{},setHeader(k,v){this.headers[k]=v},type(){return this},send(body){this.body=body;return this},status(n){this.code=n;return this}};
 await handler({},res);assert.equal(reads,0);assert.match(res.body,/Пошли наводить порядок/);assert.equal(res.headers['Cache-Control'],'no-store');
 c.isOrderingOpen=()=>isOrderingOpen(new Date('2026-10-18T07:00:00Z'),'Europe/Minsk');await handler({},res);assert.equal(reads,1);assert.match(res.body,/Fixture checkout/);
});
test('startup no longer schedules destruction of ready orders and financial item rows',()=>{
 assert.doesNotMatch(source,/DELETE FROM public\.(orders|order_items)/);assert.doesNotMatch(source,/set(?:Timeout|Interval)\(cleanupReadyOrders/);
});
