const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/checkout-privacy.js'),'utf8');
test('loyalty is optional, unchecked and legal edition changes reset the choice before submission',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');const checkbox=html.match(/<input[^>]+id="loyaltyOptIn"[^>]*>/)?.[0];assert.ok(checkbox);assert.doesNotMatch(checkbox,/\bchecked\b|\brequired\b/);
 let version='v1';const choice={checked:true},c={document:{getElementById:()=>choice},fetch:async()=>({ok:true,json:async()=>({version})})};c.window=c;vm.createContext(c);vm.runInContext(source,c);
 assert.equal((await c.CheckoutPrivacy.acknowledge()).version,'v1');version='v2';await assert.rejects(c.CheckoutPrivacy.acknowledge(),/обновились/);assert.equal(choice.checked,false);assert.equal((await c.CheckoutPrivacy.acknowledge()).version,'v2');
});
